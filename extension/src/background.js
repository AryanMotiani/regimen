// Regimen background: owns the Backend (all rules + data), turns the current
// block set into declarativeNetRequest rules, redirects already-open tabs, sends
// notifications, and mirrors a snapshot to the optional lock agent.
import { createBackend, toErrorPayload, computeBlocks, hostMatches, BUNDLES } from '@regimen/core'
import { appUrl, isOfficialApp, isDevApp } from './app-url.js'

const ext = globalThis.browser ?? globalThis.chrome
const STORE_KEY = 'r_state'
const ORIGINS_KEY = 'r_approved_origins'
const EXT_ORIGIN = new URL(ext.runtime.getURL('/')).origin

const storage = {
  load: async () => (await ext.storage.local.get(STORE_KEY))[STORE_KEY] ?? null,
  save: (s) => ext.storage.local.set({ [STORE_KEY]: s }),
}
const backend = createBackend({ storage })

// Commands that never change what is blocked
const PASSIVE = new Set([
  'state.get',
  'data.export',
  'agent.report',
  'agent.paired',
  'habits.toggle',
  'habits.create',
  'habits.update',
  'habits.delete',
  'tasks.logTime',
  'settings.update',
  'ui.mark',
])

// ---------------------------------------------------------------- blocking
let applying = Promise.resolve()
let lastBlockKeys = null

function scheduleApply() {
  applying = applying.then(apply).catch((e) => console.error('[Regimen] apply failed', e))
  return applying
}

/**
 * Can we redirect to our blocked page? Redirect rules need host access. Chrome grants it
 * at install, Firefox lets people switch it off ("Access your data for all websites"), and
 * older Firefox builds or some install paths leave it off until the user allows it.
 */
async function hasHostAccess() {
  try {
    return await ext.permissions.contains({ origins: ['<all_urls>'] })
  } catch {
    return true
  }
}

async function apply() {
  const state = await backend.rawState()
  const now = Date.now()
  const { domains, blocks } = computeBlocks(state, now)
  const hostAccess = await hasHostAccess()

  // 1. Network rules: redirect top-level pages, block embedded frames. Without host access a
  // redirect silently does nothing in Firefox, so fall back to a plain block (the browser shows
  // its own "blocked" error page) instead of letting the site load.
  const existing = await ext.declarativeNetRequest.getDynamicRules()
  const addRules = domains.map((d, i) => ({
    id: i + 2,
    priority: 1,
    action: hostAccess ? { type: 'redirect', redirect: { extensionPath: `/blocked.html?d=${encodeURIComponent(d)}` } } : { type: 'block' },
    condition: { requestDomains: [d], resourceTypes: ['main_frame'] },
  }))
  if (domains.length) {
    addRules.push({ id: 1, priority: 1, action: { type: 'block' }, condition: { requestDomains: domains, resourceTypes: ['sub_frame'] } })
  }
  await ext.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules })

  // 2. Tabs that are already open on a now-blocked site.
  if (domains.length) {
    const tabs = await ext.tabs.query({})
    for (const tab of tabs) {
      if (!tab.url || !/^https?:/.test(tab.url)) continue
      let host
      try {
        host = new URL(tab.url).hostname
      } catch {
        continue
      }
      const d = domains.find((x) => hostMatches(host, x))
      if (d) ext.tabs.update(tab.id, { url: ext.runtime.getURL(`blocked.html?d=${encodeURIComponent(d)}`) }).catch(() => {})
    }
  }

  // 3. Badge + transition notifications (remember across service-worker restarts).
  if (lastBlockKeys === null) lastBlockKeys = new Set((await ext.storage.session?.get('r_keys').catch(() => ({})))?.r_keys || [])
  const keys = new Set(blocks.map((b) => b.ruleId || b.focusId))
  // "!" in red: the extension can not show its blocked page (see hasHostAccess)
  ext.action.setBadgeText({ text: !hostAccess ? '!' : blocks.length ? String(blocks.length) : '' })
  ext.action.setBadgeBackgroundColor?.({ color: hostAccess ? '#6d5dfc' : '#d93a3a' })
  if (state.settings.notifications && state.onboarding.completed) {
    for (const b of blocks) if (!lastBlockKeys.has(b.ruleId || b.focusId)) notify(`${b.name} started`, describeBlock(b))
    for (const k of lastBlockKeys) {
      if (!keys.has(k)) {
        const rule = state.rules.find((r) => r.id === k)
        if (rule) notify(`${rule.name} ended`, 'Those sites are open again.')
      }
    }
  }
  lastBlockKeys = keys
  ext.storage.session?.set({ r_keys: [...keys] }).catch?.(() => {})

  // 4. Mirror to the lock agent (if paired).
  syncAgent(state).catch(() => {})
}

function describeBlock(b) {
  if (b.kind === 'gated') return `Finish ${b.pendingTaskIds.length || 'your'} task${b.pendingTaskIds.length === 1 ? '' : 's'} to unlock.`
  if (b.kind === 'focus') return 'Focus session running. You got this.'
  return 'Hard block until ' + new Date(b.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function notify(title, message) {
  ext.notifications
    ?.create({ type: 'basic', iconUrl: ext.runtime.getURL('icons/icon-128.png'), title: 'Regimen: ' + title, message })
    .catch?.(() => {})
}

// ---------------------------------------------------------------- lock agent
let lastAgentOk = null
let lastAgentSentAt = 0

function agentSnapshot(state, empty = false) {
  // strictly increasing so the agent can drop out-of-order requests
  lastAgentSentAt = Math.max(Date.now(), lastAgentSentAt + 1)
  if (empty) return { sentAt: lastAgentSentAt, rules: [], tasks: [], overrides: [], focus: { active: null }, customSites: [] }
  return {
    sentAt: lastAgentSentAt,
    rules: state.rules,
    tasks: state.tasks.map(({ id, ruleId, parentId, status, completedAt, createdAt, startAt, forwardedUntil, deadline }) => ({
      id,
      ruleId,
      parentId,
      status,
      completedAt,
      createdAt,
      startAt,
      forwardedUntil,
      deadline,
    })),
    overrides: state.overrides,
    focus: { active: state.focus.active },
    customSites: state.customSites,
  }
}

async function postAgent(url, path, body, token) {
  const res = await fetch(url + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data }
}

async function syncAgent(state) {
  const { token, url, pairCode } = state.agent
  if (!token && pairCode) {
    try {
      const r = await postAgent(url, '/v1/pair', { code: pairCode })
      if (r.ok) {
        await backend.dispatch('agent.paired', { token: r.data.secret })
        return syncAgent(await backend.rawState())
      }
      await backend.dispatch('agent.report', {
        ok: false,
        error: r.data.error || `HTTP ${r.status}`,
        dropPairCode: r.status === 401 || r.status === 409,
      })
    } catch {
      if (state.agent.lastError !== 'Agent not reachable')
        await backend.dispatch('agent.report', { ok: false, error: 'Agent not reachable' })
    }
    return
  }
  if (!token) return
  let ok = false
  let error = null
  try {
    const r = await postAgent(url, '/v1/sync', agentSnapshot(state), token)
    ok = r.ok
    if (!ok) error = r.data.error || `HTTP ${r.status}`
  } catch {
    error = 'Agent not reachable'
  }
  const stale = Date.now() - (state.agent.lastSyncAt || 0) > 10 * 60_000
  if (ok !== lastAgentOk || (ok && stale) || (!ok && state.agent.lastError !== error)) {
    lastAgentOk = ok
    await backend.dispatch('agent.report', { ok, error })
  }
}

// ---------------------------------------------------------------- messaging
async function approvedOrigins() {
  return (await ext.storage.local.get(ORIGINS_KEY))[ORIGINS_KEY] || []
}

// A local copy of the app (localhost, for development) asked to connect. We never pop up a
// window for it; the request waits in the toolbar popup until the user allows it. The official
// hosted app does not ask: it is trusted by its exact origin and path (see app-url.js).
async function requestApproval(origin) {
  const list = new Set((await ext.storage.session.get('r_pending_origins')).r_pending_origins || [])
  if (list.has(origin)) return
  list.add(origin)
  await ext.storage.session.set({ r_pending_origins: [...list].slice(-5) })
  ext.action.setBadgeText({ text: '?' })
}

async function runCommand(cmd, payload) {
  try {
    if (cmd === 'agent.unpair' || cmd === 'data.reset') {
      // verify first (throws on wrong PIN), then release the agent, then apply
      const state = await backend.rawState()
      const saved = { url: state.agent.url, token: state.agent.token }
      const res = await backend.dispatch(cmd, payload)
      if (saved.token) postAgent(saved.url, '/v1/sync', agentSnapshot(null, true), saved.token).catch(() => {})
      await scheduleApply()
      return { ok: true, data: res.data, state: res.state, now: Date.now() }
    }
    const res = await backend.dispatch(cmd, payload)
    if (!PASSIVE.has(cmd)) await scheduleApply()
    return { ok: true, data: res.data, state: res.state, now: Date.now() }
  } catch (e) {
    return { ok: false, error: toErrorPayload(e) }
  }
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  ;(async () => {
    const fromExtensionPage = sender.id === ext.runtime.id && sender.url && new URL(sender.url).origin === EXT_ORIGIN
    if (msg?.type === 'fg' && fromExtensionPage) return runCommand(msg.cmd, msg.payload)
    if (msg?.type === 'fg-meta' && fromExtensionPage) {
      if (msg.action === 'approve') {
        const list = new Set(await approvedOrigins())
        if (msg.allow) list.add(msg.origin)
        else list.delete(msg.origin)
        await ext.storage.local.set({ [ORIGINS_KEY]: [...list] })
        const pending = ((await ext.storage.session.get('r_pending_origins')).r_pending_origins || []).filter((o) => o !== msg.origin)
        await ext.storage.session.set({ r_pending_origins: pending })
        scheduleApply()
        return { ok: true }
      }
      if (msg.action === 'origins') return { ok: true, data: await approvedOrigins() }
      if (msg.action === 'pending') return { ok: true, data: (await ext.storage.session.get('r_pending_origins')).r_pending_origins || [] }
      if (msg.action === 'bundles') return { ok: true, data: BUNDLES }
      if (msg.action === 'permissions') {
        const incognito = await ext.extension.isAllowedIncognitoAccess?.().catch?.(() => null)
        return { ok: true, data: { hostAccess: await hasHostAccess(), incognito: incognito ?? null } }
      }
    }
    if (msg?.type === 'fg-bridge' && sender.id === ext.runtime.id && sender.url) {
      // the bridge only runs on these (manifest matches + bridge.js), checked here once more
      const official = isOfficialApp(sender.url)
      if (!official && !isDevApp(sender.url)) return { ok: false, error: { code: 'FORBIDDEN', message: 'Not the Regimen app.' } }
      const origin = new URL(sender.url).origin
      const approved = official || (await approvedOrigins()).includes(origin)
      if (msg.cmd === 'hello') {
        if (!approved) await requestApproval(origin)
        return { ok: true, data: { approved, version: ext.runtime.getManifest().version, hostAccess: await hasHostAccess() } }
      }
      if (!approved) return { ok: false, error: { code: 'NOT_APPROVED', message: 'Approve this site in the Regimen extension first.' } }
      return runCommand(msg.cmd, msg.payload)
    }
    return { ok: false, error: { code: 'FORBIDDEN', message: 'Unknown sender.' } }
  })().then(sendResponse)
  return true // async response
})

// ---------------------------------------------------------------- lifecycle
async function tick() {
  try {
    await backend.dispatch('system.tick')
  } catch (e) {
    console.error(e)
  }
  await scheduleApply()
}

// Access switched on or off in the browser's extension settings: rebuild the rules now.
ext.permissions.onAdded?.addListener(() => scheduleApply())
ext.permissions.onRemoved?.addListener(() => scheduleApply())

ext.alarms.create('fg-tick', { periodInMinutes: 0.5 })
ext.alarms.onAlarm.addListener((a) => a.name === 'fg-tick' && tick())
ext.runtime.onStartup.addListener(tick)
ext.runtime.onInstalled.addListener(async (details) => {
  await tick()
  // Firefox may install us without access to websites. Ask right away, from our own page,
  // because permission prompts need a click and blocking does nothing without it.
  if (!(await hasHostAccess())) ext.tabs.create({ url: ext.runtime.getURL('grant.html') }).catch(() => {})
  if (details.reason === 'install') {
    // Came from a Regimen website tab? Reload it (content scripts are not injected
    // into pages that were open before install) and send the user back there, so a setup
    // done on the website carries over instead of starting the tutorial again.
    const tabs = await ext.tabs.query({ url: ['http://*/*', 'https://*/*'] }).catch(() => [])
    const appTab = tabs.find(
      (t) =>
        (isOfficialApp(t.url) || isDevApp(t.url)) &&
        (/(^| · )Regimen($|:)/.test(t.title || '') || /Regimen: study without the scroll/.test(t.title || '')),
    )
    if (appTab) {
      await ext.tabs.reload(appTab.id).catch(() => {})
      await ext.tabs.update(appTab.id, { active: true }).catch(() => {})
      if (appTab.windowId != null) ext.windows?.update(appTab.windowId, { focused: true }).catch(() => {})
    } else {
      // the hosted app when online (always the newest version), the bundled copy when not
      ext.tabs.create({ url: await appUrl('/welcome') })
    }
  }
})
ext.action.onClicked?.addListener?.(() => {})
tick()
