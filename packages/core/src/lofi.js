// The study room sound and scene settings (`settings.lofi`): validation shared by the
// backend (settings.update, import) and migrate(). Scenes and music styles are sold in the
// shop (unlocks.js for the catalog, economy.js for owning them).
import { UNLOCKS } from './unlocks.js'
import { trackById } from './tracks.js'
import { shopHint } from './economy.js'

/** The ambience sounds: each one is on or off (`ambience`) with its own level (`mix`). */
export const LOFI_MIX_KEYS = ['rain', 'fire']
/** Ambience sounds of older versions. Saved levels and patches that name them are ignored. */
export const LEGACY_MIX_KEYS = ['cafe', 'noise']
/** Scene names saved before scenes became unlocks. */
export const LEGACY_SCENES = { night: 'scene-night', sunset: 'scene-sunset', morning: 'scene-morning' }

const SCENES = Object.fromEntries(UNLOCKS.filter((u) => u.kind === 'scene').map((u) => [u.id, u]))
const MUSIC = Object.fromEntries(UNLOCKS.filter((u) => u.kind === 'music').map((u) => [u.id, u]))

export const DEFAULT_LOFI = {
  volume: 0.6,
  scene: 'scene-night',
  style: 'music-classic',
  objects: true,
  // the lofi radio plays alone by default, ambience is opt in
  music: true,
  mix: { rain: 0.5, fire: 0.5 },
  ambience: { rain: false, fire: false },
  // track: the last played track id (tracks.js). Left out until one is picked, which means
  // the style's first track.
}

export const normalizeScene = (id) => LEGACY_SCENES[id] || id

const unit = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
const clampUnit = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Ambience from settings saved before it had its own on and off switches. Back then the
 * level was the switch and every room started with rain at 0.5. That exact old default
 * means "never chosen", so it turns into silence. Anything else someone set keeps playing.
 */
function legacyAmbience(mix) {
  const level = (k) => clampUnit(mix?.[k], 0)
  const untouched = (mix?.rain === undefined || mix.rain === 0.5) && ['cafe', 'fire', 'noise'].every((k) => !level(k))
  const out = { mix: { ...DEFAULT_LOFI.mix }, ambience: { ...DEFAULT_LOFI.ambience } }
  if (!isObj(mix) || untouched) return out
  for (const k of LOFI_MIX_KEYS) {
    if (level(k) > 0) {
      out.mix[k] = level(k)
      out.ambience[k] = true
    }
  }
  return out
}

/** Forgiving clean-up for stored or imported values: anything unknown falls back to `base`. */
export function sanitizeLofi(input, base = DEFAULT_LOFI) {
  const src = input && typeof input === 'object' ? input : {}
  const b = base && typeof base === 'object' ? base : DEFAULT_LOFI
  const scene = normalizeScene(src.scene)
  const baseScene = normalizeScene(b.scene)
  const out = {
    volume: clampUnit(src.volume, clampUnit(b.volume, DEFAULT_LOFI.volume)),
    scene: SCENES[scene] ? scene : SCENES[baseScene] ? baseScene : DEFAULT_LOFI.scene,
    style: MUSIC[src.style] ? src.style : MUSIC[b.style] ? b.style : DEFAULT_LOFI.style,
    objects: typeof src.objects === 'boolean' ? src.objects : typeof b.objects === 'boolean' ? b.objects : true,
    music: typeof src.music === 'boolean' ? src.music : typeof b.music === 'boolean' ? b.music : true,
    mix: {},
    ambience: {},
  }
  // settings without the ambience switches come from an older version: convert them once
  const legacy = isObj(src.ambience) ? null : 'mix' in src ? legacyAmbience(src.mix) : null
  const bAmb = isObj(b.ambience) ? b.ambience : DEFAULT_LOFI.ambience
  for (const k of LOFI_MIX_KEYS) {
    out.mix[k] = legacy ? legacy.mix[k] : clampUnit(src.mix?.[k], clampUnit(b.mix?.[k], DEFAULT_LOFI.mix[k]))
    const on = legacy ? legacy.ambience[k] : src.ambience?.[k]
    out.ambience[k] = typeof on === 'boolean' ? on : bAmb[k] === true
  }
  // a track only stays when it is known and belongs to the saved style
  const fits = (id) => trackById(id)?.style === out.style
  const track = fits(src.track) ? src.track : fits(b.track) ? b.track : null
  if (track) out.track = track
  return out
}

/**
 * Strict merge of a settings.update patch into the saved lofi settings.
 * Returns { value } or { error }. `owns(id)` says whether a scene or music style is owned.
 * It is only checked when the value differs from the saved one, so what is saved always stays.
 */
export function mergeLofi(current, patch, owns) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { error: 'Room sound settings must be an object.' }
  const cur = sanitizeLofi(current)
  const value = { ...cur, mix: { ...cur.mix }, ambience: { ...cur.ambience } }
  for (const key of Object.keys(patch)) {
    if (!['volume', 'scene', 'style', 'objects', 'music', 'mix', 'ambience', 'track'].includes(key))
      return { error: `Unknown room setting "${key}".` }
  }
  if ('volume' in patch) {
    if (!unit(patch.volume)) return { error: 'Volume must be between 0 and 1.' }
    value.volume = patch.volume
  }
  if ('objects' in patch) {
    if (typeof patch.objects !== 'boolean') return { error: 'Show objects must be on or off.' }
    value.objects = patch.objects
  }
  if ('music' in patch) {
    if (typeof patch.music !== 'boolean') return { error: 'Music must be on or off.' }
    value.music = patch.music
  }
  if ('mix' in patch) {
    const mix = patch.mix
    if (!isObj(mix)) return { error: 'Ambience mix must be an object.' }
    for (const [k, v] of Object.entries(mix)) {
      // an older copy of the app still sends the sounds that are gone: skip them
      if (LEGACY_MIX_KEYS.includes(k)) continue
      if (!LOFI_MIX_KEYS.includes(k)) return { error: `Unknown ambience sound "${k}".` }
      if (!unit(v)) return { error: 'Ambience levels must be between 0 and 1.' }
      value.mix[k] = v
    }
  }
  if ('ambience' in patch) {
    const amb = patch.ambience
    if (!isObj(amb)) return { error: 'Ambience must be an object.' }
    for (const [k, v] of Object.entries(amb)) {
      if (!LOFI_MIX_KEYS.includes(k)) return { error: `Unknown ambience sound "${k}".` }
      if (typeof v !== 'boolean') return { error: 'Each ambience sound must be on or off.' }
      value.ambience[k] = v
    }
  }
  if ('scene' in patch) {
    const id = normalizeScene(patch.scene)
    const u = SCENES[id]
    if (!u) return { error: 'Unknown scene.' }
    if (id !== cur.scene && !owns(id)) return { error: shopHint(u) }
    value.scene = id
  }
  if ('style' in patch) {
    const u = MUSIC[patch.style]
    if (!u) return { error: 'Unknown music style.' }
    if (patch.style !== cur.style && !owns(patch.style)) return { error: shopHint(u) }
    value.style = patch.style
  }
  if ('track' in patch) {
    if (patch.track === null) delete value.track
    else {
      const t = trackById(patch.track)
      if (!t) return { error: 'Unknown track.' }
      const u = MUSIC[t.style]
      if (patch.track !== cur.track && !owns(u.id)) return { error: `${t.name} is part of ${u.name}. ${shopHint(u)}` }
      if (t.style !== value.style) return { error: `${t.name} is not a ${MUSIC[value.style].name} track.` }
      value.track = patch.track
    }
  } else if (value.track && trackById(value.track).style !== value.style) delete value.track
  return { value }
}
