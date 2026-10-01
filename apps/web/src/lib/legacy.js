// Regimen was called FocusGateway up to v1.2.0, and the web app saved everything under
// 'focusgateway:*' keys: the whole local state ('focusgateway:v1'), the look picked before setup,
// what was seen (tours, tips, badges), the room layout and notes. The rename moved every key to
// 'regimen:*'. Without this copy an existing user would open the new version to an empty app.
//
// It runs once per page load, before anything reads storage: api.js imports it first, and every
// module that touches localStorage imports api.js (directly or through store.js). The old keys
// stay where they are when the copy can not be written (for example a full quota), so nothing
// is lost, and they are removed once their value lives under the new name.

export const LEGACY_PREFIX = 'focusgateway:'
export const PREFIX = 'regimen:'

/**
 * Copy every 'focusgateway:*' key of `storage` (a Web Storage object) to the matching 'regimen:*'
 * key when that key does not exist yet. A key that already exists under the new name is never
 * overwritten: it is newer. Returns the number of keys copied.
 */
export function migrateLegacyKeys(storage) {
  if (!storage) return 0
  const keys = []
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i)
    if (k && k.startsWith(LEGACY_PREFIX)) keys.push(k)
  }
  let copied = 0
  for (const oldKey of keys) {
    const newKey = PREFIX + oldKey.slice(LEGACY_PREFIX.length)
    try {
      if (storage.getItem(newKey) === null) {
        storage.setItem(newKey, storage.getItem(oldKey))
        copied++
      }
      // Only drop the old key once the very same value is safely stored under the new name.
      if (storage.getItem(newKey) === storage.getItem(oldKey)) storage.removeItem(oldKey)
    } catch {
      // quota or a blocked storage: keep the old key, the next load tries again
    }
  }
  return copied
}

/** Runs the copy on localStorage and sessionStorage. Never throws (storage can be blocked). */
export function migrateLegacyStorage(scope = globalThis) {
  let copied = 0
  for (const name of ['localStorage', 'sessionStorage']) {
    try {
      copied += migrateLegacyKeys(scope[name])
    } catch {
      // storage disabled (private mode, blocked cookies): nothing to migrate
    }
  }
  return copied
}

migrateLegacyStorage()
