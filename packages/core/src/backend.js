// The Backend is the single authority for every rule in Regimen: PIN checks,
// cooldowns, type-to-confirm friction, conflict and empty-window validation.
// It runs inside the extension's service worker (or in the page in standalone
// mode). UIs only ever call dispatch(command, payload).
import { migrate, defaultState, publicState } from './state.js'
import { computeBlocks, gatedStatus, isLocked, isRuleLive, focusEndsAt, focusPhase, TEST_DOMAIN, TEST_BLOCK_MS } from './engine.js'
import { rulesOverlap, validateSchedule, nextWindowStart, windowAt, previousWindow } from './schedule.js'
import { findSite, parseDomainList, normalizeDomain, hostMatches } from './sites.js'
import { hashSecret, verifySecret, generateRecoveryCode, normalizeRecoveryCode, randomId } from './crypto.js'
import { checkConfirmation } from './confirm.js'
import { sanitizeRoom, roomLockError } from './room.js'
import { progressOf, awardEvent, recordFocus } from './progress.js'
import { mergeLofi } from './lofi.js'
import { ownsFn, canBuy, coinsOf, sessionReward, payFocusCoins, defaultCoinStats, COINS } from './economy.js'
import { computeMilestones } from './milestones.js'
import {
  PRIORITIES,
  PRIORITY_RANK,
  FORWARD_LIMITS,
  classifyTaskChange,
  subtaskProblem,
  validateRecurrence,
  nextDeadline,
  taskColor,
} from './tasks.js'
import { dateKey, fromDateKey, startOfDay, addDays } from './time.js'
import { COLOR_MODES, mergeAppearance } from './appearance.js'
import { mergeUi, unionUi } from './ui.js'

export class FGError extends Error {
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}
const fail = (code, message, details) => {
  throw new FGError(code, message, details)
}

const MAX_PIN_ATTEMPTS = 5
const PIN_LOCKOUT_MS = 5 * 60_000
const MAX_LOG = 5000

export const FAILSAFE_COPY = {
  title: 'Are you sure?',
  message: "You set this rule for a reason. Don't break your own promise.",
  cancel: "I'm Honorable",
  continue: 'I Choose Comfort',
}

export function createBackend({ storage, now = () => Date.now(), hashIterations, onChange } = {}) {
  let state = null
  let queue = Promise.resolve()

  async function load() {
    if (!state) {
      const saved = await storage.load()
      state = migrate(saved, now())
      if (!state.createdAt) state.createdAt = now()
    }
    return state
  }

  function log(s, type, fields = {}) {
    s.log.push({ id: randomId(), type, at: now(), ...fields })
    if (s.log.length > MAX_LOG) s.log.splice(0, s.log.length - MAX_LOG)
  }

  // ---- PIN handling (attempt counter must persist even when the command fails) ----
  async function checkPin(s, pin) {
    const sec = state.security
    if (!sec.pin) fail('NO_PIN', 'Set up a PIN first.')
    if (sec.lockedUntil > now()) {
      fail('PIN_LOCKED', `Too many wrong PINs. Try again in ${Math.ceil((sec.lockedUntil - now()) / 60000)} min.`, {
        lockedUntil: sec.lockedUntil,
      })
    }
    if (typeof pin !== 'string' || !pin) fail('PIN_REQUIRED', 'Enter your PIN.')
    const ok = await verifySecret(pin, sec.pin)
    if (!ok) {
      sec.failedAttempts += 1
      if (sec.failedAttempts >= MAX_PIN_ATTEMPTS) {
        sec.failedAttempts = 0
        sec.lockedUntil = now() + PIN_LOCKOUT_MS
      }
      await storage.save(state)
      fail('PIN_INCORRECT', 'Incorrect PIN.', { attemptsLeft: MAX_PIN_ATTEMPTS - sec.failedAttempts })
    }
    sec.failedAttempts = 0
    s.security.failedAttempts = 0
  }

  function validPinFormat(pin) {
    if (typeof pin !== 'string' || pin.length < 6 || pin.length > 64) {
      fail('BAD_PIN', 'PIN must be at least 6 characters.')
    }
  }

  // ---- helpers ----
  const getRule = (s, id) => s.rules.find((r) => r.id === id) || fail('NOT_FOUND', 'Rule not found.')
  const getTask = (s, id) => s.tasks.find((t) => t.id === id) || fail('NOT_FOUND', 'Task not found.')
  const getHabit = (s, id) => s.habits.find((h) => h.id === id) || fail('NOT_FOUND', 'Habit not found.')
  const subtasksOf = (s, id) => s.tasks.filter((t) => t.parentId === id)

  function anyLockedLive(s) {
    return s.rules.some((r) => isLocked(r) && windowAt(r, now()))
  }

  function cleanRuleInput(s, input) {
    const r = {
      name: String(input.name || '')
        .trim()
        .slice(0, 80),
      siteIds: [...new Set(input.siteIds || [])],
      days: [...new Set((input.days || []).map(Number))].sort(),
      start: Number(input.start),
      end: Number(input.end),
      failsafe: input.failsafe !== false,
    }
    const errors = validateSchedule(r)
    if (!r.siteIds.length) errors.push('Pick at least one site.')
    for (const id of r.siteIds) if (!findSite(s, id)) errors.push(`Unknown site: ${id}`)
    if (errors.length) fail('VALIDATION', errors.join(' '))
    return r
  }

  function assertNoConflict(s, rule, mode, excludeId) {
    for (const other of s.rules) {
      if (other.id === excludeId || other.mode === mode) continue
      if (!other.siteIds.some((id) => rule.siteIds.includes(id))) continue
      if (rulesOverlap(other, rule)) {
        fail(
          'CONFLICT',
          `This overlaps your ${other.mode === 'hard' ? 'Hard Block' : 'Task-Gated'} rule "${other.name || 'Untitled'}" on the same site. Edit or remove that rule first.`,
          { conflictRuleId: other.id },
        )
      }
    }
  }

  function cleanTaskInput(s, input, existing) {
    const t = {}
    if ('title' in input || !existing) {
      t.title = String(input.title || '')
        .trim()
        .slice(0, 200)
      if (!t.title) fail('VALIDATION', 'Give the task a title.')
    }
    if ('notes' in input) t.notes = String(input.notes || '').slice(0, 5000)
    if ('priority' in input || !existing) {
      t.priority = input.priority || 'medium'
      if (!PRIORITIES.includes(t.priority)) fail('VALIDATION', 'Invalid priority.')
    }
    if ('deadline' in input || !existing) {
      t.deadline = Number(input.deadline)
      if (!Number.isFinite(t.deadline) || t.deadline <= 0) fail('VALIDATION', 'Every task needs a deadline.')
    }
    if ('startAt' in input) t.startAt = input.startAt ? Number(input.startAt) : null
    if ('tags' in input) {
      t.tags = [...new Set((input.tags || []).map((x) => String(x).trim().slice(0, 30)).filter(Boolean))].slice(0, 10)
      for (const tag of t.tags) if (!s.tags.includes(tag)) s.tags.push(tag)
    }
    if ('ruleId' in input) {
      t.ruleId = input.ruleId || null
      if (t.ruleId) {
        const r = getRule(s, t.ruleId)
        if (r.mode !== 'gated') fail('VALIDATION', 'Tasks can only be attached to Task-Gated rules.')
      }
    }
    if ('recurrence' in input) {
      try {
        t.recurrence = validateRecurrence(input.recurrence)
      } catch (e) {
        fail('VALIDATION', e.message)
      }
    }
    if ('recurrenceReset' in input) t.recurrenceReset = input.recurrenceReset === 'cycle' ? 'cycle' : 'accumulate'
    return t
  }

  function newTask(s, input) {
    if (input.parentId) {
      const parent = getTask(s, input.parentId)
      input = { deadline: parent.deadline, priority: parent.priority, ...input }
      for (const k of ['deadline', 'priority']) if (input[k] == null || input[k] === '') input[k] = parent[k]
    }
    const fields = cleanTaskInput(s, input, null)
    const task = {
      id: randomId(),
      parentId: null,
      ruleId: null,
      notes: '',
      tags: [],
      startAt: null,
      recurrence: null,
      recurrenceReset: 'accumulate',
      seriesId: null,
      status: 'todo',
      completedAt: null,
      createdAt: now(),
      forwardCount: 0,
      forwardedUntil: null,
      timeSpentSec: 0,
      missedLogged: false,
      spawnedNext: false,
      ...fields,
    }
    if (input.parentId) {
      const parent = getTask(s, input.parentId)
      if (parent.parentId) fail('VALIDATION', 'Subtasks cannot have their own subtasks.')
      task.parentId = parent.id
      task.ruleId = null
      task.recurrence = null
      const p = subtaskProblem(task, parent)
      if (p) fail('VALIDATION', p)
    }
    if (task.recurrence) task.seriesId = task.id
    return task
  }

  /** When the next occurrence becomes "active": for window-gated tasks, the next
   * window after this occurrence, so finishing today's copy unlocks today. */
  function nextStart(s, task) {
    const rule = task.ruleId && s.rules.find((r) => r.id === task.ruleId)
    if (!rule) return task.deadline
    return nextWindowStart(rule, Math.max(now(), task.deadline)) || task.deadline
  }

  function spawnNextOccurrence(s, task) {
    if (!task.recurrence || task.spawnedNext) return null
    const deadline = nextDeadline(task.recurrence, task.deadline)
    const delta = deadline - task.deadline
    const next = {
      ...task,
      id: randomId(),
      status: 'todo',
      completedAt: null,
      createdAt: now(),
      startAt: nextStart(s, task),
      deadline,
      forwardedUntil: null,
      timeSpentSec: 0,
      missedLogged: false,
      spawnedNext: false,
      forwardCount: task.recurrenceReset === 'cycle' ? 0 : task.forwardCount,
    }
    task.spawnedNext = true
    s.tasks.push(next)
    for (const sub of subtasksOf(s, task.id)) {
      s.tasks.push({
        ...sub,
        id: randomId(),
        parentId: next.id,
        status: 'todo',
        completedAt: null,
        createdAt: now(),
        deadline: sub.deadline + delta,
        timeSpentSec: 0,
        missedLogged: false,
      })
    }
    return next
  }

  function focusedMinutes(f, until) {
    const work = f.workMin * 60_000
    const cycle = work + f.breakMin * 60_000
    const elapsed = Math.max(0, Math.min(until, focusEndsAt(f)) - f.startedAt)
    const full = Math.floor(elapsed / cycle)
    const rest = elapsed - full * cycle
    return Math.round((full * work + Math.min(rest, work)) / 60_000)
  }

  function endFocus(s, status, reason) {
    const f = s.focus.active
    if (!f) return
    const end = status === 'completed' ? focusEndsAt(f) : now()
    s.focus.history.push({
      id: f.id,
      startedAt: f.startedAt,
      endedAt: end,
      workMin: f.workMin,
      breakMin: f.breakMin,
      iterations: f.iterations,
      siteIds: f.siteIds,
      status,
      reason: reason || null,
      focusedMin: focusedMinutes(f, end),
    })
    if (s.focus.history.length > 1000) s.focus.history.shift()
    recordFocus(s.stats, s.focus.history.at(-1).focusedMin) // counters outlive the trimmed history
    // coins for the session, kept on its history entry for the reward card (see economy.js)
    s.stats.coins ||= defaultCoinStats()
    const entry = s.focus.history.at(-1)
    const reward = sessionReward(s.stats.coins, { minutes: entry.focusedMin, completed: status === 'completed', at: end })
    payFocusCoins(s.stats.coins, reward, end)
    const { base, bonus, first, streak, pct, coins, capped, xp } = reward
    entry.reward = { coins, base, bonus, first, streak, pct, capped, xp }
    s.focus.active = null
    log(s, status === 'completed' ? 'focus_completed' : 'focus_stopped_early', { focusId: f.id, reason })
  }

  /**
   * Turns an export / saved state from elsewhere into a safe state. Runtime state
   * (overrides, a half-finished failsafe, rule statuses) is never trusted: it could
   * skip a cooldown or unlock a window. Rules are re-validated like new ones.
   */
  function sanitizeIncoming(payload, keep) {
    const { overrides, failsafe, runtime, security, agent, onboarding, ...rest } = payload
    const next = migrate({ ...rest, ...keep }, now())
    next.customSites = next.customSites
      .filter((x) => x && typeof x.id === 'string' && Array.isArray(x.domains))
      .map((x) => ({ ...x, domains: x.domains.map(normalizeDomain).filter(Boolean) }))
    const rules = []
    for (const r of next.rules) {
      if (!r || !['hard', 'gated'].includes(r.mode)) continue
      const clean = cleanRuleInput(next, r)
      try {
        assertNoConflict({ rules }, clean, r.mode, null)
      } catch {
        continue
      }
      rules.push({
        id: String(r.id || randomId()),
        mode: r.mode,
        createdAt: Number(r.createdAt) || now(),
        ...clean,
        failsafe: r.mode === 'gated' ? true : clean.failsafe,
      })
    }
    next.rules = rules
    next.tasks = next.tasks.filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string' && Number.isFinite(t.deadline))
    for (const t of next.tasks) if (t.ruleId && !rules.some((r) => r.id === t.ruleId)) t.ruleId = null
    next.focus = { active: null, history: Array.isArray(next.focus?.history) ? next.focus.history : [] }
    return next
  }

  const isHashRecord = (r) =>
    !!r &&
    typeof r === 'object' &&
    /^[0-9a-f]{32}$/.test(r.salt) &&
    /^[0-9a-f]{64}$/.test(r.hash) &&
    (r.iterations == null || (Number.isInteger(r.iterations) && r.iterations >= 1000 && r.iterations <= 10_000_000))

  // ---- command handlers: (draft, payload) => result ----
  const handlers = {
    'state.get': { readonly: true, run: () => null },

    // Onboarding / security
    'setup.pin': async (s, { pin }) => {
      if (s.security.pin) fail('PIN_EXISTS', 'A PIN is already set. Use Change PIN in settings.')
      validPinFormat(pin)
      s.security.pin = await hashSecret(pin, hashIterations)
      const code = generateRecoveryCode()
      s.security.recovery = await hashSecret(normalizeRecoveryCode(code), hashIterations)
      s.security.recoveryUsed = false
      return { recoveryCode: code }
    },
    // The user finished setup on the website before installing the extension. A brand-new
    // extension takes over that setup (PIN included) so nobody does the tutorial twice.
    // Only allowed while the extension has nothing to protect yet.
    'setup.adopt': (s, { state: incoming }) => {
      if (s.security.pin || s.onboarding.completed || s.rules.length || s.tasks.length) {
        fail('NOT_FRESH', 'Regimen is already set up here. Use Settings, Backup, Import to bring data over.')
      }
      if (!incoming || typeof incoming !== 'object' || !Array.isArray(incoming.tasks)) fail('VALIDATION', 'Nothing to move.')
      const sec = incoming.security || {}
      if (!isHashRecord(sec.pin) || (sec.recovery != null && !isHashRecord(sec.recovery)))
        fail('VALIDATION', 'The saved PIN looks damaged. Set up again instead.')
      const onboarding = { completed: !!incoming.onboarding?.completed, steps: { ...(incoming.onboarding?.steps || {}) } }
      const next = sanitizeIncoming(incoming, {
        security: { ...s.security, pin: sec.pin, recovery: sec.recovery || null, recoveryUsed: !!sec.recoveryUsed },
        agent: s.agent,
        onboarding,
      })
      next.createdAt = Number(incoming.createdAt) || now()
      // what was already seen on either side stays seen (the room intro, tips, notices)
      next.ui = unionUi(s.ui, incoming.ui)
      Object.keys(s).forEach((k) => delete s[k])
      Object.assign(s, next)
      log(s, 'setup_adopted')
      return { onboardingCompleted: onboarding.completed, tasks: s.tasks.length, rules: s.rules.length }
    },
    'setup.step': (s, { step }) => {
      if (
        ![
          'recoverySaved',
          'pinExplained',
          'failsafeDryRun',
          'emergencyHelp',
          'dohReviewed',
          'firstRule',
          'extensionChecked',
          'uiMode',
        ].includes(step)
      )
        fail('VALIDATION', 'Unknown step.')
      if (step === 'failsafeDryRun' && !s.onboarding.steps.failsafeDryRunDone) fail('VALIDATION', 'Finish the Failsafe practice run first.')
      s.onboarding.steps[step] = true
      return null
    },
    'setup.complete': (s) => {
      if (!s.security.pin) fail('VALIDATION', 'Create your PIN first.')
      if (!s.onboarding.steps.recoverySaved) fail('VALIDATION', 'Save your recovery code first.')
      if (!s.onboarding.steps.failsafeDryRunDone) fail('VALIDATION', 'Do the Failsafe practice run first.')
      s.onboarding.completed = true
      return null
    },
    'security.changePin': async (s, { oldPin, newPin }) => {
      await checkPin(s, oldPin)
      validPinFormat(newPin)
      s.security.pin = await hashSecret(newPin, hashIterations)
      return null
    },
    'security.recover': async (s, { code, newPin }) => {
      const sec = state.security
      if (!sec.recovery || sec.recoveryUsed) fail('RECOVERY_USED', 'This recovery code was already used.')
      if (sec.lockedUntil > now()) fail('PIN_LOCKED', 'Too many attempts. Wait a few minutes.')
      const ok = await verifySecret(normalizeRecoveryCode(code), sec.recovery)
      if (!ok) {
        sec.failedAttempts += 1
        if (sec.failedAttempts >= MAX_PIN_ATTEMPTS) {
          sec.failedAttempts = 0
          sec.lockedUntil = now() + PIN_LOCKOUT_MS
        }
        await storage.save(state)
        fail('RECOVERY_INCORRECT', 'That recovery code is not right.')
      }
      validPinFormat(newPin)
      s.security.pin = await hashSecret(newPin, hashIterations)
      const fresh = generateRecoveryCode()
      s.security.recovery = await hashSecret(normalizeRecoveryCode(fresh), hashIterations)
      s.security.recoveryUsed = false
      s.security.failedAttempts = 0
      log(s, 'pin_recovered')
      return { recoveryCode: fresh }
    },
    'security.newRecoveryCode': async (s, { pin }) => {
      await checkPin(s, pin)
      const fresh = generateRecoveryCode()
      s.security.recovery = await hashSecret(normalizeRecoveryCode(fresh), hashIterations)
      s.security.recoveryUsed = false
      return { recoveryCode: fresh }
    },

    // Sites
    'sites.add': (s, { name, domains }) => {
      const list = Array.isArray(domains) ? domains.join(' ') : String(domains || '')
      const { good, bad } = parseDomainList(list)
      if (bad.length) fail('VALIDATION', `These don't look like websites: ${bad.join(', ')}`)
      if (!good.length) fail('VALIDATION', 'Add at least one website address.')
      const site = {
        id: 'custom-' + randomId().slice(0, 8),
        name: String(name || good[0])
          .trim()
          .slice(0, 60),
        domains: good,
        category: 'custom',
      }
      s.customSites.push(site)
      return site
    },
    'sites.remove': (s, { id }) => {
      if (s.rules.some((r) => r.siteIds.includes(id))) fail('IN_USE', 'A rule still uses this site. Remove it from the rule first.')
      if (s.focus.active?.siteIds.includes(id)) fail('IN_USE', 'Your focus session is blocking this site.')
      s.customSites = s.customSites.filter((x) => x.id !== id)
      return null
    },

    // Rules
    'rules.create': (s, input) => {
      const mode = input.mode
      if (mode !== 'hard' && mode !== 'gated') fail('VALIDATION', 'Pick Hard Block or Task-Gated.')
      const r = cleanRuleInput(s, input)
      if (mode === 'gated') r.failsafe = true
      assertNoConflict(s, r, mode, null)
      const rule = { id: randomId(), mode, ...r, name: r.name || (mode === 'hard' ? 'Hard Block' : 'Study window'), createdAt: now() }
      // Only free, unfinished tasks can gate a new window. Moving a task away from another
      // window would quietly unlock it, and done tasks would unlock this one instantly.
      const attach = (input.taskIds || []).map((id) => getTask(s, id))
      for (const t of attach) {
        if (t.parentId) fail('VALIDATION', 'Attach the parent task, not a subtask.')
        if (t.ruleId) fail('VALIDATION', `"${t.title}" already unlocks another window. Detach it there first.`)
        if (t.status === 'done') fail('VALIDATION', `"${t.title}" is already done, so it can't gate a window.`)
      }
      const created = mode === 'gated' ? (input.newTasks || []).map((t) => newTask(s, t)) : []
      if (mode === 'gated' && attach.length + created.length === 0) {
        fail('EMPTY_WINDOW', 'A Task-Gated window needs at least one task. Otherwise there would be nothing to unlock it.')
      }
      s.rules.push(rule)
      for (const t of attach) t.ruleId = rule.id
      for (const t of created) {
        t.ruleId = rule.id
        s.tasks.push(t)
      }
      log(s, 'rule_created', { ruleId: rule.id, title: rule.name })
      return rule
    },
    'rules.update': async (s, { id, patch = {}, pin }) => {
      const rule = getRule(s, id)
      const live = isRuleLive(s, rule, now())
      if (live && isLocked(rule))
        fail('LOCKED', 'This rule has no failsafe and is active right now. It can be changed after the window ends.')
      if (live) await checkPin(s, pin)
      const merged = cleanRuleInput(s, { ...rule, ...patch })
      if (rule.mode === 'gated') merged.failsafe = true
      assertNoConflict(s, merged, rule.mode, rule.id)
      Object.assign(rule, merged, { name: merged.name || rule.name, updatedAt: now() })
      log(s, live ? 'rule_edited_active' : 'rule_edited', { ruleId: rule.id, title: rule.name })
      return rule
    },
    'rules.delete': async (s, { id, pin }) => {
      const rule = getRule(s, id)
      if (isLocked(rule) && windowAt(rule, now()))
        fail('LOCKED', 'This rule has no failsafe and is active right now. It can be deleted after the window ends.')
      await checkPin(s, pin)
      s.rules = s.rules.filter((r) => r.id !== id)
      for (const t of s.tasks) if (t.ruleId === id) t.ruleId = null
      s.overrides = s.overrides.filter((o) => o.ruleId !== id)
      log(s, 'rule_deleted', { ruleId: id, title: rule.name })
      return null
    },

    // Tasks
    'tasks.create': (s, input) => {
      const task = newTask(s, input)
      s.tasks.push(task)
      return task
    },
    'tasks.update': (s, { id, patch = {}, confirmation }) => {
      const task = getTask(s, id)
      const fields = cleanTaskInput(s, patch, task)
      if (task.parentId) {
        delete fields.ruleId
        delete fields.recurrence
      }
      const { easing, tightening } = classifyTaskChange(task, fields)
      if (easing.length) {
        const reason = checkConfirmation('ease_task', task.title, confirmation)
        for (const e of easing) {
          log(s, { deadline: 'deadline_delayed', priority: 'priority_downgraded', rule: 'task_detached', start: 'deadline_delayed' }[e], {
            taskId: task.id,
            title: task.title,
            reason,
          })
        }
      }
      for (const t of tightening) {
        log(s, { deadline: 'deadline_tightened', priority: 'priority_raised', rule: 'task_attached' }[t], {
          taskId: task.id,
          title: task.title,
        })
      }
      const next = { ...task, ...fields }
      if (task.parentId) {
        const p = subtaskProblem(next, getTask(s, task.parentId))
        if (p) fail('VALIDATION', p)
      }
      Object.assign(task, fields)
      if (fields.recurrence && !task.seriesId) task.seriesId = task.id
      // keep subtasks inside the parent's constraints (this only ever tightens them)
      for (const sub of subtasksOf(s, task.id)) {
        if (sub.deadline > task.deadline) sub.deadline = task.deadline
        if (PRIORITY_RANK[sub.priority] < PRIORITY_RANK[task.priority]) sub.priority = task.priority
      }
      return { task, praise: tightening.length > 0 && easing.length === 0 }
    },
    'tasks.complete': (s, { id }) => {
      const task = getTask(s, id)
      if (task.status === 'done') return { task }
      const open = subtasksOf(s, id).filter((x) => x.status !== 'done')
      if (open.length) fail('SUBTASKS_OPEN', `Finish its ${open.length} subtask${open.length > 1 ? 's' : ''} first.`)
      task.status = 'done'
      task.completedAt = now()
      log(s, 'task_completed', { taskId: id, title: task.title, onTime: now() <= task.deadline, parent: !!task.parentId })
      const next = spawnNextOccurrence(s, task)
      return { task, next }
    },
    'tasks.reopen': (s, { id }) => {
      const task = getTask(s, id)
      task.status = 'todo'
      task.completedAt = null
      if (task.parentId) {
        const parent = getTask(s, task.parentId)
        if (parent.status === 'done') {
          parent.status = 'todo'
          parent.completedAt = null
        }
      }
      return { task }
    },
    'tasks.forward': (s, { id }) => {
      const task = getTask(s, id)
      if (task.parentId) fail('VALIDATION', 'Forward the parent task instead.')
      if (!task.ruleId) fail('VALIDATION', 'Only tasks attached to a Task-Gated window can be sent to its next window.')
      if (task.status === 'done') fail('VALIDATION', 'This task is already done.')
      if (task.forwardCount >= FORWARD_LIMITS[task.priority])
        fail('FORWARD_LIMIT', `No forwards left for a ${task.priority}-priority task. Finish it or use Failsafe.`)
      if (now() >= task.deadline) fail('DEADLINE_PASSED', 'The deadline has passed. Finish it or use Failsafe.')
      const rule = getRule(s, task.ruleId)
      const next = nextWindowStart(rule, now())
      if (!next) fail('VALIDATION', 'This rule has no upcoming window.')
      if (next > task.deadline) fail('DEADLINE_PASSED', "The next window is after this task's deadline. Finish it now.")
      task.forwardCount += 1
      task.forwardedUntil = next
      log(s, 'task_forwarded', { taskId: id, ruleId: rule.id, title: task.title })
      return { task, color: taskColor(task) }
    },
    'tasks.delete': (s, { id, confirmation }) => {
      const task = getTask(s, id)
      const reason = checkConfirmation('delete_task', task.title, confirmation)
      const ids = new Set([id, ...subtasksOf(s, id).map((t) => t.id)])
      s.tasks = s.tasks.filter((t) => !ids.has(t.id))
      log(s, task.parentId ? 'subtask_deleted' : 'task_deleted', { taskId: id, title: task.title, reason })
      return null
    },
    'tasks.logTime': (s, { id, seconds }) => {
      const task = getTask(s, id)
      const sec = Math.max(0, Math.min(Number(seconds) || 0, 24 * 3600))
      task.timeSpentSec = (task.timeSpentSec || 0) + Math.round(sec)
      return { task }
    },
    'tags.remove': (s, { tag }) => {
      s.tags = s.tags.filter((t) => t !== tag)
      for (const t of s.tasks) t.tags = (t.tags || []).filter((x) => x !== tag)
      return null
    },

    // Habits
    'habits.create': (s, input) => {
      const name = String(input.name || '')
        .trim()
        .slice(0, 60)
      if (!name) fail('VALIDATION', 'Name your habit.')
      const days = [...new Set((input.days?.length ? input.days : [1, 2, 3, 4, 5, 6, 7]).map(Number))]
        .filter((d) => d >= 1 && d <= 7)
        .sort()
      const habit = {
        id: randomId(),
        name,
        emoji: String(input.emoji || '').slice(0, 8),
        color: input.color || 'violet',
        days,
        createdAt: startOfDay(now()),
        archived: false,
      }
      s.habits.push(habit)
      return habit
    },
    'habits.update': (s, { id, patch = {} }) => {
      const h = getHabit(s, id)
      if ('name' in patch) h.name = String(patch.name).trim().slice(0, 60) || h.name
      if ('emoji' in patch) h.emoji = String(patch.emoji).slice(0, 8)
      if ('color' in patch) h.color = patch.color
      if ('days' in patch) {
        const days = [...new Set(patch.days.map(Number))].filter((d) => d >= 1 && d <= 7).sort()
        if (!days.length) fail('VALIDATION', 'Pick at least one day.')
        h.days = days
      }
      if ('archived' in patch) h.archived = !!patch.archived
      return h
    },
    'habits.toggle': (s, { id, date }) => {
      const h = getHabit(s, id)
      const key = date || dateKey(now())
      const day = fromDateKey(key)
      if (day > startOfDay(now())) fail('VALIDATION', "You can't check off the future.")
      if (day < addDays(startOfDay(now()), -7)) fail('VALIDATION', 'You can only edit the last 7 days.')
      const logs = (s.habitLogs[h.id] ||= {})
      if (logs[key]) delete logs[key]
      else logs[key] = true
      return { done: !!logs[key] }
    },
    'habits.delete': (s, { id }) => {
      getHabit(s, id)
      s.habits = s.habits.filter((h) => h.id !== id)
      delete s.habitLogs[id]
      return null
    },

    // Focus mode
    'focus.start': (s, { workMin, breakMin, iterations, siteIds }) => {
      if (s.focus.active && now() < focusEndsAt(s.focus.active)) fail('FOCUS_RUNNING', 'A focus session is already running.')
      if (s.focus.active) endFocus(s, 'completed')
      const w = Number(workMin),
        b = Number(breakMin),
        n = Number(iterations)
      if (!(w >= 1 && w <= 240)) fail('VALIDATION', 'Work length must be 1 to 240 minutes.')
      if (!(b >= 0 && b <= 60)) fail('VALIDATION', 'Break length must be 0 to 60 minutes.')
      if (!(Number.isInteger(n) && n >= 1 && n <= 12)) fail('VALIDATION', 'Rounds must be 1 to 12.')
      const ids = [...new Set(siteIds || [])]
      if (!ids.length) fail('VALIDATION', 'Pick at least one site to block.')
      for (const id of ids) if (!findSite(s, id)) fail('VALIDATION', `Unknown site: ${id}`)
      const f = { id: randomId(), workMin: w, breakMin: b, iterations: n, siteIds: ids, startedAt: now() }
      f.endsAt = focusEndsAt(f)
      s.focus.active = f
      log(s, 'focus_started', { focusId: f.id })
      return f
    },
    // "Test blocking": block TEST_DOMAIN for a minute. The blocked page reports back with
    // blocking.hit, which proves the whole path (extension, permission, network rule) works.
    'blocking.test': (s) => {
      const t = now()
      s.runtime.blockTest = { id: randomId(), startedAt: t, until: t + TEST_BLOCK_MS, hitAt: null }
      return { ...s.runtime.blockTest, domain: TEST_DOMAIN }
    },
    'blocking.hit': (s, { domain }) => {
      const test = s.runtime.blockTest
      if (!test || now() >= test.until || !hostMatches(String(domain || ''), TEST_DOMAIN)) return { test: false }
      test.hitAt = now()
      test.until = now() // done: the test domain opens again right away
      return { test: true }
    },
    'focus.stop': (s, { confirmation }) => {
      if (!s.focus.active) fail('VALIDATION', 'No focus session is running.')
      const reason = checkConfirmation('stop_focus', '', confirmation)
      endFocus(s, 'stopped_early', reason)
      return null
    },

    // Failsafe: intent -> pin -> cooldown -> typed confirm -> unlocked
    'failsafe.start': (s, { target }) => {
      if (!target || !['rule', 'focus', 'practice'].includes(target.type)) fail('VALIDATION', 'Unknown failsafe target.')
      if (target.type === 'rule') {
        const rule = getRule(s, target.id)
        if (isLocked(rule)) fail('NO_FAILSAFE', 'You turned off the failsafe for this rule. There is no override until the window ends.')
        const b = computeBlocks(s, now()).blocks.find((x) => x.ruleId === rule.id)
        if (!b) fail('VALIDATION', 'This rule is not blocking anything right now.')
      }
      if (target.type === 'focus' && !s.focus.active) fail('VALIDATION', 'No focus session is running.')
      s.failsafe = { id: randomId(), target, step: 'intent', startedAt: now(), cooldownEndsAt: null }
      return { ...s.failsafe, copy: FAILSAFE_COPY }
    },
    'failsafe.continue': (s) => {
      const f = s.failsafe
      if (!f || f.step !== 'intent') fail('FAILSAFE_STEP', 'Start the failsafe again.')
      f.step = 'pin'
      return f
    },
    'failsafe.pin': async (s, { pin }) => {
      const f = s.failsafe
      if (!f || f.step !== 'pin') fail('FAILSAFE_STEP', 'Start the failsafe again.')
      await checkPin(s, pin)
      const wait = f.target.type === 'practice' ? 10 : s.settings.failsafeWaitSeconds
      f.step = 'cooldown'
      f.cooldownEndsAt = now() + wait * 1000
      return f
    },
    'failsafe.confirm': (s, { confirmation }) => {
      const f = s.failsafe
      if (!f || f.step !== 'cooldown') fail('FAILSAFE_STEP', 'Start the failsafe again.')
      if (now() < f.cooldownEndsAt) fail('COOLDOWN', 'Wait for the timer to finish.', { cooldownEndsAt: f.cooldownEndsAt })
      const reason = checkConfirmation('failsafe', '', confirmation)
      s.failsafe = null
      if (f.target.type === 'practice') {
        s.onboarding.steps.failsafeDryRunDone = true
        return { practice: true }
      }
      if (f.target.type === 'focus') {
        endFocus(s, 'stopped_early', reason)
        log(s, 'failsafe_used', { focusId: f.target.id, reason })
        return { unlocked: 'focus' }
      }
      const rule = getRule(s, f.target.id)
      const block = computeBlocks(s, now()).blocks.find((x) => x.ruleId === rule.id)
      if (!block) return { unlocked: 'nothing' }
      const until = block.until || nextWindowStart(rule, now()) || now() + 24 * 3600_000
      s.overrides = s.overrides.filter((o) => o.until > now())
      s.overrides.push({ ruleId: rule.id, until, at: now() })
      log(s, 'failsafe_used', { ruleId: rule.id, title: rule.name, mode: rule.mode, reason })
      return { unlocked: 'rule', until }
    },
    'failsafe.cancel': (s) => {
      const f = s.failsafe
      s.failsafe = null
      if (!f || f.target.type === 'practice') return null
      // Walking away only earns XP after the PIN (the cooldown step), once per target per day.
      // All focus sessions count as one target, so short sessions can not be looped for XP.
      const id = f.target.type === 'focus' ? 'session' : f.target.id
      const { xp } =
        f.step === 'cooldown'
          ? awardEvent(s.stats, 'failsafe_resisted', `resisted:${f.target.type}:${id}:${dateKey(now())}`, now())
          : { xp: 0 }
      log(s, 'failsafe_resisted', { ruleId: f.target.id, step: f.step, xp })
      return null
    },

    // Settings & data
    'settings.update': async (s, { patch = {}, pin }) => {
      if ('failsafeWaitSeconds' in patch) {
        const v = Math.round(Number(patch.failsafeWaitSeconds))
        if (!(v >= 30 && v <= 300)) fail('VALIDATION', 'Failsafe wait must be 30 seconds to 5 minutes.')
        if (v < s.settings.failsafeWaitSeconds) await checkPin(s, pin)
        s.settings.failsafeWaitSeconds = v
      }
      for (const k of ['weekStartsOn', 'notifications', 'sounds']) if (k in patch) s.settings[k] = patch[k]
      if ('uiMode' in patch) s.settings.uiMode = patch.uiMode === 'minimal' ? 'minimal' : 'game'
      if ('weeklyFocusGoalMin' in patch) {
        const v = Math.round(Number(patch.weeklyFocusGoalMin))
        if (!(v >= 30 && v <= 5000)) fail('VALIDATION', 'Weekly focus goal must be 30 to 5000 minutes.')
        s.settings.weeklyFocusGoalMin = v
      }
      if ('appearance' in patch) {
        const r = mergeAppearance(s.settings.appearance, patch.appearance)
        if (r.error) fail('VALIDATION', r.error)
        s.settings.appearance = r.value
      }
      if ('colorMode' in patch) {
        if (!COLOR_MODES.includes(patch.colorMode)) fail('VALIDATION', 'Colour mode must be light, dark or auto.')
        s.settings.colorMode = patch.colorMode
      }
      if ('lofi' in patch) {
        const r = mergeLofi(s.settings.lofi, patch.lofi, ownsFn(s))
        if (r.error) fail('VALIDATION', r.error)
        s.settings.lofi = r.value
      }
      if (patch.room) {
        const next = sanitizeRoom(patch.room, s.settings.room)
        // only what changes has to be owned, so saved choices always stay
        let earned = null // badges, worked out only when a new badge is placed
        const achieved = {
          has: (id) =>
            (earned ??= new Set(
              computeMilestones(s, now())
                .filter((m) => m.achieved)
                .map((m) => m.id),
            )).has(id),
        }
        const err = roomLockError(next, s.settings.room, ownsFn(s), achieved)
        if (err) fail('VALIDATION', err)
        s.settings.room = next
      }
      return s.settings
    },

    // Tours, tips and notices the person has seen (ui.js). Only adds, never removes.
    'ui.mark': (s, patch) => {
      const r = mergeUi(s.ui, patch)
      if (r.error) fail('VALIDATION', r.error)
      s.ui = r.value
      return s.ui
    },

    // The shop (economy.js): buy with coins, once, for keeps
    'shop.buy': (s, { id }) => {
      const r = canBuy(s, id, progressOf(s).level)
      if (!r.ok) fail(r.code === 'FUNDS' ? 'NOT_ENOUGH_COINS' : 'VALIDATION', r.reason)
      s.shop.purchases.push({ id, price: r.item.price, at: now() })
      log(s, 'shop_purchase', { itemId: id, price: r.item.price })
      return { id, price: r.item.price, balance: coinsOf(s).balance }
    },
    // the starter gift from the welcome card in the room, once
    'shop.gift': (s) => {
      if (s.shop.giftAt) fail('VALIDATION', 'The starter gift is already yours.')
      s.shop.giftAt = now()
      return { coins: COINS.gift, balance: coinsOf(s).balance }
    },
    'agent.configure': async (s, { url, pairCode, pin }) => {
      if (s.agent.token) await checkPin(s, pin)
      if (url) {
        if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(url)) fail('VALIDATION', 'The agent address must be http://127.0.0.1:<port>.')
        s.agent.url = url
      }
      const code =
        String(pairCode || '')
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .match(/.{1,4}/g)
          ?.join('-') || ''
      if (!code) fail('VALIDATION', 'Enter the pairing code the installer printed.')
      s.agent.pairCode = code
      s.agent.lastError = null
      return null
    },
    // called by the extension background after exchanging the pairing code
    'agent.paired': (s, { token }) => {
      if (!/^[a-f0-9]{64}$/.test(String(token))) fail('VALIDATION', 'Bad agent secret.')
      s.agent.token = token
      s.agent.pairCode = null
      s.agent.lastError = null
      return null
    },
    'agent.unpair': async (s, { pin }) => {
      await checkPin(s, pin)
      s.agent.token = null
      s.agent.pairCode = null
      s.agent.lastSyncAt = 0
      return null
    },
    'agent.report': (s, { ok, error, dropPairCode }) => {
      if (ok) {
        s.agent.lastSyncAt = now()
        s.agent.lastError = null
      } else s.agent.lastError = String(error || 'unreachable').slice(0, 200)
      if (dropPairCode) s.agent.pairCode = null
      return null
    },
    'data.export': {
      readonly: true,
      run: (s) => {
        const { security, agent, runtime, failsafe, ...rest } = s
        return { app: 'Regimen', exportedAt: now(), data: structuredClone(rest) }
      },
    },
    'data.import': async (s, { data, pin }) => {
      if (s.security.pin) await checkPin(s, pin)
      if (anyLockedLive(s)) fail('LOCKED', 'A no-failsafe rule is active. Import after it ends.')
      const payload = data?.data || data
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tasks)) fail('VALIDATION', 'That file is not a Regimen export.')
      const next = sanitizeIncoming(payload, { security: s.security, agent: s.agent, onboarding: s.onboarding })
      next.ui = unionUi(s.ui, payload.ui)
      Object.keys(s).forEach((k) => delete s[k])
      Object.assign(s, next)
      log(s, 'data_imported')
      return { tasks: s.tasks.length, rules: s.rules.length, habits: s.habits.length }
    },
    'data.reset': async (s, { pin, confirmation }) => {
      await checkPin(s, pin)
      checkConfirmation('reset_data', '', confirmation)
      if (anyLockedLive(s)) fail('LOCKED', 'A no-failsafe rule is active. Reset after it ends.')
      const fresh = defaultState()
      fresh.createdAt = now()
      Object.keys(s).forEach((k) => delete s[k])
      Object.assign(s, fresh)
      return null
    },

    // Periodic housekeeping (every minute and on wake)
    'system.tick': (s) => {
      const t = now()
      if (s.focus.active && t >= focusEndsAt(s.focus.active)) endFocus(s, 'completed')
      s.overrides = s.overrides.filter((o) => o.until > t)
      if (s.failsafe && t - s.failsafe.startedAt > 30 * 60_000) s.failsafe = null
      for (const task of s.tasks) {
        if (task.status !== 'done' && task.deadline < t && !task.missedLogged) {
          task.missedLogged = true
          log(s, 'missed_deadline', { taskId: task.id, title: task.title, at: task.deadline })
        }
        if (task.recurrence && !task.spawnedNext && task.deadline < t && !task.parentId) spawnNextOccurrence(s, task)
      }
      // window transitions for accountability stats
      const status = s.runtime.ruleStatus
      for (const rule of s.rules) {
        const g = rule.mode === 'gated' ? gatedStatus(s, rule, t) : null
        const cur = g ? g.status : windowAt(rule, t) ? 'active' : 'inactive'
        const prev = status[rule.id]
        // Each window occurrence (rule + the day it started) is logged and paid at most once,
        // so reopening and finishing a task again in the same window earns nothing new.
        const once = (type, windowStart, fields) => {
          const key = `${type}:${rule.id}:${dateKey(windowStart ?? t)}`
          const { fresh, xp } = awardEvent(s.stats, type, key, t)
          if (fresh) log(s, type, { ruleId: rule.id, title: rule.name, xp, ...fields })
        }
        if (prev && prev !== cur) {
          if (g && cur === 'unlocked') once('window_unlocked', g.window.start)
          if (g && prev === 'extended' && cur === 'inactive') once('window_unlocked', previousWindow(rule, t)?.start, { late: true })
          if (rule.mode === 'hard' && prev === 'active' && cur === 'inactive') {
            const used = s.log.some((e) => e.type === 'failsafe_used' && e.ruleId === rule.id && t - e.at < 24 * 3600_000)
            if (!used) once('window_respected', t)
          }
        }
        status[rule.id] = cur
      }
      for (const id of Object.keys(status)) if (!s.rules.some((r) => r.id === id)) delete status[id]
      return null
    },
  }

  async function run(command, payload) {
    const h = handlers[command]
    if (!h) fail('UNKNOWN_COMMAND', `Unknown command: ${command}`)
    await load()
    const fn = typeof h === 'function' ? h : h.run
    if (h.readonly) {
      const data = await fn(state, payload || {})
      return { data, state: publicState(state) }
    }
    const draft = structuredClone(state)
    const before = command === 'system.tick' ? JSON.stringify(state) : null
    const data = await fn(draft, payload || {})
    state = draft
    if (before === null || JSON.stringify(state) !== before) {
      await storage.save(state)
      onChange?.(publicState(state))
    }
    return { data, state: publicState(state) }
  }

  return {
    dispatch(command, payload) {
      const p = queue.then(() => run(command, payload))
      queue = p.catch(() => {})
      return p
    },
    /** Raw state for trusted callers inside the extension (agent sync). */
    async rawState() {
      await load()
      return state
    },
    blocks(at = now()) {
      return computeBlocks(state || defaultState(), at)
    },
    focusPhase: (f) => focusPhase(f, now()),
  }
}

/** Serialisable error shape for message passing. */
export function toErrorPayload(e) {
  return { code: e.code || 'ERROR', message: e.message || String(e), details: e.details }
}
