import { describe, it, expect, beforeEach } from 'vitest'
import { createBackend } from '../src/backend.js'
import { migrate } from '../src/state.js'
import { UNLOCKS } from '../src/unlocks.js'
import { sanitizeLofi, mergeLofi, DEFAULT_LOFI } from '../src/lofi.js'
import { trackOwned } from '../src/economy.js'
import {
  TRACKS,
  TRACK_KEYS,
  CHORD_QUALITIES,
  trackById,
  tracksForStyle,
  firstTrack,
  isTrackUnlocked,
  voiceTrack,
  trackIsMinor,
} from '../src/tracks.js'

function memoryStorage(initial = null) {
  let saved = initial ? structuredClone(initial) : null
  return {
    load: async () => (saved ? structuredClone(saved) : null),
    save: async (s) => {
      saved = structuredClone(s)
    },
  }
}

describe('track catalog', () => {
  const styles = UNLOCKS.filter((u) => u.kind === 'music')

  it('has 6 to 10 named tracks for every music style', () => {
    for (const s of styles) {
      const list = tracksForStyle(s.id)
      expect(list.length).toBeGreaterThanOrEqual(6)
      expect(list.length).toBeLessThanOrEqual(10)
      expect(firstTrack(s.id).style).toBe(s.id)
    }
  })

  it('uses unique ids, names and seeds, known keys and chord qualities', () => {
    expect(new Set(TRACKS.map((t) => t.id)).size).toBe(TRACKS.length)
    expect(new Set(TRACKS.map((t) => t.name)).size).toBe(TRACKS.length)
    expect(new Set(TRACKS.map((t) => t.seed)).size).toBe(TRACKS.length)
    for (const t of TRACKS) {
      expect(t.name).not.toMatch(/[\u2014;]/)
      expect(TRACK_KEYS[t.key]).toBeTypeOf('number')
      expect(t.bpm).toBeGreaterThanOrEqual(48)
      expect(t.bpm).toBeLessThanOrEqual(96)
      expect(t.length).toBeGreaterThanOrEqual(120)
      expect(t.length).toBeLessThanOrEqual(240)
      expect(t.mood).toBeTruthy()
      for (const [deg, q] of t.progression) {
        expect(deg).toBeGreaterThanOrEqual(0)
        expect(deg).toBeLessThan(12)
        expect(CHORD_QUALITIES[q]).toBeDefined()
      }
    }
  })

  it('voices every chord in a comfortable range', () => {
    for (const t of TRACKS) {
      const chords = voiceTrack(t)
      expect(chords).toHaveLength(t.progression.length)
      for (const c of chords) {
        expect(c[0]).toBeGreaterThanOrEqual(45)
        expect(c[0]).toBeLessThan(57)
        expect(Math.max(...c)).toBeLessThanOrEqual(80)
      }
    }
    expect(voiceTrack(trackById('classic-rain-window'))[0]).toEqual([46, 50, 53, 57])
  })

  it('knows minor tracks and locked styles', () => {
    expect(trackIsMinor(trackById('classic-tram-stop'))).toBe(true)
    expect(trackIsMinor(trackById('classic-rain-window'))).toBe(false)
    expect(isTrackUnlocked('classic-late-library', 1)).toBe(true)
    expect(isTrackUnlocked('bossa-' + 'x', 99)).toBe(false)
    const bossa = TRACKS.find((t) => t.style === 'music-bossa').id
    expect(isTrackUnlocked(bossa, 12)).toBe(false)
    expect(isTrackUnlocked(bossa, 13)).toBe(true)
    // playing needs the style to be owned (bought in the shop, or free)
    expect(trackOwned('classic-late-library', () => false)).toBe(false)
    expect(trackOwned('classic-late-library', (id) => id === 'music-classic')).toBe(true)
    expect(trackOwned('jazz-corner-booth', (id) => id === 'music-classic')).toBe(false)
    expect(isTrackUnlocked('nope', 99)).toBe(false)
  })
})

describe('settings.lofi.track', () => {
  let be
  beforeEach(async () => {
    be = createBackend({ storage: memoryStorage(), hashIterations: 1000 })
    await be.dispatch('setup.pin', { pin: '246810' })
  })
  const lofi = (patch) => be.dispatch('settings.update', { patch: { lofi: patch } })

  it('saves a known track of an unlocked style', async () => {
    const r = await lofi({ style: 'music-classic', track: 'classic-matcha-break' })
    expect(r.state.settings.lofi).toMatchObject({ style: 'music-classic', track: 'classic-matcha-break' })
    const back = await lofi({ track: null })
    expect(back.state.settings.lofi.track).toBeUndefined()
  })

  it('rejects unknown tracks, locked styles and tracks of another style', async () => {
    await expect(lofi({ track: 'made-up' })).rejects.toMatchObject({ code: 'VALIDATION', message: 'Unknown track.' })
    await expect(lofi({ style: 'music-jazz', track: 'jazz-corner-booth' })).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(lofi({ track: 'jazz-corner-booth' })).rejects.toMatchObject({
      code: 'VALIDATION',
      message: 'Corner Booth is part of Rainy jazz. Rainy jazz is in the shop for 450 coins.',
    })
    await expect(lofi({ track: 42 })).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  it('keeps a saved locked track and clears a track when the style changes', () => {
    const cur = { ...migrate(null).settings.lofi, style: 'music-ambient', track: 'ambient-quiet-orbit' }
    const none = (id) => id === 'music-classic'
    expect(mergeLofi(cur, { volume: 0.2 }, none).value.track).toBe('ambient-quiet-orbit')
    expect(mergeLofi(cur, { track: 'ambient-quiet-orbit' }, none).value.track).toBe('ambient-quiet-orbit')
    expect(mergeLofi(cur, { style: 'music-classic' }, none).value.track).toBeUndefined()
  })

  it('sanitizes stored and imported tracks', () => {
    expect(sanitizeLofi({ style: 'music-classic', track: 'classic-late-library' }).track).toBe('classic-late-library')
    expect(sanitizeLofi({ style: 'music-classic', track: 'jazz-corner-booth' }).track).toBeUndefined()
    expect(sanitizeLofi({ style: 'music-classic', track: 'nope' }).track).toBeUndefined()
    expect(sanitizeLofi({}).track).toBeUndefined()
    expect(migrate(null).settings.lofi.track).toBeUndefined()
  })
})

describe('settings.lofi ambience', () => {
  it('plays the music alone by default', () => {
    const l = migrate(null).settings.lofi
    expect(l.music).toBe(true)
    expect(l.ambience).toEqual({ rain: false, fire: false })
    expect(sanitizeLofi({})).toMatchObject({ music: true, ambience: { rain: false, fire: false }, mix: { rain: 0.5, fire: 0.5 } })
  })

  it('turns the old default rain off once, and keeps a mix someone chose', () => {
    const old = (mix) => sanitizeLofi({ volume: 0.6, scene: 'scene-night', style: 'music-classic', objects: true, mix })
    // exactly the old default: never chosen, so it goes quiet
    expect(old({ rain: 0.5, cafe: 0, fire: 0, noise: 0 })).toMatchObject({ ambience: { rain: false, fire: false }, mix: DEFAULT_LOFI.mix })
    expect(old({ rain: 0.5 }).ambience).toEqual({ rain: false, fire: false })
    // changed: the sounds that still exist stay on at their level
    expect(old({ rain: 0.8, cafe: 0, fire: 0, noise: 0 })).toMatchObject({
      ambience: { rain: true, fire: false },
      mix: { rain: 0.8, fire: 0.5 },
    })
    expect(old({ rain: 0.5, cafe: 0, fire: 0.3, noise: 0 })).toMatchObject({
      ambience: { rain: true, fire: true },
      mix: { rain: 0.5, fire: 0.3 },
    })
    expect(old({ rain: 0, cafe: 0, fire: 0, noise: 0 }).ambience).toEqual({ rain: false, fire: false })
    // only sounds that are gone: nothing left to play
    expect(old({ rain: 0, cafe: 0.7, fire: 0, noise: 0.4 })).toMatchObject({
      ambience: { rain: false, fire: false },
      mix: DEFAULT_LOFI.mix,
    })
    // once converted it stays put, the old default level no longer means anything
    const once = sanitizeLofi(old({ rain: 0.9 }))
    expect(sanitizeLofi({ ...once, mix: { rain: 0.5, fire: 0.5 } }).ambience).toEqual({ rain: true, fire: false })
    expect(sanitizeLofi({ ...once, ambience: { rain: false, fire: true } }).ambience).toEqual({ rain: false, fire: true })
  })

  it('migrates stored state through migrate()', () => {
    const s = migrate(null)
    s.settings.lofi = {
      volume: 0.4,
      scene: 'scene-night',
      style: 'music-classic',
      objects: true,
      mix: { rain: 0.5, cafe: 0, fire: 0, noise: 0 },
    }
    const m = migrate(s)
    expect(m.settings.lofi).toMatchObject({ volume: 0.4, music: true, ambience: { rain: false, fire: false } })
    expect('cafe' in m.settings.lofi.mix).toBe(false)
  })
})
