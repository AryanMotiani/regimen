import { reactive, computed, ref } from 'vue'
import { computeBlocks, allSites, focusEndsAt, isOlderVersion } from '@regimen/core'
import { connect, createLocalAdapter, readLocalState, clearLocalData, extensionPresent } from './api.js'

export const store = reactive({
  ready: false,
  mode: 'local', // 'extension' | 'bridge' | 'local'
  pendingApproval: false,
  state: null,
  now: Date.now(),
  // the same clock at minute resolution, for day-level data (streaks, grids, badges) that
  // should not recompute every second
  minute: Math.floor(Date.now() / 60_000) * 60_000,
  clockOffset: 0,
  toasts: [],
  // can blocking actually work here? see checkHealth and blockingIssue
  // version: the extension's version from its hello answer (bridge mode), see extensionOutdated
  health: { extension: false, hostAccess: null, incognito: null, version: null },
})

/** This web app's version (root package.json, injected by vite.config.js). */
export const APP_VERSION = typeof __R_VERSION__ === 'string' ? __R_VERSION__ : null

let adapter = null

export class ApiError extends Error {
  constructor(e) {
    super(e?.message || 'Something went wrong.')
    this.code = e?.code
    this.details = e?.details
  }
}

export async function call(cmd, payload) {
  const res = await adapter.call(cmd, payload)
  if (!res || !res.ok) throw new ApiError(res?.error)
  if (res.state) store.state = res.state
  if (res.now) store.clockOffset = res.now - Date.now()
  return res.data
}

export async function refresh() {
  if (!adapter) return
  try {
    await call('state.get')
  } catch (e) {
    console.warn(e)
  }
}

let markBooted
/** Settles once init() has finished (or failed): the state is in, or never will be. */
export const booted = new Promise((resolve) => (markBooted = resolve))

export async function init() {
  try {
    await start()
  } finally {
    markBooted()
  }
}

async function start() {
  adapter = await connect()
  store.mode = adapter.mode
  if (adapter.hostAccess != null) store.health.hostAccess = adapter.hostAccess
  if (adapter.version) store.health.version = adapter.version
  store.health.extension = adapter.mode !== 'local' || extensionPresent()
  if (adapter.mode === 'bridge' && !adapter.approved) {
    store.pendingApproval = true
    pollApproval()
  }
  await refresh()
  await adoptLocalSetup()
  store.ready = true
  setInterval(() => {
    store.now = Date.now() + store.clockOffset
    const minute = Math.floor(store.now / 60_000) * 60_000
    if (minute !== store.minute) store.minute = minute
  }, 1000)
  // Local mode has no background worker, so run housekeeping from the page.
  setInterval(() => (adapter.mode === 'local' ? call('system.tick').catch(() => {}) : refresh()), 30_000)
  checkHealth()
  setInterval(checkHealth, 30_000)
  window.addEventListener('focus', checkHealth)
  setInterval(() => adapter.mode !== 'local' && store.state && !store.state.onboarding.completed && refresh(), 3000)
  if (adapter.mode === 'local') call('system.tick').catch(() => {})
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && refresh())
  window.addEventListener('focus', refresh)
}

const wantedHash = location.hash
async function pollApproval() {
  while (store.pendingApproval) {
    await new Promise((r) => setTimeout(r, 2000))
    await checkApproval()
  }
}

/** Asks the extension right now whether this site was approved ("Check again"). */
export async function checkApproval() {
  if (!store.pendingApproval || adapter?.mode !== 'bridge') return false
  const hello = await adapter.call('hello')
  if (!(hello?.ok && hello.data.approved) || !store.pendingApproval) return false
  store.pendingApproval = false
  if (hello.data.version) store.health.version = hello.data.version
  await refresh()
  await adoptLocalSetup()
  checkHealth()
  location.hash = wantedHash && wantedHash !== '#/home' ? wantedHash : '#/'
  return true
}

/**
 * Someone set up Regimen on the website first (PIN, tutorial, maybe rules),
 * then installed the extension. Hand that setup to the extension once, so the
 * tutorial never runs twice. Only happens while the extension is still empty.
 */
async function adoptLocalSetup() {
  if (store.mode === 'local' || !store.state) return
  const local = readLocalState()
  if (!local?.security?.pin) return
  const ext = store.state
  const fresh = !ext.security.hasPin && !ext.onboarding.completed && !ext.rules.length && !ext.tasks.length
  if (!fresh) return // Settings offers "Move my data" for this case
  try {
    await call('setup.adopt', { state: local })
    clearLocalData()
    toast('Your setup moved into the extension. Blocking is on.', 'success')
  } catch (e) {
    console.warn('Could not move the local setup', e)
  }
}

/**
 * Re-checks what could stop blocking from working: no extension, this site not approved,
 * or no host access (Firefox can install extensions without it, and people can switch it off).
 */
export async function checkHealth() {
  if (!adapter) return
  store.health.extension = adapter.mode !== 'local' || extensionPresent()
  try {
    if (adapter.mode === 'extension') {
      const r = await adapter.meta('permissions')
      if (r?.ok) Object.assign(store.health, { hostAccess: r.data.hostAccess, incognito: r.data.incognito })
    } else if (adapter.mode === 'bridge' && !store.pendingApproval) {
      const r = await adapter.call('hello')
      if (r?.ok && r.data.hostAccess != null) store.health.hostAccess = r.data.hostAccess
      if (r?.ok && r.data.version) store.health.version = r.data.version
    }
  } catch {}
}

/**
 * Why blocking is not working in this browser right now, or null when it should work.
 *  no-extension  local mode, no extension found
 *  not-approved  the extension is installed but this site is not connected to it
 *  no-access     the extension can not touch websites (host permission missing)
 */
export const blockingIssue = computed(() => {
  if (!store.ready) return null
  if (store.mode === 'local') return store.health.extension ? 'not-approved' : 'no-extension'
  if (store.health.hostAccess === false) return 'no-access'
  return null
})

/**
 * The connected extension is older than this web app (bridge mode only: inside the
 * extension the app ships with it). Blocking still works, newer features may not.
 */
export const extensionOutdated = computed(
  () => store.ready && store.mode === 'bridge' && !store.pendingApproval && isOlderVersion(store.health.version, APP_VERSION),
)

/** A focus session is running right now. */
export function sessionRunning() {
  const f = store.state?.focus?.active
  return !!f && Date.now() + store.clockOffset < focusEndsAt(f)
}

/** The sites picked for the next focus session, shared by every focus card (Today, Blocking, room). */
export const focusDraft = ref(null)

/** Asks the extension (from its own pages) for access to all websites. Needs a click. */
export async function requestHostAccess() {
  const ext = globalThis.browser ?? globalThis.chrome
  try {
    await ext.permissions.request({ origins: ['<all_urls>'] })
  } catch {}
  await checkHealth()
  return store.health.hostAccess
}

export function useLocalInstead() {
  store.pendingApproval = false
  adapter = createLocalAdapter()
  store.mode = 'local'
  store.health.extension = extensionPresent()
  return refresh()
}

export function meta(action, extra) {
  return adapter?.meta?.(action, extra)
}

export function toast(message, kind = 'info') {
  const id = Math.random()
  store.toasts.push({ id, message, kind })
  setTimeout(() => (store.toasts = store.toasts.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3500)
}

/** Runs an action and shows its error as a toast. Returns the result or undefined. */
export async function attempt(fn, success) {
  try {
    const r = await fn()
    if (success) toast(success, 'success')
    return r
  } catch (e) {
    toast(e.message, 'error')
    throw e
  }
}

export const blocks = computed(() => (store.state ? computeBlocks(store.state, store.now) : { domains: [], blocks: [] }))
export const sites = computed(() => (store.state ? allSites(store.state) : []))
export const canBlock = computed(() => store.mode !== 'local')
