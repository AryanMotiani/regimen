// Landing page media: screenshots of the app and a short demo video, made from a
// believable level 14 demo user, saved to apps/web/public/media for the landing page.
// Run it again whenever the UI changes:
//
//   node scripts/landing-media.mjs            (builds apps/web first if dist is missing)
//   node scripts/landing-media.mjs --build    (always rebuild)
//   node scripts/landing-media.mjs --no-video (screenshots only)
//
// Needs Playwright's Chromium (npx playwright install chromium) and ffmpeg with
// libwebp, libx264 and libvpx-vp9. Uses sharp instead of ffmpeg for images when installed.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync, execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { createBackend, progressOf, toErrorPayload } from '../packages/core/src/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB = path.join(root, 'apps/web')
const OUT = path.join(WEB, 'public/media')
const TARGET_LEVEL = 14
const PORT = Number(process.env.PORT || 4199)
const BASE = `http://localhost:${PORT}/`
const args = process.argv.slice(2)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-landing-media-'))

// ------------------------------------------------------------ demo state
async function seed() {
  let saved = null
  const backend = createBackend({
    storage: { load: async () => saved, save: async (s) => (saved = structuredClone(s)) },
    hashIterations: 1000,
  })
  const run = async (cmd, payload) => (await backend.dispatch(cmd, payload)).data
  await run('setup.pin', { pin: 'demo-pin-2468' })
  for (const step of ['recoverySaved', 'emergencyHelp', 'dohReviewed']) await run('setup.step', { step }).catch(() => {})

  const DAY = 864e5
  const HOUR = 36e5
  const now = Date.now()
  const everyDay = [1, 2, 3, 4, 5, 6, 7]
  const homework = await run('tasks.create', { title: 'Chemistry homework', priority: 'high', deadline: now + 5 * HOUR }).catch(() => null)
  await run('rules.create', {
    name: 'Evening homework',
    mode: 'gated',
    siteIds: ['reddit', 'netflix', 'youtube'],
    days: everyDay,
    start: 1140,
    end: 1260,
    taskIds: homework ? [homework.id] : [],
  }).catch(() => {})
  await run('rules.create', {
    name: 'Sleep',
    mode: 'hard',
    siteIds: ['instagram', 'tiktok'],
    days: everyDay,
    start: 1380,
    end: 420,
  }).catch(() => {})

  const s = saved
  s.onboarding.completed = true
  for (const k of Object.keys(s.onboarding.steps || {})) s.onboarding.steps[k] = true
  s.settings.theme = 'light'

  // Deterministic "random" history so every run looks the same.
  let r = 7
  const rnd = () => (r = (r * 16807) % 2147483647) / 2147483647
  const sod = (t) => new Date(t).setHours(0, 0, 0, 0)
  const titles = [
    'Read chapter 4',
    'Problem set 3',
    'Essay outline',
    'Flashcards',
    'Lab report',
    'Revise notes',
    'Email professor',
    'Past paper',
  ]
  const priorities = ['low', 'medium', 'high']
  const task = (fields) => ({
    notes: '',
    startAt: null,
    tags: [],
    ruleId: null,
    parentId: null,
    forwardCount: 0,
    forwardedUntil: null,
    recurrence: null,
    timeSpentSec: 0,
    ...fields,
  })
  let id = 0
  const STREAK = 21
  const HISTORY = 340
  s.createdAt = now - (HISTORY + 10) * DAY
  for (let d = HISTORY; d >= 1; d--) {
    const n = rnd() < 0.25 ? 0 : rnd() < 0.7 ? 1 : 2
    for (let i = 0; i < n; i++) {
      const deadline = sod(now - d * DAY) + 20 * HOUR
      // everything is finished (nothing shows as overdue), older work sometimes late,
      // the last three weeks on time, so the streak is a proud one
      const late = d > STREAK && rnd() < 0.14
      s.tasks.push(
        task({
          id: 'demo' + id++,
          title: titles[Math.floor(rnd() * titles.length)],
          priority: priorities[Math.floor(rnd() * 3)],
          deadline,
          status: 'done',
          completedAt: deadline + (late ? 5 : -3) * HOUR,
          createdAt: deadline - 2 * DAY,
        }),
      )
    }
  }
  for (const [title, priority, h] of [
    ['Finish calculus worksheet', 'high', 3],
    ['Read 20 pages of Dune', 'low', 6],
    ['Outline history essay', 'medium', 5],
    ['Physics flashcards', 'medium', 30],
  ])
    s.tasks.push(task({ id: 'demo' + id++, title, priority, deadline: now + h * HOUR, status: 'todo', completedAt: null, createdAt: now }))

  s.habits = [
    { id: 'h1', name: 'Gym', emoji: '🏃', color: 'green', days: [1, 3, 5, 6], createdAt: now - HISTORY * DAY, archived: false },
    { id: 'h2', name: 'Read 10 pages', emoji: '📚', color: 'violet', days: everyDay, createdAt: now - HISTORY * DAY, archived: false },
    { id: 'h3', name: 'Sleep by midnight', emoji: '🛏️', color: 'sky', days: everyDay, createdAt: now - 150 * DAY, archived: false },
  ]
  s.habitLogs = { h1: {}, h2: {}, h3: {} }
  const key = (t) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }
  for (let d = HISTORY; d >= 1; d--)
    for (const h of ['h1', 'h2', 'h3']) if (d < 12 || rnd() < 0.62) s.habitLogs[h][key(now - d * DAY)] = true
  s.focus.history = Array.from({ length: 20 }, (_, i) => ({
    id: 'f' + i,
    startedAt: now - i * 2 * DAY,
    endedAt: now - i * 2 * DAY + 50 * 6e4,
    focusedMin: 50,
    completed: true,
  }))
  s.log.push(
    ...Array.from({ length: 30 }, (_, i) => ({
      id: 'l' + i,
      type: i % 3 ? 'window_unlocked' : 'failsafe_resisted',
      at: now - i * 3 * DAY,
    })),
  )
  // Land on the target level whatever the XP rules are: thin out old history when above it,
  // top up focus sessions when below.
  const over = (p) => p.level > TARGET_LEVEL || (p.level === TARGET_LEVEL && p.progress > 0.6)
  while (over(progressOf(s)) && s.tasks.length > 50) s.tasks.splice(Math.floor(rnd() * s.tasks.length * 0.6), 1)
  for (let i = s.focus.history.length; progressOf(s).level < TARGET_LEVEL && i < 400; i++)
    s.focus.history.push({ id: 'f' + i, startedAt: now - i * DAY, endedAt: now - i * DAY + 50 * 6e4, focusedMin: 50, completed: true })
  // the starter gift is already claimed, so its welcome card does not cover the room
  if (s.shop) s.shop.giftAt = s.shop.giftAt || now - DAY
  return s
}

/** A variant of the demo state. Only touches fields that exist, so it survives settings reworks. */
function variant(base, { mode, theme, scene } = {}) {
  const s = structuredClone(base)
  if (mode) s.settings.uiMode = mode
  if (theme) s.settings.theme = theme
  if (scene) {
    s.settings.lofi = s.settings.lofi || {}
    s.settings.lofi.scene = scene
  }
  return s
}

// ------------------------------------------------------------ preview server
async function startServer() {
  // On Windows npx is npx.cmd; on Unix it's just npx.
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const child = spawn(npxCmd, ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: WEB,
    // detached only works for process-group kill on Unix; skip on Windows
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE)
      if (res.ok) return child
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  stopServer(child)
  throw new Error(`vite preview did not start on port ${PORT}`)
}
function stopServer(child) {
  try {
    if (process.platform === 'win32') {
      // taskkill /T kills the whole child tree on Windows
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' })
    } else {
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {}
}

// ------------------------------------------------------------ image conversion
let sharp = null
try {
  sharp = (await import('sharp')).default
} catch {}
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Saves <name>.webp (1440 wide) and <name>-800.webp. Falls back to PNG without sharp or ffmpeg. */
async function saveImage(png, name) {
  const out = []
  for (const [suffix, width, quality] of [
    ['', 1440, 78],
    ['-800', 800, 76],
  ]) {
    if (sharp) {
      const file = path.join(OUT, `${name}${suffix}.webp`)
      await sharp(png).resize({ width }).webp({ quality }).toFile(file)
      out.push(file)
    } else if (hasFfmpeg) {
      const file = path.join(OUT, `${name}${suffix}.webp`)
      execFileSync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        png,
        '-vf',
        `scale=${width}:-2:flags=lanczos`,
        '-c:v',
        'libwebp',
        '-quality',
        String(quality),
        file,
      ])
      out.push(file)
    } else {
      const file = path.join(OUT, `${name}${suffix}.png`)
      fs.copyFileSync(png, file)
      out.push(file)
    }
  }
  return out
}

// ------------------------------------------------------------ browser helpers
/**
 * A browser context that looks like it has the extension installed: the page finds the
 * extension marker and its messages are answered by a demo backend running here in Node,
 * the same way the real extension bridge answers them. So no "install the extension" hints.
 */
async function contextFor(browser, state, level, extra = {}) {
  let saved = structuredClone(state)
  const backend = createBackend({
    storage: { load: async () => saved, save: async (s) => (saved = structuredClone(s)) },
    hashIterations: 1000,
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, ...extra })
  await context.exposeBinding('__fgDemoBackend', async (_source, cmd, payload) => {
    if (cmd === 'hello') return { ok: true, data: { approved: true, version: 'demo' } }
    try {
      const res = await backend.dispatch(cmd, payload)
      return { ok: true, data: res.data, state: res.state, now: Date.now() }
    } catch (e) {
      return { ok: false, error: toErrorPayload(e) }
    }
  })
  await context.addInitScript((lvl) => {
    // init scripts can run before <html> exists: mark it as soon as it does
    const mark = () => document.documentElement && (document.documentElement.dataset.regimenExtension = 'demo')
    if (!mark()) new MutationObserver((_, o) => mark() && o.disconnect()).observe(document, { childList: true })
    window.addEventListener('message', async (e) => {
      if (e.source !== window || e.data?.__fg !== 'req') return
      const res = await window.__fgDemoBackend(e.data.cmd, e.data.payload)
      window.postMessage({ __fg: 'res', id: e.data.id, res }, location.origin)
    })
    if (sessionStorage.getItem('fg-seeded')) return
    sessionStorage.setItem('fg-seeded', '1')
    localStorage.setItem('regimen:seen-level', String(lvl))
    localStorage.setItem('regimen:room-drawer', 'false')
    // no first-run tours in the marketing media
    const pages = ['room', 'today', 'tasks', 'schedule', 'blocking', 'habits', 'stats', 'settings', 'install', 'decorate', 'shop']
    localStorage.setItem('regimen:tours-seen', JSON.stringify(pages))
  }, level)
  return context
}

/** Toasts and celebration pop ups are noise in a screenshot. */
const quiet = (page) =>
  page.evaluate(() => {
    document.querySelectorAll('[role=status]').forEach((e) => e.closest('.fixed')?.remove())
  })

const problems = []
async function step(label, fn) {
  try {
    await fn()
  } catch (e) {
    problems.push(`${label}: ${e.message.split('\n')[0]}`)
  }
}

/**
 * Gets the shop on screen. The router sends unknown routes back to the room, so a hash that
 * still says #/shop means the page exists. Otherwise it tries the shop tab in decorate mode.
 */
async function openShop(page) {
  if (new URL(page.url()).hash.startsWith('#/shop')) return true
  await page.goto(BASE + '#/')
  await page.waitForLoadState('networkidle')
  await page.waitForTimeout(1200)
  await quiet(page)
  await page.keyboard.press('d')
  await page.waitForTimeout(900)
  const tab = page.getByRole('tab', { name: /shop/i }).or(page.getByRole('button', { name: /^shop$/i }))
  if (!(await tab.count())) return false
  await tab.first().click()
  await page.waitForTimeout(900)
  return true
}

// ------------------------------------------------------------ screenshots
async function screenshots(browser, base, level) {
  const shots = [
    { name: 'room-night', route: '/', state: { mode: 'game', scene: 'scene-night' } },
    { name: 'room-morning', route: '/', state: { mode: 'game', scene: 'scene-morning' } },
    { name: 'today', route: '/today', state: { mode: 'game' } },
    { name: 'tasks', route: '/tasks', state: { mode: 'game' } },
    { name: 'habits', route: '/habits', state: { mode: 'game' } },
    { name: 'stats', route: '/stats', state: { mode: 'game' } },
    { name: 'decorate', route: '/', state: { mode: 'game', scene: 'scene-night' }, action: 'decorate' },
    { name: 'room-drawer', route: '/', state: { mode: 'game', scene: 'scene-night' }, action: 'drawer' },
    { name: 'calm-today', route: '/today', state: { mode: 'minimal' } },
    { name: 'calm-room', route: '/', state: { mode: 'minimal', scene: 'scene-morning' } },
    // the coin shop: its own page if the app has one, else the shop tab of the decorate panel.
    // Optional, skipped quietly when neither exists yet.
    { name: 'shop', route: '/shop', state: { mode: 'game', scene: 'scene-night' }, action: 'shop', optional: true },
  ]
  const made = []
  for (const shot of shots) {
    await step(shot.name, async () => {
      const context = await contextFor(browser, variant(base, shot.state), level)
      const page = await context.newPage()
      page.on('pageerror', (e) => problems.push(`${shot.name}: ${e.message}`))
      await page.goto(BASE + '#' + shot.route)
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(1500)
      await quiet(page)
      if (shot.action === 'shop' && !(await openShop(page))) {
        console.log(`> ${shot.name}: no shop page or shop tab yet, skipped`)
        await context.close()
        return
      }
      if (shot.action === 'decorate') {
        await page.keyboard.press('d')
        await page.waitForTimeout(900)
      }
      if (shot.action === 'drawer') {
        await page.keyboard.press('t')
        await page.waitForTimeout(900)
      }
      await quiet(page)
      const png = path.join(TMP, shot.name + '.png')
      await page.screenshot({ path: png })
      made.push(...(await saveImage(png, shot.name)))
      await context.close()
    })
  }
  return made
}

// ------------------------------------------------------------ demo video
// A soft cursor, since recorded video has none, and a ring on every click.
function cursorScript() {
  const css = `#fg-cursor{position:fixed;left:0;top:0;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
    background:rgba(255,255,255,.9);border:2px solid rgba(20,16,40,.55);box-shadow:0 2px 10px rgba(0,0,0,.35);z-index:2147483647;
    pointer-events:none;transition:transform .12s ease}#fg-cursor.down{transform:scale(.7)}
    .fg-ring{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid rgba(255,214,102,.95);
    z-index:2147483646;pointer-events:none;animation:fg-ring .5s ease-out forwards}
    @keyframes fg-ring{from{transform:scale(.3);opacity:1}to{transform:scale(1.4);opacity:0}}`
  const add = () => {
    if (document.getElementById('fg-cursor')) return
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    const dot = document.createElement('div')
    dot.id = 'fg-cursor'
    dot.style.transform = 'translate(-100px,-100px)'
    document.body.appendChild(dot)
    let x = -100
    let y = -100
    addEventListener(
      'mousemove',
      (e) => {
        x = e.clientX
        y = e.clientY
        dot.style.left = x + 'px'
        dot.style.top = y + 'px'
        dot.style.transform = ''
      },
      true,
    )
    addEventListener('mousedown', () => dot.classList.add('down'), true)
    addEventListener(
      'mouseup',
      () => {
        dot.classList.remove('down')
        const ring = document.createElement('div')
        ring.className = 'fg-ring'
        ring.style.left = x + 'px'
        ring.style.top = y + 'px'
        document.body.appendChild(ring)
        setTimeout(() => ring.remove(), 600)
      },
      true,
    )
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', add)
  else add()
}

async function video(browser, base, level) {
  const dir = path.join(TMP, 'video')
  const context = await contextFor(browser, variant(base, { mode: 'game', scene: 'scene-night' }), level, {
    deviceScaleFactor: 1,
    recordVideo: { dir, size: { width: 1280, height: 800 } },
  })
  await context.addInitScript(cursorScript)
  const page = await context.newPage()
  page.on('pageerror', (e) => problems.push(`video: ${e.message}`))
  const started = Date.now()
  const wait = (ms) => page.waitForTimeout(ms)
  // glide to an element's centre, then click it
  async function glide(locator, { click = true, timeout = 3000 } = {}) {
    const el = locator.first()
    await el.waitFor({ state: 'visible', timeout })
    const box = await el.boundingBox()
    if (!box) throw new Error('no box')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 24 })
    await wait(250)
    if (click) await el.click()
  }
  async function go(route) {
    await page.goto(BASE + '#' + route)
    await page.waitForLoadState('networkidle')
    await wait(700)
    await quiet(page)
  }

  await go('/')
  await page.mouse.move(640, 420)
  await wait(2800)
  await page.mouse.move(420, 360, { steps: 40 })
  await wait(1200)

  // add a task in the drawer, then complete it for the XP pop
  await step('video: open tasks', async () => {
    await glide(page.getByRole('tab', { name: /Tasks/ }).first())
    await wait(900)
  })
  const title = 'Finish biology notes'
  await step('video: add task', async () => {
    const input = page.getByLabel('New task')
    await glide(input)
    await input.pressSequentially(title, { delay: 70 })
    await wait(300)
    await input.press('Enter')
    await wait(1100)
  })
  await step('video: complete task', async () => {
    await glide(page.getByRole('button', { name: `Complete ${title}` }))
    await wait(2200)
  })
  await step('video: habits tab', async () => {
    await glide(page.getByRole('tab', { name: /Habits/ }).first())
    await wait(1400)
    const check = page.locator('[aria-label="Room drawer"] button', { hasText: 'Read 10 pages' })
    if (await check.count()) {
      await glide(check)
      await wait(1400)
    }
  })
  await step('video: progress tab', async () => {
    await glide(page.getByRole('tab', { name: /Progress/ }).first())
    await wait(2200)
  })

  // the full pages: habits year view and accountability
  await step('video: habits page', async () => {
    await go('/habits')
    await page.mouse.move(700, 300, { steps: 20 })
    await wait(1200)
    await page.mouse.wheel(0, 420)
    await wait(1800)
  })
  await step('video: stats page', async () => {
    await go('/stats')
    await page.mouse.move(600, 380, { steps: 20 })
    await wait(2000)
    await page.mouse.wheel(0, 380)
    await wait(1600)
  })

  // back in the room: decorate mode, place something
  await step('video: decorate', async () => {
    await go('/')
    await wait(900)
    await page.keyboard.press('d')
    await wait(1300)
    const place = page.getByRole('button', { name: /^Place / })
    for (let i = 0; i < 2; i++) {
      if (!(await place.count())) break
      await glide(place.nth(i), { click: false })
      await place.nth(i).focus()
      await page.keyboard.press('Enter')
      await wait(1300)
    }
    await wait(900)
    await page.keyboard.press('Escape')
    await wait(1200)
  })
  await step('video: morning scene', async () => {
    await page.keyboard.press('c')
    await wait(900)
    const morning = page.locator('[aria-label="Scene and music"] button[title*="orning" i]')
    if (await morning.count()) {
      await glide(morning)
      await wait(1500)
    }
    await page.keyboard.press('Escape')
    await wait(2500)
  })
  const seconds = (Date.now() - started) / 1000
  const recorded = await page.video()?.path()
  await context.close()
  return { recorded, seconds }
}

function encodeVideo(src) {
  const mp4 = path.join(OUT, 'demo.mp4')
  const webm = path.join(OUT, 'demo.webm')
  const poster = path.join(OUT, 'demo-poster.webp')
  // Playwright starts recording before the first paint: trim the blank first half second.
  const common = ['-y', '-loglevel', 'error', '-ss', '0.6', '-i', src, '-an', '-vf', 'fps=30,scale=1280:-2:flags=lanczos']
  execFileSync('ffmpeg', [
    ...common,
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    '28',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    mp4,
  ])
  execFileSync('ffmpeg', [
    ...common,
    '-c:v',
    'libvpx-vp9',
    '-b:v',
    '0',
    '-crf',
    '40',
    '-row-mt',
    '1',
    '-deadline',
    'good',
    '-cpu-used',
    '4',
    webm,
  ])
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    '2.5',
    '-i',
    src,
    '-frames:v',
    '1',
    '-c:v',
    'libwebp',
    '-quality',
    '78',
    poster,
  ])
  return [mp4, webm, poster]
}

// ------------------------------------------------------------ main
if (args.includes('--build') || !fs.existsSync(path.join(WEB, 'dist/index.html'))) {
  console.log('> building apps/web')
  execSync('npm run build -w apps/web', { cwd: root, stdio: 'inherit' })
}
fs.mkdirSync(OUT, { recursive: true })
const base = await seed()
const level = progressOf(base).level
console.log(`> demo user is level ${level}`, progressOf(base).breakdown)
if (args.includes('--seed-only')) process.exit(0)
const server = await startServer()
const browser = await chromium.launch()
const made = []
try {
  made.push(...(await screenshots(browser, base, level)))
  if (!args.includes('--no-video')) {
    if (!hasFfmpeg) problems.push('video: ffmpeg is not installed, skipped')
    else {
      const { recorded, seconds } = await video(browser, base, level)
      console.log(`> recorded ${seconds.toFixed(1)} s`)
      if (recorded) made.push(...encodeVideo(recorded))
    }
  }
} catch (e) {
  problems.push(e.message)
} finally {
  await browser.close()
  stopServer(server)
  fs.rmSync(TMP, { recursive: true, force: true })
}
let total = 0
for (const f of made) {
  const size = fs.statSync(f).size
  total += size
  console.log(`saved ${path.relative(root, f)}  ${(size / 1024).toFixed(0)} KB`)
}
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`)
if (problems.length) {
  console.error('Problems:\n' + problems.join('\n'))
  process.exitCode = 1
}
