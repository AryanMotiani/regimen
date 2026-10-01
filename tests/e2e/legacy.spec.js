// Regimen was called FocusGateway up to v1.2.0. People who used that version keep their data:
// the web app copies 'focusgateway:*' localStorage keys to 'regimen:*' (apps/web/src/lib/legacy.js)
// and the extension moves its 'fg_*' storage keys to 'r_*' (extension/src/legacy.js, covered by
// extension/test/legacy.test.js: an unpacked test extension can not be restarted like an update).
import { test, expect } from './fixtures.js'
import { createBackend } from '../../packages/core/src/index.js'

const PIN = '246810'
const REASON = 'I want to break my own rule because this is only a practice run'

async function oldSetup(title) {
  let saved = null
  let clock = Date.now() - 60_000
  const local = createBackend({
    storage: { load: async () => saved, save: async (s) => (saved = structuredClone(s)) },
    now: () => clock,
    hashIterations: 1000,
  })
  await local.dispatch('setup.pin', { pin: PIN })
  await local.dispatch('setup.step', { step: 'recoverySaved' })
  await local.dispatch('failsafe.start', { target: { type: 'practice' } })
  await local.dispatch('failsafe.continue')
  await local.dispatch('failsafe.pin', { pin: PIN })
  clock += 11_000
  await local.dispatch('failsafe.confirm', { confirmation: REASON })
  await local.dispatch('tasks.create', { title, deadline: Date.now() + 86400e3 })
  await local.dispatch('setup.complete')
  return saved
}

test('a website setup saved under the old FocusGateway keys is found and moves into the extension', async ({ context, extensionId }) => {
  const saved = await oldSetup('Saved by FocusGateway')
  const page = await context.newPage()
  await page.addInitScript((s) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('focusgateway:v1', s)
    localStorage.setItem('focusgateway:tours-seen', '["*"]')
  }, JSON.stringify(saved))

  await page.goto('http://localhost:4173/#/')
  await expect(page.getByText('Approve this site in the extension')).toBeVisible()
  const keys = await page.evaluate(() => Object.keys(localStorage).sort())
  expect(keys).toContain('regimen:tours-seen')
  expect(keys.filter((k) => k.startsWith('focusgateway:'))).toEqual([])

  const popup = await context.newPage()
  await popup.goto(`chrome-extension://${extensionId}/popup.html`)
  await popup.getByRole('button', { name: 'Allow' }).click()
  await expect(page.getByText('Your setup moved into the extension')).toBeVisible({ timeout: 10_000 })
  await page.goto('http://localhost:4173/#/tasks')
  await expect(page.getByText('Saved by FocusGateway')).toBeVisible()
})
