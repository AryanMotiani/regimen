import { describe, it, expect } from 'vitest'
import { migrateLegacyStorage, LEGACY_KEYS } from '../src/legacy.js'

// A stand-in for ext.storage.local (promise based, like browser.storage and Chrome MV3).
function memoryArea(initial = {}) {
  const data = { ...initial }
  return {
    data,
    get: async (keys) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
    set: async (items) => Object.assign(data, structuredClone(items)),
    remove: async (keys) => keys.forEach((k) => delete data[k]),
  }
}

describe('extension storage migration (FocusGateway to Regimen)', () => {
  it('moves the state, approved origins and offline choice to the new keys', async () => {
    const state = { tasks: [{ id: 't1' }], agent: { token: 'secret', url: 'http://127.0.0.1:47621' }, security: { pin: 'hash' } }
    const area = memoryArea({ fg_state: state, fg_approved_origins: ['http://localhost:5173'], fg_offline_app: true, other: 1 })
    const copied = await migrateLegacyStorage(area)
    expect(copied.sort()).toEqual(Object.values(LEGACY_KEYS).sort())
    expect(area.data.r_state).toEqual(state) // PIN, data and the lock agent pairing survive the update
    expect(area.data.r_approved_origins).toEqual(['http://localhost:5173'])
    expect(area.data.r_offline_app).toBe(true)
    expect(Object.keys(area.data).filter((k) => k.startsWith('fg_'))).toEqual([])
    expect(area.data.other).toBe(1)
  })

  it('never overwrites newer data and is a no-op the second time', async () => {
    const area = memoryArea({ fg_state: { tasks: ['old'] }, r_state: { tasks: ['new'] } })
    expect(await migrateLegacyStorage(area)).toEqual([])
    expect(area.data.r_state).toEqual({ tasks: ['new'] })
    expect(area.data.fg_state).toBeUndefined()
    expect(await migrateLegacyStorage(area)).toEqual([])
  })

  it('keeps a false offline choice (only undefined counts as missing)', async () => {
    const area = memoryArea({ fg_offline_app: false })
    await migrateLegacyStorage(area)
    expect(area.data.r_offline_app).toBe(false)
  })
})
