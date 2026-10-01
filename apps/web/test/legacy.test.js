import { describe, it, expect } from 'vitest'
import { migrateLegacyKeys, migrateLegacyStorage } from '../src/lib/legacy.js'

// A minimal Web Storage (localStorage) stand-in.
class MemoryStorage {
  constructor(entries = {}, { quota = Infinity } = {}) {
    this.map = new Map(Object.entries(entries))
    this.quota = quota
  }
  get length() {
    return this.map.size
  }
  key(i) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(k) {
    return this.map.has(k) ? this.map.get(k) : null
  }
  setItem(k, v) {
    if (this.map.size >= this.quota) throw new Error('QuotaExceededError')
    this.map.set(k, String(v))
  }
  removeItem(k) {
    this.map.delete(k)
  }
}

describe('FocusGateway to Regimen storage migration', () => {
  it('copies every old key to the new name and drops the old one', () => {
    const state = JSON.stringify({ tasks: [{ id: 't1', title: 'Essay' }], rules: [], habits: [] })
    const s = new MemoryStorage({
      'focusgateway:v1': state,
      'focusgateway:tours-seen': '["room"]',
      'focusgateway:room-layout:v1': '{"x":1}',
      'focusgateway:look': '{"theme":"quest"}',
      unrelated: 'keep',
    })
    expect(migrateLegacyKeys(s)).toBe(4)
    expect(s.getItem('regimen:v1')).toBe(state)
    expect(s.getItem('regimen:tours-seen')).toBe('["room"]')
    expect(s.getItem('regimen:room-layout:v1')).toBe('{"x":1}')
    expect(s.getItem('regimen:look')).toBe('{"theme":"quest"}')
    expect(s.getItem('focusgateway:v1')).toBeNull()
    expect(s.getItem('unrelated')).toBe('keep')
    expect(migrateLegacyKeys(s)).toBe(0) // runs on every load: the second time is a no-op
  })

  it('never overwrites a key that already exists under the new name', () => {
    const s = new MemoryStorage({ 'focusgateway:v1': '{"old":true}', 'regimen:v1': '{"new":true}' })
    expect(migrateLegacyKeys(s)).toBe(0)
    expect(s.getItem('regimen:v1')).toBe('{"new":true}')
    expect(s.getItem('focusgateway:v1')).toBe('{"old":true}') // different data: kept, not destroyed
  })

  it('keeps the old key when the copy can not be written', () => {
    const s = new MemoryStorage({ 'focusgateway:v1': '{"tasks":[]}' }, { quota: 1 })
    expect(migrateLegacyKeys(s)).toBe(0)
    expect(s.getItem('focusgateway:v1')).toBe('{"tasks":[]}')
  })

  it('survives missing or blocked storage', () => {
    expect(migrateLegacyKeys(undefined)).toBe(0)
    const blocked = {
      get localStorage() {
        throw new Error('SecurityError')
      },
      sessionStorage: new MemoryStorage({ 'focusgateway:pair-link': '{"code":"X"}' }),
    }
    expect(migrateLegacyStorage(blocked)).toBe(1)
    expect(blocked.sessionStorage.getItem('regimen:pair-link')).toBe('{"code":"X"}')
  })
})
