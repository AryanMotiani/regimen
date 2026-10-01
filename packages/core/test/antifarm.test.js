import { describe, it, expect, beforeEach } from 'vitest'
import { createBackend } from '../src/backend.js'
import { progressOf } from '../src/progress.js'
import { computeMilestones } from '../src/milestones.js'
import { migrate } from '../src/state.js'

const at = (d, hh, mm = 0) => new Date(2026, 8, d, hh, mm).getTime() // 21 = Monday
const PIN = '246810'
const reason = 'I really need this for a class project'

function memoryStorage(initial = null) {
  let saved = initial ? structuredClone(initial) : null
  return {
    load: async () => (saved ? structuredClone(saved) : null),
    save: async (s) => {
      saved = structuredClone(s)
    },
    peek: () => saved,
  }
}

let clock, be, storage
async function fresh(start = at(21, 8)) {
  clock = start
  storage = memoryStorage()
  be = createBackend({ storage, now: () => clock, hashIterations: 1000 })
  await be.dispatch('setup.pin', { pin: PIN })
}
const xp = () => progressOf(storage.peek())
const expectCode = async (p, code, message) => {
  await expect(p).rejects.toMatchObject(message ? { code, message } : { code })
}

describe('failsafe farming', () => {
  let ruleId
  beforeEach(async () => {
    await fresh()
    ruleId = (await be.dispatch('rules.create', { name: 'YT', mode: 'hard', siteIds: ['youtube'], days: [1], start: 540, end: 720 })).data
      .id
    clock = at(21, 10)
  })

  it('pays nothing for cancelling before the PIN, however often', async () => {
    for (let i = 0; i < 30; i++) {
      await be.dispatch('failsafe.start', { target: { type: 'rule', id: ruleId } })
      await be.dispatch('failsafe.cancel')
    }
    expect(xp().breakdown.discipline).toBe(0)
    expect(storage.peek().stats.events.failsafe_resisted).toBe(0)
    expect(storage.peek().log.at(-1)).toMatchObject({ type: 'failsafe_resisted', step: 'intent', xp: 0 })
  })

  it('pays once per target per day for walking away at the cooldown', async () => {
    const resist = async () => {
      await be.dispatch('failsafe.start', { target: { type: 'rule', id: ruleId } })
      await be.dispatch('failsafe.continue')
      await be.dispatch('failsafe.pin', { pin: PIN })
      await be.dispatch('failsafe.cancel')
    }
    await resist()
    await resist()
    await resist()
    expect(xp().breakdown.discipline).toBe(10)
    clock = at(28, 10) // next Monday, the window is live again
    await resist()
    expect(xp().breakdown.discipline).toBe(20)
    expect(storage.peek().stats.events.failsafe_resisted).toBe(2)
  })

  it('a one minute focus session looped with failsafe gives no levels', async () => {
    for (let i = 0; i < 20; i++) {
      await be.dispatch('focus.start', { workMin: 1, breakMin: 0, iterations: 1, siteIds: ['reddit'] })
      await be.dispatch('failsafe.start', { target: { type: 'focus' } })
      await be.dispatch('failsafe.continue')
      await be.dispatch('failsafe.pin', { pin: PIN })
      await be.dispatch('failsafe.cancel')
      clock += 61_000
      await be.dispatch('system.tick')
    }
    expect(xp().level).toBe(1)
    expect(xp().breakdown.discipline).toBe(10)
  })
})

describe('window unlock farming', () => {
  beforeEach(() => fresh())
  const win = { mode: 'gated', siteIds: ['instagram'], days: [1, 2, 3, 4, 5, 6, 7], start: 840, end: 1020 }

  it('pays one unlock per window, even when a task is reopened and finished again', async () => {
    await be.dispatch('rules.create', { ...win, newTasks: [{ title: 'Read', deadline: at(21, 23) }] })
    const id = storage.peek().tasks[0].id
    clock = at(21, 14, 30)
    await be.dispatch('system.tick')
    for (let i = 0; i < 5; i++) {
      await be.dispatch('tasks.complete', { id })
      clock += 60_000
      await be.dispatch('system.tick')
      await be.dispatch('tasks.reopen', { id })
      clock += 60_000
      await be.dispatch('system.tick')
    }
    const s = storage.peek()
    expect(s.log.filter((e) => e.type === 'window_unlocked')).toHaveLength(1)
    expect(s.stats.events.window_unlocked).toBe(1)
    expect(xp().breakdown.discipline).toBe(15)
  })
})

describe('task farming', () => {
  beforeEach(() => fresh())

  it('create, complete, delete loops earn nothing and reopening never pays twice', async () => {
    for (let i = 0; i < 10; i++) {
      const { data: t } = await be.dispatch('tasks.create', { title: 'Quick ' + i, deadline: clock, priority: 'low' })
      await be.dispatch('tasks.complete', { id: t.id })
      await be.dispatch('tasks.delete', { id: t.id, confirmation: `I want to delete "Quick ${i}" because ${reason}` })
    }
    expect(xp().xp).toBe(0)
    const { data: t } = await be.dispatch('tasks.create', { title: 'Real', deadline: at(21, 23), priority: 'medium' })
    await be.dispatch('tasks.complete', { id: t.id }) // too soon: nothing
    expect(xp().breakdown.tasks).toBe(0)
    await be.dispatch('tasks.reopen', { id: t.id })
    clock += 15 * 60_000
    await be.dispatch('tasks.complete', { id: t.id })
    expect(xp().breakdown.tasks).toBe(25)
    await be.dispatch('tasks.reopen', { id: t.id })
    await be.dispatch('tasks.complete', { id: t.id })
    expect(xp().breakdown.tasks).toBe(25)
  })

  it('hundreds of tiny tasks hit the daily cap', async () => {
    const ids = []
    for (let i = 0; i < 200; i++)
      ids.push((await be.dispatch('tasks.create', { title: 't' + i, deadline: at(21, 23), priority: 'low' })).data.id)
    clock += 11 * 60_000
    for (const id of ids) await be.dispatch('tasks.complete', { id })
    expect(xp().breakdown.tasks).toBe(300)
    expect(computeMilestones(storage.peek(), clock).find((m) => m.id === 'tasks-50').achieved).toBe(false)
  }, 30_000)
})

describe('counters', () => {
  it('focus time is counted when a session ends and survives the history cap', async () => {
    await fresh(at(21, 20))
    await be.dispatch('focus.start', { workMin: 25, breakMin: 5, iterations: 2, siteIds: ['reddit'] })
    clock = at(21, 21)
    await be.dispatch('system.tick')
    const s = storage.peek()
    expect(s.stats.focus).toEqual({ minutes: 50, sessions: 1, xp: 20 })
    s.focus.history = []
    expect(progressOf(s).breakdown.focus).toBe(20)
  })

  it('an old save without counters loads with its level intact', async () => {
    const old = migrate(null)
    delete old.stats
    old.createdAt = at(1, 0)
    old.tasks = Array.from({ length: 50 }, (_, i) => ({
      id: 't' + i,
      title: 'x',
      status: 'done',
      priority: 'high',
      deadline: at(20, 23),
      createdAt: at(20, 10),
      completedAt: at(20, 10), // made and finished at once: fine back then
    }))
    old.log = Array.from({ length: 10 }, () => ({ type: 'failsafe_resisted', at: at(20, 12) }))
    old.focus.history = [{ focusedMin: 125 }]
    const expected = progressOf(old).level
    clock = at(21, 8)
    storage = memoryStorage(old)
    be = createBackend({ storage, now: () => clock, hashIterations: 1000 })
    const { state } = await be.dispatch('state.get')
    expect(progressOf(state).level).toBe(expected)
    expect(expected).toBeGreaterThan(5)
    expect(state.stats).toMatchObject({ since: at(21, 8), events: { failsafe_resisted: 10 }, focus: { minutes: 125 } })
  })
})

describe('scene and music locks', () => {
  beforeEach(() => fresh())
  const lofi = (patch) => be.dispatch('settings.update', { patch: { lofi: patch } })

  it('rejects locked scenes and music, accepts level 1 and legacy names', async () => {
    await expectCode(lofi({ scene: 'scene-forest' }), 'VALIDATION', 'Forest cabin is in the shop for 350 coins.')
    await expectCode(lofi({ style: 'music-jazz' }), 'VALIDATION', 'Rainy jazz is in the shop for 450 coins.')
    await expectCode(
      lofi({ scene: 'scene-space' }),
      'VALIDATION',
      'Orbit station unlocks at level 30, then it is in the shop for 1900 coins.',
    )
    await expectCode(lofi({ scene: 'scene-mars' }), 'VALIDATION')
    const r = await lofi({ scene: 'sunset', style: 'music-classic', volume: 0.3 })
    expect(r.state.settings.lofi).toMatchObject({ scene: 'scene-sunset', style: 'music-classic', volume: 0.3 })
  })

  it('validates volume, mix and objects', async () => {
    await expectCode(lofi({ volume: 2 }), 'VALIDATION')
    await expectCode(lofi({ volume: '0.5' }), 'VALIDATION')
    await expectCode(lofi({ mix: { rain: 1.5 } }), 'VALIDATION')
    await expectCode(lofi({ mix: { lasers: 1 } }), 'VALIDATION')
    await expectCode(lofi({ objects: 'yes' }), 'VALIDATION')
    await expectCode(lofi({ hacked: true }), 'VALIDATION')
    await expectCode(lofi('night'), 'VALIDATION')
    await expectCode(lofi({ ambience: { rain: 1 } }), 'VALIDATION')
    await expectCode(lofi({ ambience: { cafe: true } }), 'VALIDATION')
    await expectCode(lofi({ music: 'off' }), 'VALIDATION')
    const r = await lofi({ mix: { fire: 0.4 }, objects: false })
    expect(r.state.settings.lofi.mix).toEqual({ rain: 0.5, fire: 0.4 })
    expect(r.state.settings.lofi.ambience).toEqual({ rain: false, fire: false })
    expect(r.state.settings.lofi.objects).toBe(false)
    // an older copy of the app still sends cafe and noise: ignored, the rest saves
    const old = await lofi({ mix: { rain: 0.3, cafe: 0.2, fire: 0, noise: 0 } })
    expect(old.state.settings.lofi.mix).toEqual({ rain: 0.3, fire: 0 })
    const on = await lofi({ music: false, ambience: { fire: true } })
    expect(on.state.settings.lofi).toMatchObject({ music: false, ambience: { rain: false, fire: true } })
  })

  it('keeps a locked scene that is already saved', async () => {
    const s = migrate(null)
    s.settings.lofi.scene = 'scene-space'
    storage = memoryStorage(s)
    be = createBackend({ storage, now: () => clock, hashIterations: 1000 })
    const r = await be.dispatch('settings.update', { patch: { lofi: { scene: 'scene-space', volume: 0.2 } } })
    expect(r.state.settings.lofi).toMatchObject({ scene: 'scene-space', volume: 0.2 })
  })
})

describe('import sanitizing', () => {
  it('cleans room, appearance, lofi, settings and counters from an import', async () => {
    await fresh()
    const dump = {
      data: {
        tasks: [],
        settings: {
          failsafeWaitSeconds: 1,
          theme: 'hotdog',
          appearance: { game: { palette: 'nope', heading: 'lilita' }, evil: { x: 1 } },
          lofi: { scene: 'night', style: 'music-nope', volume: 9, objects: 'yes', mix: { rain: 0.2, lasers: 1 } },
          room: {
            avatar: { hair: 'nope' },
            items: [
              { id: 'obj-nope', x: 1, y: 1 },
              { id: 'obj-mug', x: 5, y: 5 },
            ],
          },
        },
        stats: { since: -5, events: { window_unlocked: -3, failsafe_resisted: 2.7, bogus: 99 }, focus: { minutes: 'x' } },
      },
    }
    const { state } = await be.dispatch('data.import', { data: dump, pin: PIN })
    const st = state.settings
    expect(st.failsafeWaitSeconds).toBe(30)
    expect('theme' in st).toBe(false)
    // an unknown old palette and an unknown old switch fall back to the first light theme, drawn light
    expect(st.appearance).toEqual({
      game: { theme: 'sunny' },
      minimal: { theme: 'paper' },
    })
    expect(st.colorMode).toBe('light')
    expect(st.lofi).toEqual({
      volume: 1,
      scene: 'scene-night',
      style: 'music-classic',
      objects: true,
      music: true,
      // an older export that turned rain down to 0.2: it was chosen, so it stays on
      mix: { rain: 0.2, fire: 0.5 },
      ambience: { rain: true, fire: false },
    })
    expect(st.room.avatar.hair).toBe('short')
    expect(st.room.items.map((i) => i.id)).toEqual(['obj-mug'])
    expect(state.stats.since).toBe(0)
    expect(state.stats.events).toEqual({ window_unlocked: 0, window_respected: 0, failsafe_resisted: 2 })
    expect(state.stats.focus).toEqual({ minutes: 0, sessions: 0, xp: 0 })
  })
})
