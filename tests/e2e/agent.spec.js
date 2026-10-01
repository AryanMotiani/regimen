// The real extension and the real Go lock agent, paired through the one-click link
// the agent opens after installing. The agent runs with a temporary data folder
// and a fake hosts file, so nothing on this computer changes.
// Needs the agent binary: npm run agent:build -- --target <os>/<arch>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, windowAroundNow } from './fixtures.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const goos = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform]
const goarch = { x64: 'amd64', arm64: 'arm64' }[process.arch]
const BIN = path.join(root, 'agent/dist', `regimen-agent-${goos}-${goarch}${goos === 'windows' ? '.exe' : ''}`)
const HEALTH = 'http://127.0.0.1:47621/health'

const healthy = () =>
  fetch(HEALTH)
    .then((r) => r.json())
    .catch(() => null)

test.skip(!fs.existsSync(BIN), `lock agent binary missing (${path.relative(root, BIN)}). Run: npm run agent:build`)

test('one-click pairing link connects the extension to the lock agent, which then enforces the rules', async ({
  context,
  extensionId,
  send,
}) => {
  test.skip(!!(await healthy()), 'another lock agent is already running on port 47621')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-agent-'))
  const hostsFile = path.join(dir, 'hosts')
  fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n')
  fs.mkdirSync(path.join(dir, 'data'))
  const link = 'LINK-CODE-FROM-AGNT-2345'
  fs.writeFileSync(
    path.join(dir, 'data', 'config.json'),
    JSON.stringify({
      pairCode: 'MANU-ALCO-DEAB-CDEF-2345',
      linkCode: link,
      linkExpiresAt: Date.now() + 30 * 60_000,
      secretHash: null,
      strict: false,
    }),
  )
  const agent = spawn(BIN, ['run'], {
    env: { ...process.env, REGIMEN_DATA: path.join(dir, 'data'), REGIMEN_HOSTS: hostsFile },
    stdio: 'ignore',
  })
  try {
    await expect.poll(healthy, { timeout: 10_000 }).toMatchObject({ ok: true })

    // The extension needs a PIN before rules can be created.
    expect((await send('setup.pin', { pin: '246810' })).ok).toBe(true)

    // What the agent opens in the browser after installing.
    const page = await context.newPage()
    await page.goto(`http://localhost:4173/#/install?pair=${link}`)
    await expect(page.getByText('Approve this site in the extension')).toBeVisible()
    const popup = await context.newPage()
    await popup.goto(`chrome-extension://${extensionId}/popup.html`)
    await popup.getByRole('button', { name: 'Allow' }).click()

    await expect(page.getByRole('status').getByText('Lock agent connected')).toBeVisible({ timeout: 20_000 })
    // the one-time code is gone from the address bar
    expect(page.url()).not.toContain(link)
    const { state } = await send('state.get')
    expect(state.agent.paired).toBe(true)
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'config.json'), 'utf8'))
    expect(cfg.linkCode ?? null).toBeNull()
    expect(cfg.pairCode).toBeNull()

    // A rule made in the extension reaches the hosts file through the agent.
    expect((await send('rules.create', { name: 'No YouTube', mode: 'hard', siteIds: ['youtube'], ...windowAroundNow() })).ok).toBe(true)
    await expect.poll(() => fs.readFileSync(hostsFile, 'utf8'), { timeout: 15_000 }).toContain('0.0.0.0 youtube.com')
    await expect.poll(healthy).toMatchObject({ ok: true, blocking: expect.any(Number) })
  } finally {
    agent.kill()
  }
})
