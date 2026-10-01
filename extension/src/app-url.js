// Where the extension opens the Regimen app.
//
// The official hosted app (package.json "homepage", baked in by build.mjs as __R_APP_URL__) is
// always the newest version, so the popup, the install welcome and the blocked page open it by
// default. The copy bundled in app/ is the offline fallback: used when the browser is offline,
// the hosted app does not answer quickly, the extension can not reach websites (Firefox without
// website access, where the bridge could not connect the hosted app) or the person picked
// "Use the offline copy" in the popup.
const ext = globalThis.browser ?? globalThis.chrome

export const HOSTED_APP = new URL(__R_APP_URL__)
export const OFFLINE_KEY = 'r_offline_app'
// people run the web app locally with `npm run dev` / `vite preview`
export const DEV_HOSTS = ['localhost', '127.0.0.1']

/** Is `url` the official hosted app? Same origin AND inside its path (the origin is shared by every repo of that GitHub user). */
export function isOfficialApp(url) {
  try {
    const u = new URL(url)
    return u.origin === HOSTED_APP.origin && u.pathname.startsWith(HOSTED_APP.pathname)
  } catch {
    return false
  }
}
export function isDevApp(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && DEV_HOSTS.includes(u.hostname)
  } catch {
    return false
  }
}

export const bundledUrl = (route = '/') => ext.runtime.getURL('app/index.html#' + route)

export async function prefersOffline() {
  try {
    // 'fg_offline_app' is the FocusGateway name, read until the background has moved it
    const got = await ext.storage.local.get([OFFLINE_KEY, 'fg_offline_app'])
    return !!(got[OFFLINE_KEY] ?? got.fg_offline_app)
  } catch {
    return false
  }
}

async function hostedReachable(timeoutMs) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false
  const hasAccess = await ext.permissions.contains({ origins: ['<all_urls>'] }).catch(() => true)
  if (!hasAccess) return false
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(HOSTED_APP.href, { method: 'HEAD', cache: 'no-store', signal: ctl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** The app URL for a route like '/room' or '/today?failsafe=id': hosted when possible, else bundled. */
export async function appUrl(route = '/', { timeoutMs = 1500 } = {}) {
  if (await prefersOffline()) return bundledUrl(route)
  return (await hostedReachable(timeoutMs)) ? HOSTED_APP.href + '#' + route : bundledUrl(route)
}
