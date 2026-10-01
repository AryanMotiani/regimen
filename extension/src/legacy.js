// Regimen was called FocusGateway up to v1.2.0 and kept its extension data under 'fg_*' keys.
// The rename moved them to 'r_*'. This copies them over once, before the background reads
// anything, so an update keeps the PIN, rules, tasks, the lock agent pairing (all in the state),
// the approved local copies and the offline choice. Session keys ('fg_keys',
// 'fg_pending_origins') are not copied: session storage is emptied when the browser closes.

export const LEGACY_KEYS = {
  fg_state: 'r_state',
  fg_approved_origins: 'r_approved_origins',
  fg_offline_app: 'r_offline_app',
}

/**
 * Copy each old key of `area` (ext.storage.local) to its new name when the new key is not set
 * yet, then remove the old keys. A new key that already exists is never overwritten. Returns
 * the names of the keys it copied.
 */
export async function migrateLegacyStorage(area) {
  const oldNames = Object.keys(LEGACY_KEYS)
  const found = await area.get([...oldNames, ...Object.values(LEGACY_KEYS)])
  const copy = {}
  for (const [oldName, newName] of Object.entries(LEGACY_KEYS)) {
    if (found[oldName] !== undefined && found[newName] === undefined) copy[newName] = found[oldName]
  }
  if (Object.keys(copy).length) await area.set(copy)
  const stale = oldNames.filter((k) => found[k] !== undefined)
  if (stale.length) await area.remove(stale)
  return Object.keys(copy)
}
