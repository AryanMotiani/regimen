import { reactive } from 'vue'
import {
  TRACKS,
  trackById,
  tracksForStyle,
  firstTrack,
  trackStyle,
  voiceTrack,
  trackIsMinor,
  TRACK_KEYS,
  LOFI_MIX_KEYS,
  sanitizeLofi,
} from '@regimen/core'
import { createAmbience, seeded } from './ambience.js'
// Generative lofi + ambience, synthesized live with the Web Audio API.
// No audio files, no streaming, no copyright issues, and it keeps playing even
// when YouTube or Spotify are blocked.
// Music comes as named tracks (packages/core/src/tracks.js): each sets the key, chords,
// tempo and a seeded melody, and the radio moves on to the next one after 2 to 4 minutes.
// Ambience (rain, fireplace, see ambience.js) is separate: off by default, each sound with
// its own switch and level, and it plays with or without the music.

const NOTE = (n) => 440 * Math.pow(2, (n - 69) / 12) // MIDI -> Hz

const PENTA_MAJOR = [0, 2, 4, 7, 9, 12, 14, 16]
const PENTA_MINOR = [0, 3, 5, 7, 10, 12, 15, 17]

// A near silent looping audio element. Browsers only show media keys and lock screen
// controls for media elements, not for Web Audio, so this carries the track name there.
let keepAlive = null
function silentLoop() {
  if (keepAlive || typeof Audio === 'undefined') return keepAlive
  const rate = 8000
  const n = rate * 6
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const str = (o, t) => [...t].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  str(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  str(8, 'WAVEfmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  str(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, i % 2 ? 1 : -1, true)
  keepAlive = new Audio(URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })))
  keepAlive.loop = true
  return keepAlive
}

export function makeNoise(ctx, kind, seconds = 3) {
  const len = ctx.sampleRate * seconds
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let b0 = 0,
      b1 = 0,
      b2 = 0,
      b3 = 0,
      b4 = 0,
      b5 = 0,
      b6 = 0,
      last = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      if (kind === 'white') d[i] = w * 0.5
      else if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02
        d[i] = last * 3.5
      } else {
        b0 = 0.99886 * b0 + w * 0.0555179
        b1 = 0.99332 * b1 + w * 0.0750759
        b2 = 0.969 * b2 + w * 0.153852
        b3 = 0.8665 * b3 + w * 0.3104856
        b4 = 0.55 * b4 + w * 0.5329522
        b5 = -0.7616 * b5 - w * 0.016898
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
        b6 = w * 0.115926
      }
    }
  }
  return buf
}

function makeImpulse(ctx, seconds = 2.4, decay = 3) {
  const len = ctx.sampleRate * seconds
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
  }
  return buf
}

export function createLofi() {
  const AC = window.AudioContext || window.webkitAudioContext
  let ctx = null
  let nodes = null
  let timer = null
  let playing = false
  let musicOn = true
  let volume = 0.6
  // ambience levels, and which sounds are on (settings.lofi.mix and .ambience in core)
  let mix = { rain: 0.5, fire: 0.5 }
  let ambienceOn = { rain: false, fire: false }
  let ambience = null
  const listeners = new Set()

  // sequencer state. The music style sets the groove, the track sets key, chords, tempo
  // and melody.
  const STYLES = {
    'music-classic': { swing: 0.18, drums: 'lofi', melody: 0.34, keysGain: 0.07 },
    'music-jazz': { swing: 0.24, drums: 'brush', melody: 0.46, keysGain: 0.08 },
    'music-bossa': { swing: 0.08, drums: 'bossa', melody: 0.36, keysGain: 0.065 },
    'music-ambient': { swing: 0, drums: 'none', melody: 0.2, keysGain: 0.09 },
  }
  let track = firstTrack('music-classic')
  let style = STYLES[track.style]
  let chords = voiceTrack(track)
  let motif = []
  let rand = seeded(track.seed)
  let step = 60 / track.bpm / 4 // 16th note
  let nextTime = 0
  let stepIndex = 0
  let bar = 0
  let trackBar = 0
  let trackStart = 0 // ctx time the track started
  let pending = null // a track to switch to on the next bar
  let history = []
  let allowed = () => true

  // a two bar melody made from the seed, played with small changes each time round
  function makeMotif(t) {
    const r = seeded(t.seed * 7 + 3)
    const scale = trackIsMinor(t) ? PENTA_MINOR : PENTA_MAJOR
    const key = TRACK_KEYS[t.key] ?? 0
    const base = 60 + (key > 6 ? key - 12 : key) + 12
    const density = (STYLES[t.style] || STYLES['music-classic']).melody
    const out = []
    let deg = Math.floor(r() * 4)
    for (let i = 0; i < 32; i++) {
      if (i % 2 === 1 || r() > density) continue
      deg = Math.max(0, Math.min(scale.length - 1, deg + Math.round((r() - 0.5) * 3.2)))
      out.push({ at: i, midi: base + scale[deg], len: 2 + Math.floor(r() * 4), vel: 0.035 + r() * 0.03 })
    }
    return out
  }
  motif = makeMotif(track)

  function build() {
    ctx = new AC()
    const master = ctx.createGain()
    master.gain.value = volume
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.ratio.value = 3
    master.connect(comp).connect(ctx.destination)

    const reverb = ctx.createConvolver()
    reverb.buffer = makeImpulse(ctx)
    const reverbGain = ctx.createGain()
    reverbGain.gain.value = 0.28
    reverb.connect(reverbGain).connect(master)

    const music = ctx.createGain()
    music.gain.value = musicOn ? 0.9 : 0
    const tape = ctx.createBiquadFilter()
    tape.type = 'lowpass'
    tape.frequency.value = 2600
    tape.Q.value = 0.4
    music.connect(tape)
    tape.connect(master)
    tape.connect(reverb)

    const white = makeNoise(ctx, 'white')

    // vinyl crackle: sparse clicks on the music bus
    const crackle = ctx.createBufferSource()
    const cbuf = ctx.createBuffer(1, ctx.sampleRate * 4, ctx.sampleRate)
    const cd = cbuf.getChannelData(0)
    for (let i = 0; i < cd.length; i++) cd[i] = Math.random() < 0.0006 ? (Math.random() * 2 - 1) * 0.6 : (Math.random() * 2 - 1) * 0.006
    crackle.buffer = cbuf
    crackle.loop = true
    const crackleGain = ctx.createGain()
    crackleGain.gain.value = 0.35
    crackle.connect(crackleGain).connect(music)
    crackle.start()

    // ambience goes straight to the master, beside the music bus (not through its tape filter)
    ambience = createAmbience(ctx, master, { pink: makeNoise(ctx, 'pink', 6), brown: makeNoise(ctx, 'brown', 6) })
    nodes = { master, music, reverb, white }
    applyMix()
  }

  function applyMix() {
    if (!ambience) return
    for (const k of LOFI_MIX_KEYS) ambience.set(k, !!ambienceOn[k], mix[k] ?? 0)
  }

  // --- instruments ---
  function keys(midi, time, dur, vel = 0.12) {
    const out = ctx.createGain()
    out.gain.setValueAtTime(0, time)
    out.gain.linearRampToValueAtTime(vel, time + 0.02)
    out.gain.exponentialRampToValueAtTime(vel * 0.45, time + 0.4)
    out.gain.exponentialRampToValueAtTime(0.0001, time + dur)
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.setValueAtTime(1800, time)
    f.frequency.exponentialRampToValueAtTime(700, time + dur)
    for (const [type, detune, g] of [
      ['sine', 0, 1],
      ['triangle', 6, 0.35],
      ['sine', 1200, 0.08],
    ]) {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = NOTE(midi)
      o.detune.value = detune + (Math.random() * 6 - 3)
      const og = ctx.createGain()
      og.gain.value = g
      o.connect(og).connect(f)
      o.start(time)
      o.stop(time + dur + 0.05)
    }
    f.connect(out).connect(nodes.music)
  }

  function bass(midi, time, dur) {
    const o = ctx.createOscillator()
    o.type = 'sine'
    o.frequency.value = NOTE(midi - 12)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, time)
    g.gain.linearRampToValueAtTime(0.28, time + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, time + dur)
    o.connect(g).connect(nodes.music)
    o.start(time)
    o.stop(time + dur + 0.05)
  }

  function kick(time) {
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(140, time)
    o.frequency.exponentialRampToValueAtTime(42, time + 0.18)
    g.gain.setValueAtTime(0.55, time)
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.35)
    o.connect(g).connect(nodes.music)
    o.start(time)
    o.stop(time + 0.4)
  }

  function noiseHit(time, { freq, q = 1, type = 'bandpass', gain, decay }) {
    const s = ctx.createBufferSource()
    s.buffer = nodes.white
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.Q.value = q
    const g = ctx.createGain()
    g.gain.setValueAtTime(gain, time)
    g.gain.exponentialRampToValueAtTime(0.0001, time + decay)
    s.connect(f).connect(g).connect(nodes.music)
    s.start(time, Math.random())
    s.stop(time + decay + 0.02)
  }

  function drums(s16, t) {
    if (style.drums === 'none') return
    if (style.drums === 'bossa') {
      if (s16 === 0 || s16 === 6 || s16 === 8 || s16 === 14) kick(t)
      if ([3, 6, 10, 12].includes(s16)) noiseHit(t, { freq: 2600, q: 3, gain: 0.08, decay: 0.05 })
      if (s16 % 2 === 0) noiseHit(t, { freq: 9000, type: 'highpass', gain: 0.025, decay: 0.04 })
      return
    }
    if (style.drums === 'brush') {
      if (s16 === 0 || (s16 === 10 && rand() < 0.3)) kick(t)
      if (s16 === 4 || s16 === 12) noiseHit(t, { freq: 1400, q: 0.5, gain: 0.08, decay: 0.3 })
      if (s16 % 2 === 0) noiseHit(t, { freq: 6000, type: 'highpass', gain: 0.02, decay: 0.12 })
      return
    }
    if (s16 === 0 || s16 === 7 || (s16 === 10 && rand() < 0.4)) kick(t)
    if (s16 === 4 || s16 === 12) noiseHit(t, { freq: 1800, q: 0.8, gain: 0.16, decay: 0.18 })
    if (s16 % 2 === 0) noiseHit(t, { freq: 8000, type: 'highpass', gain: s16 % 4 === 0 ? 0.05 : 0.03, decay: 0.05 })
  }

  function applyTrack(t) {
    track = t
    style = STYLES[t.style] || STYLES['music-classic']
    chords = voiceTrack(t)
    motif = makeMotif(t)
    rand = seeded(t.seed)
    step = 60 / t.bpm / 4
    trackBar = 0
    stepIndex = 0
    trackStart = ctx ? ctx.currentTime : 0
    lofiState.track = t.id
    lofiState.chosen = true
    lofiState.style = t.style
    lofiState.bpm = t.bpm
    lofiState.length = t.length
    lofiState.position = 0
    updateSession()
  }

  // a short dip on the music bus so a change of track does not clash
  function dip(time, depth = 0.08) {
    if (!nodes || !musicOn) return
    const g = nodes.music.gain
    g.cancelScheduledValues(time)
    g.setValueAtTime(g.value, time)
    g.linearRampToValueAtTime(depth, time + 0.12)
    g.setTargetAtTime(0.9, time + 0.2, 0.35)
  }

  function pickNext(dir = 1, auto = false) {
    if (auto && lofiState.repeatOne) return track
    const list = tracksForStyle(track.style).filter((t) => allowed(t.id))
    if (!list.length) return track
    if (lofiState.shuffle && list.length > 1 && dir > 0) {
      const others = list.filter((t) => t.id !== track.id)
      return others[Math.floor(Math.random() * others.length)]
    }
    const i = list.findIndex((t) => t.id === track.id)
    return list[(i + dir + list.length) % list.length]
  }

  function scheduleStep(i, time) {
    const s16 = i % 16
    const swing = s16 % 2 === 1 ? step * style.swing : 0
    const t = time + swing
    if (s16 === 0) {
      bar++
      trackBar++
      // bar aligned: move on after the track's length, at the end of a 4 bar phrase
      if (!pending && playing && time - trackStart >= track.length && trackBar % 4 === 1) pending = pickNext(1, true)
      if (pending) {
        const next = pending
        pending = null
        if (next !== track) history.push(track.id)
        dip(time, 0.25)
        applyTrack(next)
        trackStart = time
        return scheduleStep(0, time)
      }
    }
    // an A section, then every third phrase a B section that starts on the third chord
    const phrase = Math.floor((trackBar - 1) / 8)
    const shift = phrase % 3 === 2 ? 2 : 0
    const chord = chords[(Math.floor(i / 16) + shift) % chords.length]
    if (musicOn) {
      const ambient = style.drums === 'none'
      if (s16 === 0) chord.forEach((n, k) => keys(n, t + k * (ambient ? 0.12 : 0.018), step * (ambient ? 16 : 15), style.keysGain))
      if (!ambient && s16 === 10 && rand() < 0.5) chord.slice(1).forEach((n, k) => keys(n, t + k * 0.015, step * 6, 0.04))
      if (s16 === 0 || (!ambient && s16 === 10)) bass(chord[0], t, step * (s16 === 0 ? 8 : 5))
      drums(s16, t)
      // the melody rests for the first two bars, then plays the motif, varied in the last bars of a phrase
      if (trackBar > 2) {
        const at = ((trackBar - 1) % 2) * 16 + s16
        const n = motif.find((m) => m.at === at)
        if (n && !((trackBar - 1) % 8 >= 6 && rand() < 0.35)) {
          const lift = (trackBar - 1) % 8 >= 6 && rand() < 0.3 ? (rand() < 0.5 ? 2 : -3) : 0
          keys(n.midi + lift, t, step * n.len, n.vel)
        }
      }
    }
    if (s16 % 4 === 0) {
      listeners.forEach((cb) => cb({ step: s16, bar }))
      lofiState.position = Math.max(0, Math.round(time - trackStart))
    }
  }

  function updateSession() {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession
    if (!ms || typeof window.MediaMetadata === 'undefined') return
    try {
      // ambience alone: name the sounds instead of a track nobody hears
      const sounds = LOFI_MIX_KEYS.filter((k) => ambienceOn[k]).map((k) => AMBIENCE_NAMES[k])
      ms.metadata = new window.MediaMetadata(
        musicOn || !sounds.length
          ? { title: track.name, artist: 'Regimen Radio', album: trackStyle(track)?.name || 'Lofi' }
          : { title: sounds.join(' and '), artist: 'Regimen Radio', album: 'Ambience' },
      )
      ms.playbackState = playing ? 'playing' : 'paused'
    } catch {}
  }

  let sessionReady = false
  function bindSession(api) {
    const ms = typeof navigator !== 'undefined' && navigator.mediaSession
    if (!ms || sessionReady) return
    sessionReady = true
    const on = (action, fn) => {
      try {
        ms.setActionHandler(action, fn)
      } catch {}
    }
    on('play', () => api.start())
    on('pause', () => api.stop())
    on('stop', () => api.stop())
    on('nexttrack', () => api.next())
    on('previoustrack', () => api.prev())
  }

  function scheduler() {
    while (nextTime < ctx.currentTime + 0.15) {
      scheduleStep(stepIndex, nextTime)
      nextTime += step
      stepIndex++
    }
  }

  const api = {
    async start() {
      if (!ctx) build()
      bindSession(api)
      if (ctx.state === 'suspended') await ctx.resume()
      nodes.master.gain.setTargetAtTime(volume, ctx.currentTime, 0.3)
      if (!timer) {
        nextTime = ctx.currentTime + 0.1
        trackStart = nextTime - lofiState.position
        timer = setInterval(scheduler, 25)
      }
      playing = true
      lofiState.playing = true
      silentLoop()
        ?.play()
        .catch(() => {})
      updateSession()
    },
    async stop() {
      if (!ctx) return
      nodes.master.gain.setTargetAtTime(0, ctx.currentTime, 0.25)
      clearInterval(timer)
      timer = null
      playing = false
      lofiState.playing = false
      keepAlive?.pause()
      updateSession()
      setTimeout(() => !playing && ctx.suspend(), 900)
    },
    setVolume(v) {
      volume = v
      if (ctx && playing) nodes.master.gain.setTargetAtTime(v, ctx.currentTime, 0.1)
    },
    setMusic(on) {
      musicOn = !!on
      lofiState.music = musicOn
      if (ctx) {
        nodes.music.gain.cancelScheduledValues(ctx.currentTime)
        nodes.music.gain.setTargetAtTime(musicOn ? 0.9 : 0, ctx.currentTime, 0.2)
      }
      updateSession()
    },
    /** Ambience levels, 0 to 1 per sound. Sounds that no longer exist are ignored. */
    setMix(m) {
      for (const k of LOFI_MIX_KEYS) if (typeof m?.[k] === 'number') mix[k] = m[k]
      applyMix()
    },
    /** Which ambience sounds are on, for example { rain: true }. */
    setAmbience(a) {
      for (const k of LOFI_MIX_KEYS) if (typeof a?.[k] === 'boolean') ambienceOn[k] = a[k]
      applyMix()
      updateSession()
    },
    onBeat(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    /** Which tracks may play, for example (id) => isTrackUnlocked(id, level). */
    setUnlockCheck(fn) {
      allowed = typeof fn === 'function' ? fn : () => true
    },
    /** Switch music style. Keeps the current track when it already is of that style. */
    setStyle(id) {
      if (track.style === id) return
      api.setTrack(firstTrack(id).id)
    },
    /** Play a track now (with a short dip), or pick it for the next start. */
    setTrack(id) {
      const t = trackById(id)
      if (!t || !allowed(t.id) || t === track) return
      history.push(track.id)
      if (history.length > 50) history.shift()
      if (ctx && playing) {
        const now = ctx.currentTime + 0.05
        dip(now)
        applyTrack(t)
        trackStart = now
        nextTime = now + 0.12
      } else {
        applyTrack(t)
      }
    },
    next() {
      api.setTrack(pickNext(1).id)
    },
    prev() {
      // restart the track when it has played a while, like a music player
      if (playing && lofiState.position > 8) {
        const now = ctx.currentTime + 0.05
        dip(now)
        applyTrack(track)
        trackStart = now
        nextTime = now + 0.12
        return
      }
      let id = history.pop()
      while (id && (!allowed(id) || trackById(id)?.style !== track.style)) id = history.pop()
      const target = id ? trackById(id) : pickNext(-1)
      api.setTrack(target.id)
      if (id) history.pop() // setTrack pushed the one we left, do not bounce back to it
    },
    setShuffle(on) {
      lofiState.shuffle = !!on
    },
    setRepeatOne(on) {
      lofiState.repeatOne = !!on
    },
    get track() {
      return track
    },
    get playing() {
      return playing
    },
    chime() {
      if (!ctx) build()
      const t = ctx.currentTime + 0.05
      ;[76, 79, 84].forEach((n, i) => keys(n, t + i * 0.18, 1.6, 0.12))
    },
  }
  return api
}

// One shared instance so music keeps playing while you move between pages.
/** Reactive mirror so every screen shows the same play state and track. */
export const lofiState = reactive({
  playing: false,
  track: TRACKS[0].id,
  style: TRACKS[0].style,
  bpm: TRACKS[0].bpm,
  length: TRACKS[0].length,
  position: 0, // seconds into the track, updated every beat
  shuffle: false,
  repeatOne: false,
  music: true, // the radio is part of what plays (off: ambience alone)
  chosen: false, // a track was picked or played in this session (before that, show the saved one)
})

/** The track to show before anything plays: the saved one, or the style's first. */
export function savedTrack(settings = {}) {
  const l = settings.lofi || {}
  const t = trackById(l.track)
  return t && (!l.style || t.style === l.style) ? t : firstTrack(l.style || 'music-classic')
}

/** Display names of the ambience sounds. */
export const AMBIENCE_NAMES = { rain: 'Rain', fire: 'Fireplace' }

/** Start with the user's saved room settings (volume, music on or off, ambience, style). */
export async function playWithSettings(settings = {}) {
  const p = lofi()
  // sanitizeLofi also reads settings saved by an older extension (no ambience switches yet)
  const l = sanitizeLofi(settings.lofi)
  p.setVolume(l.volume)
  p.setMusic(l.music)
  p.setMix(l.mix)
  p.setAmbience(l.ambience)
  if (!p.playing) p.setTrack(savedTrack(settings).id)
  await p.start()
}

let shared = null
export function lofi() {
  return (shared ||= createLofi())
}
