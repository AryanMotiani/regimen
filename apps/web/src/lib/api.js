// Three ways the UI can reach the Backend:
//  extension  the app is running inside the extension (chrome-extension:// / moz-extension://)
//  bridge     a hosted copy of the app, extension installed, origin approved by the user
//  local      no extension: the Backend runs in this page, data in localStorage
//             (tasks, habits and the study room work; blocking needs the extension)
// First: copies data saved under the old FocusGateway keys before anything reads storage.
import './legacy.js'
import { createBackend, toErrorPayload } from '@regimen/core'

const ext = globalThis.browser ?? globalThis.chrome

export function inExtension() {
  return /^(chrome|moz)-extension:$/.test(location.protocol) && !!ext?.runtime?.id
}

/** Which browser this is, for install instructions ('chrome', 'edge', 'firefox', 'safari', ...). */
export function detectBrowser(ua = navigator.userAgent) {
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return 'phone'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Edg\//.test(ua)) return 'edge'
  if (/OPR\/|Opera/.test(ua)) return 'opera'
  if (typeof navigator !== 'undefined' && navigator.brave) return 'brave'
  if (/Chrome\/|Chromium\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

export function extensionPresent() {
  return !!document.documentElement.dataset.regimenExtension
}

function extensionAdapter() {
  return {
    mode: 'extension',
    call: (cmd, payload) => ext.runtime.sendMessage({ type: 'fg', cmd, payload }),
    meta: (action, extra) => ext.runtime.sendMessage({ type: 'fg-meta', action, ...extra }),
  }
}

function bridgeAdapter() {
  let seq = 0
  const waiting = new Map()
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__fg !== 'res') return
    const w = waiting.get(e.data.id)
    if (w) {
      waiting.delete(e.data.id)
      w(e.data.res)
    }
  })
  const call = (cmd, payload) =>
    new Promise((resolve) => {
      const id = ++seq
      waiting.set(id, resolve)
      // Payloads often hold Vue reactive arrays (the picked sites, the rule's days). postMessage
      // can not clone a Proxy and throws DataCloneError, which silently broke focus.start and
      // rules.create on the hosted site. A JSON copy is what runtime.sendMessage sends anyway.
      let data
      try {
        data = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload))
      } catch (e) {
        waiting.delete(id)
        return resolve({ ok: false, error: { code: 'VALIDATION', message: String(e?.message || e) } })
      }
      window.postMessage({ __fg: 'req', id, cmd, payload: data }, location.origin)
      setTimeout(() => {
        if (waiting.delete(id)) resolve({ ok: false, error: { code: 'TIMEOUT', message: 'The extension did not answer.' } })
      }, 15000)
    })
  return { mode: 'bridge', call, meta: async () => ({ ok: false }) }
}

const LOCAL_KEY = 'regimen:v1'
function localAdapter() {
  const storage = {
    load: async () => {
      try {
        return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')
      } catch {
        return null
      }
    },
    save: async (s) => {
      try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(s))
      } catch (e) {
        console.warn('Could not save to localStorage', e)
      }
    },
  }
  const backend = createBackend({ storage })
  return {
    mode: 'local',
    call: async (cmd, payload) => {
      try {
        const r = await backend.dispatch(cmd, payload)
        return { ok: true, data: r.data, state: r.state, now: Date.now() }
      } catch (e) {
        return { ok: false, error: toErrorPayload(e) }
      }
    },
    meta: async () => ({ ok: false }),
  }
}

export function hasLocalData() {
  try {
    const s = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')
    return !!s && (s.tasks?.length || s.rules?.length || s.habits?.length)
  } catch {
    return false
  }
}
/** The full state saved by standalone mode (PIN hash included), or null. */
export function readLocalState() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null')
  } catch {
    return null
  }
}

export function clearLocalData() {
  try {
    localStorage.removeItem(LOCAL_KEY)
  } catch {}
}
export const createLocalAdapter = localAdapter

/** Picks the best adapter. For bridge mode it also performs the approval handshake. */
export async function connect() {
  if (inExtension()) return extensionAdapter()
  // give the content script a moment (it runs at document_start, so this is usually instant)
  for (let i = 0; i < 10 && !extensionPresent(); i++) await new Promise((r) => setTimeout(r, 50))
  if (extensionPresent()) {
    const bridge = bridgeAdapter()
    const hello = await bridge.call('hello')
    if (hello?.ok)
      return { ...bridge, approved: hello.data.approved, hostAccess: hello.data.hostAccess ?? null, version: hello.data.version ?? null }
  }
  return localAdapter()
}
