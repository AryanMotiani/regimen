// Ambience for the study room: rain and a fireplace, synthesized, no audio files.
// The two are built to sound nothing alike:
//  rain  a bright, steady hiss (most energy from 1 to 8 kHz) with thousands of tiny droplet
//        ticks and plinks spread across the stereo field, slow gusts, and a soft low rumble
//  fire  a warm, dark roar (most energy below 400 Hz) that flickers a few times a second,
//        with sparse, very sharp crackles in little bursts and the odd louder pop of wood
// Droplets and crackles are rendered once into buffers in plain JS (a crackle is a few
// samples wide, finer than scheduling Web Audio nodes allows) and looped at lengths that
// never line up, so the pattern does not audibly repeat.

/** Small seeded random numbers, so the rendered loops are the same every time. */
export function seeded(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** RBJ band pass (constant peak gain) coefficients. */
function bandpass(sr, freq, q) {
  const w = (2 * Math.PI * freq) / sr
  const alpha = Math.sin(w) / (2 * q)
  const a0 = 1 + alpha
  return { b0: alpha / a0, b2: -alpha / a0, a1: (-2 * Math.cos(w)) / a0, a2: (1 - alpha) / a0 }
}

/** Adds `fn(k)` for k = 0..len-1 at `at` into both channels, wrapping so the loop is seamless. */
function stamp(L, R, at, len, pan, fn) {
  const n = L.length
  const gl = Math.cos((pan * Math.PI) / 2)
  const gr = Math.sin((pan * Math.PI) / 2)
  for (let k = 0; k < len; k++) {
    const v = fn(k)
    const i = (at + k) % n
    L[i] += v * gl
    R[i] += v * gr
  }
}

function scaleTo(chans, rms) {
  let sum = 0
  let count = 0
  for (const c of chans) for (let i = 0; i < c.length; i++, count++) sum += c[i] * c[i]
  const g = sum ? rms / Math.sqrt(sum / count) : 1
  for (const c of chans) for (let i = 0; i < c.length; i++) c[i] *= g
  return chans
}

/**
 * Rain drops: short resonant noise ticks (drops on leaves, glass and the sill) and a few
 * small rising plinks (a drop landing in a puddle). Returns [left, right].
 */
export function renderRainDrops(sr, seconds, seed = 1, perSecond = 70) {
  const r = seeded(seed)
  const n = Math.round(sr * seconds)
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  const count = Math.round(perSecond * seconds)
  for (let d = 0; d < count; d++) {
    const at = Math.floor(r() * n)
    const pan = 0.1 + r() * 0.8
    const near = r() < 0.15
    const amp = near ? 0.35 + r() * 0.4 : 0.06 + r() * 0.16
    if (r() < 0.22) {
      // plink: a little bubble whose pitch rises as it closes
      const f0 = 1700 + r() * 2400
      const rise = 0.25 + r() * 0.5
      const len = Math.round(sr * (0.014 + r() * 0.03))
      let ph = 0
      stamp(L, R, at, len, pan, (k) => {
        const t = k / len
        ph += (2 * Math.PI * f0 * (1 + rise * t)) / sr
        return Math.sin(ph) * Math.exp(-4.5 * t) * Math.min(1, k / (sr * 0.0006)) * amp * 0.55
      })
    } else {
      // tick: a burst of noise through a resonant band pass
      const c = bandpass(sr, 2200 + r() * 5600, 1.2 + r() * 3.5)
      const tau = sr * (0.0015 + r() * 0.006)
      const len = Math.round(tau * 6)
      let x1 = 0
      let x2 = 0
      let y1 = 0
      let y2 = 0
      stamp(L, R, at, len, pan, (k) => {
        const x = (r() * 2 - 1) * Math.exp(-k / tau)
        const y = c.b0 * x + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
        return y * amp * 2.2
      })
    }
  }
  return [L, R]
}

/**
 * The fire: a dark flickering roar plus crackles. `bed: false` renders the crackles alone
 * (the second, differently sized loop on top). Returns [left, right].
 */
export function renderFire(sr, seconds, seed = 1, { bed = true, crackles = 5 } = {}) {
  const r = seeded(seed)
  const n = Math.round(sr * seconds)
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  if (bed) {
    // brown noise, low passed again, under a flicker: a random walk smoothed to a few Hz
    // and a slower swell, both seamless across the loop (cross faded over the last second)
    const fade = Math.round(sr)
    const raw = [new Float32Array(n + fade), new Float32Array(n + fade)]
    const flick = new Float32Array(n + fade)
    let f = 0
    let target = 0
    let fs = 0
    for (let i = 0; i < n + fade; i++) {
      if (i % Math.round(sr / 9) === 0) target = r() * 2 - 1
      f += (target - f) * (40 / sr)
      fs += (f - fs) * (25 / sr)
      flick[i] = 1 + 0.45 * fs + 0.2 * Math.sin((2 * Math.PI * i) / (sr * 3.7))
    }
    // the roar: noise through a leaky integrator (flat to about 200 Hz, then falling) and
    // two gentle low passes, so it sits in the low mids rather than a sub rumble that small
    // speakers can not play
    const k1 = 1 - Math.exp((-2 * Math.PI * 200) / sr)
    const k2 = 1 - Math.exp((-2 * Math.PI * 900) / sr)
    for (const ch of raw) {
      let b = 0
      let lp = 0
      let lp2 = 0
      for (let i = 0; i < ch.length; i++) {
        b += (r() * 2 - 1 - b) * k1
        lp += (b - lp) * k2
        lp2 += (lp - lp2) * k2
        ch[i] = lp2 * flick[i]
      }
    }
    for (let c = 0; c < 2; c++) {
      const out = c ? R : L
      const ch = raw[c]
      for (let i = 0; i < n; i++) out[i] = ch[i]
      for (let i = 0; i < fade; i++) {
        const t = i / fade
        out[i] = ch[i] * t + ch[n + i] * (1 - t)
      }
    }
    scaleTo([L, R], 0.16)
  }
  // crackles: bursts of 1 to 7 clicks a few ms apart, every click a few samples wide
  const events = Math.round(crackles * seconds)
  for (let e = 0; e < events; e++) {
    let at = Math.floor(r() * n)
    const pan = 0.3 + r() * 0.4
    const clicks = 1 + Math.floor(r() * r() * 7)
    const loud = Math.pow(r(), 2.2)
    for (let c = 0; c < clicks; c++) {
      const amp = (0.15 + 0.85 * loud) * (c ? 0.35 + r() * 0.5 : 1)
      const tau = sr * (0.00012 + r() * 0.0005)
      const len = Math.round(tau * 8) + 2
      const sign = r() < 0.5 ? -1 : 1
      let prev = 0
      stamp(L, R, at, len, pan + (r() - 0.5) * 0.1, (k) => {
        // a spike, then a little ringing noise, differentiated so it stays bright and dry
        const x = (k === 0 ? sign : (r() * 2 - 1) * 0.6) * Math.exp(-k / tau)
        const y = x - prev * 0.6
        prev = x
        return y * amp * 0.9
      })
      at += Math.round(sr * (0.003 + r() * r() * 0.06))
    }
    // now and then wood pops: a resonant knock with a low thump under it
    if (r() < 0.06) {
      const c = bandpass(sr, 500 + r() * 700, 4)
      const len = Math.round(sr * 0.09)
      let x1 = 0
      let x2 = 0
      let y1 = 0
      let y2 = 0
      const amp = 0.5 + r() * 0.4
      stamp(L, R, at, len, pan, (k) => {
        const t = k / sr
        const x = (r() * 2 - 1) * Math.exp(-t / 0.004)
        const y = c.b0 * x + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
        x2 = x1
        x1 = x
        y2 = y1
        y1 = y
        return (y * 3 + Math.sin(2 * Math.PI * 85 * t) * Math.exp(-t / 0.03) * 0.25) * amp
      })
    }
  }
  return [L, R]
}

function toBuffer(ctx, [L, R]) {
  const buf = ctx.createBuffer(2, L.length, ctx.sampleRate)
  buf.getChannelData(0).set(L)
  buf.getChannelData(1).set(R)
  return buf
}

function loopOf(ctx, buf, offset = 0) {
  const s = ctx.createBufferSource()
  s.buffer = buf
  s.loop = true
  s.start(0, offset % buf.duration)
  return s
}

/** How loud each sound is at level 1, so both sit at a similar loudness under the music. */
export const AMBIENCE_GAIN = { rain: 0.55, fire: 1.1 }

const BUILD = {
  // noise: { pink, brown } AudioBuffers of a few seconds
  rain(ctx, out, noise) {
    // the hiss of steady rain: pink noise, band limited to where rain lives
    const bed = loopOf(ctx, noise.pink, Math.random() * 2)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 700
    hp.Q.value = 0.5
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 7800
    const shelf = ctx.createBiquadFilter()
    shelf.type = 'peaking'
    shelf.frequency.value = 3800
    shelf.gain.value = 4
    shelf.Q.value = 0.7
    // slow gusts: two detuned slow oscillators nudge the level
    const gust = ctx.createGain()
    gust.gain.value = 0.7
    for (const [hz, depth] of [
      [0.061, 0.12],
      [0.17, 0.06],
    ]) {
      const o = ctx.createOscillator()
      o.frequency.value = hz
      const d = ctx.createGain()
      d.gain.value = depth
      o.connect(d).connect(gust.gain)
      o.start()
    }
    bed.connect(hp).connect(shelf).connect(lp).connect(gust).connect(out)
    // the rumble of rain on a roof and the street, far away
    const low = loopOf(ctx, noise.brown, Math.random() * 2)
    const lowLp = ctx.createBiquadFilter()
    lowLp.type = 'lowpass'
    lowLp.frequency.value = 180
    const lowGain = ctx.createGain()
    lowGain.gain.value = 0.32
    low.connect(lowLp).connect(lowGain).connect(out)
    // droplets: two loops of different lengths, so the pattern never repeats exactly
    const dropGain = ctx.createGain()
    dropGain.gain.value = 1.5
    for (const [secs, seed, rate] of [
      [7.3, 11, 60],
      [11.9, 23, 45],
    ])
      loopOf(ctx, toBuffer(ctx, renderRainDrops(ctx.sampleRate, secs, seed, rate))).connect(dropGain)
    dropGain.connect(out)
  },
  fire(ctx, out) {
    const warm = ctx.createBiquadFilter()
    warm.type = 'peaking'
    warm.frequency.value = 260
    warm.Q.value = 0.8
    warm.gain.value = 3
    const floor = ctx.createBiquadFilter()
    floor.type = 'highpass'
    floor.frequency.value = 60
    const top = ctx.createBiquadFilter()
    top.type = 'lowpass'
    top.frequency.value = 9500
    warm.connect(floor).connect(top).connect(out)
    loopOf(ctx, toBuffer(ctx, renderFire(ctx.sampleRate, 17.9, 5)), Math.random() * 10).connect(warm)
    loopOf(ctx, toBuffer(ctx, renderFire(ctx.sampleRate, 12.7, 9, { bed: false, crackles: 2.5 }))).connect(warm)
  },
}

/**
 * The ambience mixer on an AudioContext. Each sound's graph is built the first time it is
 * turned on, so a room that never uses ambience never renders any.
 */
export function createAmbience(ctx, destination, noise) {
  const sounds = {}
  const targets = {}
  const apply = (key) => sounds[key]?.gain.setTargetAtTime(targets[key], ctx.currentTime, 0.35)
  return {
    /** Sets one sound on or off at a level from 0 to 1. Unknown sounds are ignored. */
    set(key, on, level) {
      if (!BUILD[key]) return
      targets[key] = on ? Math.max(0, Math.min(1, level)) * AMBIENCE_GAIN[key] : 0
      if (sounds[key] !== undefined) return apply(key)
      if (!targets[key]) return
      // rendering takes a moment (around 0.1 s): let the switch that asked for it paint first
      sounds[key] = null
      setTimeout(() => {
        const g = ctx.createGain()
        g.gain.value = 0
        g.connect(destination)
        BUILD[key](ctx, g, noise)
        sounds[key] = g
        apply(key)
      }, 0)
    },
  }
}
