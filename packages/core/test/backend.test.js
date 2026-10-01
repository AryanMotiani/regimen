import { describe, it, expect, beforeEach } from 'vitest'
import { createBackend } from '../src/backend.js'
import { computeBlocks } from '../src/engine.js'

const at = (d, hh, mm = 0) => new Date(2026, 8, d, hh, mm).getTime() // 21 = Monday
const PIN = '246810'

function memoryStorage() {
  let saved = null
  return {
    load: async () => (saved ? structuredClone(saved) : null),
    save: async (s) => {
      saved = structuredClone(s)
    },
    peek: () => saved,
  }
}

let clock, be, storage
async function fresh(start = at(21, 8)) {
  clock = start
  storage = memoryStorage()
  be = createBackend({ storage, now: () => clock, hashIterations: 1000 })
  const r = await be.dispatch('setup.pin', { pin: PIN })
  return r.data.recoveryCode
}
const expectCode = async (p, code) => {
  await expect(p).rejects.toMatchObject({ code })
}
const reason = 'I really need this for a class project'

describe('setup and security', () => {
  it('returns a recovery code once and never exposes hashes', async () => {
    const code = await fresh()
    expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/)
    const { state } = await be.dispatch('state.get')
    expect(state.security).toEqual({ hasPin: true, recoveryUsed: false, lockedUntil: 0 })
    expect(JSON.stringify(state)).not.toContain('salt')
    await expectCode(be.dispatch('setup.pin', { pin: '999999' }), 'PIN_EXISTS')
  })

  it('locks the PIN after 5 wrong attempts, and the counter survives failures', async () => {
    await fresh()
    for (let i = 0; i < 4; i++) await expectCode(be.dispatch('security.changePin', { oldPin: 'nope00', newPin: '111111' }), 'PIN_INCORRECT')
    await expectCode(be.dispatch('security.changePin', { oldPin: 'nope00', newPin: '111111' }), 'PIN_INCORRECT')
    await expectCode(be.dispatch('security.changePin', { oldPin: PIN, newPin: '111111' }), 'PIN_LOCKED')
    clock += 6 * 60_000
    await be.dispatch('security.changePin', { oldPin: PIN, newPin: '111111' })
  })

  it('recovery code resets the PIN and issues a new code', async () => {
    const code = await fresh()
    const r = await be.dispatch('security.recover', { code: code.toLowerCase().replace(/-/g, ''), newPin: '135791' })
    expect(r.data.recoveryCode).not.toBe(code)
    await expectCode(be.dispatch('security.recover', { code, newPin: '135791' }), 'RECOVERY_INCORRECT')
    await be.dispatch('security.changePin', { oldPin: '135791', newPin: '222222' })
  })
})

describe('rules', () => {
  beforeEach(() => fresh())
  const hardInput = { name: 'Mornings', mode: 'hard', siteIds: ['youtube'], days: [1, 2, 3, 4, 5], start: 540, end: 720 }

  it('refuses a task-gated window with no tasks', async () => {
    await expectCode(be.dispatch('rules.create', { ...hardInput, mode: 'gated' }), 'EMPTY_WINDOW')
  })

  it('creates a task-gated window together with its tasks', async () => {
    const r = await be.dispatch('rules.create', { ...hardInput, mode: 'gated', newTasks: [{ title: 'Read ch. 4', deadline: at(21, 23) }] })
    expect(r.state.tasks[0]).toMatchObject({ ruleId: r.data.id, title: 'Read ch. 4', priority: 'medium' })
  })

  it('prevents hard and gated rules overlapping on the same site', async () => {
    const h = await be.dispatch('rules.create', hardInput)
    await expectCode(
      be.dispatch('rules.create', { ...hardInput, mode: 'gated', start: 600, end: 800, newTasks: [{ title: 'x', deadline: at(22, 0) }] }),
      'CONFLICT',
    )
    try {
      await be.dispatch('rules.create', {
        ...hardInput,
        mode: 'gated',
        start: 600,
        end: 800,
        newTasks: [{ title: 'x', deadline: at(22, 0) }],
      })
    } catch (e) {
      expect(e.details.conflictRuleId).toBe(h.data.id)
    }
    // same mode overlap is fine, different site is fine
    await be.dispatch('rules.create', { ...hardInput, start: 600 })
    await be.dispatch('rules.create', { ...hardInput, siteIds: ['reddit'], mode: 'gated', newTasks: [{ title: 'x', deadline: at(22, 0) }] })
  })

  it('needs the PIN to edit a live rule but not an inactive one', async () => {
    const { data: rule } = await be.dispatch('rules.create', hardInput)
    await be.dispatch('rules.update', { id: rule.id, patch: { end: 700 } }) // 08:00, inactive
    clock = at(21, 10)
    await expectCode(be.dispatch('rules.update', { id: rule.id, patch: { end: 660 } }), 'PIN_REQUIRED')
    const r = await be.dispatch('rules.update', { id: rule.id, patch: { end: 660 }, pin: PIN })
    expect(r.data.end).toBe(660)
    expect(r.state.log.some((e) => e.type === 'rule_edited_active')).toBe(true)
  })

  it('always needs the PIN to delete, and a live no-failsafe rule cannot be touched', async () => {
    const { data: rule } = await be.dispatch('rules.create', { ...hardInput, failsafe: false })
    await expectCode(be.dispatch('rules.delete', { id: rule.id }), 'PIN_REQUIRED')
    clock = at(21, 10)
    await expectCode(be.dispatch('rules.delete', { id: rule.id, pin: PIN }), 'LOCKED')
    await expectCode(be.dispatch('rules.update', { id: rule.id, patch: { end: 600 }, pin: PIN }), 'LOCKED')
    clock = at(21, 13)
    await be.dispatch('rules.delete', { id: rule.id, pin: PIN })
  })
})

describe('tasks', () => {
  beforeEach(() => fresh())

  it('easing edits need a typed reason, tightening edits get praise', async () => {
    const { data: t } = await be.dispatch('tasks.create', { title: 'Essay', deadline: at(22, 12), priority: 'medium' })
    await expectCode(be.dispatch('tasks.update', { id: t.id, patch: { deadline: at(23, 12) } }), 'CONFIRMATION_REQUIRED')
    await expectCode(
      be.dispatch('tasks.update', { id: t.id, patch: { deadline: at(23, 12) }, confirmation: 'I want to make "Essay" easier because' }),
      'CONFIRMATION_REQUIRED',
    )
    const eased = await be.dispatch('tasks.update', {
      id: t.id,
      patch: { deadline: at(23, 12) },
      confirmation: `I want to make "Essay" easier because ${reason}`,
    })
    expect(eased.data.praise).toBe(false)
    expect(eased.state.log.at(-1)).toMatchObject({ type: 'deadline_delayed', reason })
    const tight = await be.dispatch('tasks.update', { id: t.id, patch: { priority: 'high' } })
    expect(tight.data.praise).toBe(true)
  })

  it('subtasks inherit, cannot be later or lower than the parent', async () => {
    const { data: p } = await be.dispatch('tasks.create', { title: 'Project', deadline: at(25, 12), priority: 'high' })
    const { data: s } = await be.dispatch('tasks.create', { title: 'Outline', parentId: p.id })
    expect(s).toMatchObject({ priority: 'high', deadline: at(25, 12) })
    await expectCode(be.dispatch('tasks.create', { title: 'Late', parentId: p.id, deadline: at(26, 12) }), 'VALIDATION')
    await expectCode(be.dispatch('tasks.create', { title: 'Low', parentId: p.id, priority: 'low' }), 'VALIDATION')
    await expectCode(be.dispatch('tasks.complete', { id: p.id }), 'SUBTASKS_OPEN')
    await be.dispatch('tasks.complete', { id: s.id })
    await be.dispatch('tasks.complete', { id: p.id })
  })

  it('deleting needs the typed sentence and removes subtasks', async () => {
    const { data: p } = await be.dispatch('tasks.create', { title: 'Project', deadline: at(25, 12) })
    await be.dispatch('tasks.create', { title: 'Sub', parentId: p.id })
    await expectCode(be.dispatch('tasks.delete', { id: p.id }), 'CONFIRMATION_REQUIRED')
    const r = await be.dispatch('tasks.delete', { id: p.id, confirmation: `I want to delete "Project" because ${reason}` })
    expect(r.state.tasks).toHaveLength(0)
  })

  it('forward limits depend on priority', async () => {
    const { data: rule } = await be.dispatch('rules.create', {
      mode: 'gated',
      siteIds: ['instagram'],
      days: [1, 2, 3, 4, 5],
      start: 840,
      end: 1020,
      newTasks: [{ title: 'Hard one', priority: 'high', deadline: at(25, 23) }],
    })
    const id = (await be.dispatch('state.get')).state.tasks[0].id
    clock = at(21, 15)
    const f = await be.dispatch('tasks.forward', { id })
    expect(f.data.color).toBe('red')
    expect(f.data.task.forwardedUntil).toBe(at(22, 14))
    await expectCode(be.dispatch('tasks.forward', { id }), 'FORWARD_LIMIT')
    expect(rule.id).toBeTruthy()
  })

  it('completing a recurring task spawns the next one that does not unlock today', async () => {
    await be.dispatch('rules.create', {
      mode: 'gated',
      siteIds: ['instagram'],
      days: [1, 2, 3, 4, 5, 6, 7],
      start: 840,
      end: 1020,
      newTasks: [{ title: 'Anki', deadline: at(21, 23), recurrence: { type: 'daily' } }],
    })
    clock = at(21, 15)
    const id = (await be.dispatch('state.get')).state.tasks[0].id
    const r = await be.dispatch('tasks.complete', { id })
    expect(r.data.next).toMatchObject({ title: 'Anki', status: 'todo', deadline: at(22, 23), startAt: at(22, 14) })
    const s = await storage.peek()
    expect(computeBlocks(s, at(21, 15, 30)).domains).toEqual([]) // unlocked today
    expect(computeBlocks(s, at(22, 15)).domains).toContain('instagram.com') // blocked tomorrow
  })
})

describe('failsafe', () => {
  let ruleId
  beforeEach(async () => {
    await fresh()
    ruleId = (await be.dispatch('rules.create', { name: 'YT', mode: 'hard', siteIds: ['youtube'], days: [1], start: 540, end: 720 })).data
      .id
    clock = at(21, 10)
  })

  it('walks intent -> pin -> cooldown -> typed confirm and lifts only this window', async () => {
    await be.dispatch('failsafe.start', { target: { type: 'rule', id: ruleId } })
    await expectCode(be.dispatch('failsafe.pin', { pin: PIN }), 'FAILSAFE_STEP')
    await be.dispatch('failsafe.continue')
    const c = await be.dispatch('failsafe.pin', { pin: PIN })
    expect(c.data.cooldownEndsAt).toBe(clock + 60_000)
    await expectCode(be.dispatch('failsafe.confirm', { confirmation: `I want to break my own rule because ${reason}` }), 'COOLDOWN')
    clock += 61_000
    const r = await be.dispatch('failsafe.confirm', { confirmation: `I want to break my own rule because ${reason}` })
    expect(r.data).toMatchObject({ unlocked: 'rule', until: at(21, 12) })
    const s = await storage.peek()
    expect(computeBlocks(s, clock).domains).toEqual([])
    expect(computeBlocks(s, at(28, 10)).domains).toContain('youtube.com') // next week enforced again
  })

  it('is refused for rules without failsafe', async () => {
    clock = at(21, 8)
    const { data } = await be.dispatch('rules.create', {
      mode: 'hard',
      siteIds: ['reddit'],
      days: [1],
      start: 540,
      end: 720,
      failsafe: false,
    })
    clock = at(21, 10)
    await expectCode(be.dispatch('failsafe.start', { target: { type: 'rule', id: data.id } }), 'NO_FAILSAFE')
  })

  it('cancelling logs a resisted temptation', async () => {
    await be.dispatch('failsafe.start', { target: { type: 'rule', id: ruleId } })
    const r = await be.dispatch('failsafe.cancel')
    expect(r.state.log.at(-1).type).toBe('failsafe_resisted')
  })
})

describe('focus mode', () => {
  beforeEach(() => fresh(at(21, 20)))

  it('blocks for the session, needs a typed reason to stop early', async () => {
    await be.dispatch('focus.start', { workMin: 25, breakMin: 5, iterations: 2, siteIds: ['reddit'] })
    clock = at(21, 20, 27) // in the break
    expect(be.blocks().domains).toContain('reddit.com')
    await expectCode(be.dispatch('focus.stop', {}), 'CONFIRMATION_REQUIRED')
    const r = await be.dispatch('focus.stop', { confirmation: `I want to stop this focus session because ${reason}` })
    expect(r.state.focus.history[0]).toMatchObject({ status: 'stopped_early', focusedMin: 25 })
  })

  it('completes naturally on tick', async () => {
    await be.dispatch('focus.start', { workMin: 25, breakMin: 5, iterations: 2, siteIds: ['reddit'] })
    clock = at(21, 21)
    const r = await be.dispatch('system.tick')
    expect(r.state.focus.active).toBeNull()
    expect(r.state.focus.history[0]).toMatchObject({ status: 'completed', focusedMin: 50 })
  })
})

describe('habits', () => {
  beforeEach(() => fresh())
  it('toggles today and refuses the future', async () => {
    const { data: h } = await be.dispatch('habits.create', { name: 'Drink water' })
    const r = await be.dispatch('habits.toggle', { id: h.id })
    expect(r.data.done).toBe(true)
    await expectCode(be.dispatch('habits.toggle', { id: h.id, date: '2026-09-22' }), 'VALIDATION')
  })
})

describe('export / import', () => {
  it('round-trips data without secrets and keeps the PIN', async () => {
    await fresh()
    await be.dispatch('tasks.create', { title: 'Keep me', deadline: at(25, 12) })
    const { data: dump } = await be.dispatch('data.export')
    expect(JSON.stringify(dump)).not.toContain('salt')
    await be.dispatch('data.reset', { pin: PIN, confirmation: `I want to permanently delete all my data because ${reason}` })
    await be.dispatch('setup.pin', { pin: PIN })
    const r = await be.dispatch('data.import', { data: dump, pin: PIN })
    expect(r.data.tasks).toBe(1)
    expect(r.state.security.hasPin).toBe(true)
  })

  it('imports a backup made before the rename (app: FocusGateway)', async () => {
    await fresh()
    await be.dispatch('tasks.create', { title: 'From FocusGateway', deadline: at(25, 12) })
    const { data: dump } = await be.dispatch('data.export')
    expect(dump.app).toBe('Regimen')
    const old = { ...dump, app: 'FocusGateway' }
    await be.dispatch('data.reset', { pin: PIN, confirmation: `I want to permanently delete all my data because ${reason}` })
    await be.dispatch('setup.pin', { pin: PIN })
    const r = await be.dispatch('data.import', { data: old, pin: PIN })
    expect(r.data.tasks).toBe(1)
    expect(r.state.tasks[0].title).toBe('From FocusGateway')
  })
})

describe('loophole regressions', () => {
  beforeEach(() => fresh())
  const win = { mode: 'gated', siteIds: ['instagram'], days: [1, 2, 3, 4, 5, 6, 7], start: 840, end: 1020 }

  it('cannot steal a pending task from a live window, or gate a window with done tasks', async () => {
    const { data: a } = await be.dispatch('rules.create', { ...win, newTasks: [{ title: 'T2', deadline: at(21, 23) }] })
    const t2 = (await be.dispatch('state.get')).state.tasks[0]
    await expectCode(be.dispatch('rules.create', { ...win, siteIds: ['reddit'], taskIds: [t2.id] }), 'VALIDATION')
    const { data: done } = await be.dispatch('tasks.create', { title: 'old', deadline: at(21, 23) })
    await be.dispatch('tasks.complete', { id: done.id })
    await expectCode(be.dispatch('rules.create', { ...win, siteIds: ['reddit'], taskIds: [done.id] }), 'VALIDATION')
    expect(a.id).toBeTruthy()
  })

  it('pushing the start of a gated task later needs a typed reason', async () => {
    await be.dispatch('rules.create', { ...win, newTasks: [{ title: 'Essay', deadline: at(25, 23) }] })
    const t = (await be.dispatch('state.get')).state.tasks[0]
    clock = at(21, 15)
    await expectCode(be.dispatch('tasks.update', { id: t.id, patch: { startAt: at(24, 0) } }), 'CONFIRMATION_REQUIRED')
  })

  it('finishing a recurring gated task unlocks the window and does not extend it', async () => {
    await be.dispatch('rules.create', {
      ...win,
      start: 900,
      end: 1080,
      newTasks: [{ title: 'Daily', deadline: at(21, 17), recurrence: { type: 'daily' } }],
    })
    clock = at(21, 16)
    const t = (await be.dispatch('state.get')).state.tasks[0]
    await be.dispatch('tasks.complete', { id: t.id })
    const s = storage.peek()
    expect(computeBlocks(s, at(21, 16, 30)).domains).toEqual([])
    expect(computeBlocks(s, at(21, 19)).domains).toEqual([])
    expect(computeBlocks(s, at(22, 16)).domains).toContain('instagram.com')
  })

  it('import drops overrides and failsafe state and skips broken rules', async () => {
    const dump = {
      data: {
        tasks: [],
        rules: [
          { id: 'x', mode: 'hard', siteIds: ['youtube'] },
          { id: 'y', mode: 'hard', siteIds: ['youtube'], days: [1], start: 60, end: 120 },
        ],
        overrides: [{ ruleId: 'y', until: 9e15 }],
        failsafe: { step: 'cooldown', cooldownEndsAt: 0 },
      },
    }
    await expectCode(be.dispatch('data.import', { data: dump, pin: PIN }), 'VALIDATION')
    dump.data.rules.shift()
    const r = await be.dispatch('data.import', { data: dump, pin: PIN })
    expect(r.state.overrides).toEqual([])
    expect(r.state.failsafe).toBeNull()
    expect(r.state.rules).toHaveLength(1)
  })
})

describe('adopting a setup made before the extension was installed', () => {
  async function standaloneSetup() {
    const s = memoryStorage()
    const local = createBackend({ storage: s, now: () => clock, hashIterations: 1000 })
    await local.dispatch('setup.pin', { pin: PIN })
    await local.dispatch('setup.step', { step: 'recoverySaved' })
    await local.dispatch('failsafe.start', { target: { type: 'practice' } })
    await local.dispatch('failsafe.continue')
    await local.dispatch('failsafe.pin', { pin: PIN })
    clock += 11_000
    await local.dispatch('failsafe.confirm', { confirmation: `I want to break my own rule because ${reason}` })
    await local.dispatch('rules.create', {
      name: 'Study',
      mode: 'gated',
      siteIds: ['instagram'],
      days: [1],
      start: 840,
      end: 1020,
      newTasks: [{ title: 'Essay', deadline: at(25, 12) }],
    })
    await local.dispatch('setup.complete')
    return s.peek()
  }

  it('moves PIN, onboarding and data into a fresh extension, no second tutorial', async () => {
    clock = at(21, 8)
    const saved = await standaloneSetup()
    const ext = createBackend({ storage: memoryStorage(), now: () => clock, hashIterations: 1000 })
    const r = await ext.dispatch('setup.adopt', { state: saved })
    expect(r.state.onboarding.completed).toBe(true)
    expect(r.state.security.hasPin).toBe(true)
    expect(r.state.rules).toHaveLength(1)
    expect(r.state.tasks[0].title).toBe('Essay')
    // the same PIN works in the extension
    await ext.dispatch('security.changePin', { oldPin: PIN, newPin: '135791' })
  })

  it('refuses to overwrite an extension that is already set up', async () => {
    clock = at(21, 8)
    const saved = await standaloneSetup()
    await fresh()
    await expectCode(be.dispatch('setup.adopt', { state: saved }), 'NOT_FRESH')
  })

  it('never carries over overrides, a half-finished failsafe or a malformed PIN record', async () => {
    clock = at(21, 8)
    const saved = await standaloneSetup()
    const ext = createBackend({ storage: memoryStorage(), now: () => clock, hashIterations: 1000 })
    const r = await ext.dispatch('setup.adopt', {
      state: { ...saved, overrides: [{ ruleId: saved.rules[0].id, until: 9e15 }], failsafe: { step: 'cooldown', cooldownEndsAt: 0 } },
    })
    expect(r.state.overrides).toEqual([])
    expect(r.state.failsafe).toBeNull()
    const ext2 = createBackend({ storage: memoryStorage(), now: () => clock, hashIterations: 1000 })
    await expectCode(ext2.dispatch('setup.adopt', { state: { ...saved, security: { pin: { salt: 'zz', hash: 1 } } } }), 'VALIDATION')
  })
})
