import { test, expect } from '@playwright/test'
import { createBackend } from '../../packages/core/src/index.js'

// The study room: it starts clean (every window in the dock), a short intro runs once, each
// window explains itself the first time it is opened, and the windows drag, resize, minimize,
// maximize and remember their layout, with real pointer events. Runs on the public room
// (/room), no setup needed, plus a set up user for the welcome step on other pages.
const APP = 'http://localhost:4173/'
test.use({ viewport: { width: 1440, height: 900 } })
// the one-time "Site blocking needs the free extension" dialog is tested in clarity.spec.js
test.beforeEach(({ page }) => page.addInitScript(() => localStorage.setItem('regimen:no-extension-seen', '1')))
/** Skip the intro, but keep the first-open tips. */
const introSeen = (page) => page.addInitScript(() => localStorage.setItem('regimen:tours-seen', '["room"]'))

const rect = (page, id) =>
  page.locator(`[data-window="${id}"]`).evaluate((e) => {
    const r = e.getBoundingClientRect()
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
  })

async function pointerDrag(page, locator, dx, dy) {
  const b = await locator.boundingBox()
  const x = b.x + Math.min(20, b.width / 2)
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 })
  await page.mouse.move(x + dx, y + dy, { steps: 4 })
  await page.mouse.up()
}

test('the room starts clean and the intro shows once', async ({ page }) => {
  await page.goto(APP + '#/room')
  // nothing open, every window waits in the labelled dock
  const dock = page.locator('nav[aria-label="Room windows"]')
  for (const name of ['Focus', 'Music', 'Scratchpad', 'Scene and music']) await expect(dock).toContainText(name)
  await expect(page.locator('[data-window]:visible')).toHaveCount(0)

  // the intro: the blocking pill, help, the eye, the dock
  const card = page.locator('[data-tour-card]')
  await expect(card).toContainText('1 of 4')
  await expect(card).toContainText('Blocking on or off')
  await card.getByRole('button', { name: 'Next' }).click()
  await expect(card).toContainText('Every page has this ? button')
  await card.getByRole('button', { name: 'Next' }).click()
  await expect(card).toContainText('Press the eye to clear everything')
  await card.getByRole('button', { name: 'Next' }).click()
  await expect(card).toContainText('Everything else lives here')
  await card.getByRole('button', { name: 'Done' }).click()
  await expect(card).toBeHidden()

  await page.reload()
  await expect(dock).toBeVisible()
  await page.waitForTimeout(2000)
  await expect(card).toHaveCount(0)
  // still there from the help drawer
  await page.locator('[data-help-button]').click()
  await page.locator('[data-replay-tour]').click()
  await expect(card).toContainText('1 of 4')
})

test('the blocking pill says blocking is off and opens the checklist, the eye clears everything', async ({ page }) => {
  await introSeen(page)
  await page.goto(APP + '#/room')
  const pill = page.locator('header [data-blocking-pill="off"]')
  await expect(pill).toContainText('Blocking off')
  await expect(pill).toContainText('add the extension')
  await pill.click()
  const status = page.getByRole('dialog', { name: 'Blocking status' })
  await expect(status.locator('[data-check="extension"]')).toHaveAttribute('data-state', /bad|off/)
  await page.keyboard.press('Escape')
  await expect(status).toBeHidden()

  await page.locator('[data-tour="room-eye"]').click()
  await expect(page.locator('nav[aria-label="Room windows"]')).toBeHidden()
  await expect(pill).toBeHidden()
  // a small sign stays next to the timer
  await expect(page.locator('[data-blocking-pill="off"]')).toBeVisible()
  await page.keyboard.press('z')
  await expect(pill).toBeVisible()
})

test('a window explains itself the first time it opens, only once', async ({ page }) => {
  await introSeen(page)
  await page.goto(APP + '#/room')
  const focus = page.locator('[data-window="focus"]')
  await page.locator('[data-dock="focus"]').click()
  await expect(focus).toBeVisible()
  const tip = focus.locator('[data-room-tip]')
  await expect(tip).toContainText('Start focus')
  await tip.getByRole('button', { name: 'Got it' }).click()
  await expect(tip).toHaveCount(0)
  await focus.getByRole('button', { name: 'Minimize Focus' }).click()
  await page.locator('[data-dock="focus"]').click()
  await expect(focus).toBeVisible()
  await expect(page.locator('[data-room-tip]')).toHaveCount(0)

  // another window has its own tip, closing the window counts as seen
  const player = page.locator('[data-window="player"]')
  await page.locator('[data-dock="player"]').click()
  await expect(player.locator('[data-room-tip]')).toContainText('lofi radio')
  await player.getByRole('button', { name: 'Minimize Music' }).click()
  await page.waitForTimeout(400) // the layout saves a moment later
  await page.reload()
  await page.locator('[data-dock="player"]').click()
  await expect(player).toBeVisible()
  await expect(page.locator('[data-room-tip]')).toHaveCount(0)
})

test('room windows move, resize, minimize, maximize and remember their layout', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('regimen:tours-seen', '["*"]'))
  await page.goto(APP + '#/room')
  const focus = page.locator('[data-window="focus"]')
  await page.locator('[data-dock="focus"]').click()
  await expect(focus).toBeVisible()
  const start = await rect(page, 'focus')

  // drag by the title bar (no snapping target near the middle of the room)
  await pointerDrag(page, focus.locator('.rw-title'), 300, -100)
  await page.waitForTimeout(250)
  const moved = await rect(page, 'focus')
  expect(moved.x).toBe(start.x + 300)
  expect(moved.y).toBe(start.y - 100)

  // resize from the bottom right corner, the size stays within the window's limits
  await pointerDrag(page, focus.locator('[data-resize="se"]'), 120, 60)
  await page.waitForTimeout(250)
  const grown = await rect(page, 'focus')
  expect(grown.w).toBe(moved.w + 120)
  expect(grown.h).toBe(moved.h + 60)
  await pointerDrag(page, focus.locator('[data-resize="se"]'), -2000, -2000)
  await page.waitForTimeout(250)
  const tiny = await rect(page, 'focus')
  expect(tiny.w).toBe(250)
  expect(tiny.h).toBe(150)
  await pointerDrag(page, focus.locator('[data-resize="se"]'), 200, 200)
  await page.waitForTimeout(250)
  const final = await rect(page, 'focus')

  // maximize (double click the title bar), Escape restores
  await focus.locator('.rw-title').dblclick()
  await page.waitForTimeout(300)
  const max = await rect(page, 'focus')
  expect(max.w).toBeGreaterThan(1400)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  expect(await rect(page, 'focus')).toEqual(final)

  // minimize to the dock, restore from it
  await focus.getByRole('button', { name: 'Minimize Focus' }).click()
  await expect(focus).toBeHidden()
  await page.locator('[data-dock="focus"]').click()
  await expect(focus).toBeVisible()

  // the music window shows the track name and lists the tracks
  await page.locator('[data-dock="player"]').click()
  await expect(page.locator('[data-now-playing]')).toHaveText('Rain on the Window')
  await page.locator('[data-track-list-button]').click()
  await expect(page.locator('[data-track-pop] [data-track="jazz-corner-booth"]')).toBeDisabled()
  await page.locator('[data-track-pop] [data-track="classic-late-library"]').click()
  await expect(page.locator('[data-now-playing]')).toHaveText('Late Library')
  await page.keyboard.press('Escape')

  // the layout survives a reload
  await page.waitForTimeout(400)
  await page.reload()
  await expect(focus).toBeVisible()
  expect(await rect(page, 'focus')).toEqual(final)

  // reset layout clears the room again, and a window opens back in its default place
  await page.locator('[data-dock-reset]').click()
  await expect(page.locator('[data-window]:visible')).toHaveCount(0)
  await page.locator('[data-dock="focus"]').click()
  await page.waitForTimeout(300)
  expect(await rect(page, 'focus')).toEqual(start)
})

test('on phones the room windows stack and open full screen', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('regimen:tours-seen', '["*"]'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(APP + '#/room')
  const player = page.locator('[data-window="player"]')
  await expect(player).toBeHidden()
  await page.locator('[data-dock="player"]').click()
  await expect(player).toBeVisible()
  await expect(player.locator('[data-resize]')).toHaveCount(0)
  await player.getByRole('button', { name: 'Maximize Music' }).click()
  const r = await rect(page, 'player')
  expect(r).toMatchObject({ x: 0, y: 0, w: 390, h: 844 })
  await expect(player.locator('[data-track="classic-tram-stop"]')).toBeVisible()
  await player.getByRole('button', { name: 'Restore Music' }).click()
  await player.getByRole('button', { name: 'Minimize Music' }).click()
  await expect(player).toBeHidden()
  await page.locator('[data-dock="player"]').click()
  await expect(player).toBeVisible()
})

test('music plays alone by default, ambience has its own switches and they are remembered', async ({ page }) => {
  // a room saved by an older version with the old default ambience (rain at 0.5): it goes quiet
  const state = JSON.parse(await setUpUser())
  state.settings.lofi = {
    volume: 0.6,
    scene: 'scene-night',
    style: 'music-classic',
    objects: true,
    mix: { rain: 0.5, cafe: 0, fire: 0, noise: 0 },
  }
  await page.addInitScript((s) => {
    localStorage.setItem('regimen:tours-seen', '["room"]')
    if (!localStorage.getItem('regimen:v1')) localStorage.setItem('regimen:v1', s)
  }, JSON.stringify(state))
  await page.goto(APP + '#/room')
  const player = page.locator('[data-window="player"]')
  await page.locator('[data-dock="player"]').click()
  const music = player.getByRole('button', { name: /^Music/ }).first()
  const rain = player.locator('[data-ambience="rain"]').first()
  const fire = player.locator('[data-ambience="fire"]').first()
  await expect(music).toHaveAttribute('aria-pressed', 'true')
  await expect(rain).toHaveAttribute('aria-pressed', 'false')
  await expect(fire).toHaveAttribute('aria-pressed', 'false')
  // ambience alone: fireplace on, music off
  await fire.click()
  await music.click()
  await expect(fire).toHaveAttribute('aria-pressed', 'true')
  await expect(music).toHaveAttribute('aria-pressed', 'false')
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('regimen:v1')).settings.lofi))
    .toMatchObject({ music: false, ambience: { rain: false, fire: true } })
  await page.reload()
  await page.waitForTimeout(500)
  if (!(await player.isVisible())) await page.locator('[data-dock="player"]').click()
  await expect(player.locator('[data-ambience="fire"]').first()).toHaveAttribute('aria-pressed', 'true')
  await expect(player.getByRole('button', { name: /^Music/ }).first()).toHaveAttribute('aria-pressed', 'false')
})

/** A finished setup in this browser's local storage. */
async function setUpUser() {
  let saved = null
  const b = createBackend({ storage: { load: async () => saved, save: async (s) => (saved = structuredClone(s)) }, hashIterations: 1000 })
  await b.dispatch('setup.pin', { pin: '246810' })
  saved.onboarding.completed = true
  return JSON.stringify(saved)
}

test('pages do not start a tour by themselves, one welcome step points at help', async ({ page }) => {
  const state = await setUpUser()
  await page.addInitScript((s) => {
    if (!localStorage.getItem('regimen:v1')) localStorage.setItem('regimen:v1', s)
  }, state)
  await page.goto(APP + '#/today')
  const card = page.locator('[data-tour-card]')
  await expect(card).toContainText('Every page has this')
  await expect(card.locator('.tour-count')).toHaveCount(0)
  await card.getByRole('button', { name: 'Got it' }).click()
  await expect(card).toBeHidden()
  for (const path of ['tasks', 'habits', 'today']) {
    await page.goto(APP + '#/' + path)
    await page.waitForTimeout(1500)
    await expect(card).toHaveCount(0)
  }
  // page tours are still in the help drawer
  await page.locator('[data-help-button]').first().click()
  await expect(page.locator('[data-replay-tour]')).toHaveText(/Take the tour/)
  await page.locator('[data-replay-tour]').click()
  await expect(card).toContainText('1 of')
})
