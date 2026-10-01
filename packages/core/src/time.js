// Local-clock time helpers. Regimen deliberately reads the system clock and
// stores no timezone (see docs/ARCHITECTURE.md, "Time and the clock"). All instants are epoch ms.

export const MINUTE = 60_000
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

/** ISO weekday, 1 = Monday ... 7 = Sunday */
export function isoWeekday(ms) {
  const d = new Date(ms).getDay()
  return d === 0 ? 7 : d
}

export function startOfDay(ms) {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Adds calendar days while keeping the local wall-clock time (DST safe). */
export function addDays(ms, n) {
  const d = new Date(ms)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/** Local midnight of `dayMs` plus `minutes` of wall-clock time. */
export function atMinutes(dayMs, minutes) {
  const d = new Date(startOfDay(dayMs))
  d.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return d.getTime()
}

export function minutesOfDay(ms) {
  const d = new Date(ms)
  return d.getHours() * 60 + d.getMinutes()
}

/** 'YYYY-MM-DD' in local time */
export function dateKey(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function fromDateKey(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

export function formatMinutes(minutes) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(Math.floor(minutes / 60) % 24)}:${p(minutes % 60)}`
}

export function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}
