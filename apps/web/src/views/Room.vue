<script setup>
// Home. An illustrated study room (components/room/StudyRoom.vue) with every panel in its own
// window: focus, music, planner (tasks, habits, blocks, progress), status, scratchpad and
// scene. Drag a window by its title bar, resize it from any edge or corner, minimize it to
// the dock or maximize it. The layout is saved per device size (lib/windows.js).
// The room starts clean: every window waits in the dock, and Reset layout clears the room
// again. The header always shows whether blocking works (BlockingPill). The first visit gets
// a short intro (lib/tour.js), and each window a one-time tip the first time it is opened.
// On phones the windows stack in a column under the room, and can collapse or go full screen.
// Scenes, decor and music styles are bought with coins in the shop (packages/core/src/economy.js).
// Keys: Space play, F full screen, C scene, D decorate, N scratchpad, Z hide panels,
// T H B S planner tabs, Esc restores a maximized window.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { UNLOCKS, trackOwned, trackById, sanitizeLofi } from '@regimen/core'
import { store, call, sessionRunning } from '../lib/store.js'
import { lofi, lofiState, playWithSettings, savedTrack } from '../lib/lofi.js'
import { createWindows } from '../lib/windows.js'
import { progress } from '../lib/rewards.js'
import { ownsItem, balance, freshAffordable } from '../lib/shop.js'
import { request } from '../lib/room.js'
import CoinIcon from '../components/shop/CoinIcon.vue'
import WelcomeGift from '../components/shop/WelcomeGift.vue'
import StudyRoom from '../components/room/StudyRoom.vue'
import DecoratePanel from '../components/room/DecoratePanel.vue'
import RoomClock from '../components/room/RoomClock.vue'
import RoomWindow from '../components/room/RoomWindow.vue'
import RoomDock from '../components/room/RoomDock.vue'
import RoomIcon from '../components/room/RoomIcon.vue'
import FocusPanel from '../components/room/panels/FocusPanel.vue'
import PlayerPanel from '../components/room/panels/PlayerPanel.vue'
import NotesPanel from '../components/room/panels/NotesPanel.vue'
import ScenePanel from '../components/room/panels/ScenePanel.vue'
import RoomDrawer from '../components/RoomDrawer.vue'
import StatusStrip from '../components/StatusStrip.vue'
import Icon from '../components/Icon.vue'
import logo from '../assets/logo.svg'
import HelpButton from '../components/help/HelpButton.vue'
import BlockingPill from '../components/help/BlockingPill.vue'
import QuickTheme from '../components/look/QuickTheme.vue'
import RoomTip from '../components/room/RoomTip.vue'
import { ROOM_TIPS, tipSeen, markTipSeen, tour, tourSeen } from '../lib/tour.js'
import { isSeen, markSeen } from '../lib/seen.js'
import BlockingWays from '../components/help/BlockingWays.vue'
import { useRouter } from 'vue-router'

const player = lofi()
// sanitizeLofi: settings from an older extension have no music or ambience switches yet
const saved = sanitizeLofi(store.state?.settings?.lofi)
const LEGACY = { night: 'scene-night', sunset: 'scene-sunset', morning: 'scene-morning' }
const level = computed(() => progress.value?.level || 1)
// scenes and music styles are owned (free or bought in the shop, see core economy.js)
const has = (id) => ownsItem(id)
const onboarded = computed(() => !!store.state?.onboarding?.completed)

const ui = reactive({
  music: saved.music,
  volume: saved.volume,
  scene: LEGACY[saved.scene] || saved.scene,
  style: saved.style,
  // ambience: each sound on or off, mix: its level when on
  ambience: { ...saved.ambience },
  mix: { ...saved.mix },
})
// never show something that is not owned (for example after importing old data)
if (!has(ui.scene)) ui.scene = 'scene-night'
if (!has(ui.style)) ui.style = 'music-classic'

// only tracks of owned styles play, and the saved track shows before anything plays
player.setUnlockCheck((id) => trackOwned(id, ownsItem))
if (!player.playing) player.setTrack(savedTrack({ lofi: { ...saved, style: ui.style } }).id)

function recall(key, fallback) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : JSON.parse(v)
  } catch {
    return fallback
  }
}
function remember(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {}
}

const width = ref(window.innerWidth)
const narrow = computed(() => width.value < 768)
const drawerTab = ref(recall('regimen:room-drawer-tab', 'tasks'))
watch(drawerTab, (v) => remember('regimen:room-drawer-tab', v))
const decorating = ref(false)
const decorTab = ref('items')
const hidden = ref(recall('regimen:room-hidden', false))
watch(hidden, (v) => remember('regimen:room-hidden', v))

const unlockedCount = computed(() => UNLOCKS.filter((u) => has(u.id)).length)
const NAV = [
  { to: '/today', label: 'Today', icon: 'home' },
  { to: '/tasks', label: 'Tasks', icon: 'list' },
  { to: '/schedule', label: 'Schedule', icon: 'calendar' },
  { to: '/blocking', label: 'Blocking', icon: 'shield' },
  { to: '/habits', label: 'Habits', icon: 'target' },
  { to: '/stats', label: 'Accountability', icon: 'chart' },
  { to: '/shop', label: 'Shop', icon: 'bag' },
  { to: '/settings', label: 'Settings', icon: 'settings' },
]

// --- windows ---
// short: the dock label on phones
const ALL_WINDOWS = [
  { id: 'status', title: 'Status', short: 'Status', icon: 'pulse', min: [300, 84], max: [1200, 220], onboarded: true },
  { id: 'focus', title: 'Focus', short: 'Focus', icon: 'clock', min: [250, 150], max: [1100, 1000] },
  { id: 'player', title: 'Music', short: 'Music', icon: 'headphones', min: [270, 216], max: [800, 1100] },
  { id: 'drawer', title: 'Planner', short: 'Planner', icon: 'list', min: [280, 200], max: [1100, 1600], onboarded: true },
  { id: 'notes', title: 'Scratchpad', short: 'Notes', icon: 'notes', min: [220, 140], max: [1000, 1000] },
  { id: 'scene', title: 'Scene and music', short: 'Scene', icon: 'sparkles', min: [300, 220], max: [680, 1000] },
  { id: 'welcome', title: 'Welcome', short: 'Welcome', icon: 'home', min: [260, 150], max: [560, 420], onboarded: false },
]
const WINDOWS = ALL_WINDOWS.filter((w) => w.onboarded === undefined || w.onboarded === onboarded.value)
const M = 16 // room margin
const GAP = 8
/**
 * The default layout is the clean room: every window minimized to the dock, so the room
 * shows in full. The rects are where each window opens: focus and music on the left,
 * planner on the right, status up top.
 */
function layout(vw, vh) {
  const all = openLayout(vw, vh)
  return Object.fromEntries(WINDOWS.map((w) => [w.id, { ...(all[w.id] || { x: 20, y: 80, w: 320, h: 240 }), min: true }]))
}
function openLayout(vw, vh) {
  if (vw < 768) return {}
  const wide = vw >= 1180
  const big = vw >= 1600 && vh >= 960
  const lw = big ? 400 : 360 // the left column
  const pH = big ? 340 : 224
  // on narrower screens the dock would sit on the bottom windows, so they stay above it
  const bottom = vh - (vw >= 1180 ? M : 64)
  const player = { x: M, y: bottom - pH, w: lw, h: pH }
  let status
  // in the gap between the logo and pages on the left and the buttons (coins, decorate, scene,
  // help) on the right, when that gap is wide enough, else under the header
  const x0 = 484
  const x1 = vw - 476
  const inBar = wide && x1 - x0 >= 560
  if (inBar) {
    const w = Math.min(660, x1 - x0)
    status = { x: Math.round(x0 + (x1 - x0 - w) / 2), y: 12, w, h: 96 }
  } else status = { x: M, y: 76, w: Math.min(920, vw - 2 * M), h: 96 }
  const top = inBar ? 80 : status.y + status.h + GAP
  const fH = Math.max(200, Math.min(onboarded.value ? 380 : 190, player.y - GAP - top))
  const focus = { x: M, y: player.y - GAP - fH, w: lw, h: fH }
  const dW = vw >= 1600 ? 420 : wide ? 400 : Math.min(380, vw - lw - 2 * M - GAP)
  const dH = Math.min(vh >= 1000 ? 660 : 560, bottom - top)
  const drawer = { x: vw - M - dW, y: bottom - dH, w: dW, h: dH }
  return {
    status,
    focus,
    player,
    drawer,
    welcome: { x: M, y: focus.y - GAP - 196, w: lw, h: 196 },
    notes: { x: vw - M - 320, y: Math.max(top, drawer.y - GAP - 230), w: 320, h: 230 },
    scene: { x: vw - M - 460, y: top, w: 460, h: 480 },
  }
}
const ctl = createWindows({
  specs: Object.fromEntries(WINDOWS.map((w) => [w.id, { min: w.min, max: w.max }])),
  layout,
  area: (vw, vh) => ({ l: 12, t: 12, r: vw - 12, b: vh - 12 }),
  // a maximized window leaves the header and the dock free
  maxArea: (vw, vh) => ({ l: 12, t: 76, r: vw - 12, b: vh - 66 }),
  storageKey: `regimen:room-layout:${onboarded.value ? 'v1' : 'guest'}`,
})
// on phones a maximized window covers the whole screen, header and dock included
const phoneFull = computed(() => narrow.value && WINDOWS.some((w) => ctl.wm.wins[w.id]?.max && !ctl.wm.wins[w.id]?.min))
const winOpen = (id) => ctl.wm.wins[id] && !ctl.wm.wins[id].min
const noneOpen = computed(() => WINDOWS.every((w) => !winOpen(w.id)))
/** Reset layout: the clean room again, every window back in the dock. */
function resetLayout() {
  ctl.reset()
}

// --- one-time tips: the first time a window is opened (and decorate mode), a short tip
// explains it. Only one shows at a time. Seen tips are kept in lib/tour.js.
const tipFor = ref(null)
function offerTip(id) {
  if (!ROOM_TIPS[id] || tipSeen(id)) return
  if (tipFor.value && tipFor.value !== id) markTipSeen(tipFor.value)
  tipFor.value = id
}
function tipDone() {
  if (tipFor.value) markTipSeen(tipFor.value)
  tipFor.value = null
}
const tipOf = (id) => (tipFor.value === id ? ROOM_TIPS[id] : null)
watch(
  () => WINDOWS.map((w) => !!ctl.wm.wins[w.id]?.min),
  (now, before) =>
    WINDOWS.forEach((w, i) => {
      if (before?.[i] && !now[i]) {
        offerTip(w.id)
        // phones: the window opens in the column under the room, so bring it into view
        if (narrow.value)
          nextTick(() => document.querySelector(`[data-window="${w.id}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
      }
      // minimized (or reset) with its tip up: it was seen
      else if (now[i] && tipFor.value === w.id) tipDone()
    }),
)
watch(decorating, (v) => (v ? offerTip('decorate') : tipFor.value === 'decorate' && tipDone()))

// --- sound ---
async function toggle() {
  if (player.playing) return player.stop()
  await playWithSettings({ lofi: soundSettings() })
}
const soundSettings = () => ({
  volume: ui.volume,
  music: ui.music,
  mix: { ...ui.mix },
  ambience: { ...ui.ambience },
  style: ui.style,
  track: lofiState.track,
})
function choose(t) {
  if (!trackOwned(t.id, ownsItem)) return
  player.setTrack(t.id)
  ui.style = t.style
  if (!lofiState.playing) toggle()
}
function setStyle(id) {
  if (has(id)) ui.style = id
}
watch(
  () => ui.volume,
  (v) => player.setVolume(v),
)
watch(
  () => ui.music,
  (v) => player.setMusic(v),
)
watch(
  () => ui.style,
  (v) => player.setStyle(v),
)
// the radio moves on by itself: keep the style in step
watch(
  () => lofiState.track,
  () => {
    if (lofiState.style !== ui.style && has(lofiState.style)) ui.style = lofiState.style
  },
)
watch(
  () => ({ ...ui.mix }),
  (m) => player.setMix(m),
  { deep: true },
)
watch(
  () => ({ ...ui.ambience }),
  (a) => player.setAmbience(a),
  { deep: true },
)
// the rain on the window: the usual drizzle, heavier when the rain sound is turned up
const rainView = computed(() => Math.max(0.5, ui.ambience.rain ? ui.mix.rain : 0))

let saveT = null
watch(
  () => [ui.volume, ui.music, ui.scene, ui.style, lofiState.track, { ...ui.mix }, { ...ui.ambience }],
  () => {
    if (!store.state) return
    clearTimeout(saveT)
    saveT = setTimeout(() => {
      const lofiPatch = {
        volume: ui.volume,
        scene: ui.scene,
        style: ui.style,
        music: ui.music,
        mix: { ...ui.mix },
        ambience: { ...ui.ambience },
      }
      const t = trackById(lofiState.track)
      if (t && t.style === ui.style && trackOwned(t.id, ownsItem)) lofiPatch.track = t.id
      call('settings.update', { patch: { lofi: lofiPatch } }).catch(() => {
        // an older extension does not know the music and ambience switches yet: save what
        // it understands, a sound that is off as level 0
        const { music, ambience, ...rest } = lofiPatch
        const mix = Object.fromEntries(Object.entries(rest.mix).map(([k, v]) => [k, ambience[k] ? v : 0]))
        call('settings.update', { patch: { lofi: { ...rest, mix } } }).catch(() => {})
      })
    }, 800)
  },
  { deep: true },
)

const roomEl = ref(null)
const startDrag = (id, e) => roomEl.value?.startDrag(id, e)
// the starter gift card: shows until claimed and closed (components/shop/WelcomeGift.vue)
const giftPending = ref(!store.state?.shop?.giftAt)
const shopNew = computed(() => freshAffordable.value.length)

// The start card: once, after the room intro has ended, the three ways to block for someone who
// has no rules yet. It comes before the starter gift so the two never stack.
const router = useRouter()
const startCard = computed(
  () =>
    onboarded.value &&
    panels.value &&
    !tour.id &&
    tourSeen('room') &&
    !store.state.rules.length &&
    !store.state.focus?.active &&
    !isSeen('flags', 'blocking-start-seen') &&
    !isSeen('flags', 'blocking-intro-hidden'),
)
function startWay(way) {
  markSeen('flags', 'blocking-start-seen')
  if (way === 'focus') return ctl.restore('focus')
  router.push({ path: '/blocking', query: { new: way } })
}
function decorate(tab) {
  if (!onboarded.value) return
  if (typeof tab === 'string') decorTab.value = tab
  decorating.value = typeof tab === 'string' ? true : !decorating.value
}

// on phones the room scrolls sideways: start with the desk in the middle
const scroller = ref(null)
const heroH = computed(() => {
  if (!narrow.value) return 0
  const vh = window.innerHeight
  // nothing open (the clean room): the room fills the screen above the dock
  if (hidden.value || (noneOpen.value && !decorating.value)) return vh - (hidden.value ? 96 : 84)
  return Math.round(decorating.value ? Math.min(vh * 0.44, 380) : Math.min(vh * 0.42, 380))
})
function centerRoom() {
  const s = scroller.value
  if (s) s.scrollLeft = (s.scrollWidth * 840) / 1600 - s.clientWidth / 2
}
watch([narrow, heroH], () => nextTick(centerRoom))

function fullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else document.documentElement.requestFullscreen?.()
}
// T H B S from the planner: show that tab, or minimize the planner when it already shows it
function plannerKey(tab) {
  const w = ctl.wm.wins.drawer
  if (!w) return
  if (!w.min && drawerTab.value === tab && (narrow.value || w.z === ctl.wm.top - 1)) return ctl.minimize('drawer')
  drawerTab.value = tab
  ctl.restore('drawer')
}
function onKey(e) {
  if (e.key === 'Escape') {
    if (decorating.value) decorating.value = false
    else if (panels.value && ctl.unmaximizeTop()) e.preventDefault()
    else if (hidden.value) hidden.value = false
    return
  }
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.code === 'Space' && !e.target.closest('button, a, [tabindex]')) {
    e.preventDefault()
    toggle()
  }
  const k = e.key.toLowerCase()
  if (k === 'f') fullscreen()
  if (k === 'c') ctl.toggleMin('scene')
  if (k === 'n') ctl.toggleMin('notes')
  if (k === 'd') decorate()
  if (k === 'z') hidden.value = !hidden.value
}
const onResize = () => {
  width.value = window.innerWidth
  ctl.setViewport(window.innerWidth, window.innerHeight)
}
// closing or reloading the tab during a focus session asks first (the browser's own prompt)
function onLeave(e) {
  if (!sessionRunning()) return
  e.preventDefault()
  e.returnValue = ''
}
onMounted(() => {
  // "Place it now" in the shop page opens decorate mode here
  if (request.decorate) {
    decorate(request.decorate)
    request.decorate = null
  }
  window.addEventListener('beforeunload', onLeave)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  nextTick(centerRoom)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onLeave)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onResize)
})

const panels = computed(() => !hidden.value && !decorating.value)
const HINT = 'Space play · F full screen · C scene · D decorate · N scratchpad · Z hide panels · T H B S planner · Esc restore'
const track = computed(() => trackById(lofiState.track))
// the header's glass buttons, drawn by the theme (style.css, --fg-room-*)
const pill = 'room-glass room-pill'
const chipOn = 'room-glass room-pill room-on'
</script>

<template>
  <div class="room-ui relative bg-(--fg-room-page)" :class="narrow ? 'min-h-[100dvh]' : 'h-[100dvh] overflow-hidden'">
    <!-- the room: full screen on desktop, a sideways scrolling picture on phones -->
    <StudyRoom
      v-if="!narrow"
      ref="roomEl"
      class="absolute inset-x-0 top-0 transition-[bottom] duration-300"
      :class="
        decorating
          ? decorTab === 'avatar' || decorTab === 'room' || decorTab === 'shop'
            ? 'bottom-[326px]'
            : 'bottom-[272px]'
          : 'bottom-0'
      "
      :scene="ui.scene"
      :rain="rainView"
      :fit="decorating ? 'contain' : 'cover'"
      :editable="decorating"
    />
    <div v-else ref="scroller" data-room-scroll class="room-scroll overflow-x-auto overflow-y-hidden" :style="{ height: heroH + 'px' }">
      <StudyRoom
        ref="roomEl"
        :style="{ width: Math.round((heroH * 16) / 9) + 'px', height: heroH + 'px' }"
        :scene="ui.scene"
        :rain="rainView"
        :editable="decorating"
      />
    </div>

    <header
      class="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-wrap items-center gap-2 p-3 sm:flex-nowrap sm:p-5 [&>*]:pointer-events-auto"
    >
      <template v-if="!hidden">
        <RouterLink
          :to="onboarded ? '/today' : '/home'"
          class="flex shrink-0 items-center p-1.5"
          :class="pill"
          title="Regimen"
          aria-label="Regimen home"
        >
          <img :src="logo" alt="" class="h-7 w-7" />
        </RouterLink>
        <!-- always: does blocking work in this browser? Left, next to the logo, so the row never wraps -->
        <BlockingPill class="min-w-0 shrink max-sm:flex-1 sm:max-w-72" />
        <nav v-if="onboarded" class="flex shrink-0 items-center gap-0.5 p-1 max-sm:hidden" :class="pill" aria-label="Pages">
          <RouterLink
            v-for="n in NAV"
            :key="n.to"
            :to="n.to"
            class="room-hover grid h-8 w-8 place-items-center rounded-(--fg-room-btn-radius) text-muted"
            :title="n.label"
            :aria-label="n.label"
          >
            <Icon :name="n.icon" :size="16" />
          </RouterLink>
        </nav>
        <RouterLink
          v-if="!onboarded"
          to="/welcome"
          class="room-on room-pill px-3 py-2 text-xs font-bold"
          title="Set up Regimen for tasks, habits, blocking and coins"
          data-room-setup
          >Set up free</RouterLink
        >
        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            v-if="onboarded"
            class="relative flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
            :class="decorating && decorTab === 'shop' ? chipOn : pill"
            :title="`Shop: ${balance} coins${shopNew ? `, ${shopNew} new thing${shopNew === 1 ? '' : 's'} you can afford` : ''}`"
            data-room-shop-button
            @click="decorating && decorTab === 'shop' ? (decorating = false) : decorate('shop')"
          >
            <CoinIcon :size="16" /> <span class="num">{{ balance }}</span> <span class="max-sm:hidden">Shop</span>
            <span
              v-if="shopNew"
              class="absolute -top-1 -right-1 grid h-4 min-w-4 place-items-center rounded-full bg-[#ff5d8f] px-1 text-[10px] text-white"
              data-shop-dot
              >{{ shopNew }}</span
            >
          </button>
          <button
            v-if="onboarded"
            class="flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
            :class="decorating ? chipOn : pill"
            data-tour="room-decorate"
            title="Decorate the room and your avatar (D)"
            :aria-pressed="decorating"
            @click="decorate()"
          >
            <Icon name="edit" :size="15" /> Decorate
          </button>
          <button
            class="flex items-center gap-1.5 px-3 py-2 text-xs font-bold"
            :class="winOpen('scene') && panels ? chipOn : pill"
            data-tour="room-scene"
            title="Scene and music (C)"
            :aria-pressed="winOpen('scene')"
            @click="decorating ? ((decorating = false), ctl.restore('scene')) : ctl.toggleMin('scene')"
          >
            <Icon name="sparkles" :size="15" /> <span class="max-sm:hidden">Scene</span>
            <span class="num opacity-60 max-sm:hidden">{{ unlockedCount }}/{{ UNLOCKS.length }}</span>
          </button>
          <QuickTheme glass />
          <HelpButton glass page="room" :class="pill" />
          <button
            class="p-2"
            :class="pill"
            data-tour="room-eye"
            aria-label="Hide panels (Z)"
            title="Clear everything and just enjoy the room (Z)"
            @click="hidden = true"
          >
            <Icon name="eyeOff" :size="16" />
          </button>
          <button class="p-2 max-sm:hidden" :class="pill" aria-label="Full screen (F)" title="Full screen (F)" @click="fullscreen">
            <Icon name="maximize" :size="16" />
          </button>
        </div>
      </template>
    </header>

    <!-- the windows -->
    <div
      v-if="panels"
      data-room-windows
      :class="
        narrow ? ['relative flex flex-col gap-3 p-3 pb-24', phoneFull ? 'z-50' : 'z-10'] : 'pointer-events-none absolute inset-0 z-10'
      "
    >
      <RoomWindow
        v-if="onboarded"
        id="status"
        title="Status"
        icon="pulse"
        :ctl="ctl"
        :stacked="narrow"
        :tip="tipOf('status')"
        @tip-done="tipDone"
      >
        <StatusStrip bare />
      </RoomWindow>
      <RoomWindow v-if="!onboarded" id="welcome" title="Welcome" icon="home" :ctl="ctl" :stacked="narrow">
        <p class="font-bold">This is the study room.</p>
        <p class="mt-1 text-sm text-muted">
          Set up Regimen to keep tasks, habits and blocks right here, and to earn coins for new scenes and decor.
        </p>
        <RouterLink to="/welcome" class="btn btn-primary btn-sm mt-3">Set up, it is free</RouterLink>
      </RoomWindow>
      <RoomWindow id="focus" title="Focus" icon="clock" :ctl="ctl" :stacked="narrow" :tip="tipOf('focus')" @tip-done="tipDone">
        <template #default="s"><FocusPanel :w="s.w" :h="s.h" :max="s.max" /></template>
      </RoomWindow>
      <RoomWindow id="player" title="Music" icon="headphones" :ctl="ctl" :stacked="narrow" :tip="tipOf('player')" @tip-done="tipDone">
        <template #default="s">
          <PlayerPanel :w="s.w" :h="s.h" :max="s.max" :ui="ui" :level="level" @toggle="toggle" @choose="choose" />
        </template>
      </RoomWindow>
      <RoomWindow
        v-if="onboarded"
        id="drawer"
        title="Planner"
        icon="list"
        :ctl="ctl"
        :stacked="narrow"
        :pad="false"
        :tip="tipOf('drawer')"
        @tip-done="tipDone"
      >
        <template #default="s">
          <RoomDrawer v-model:tab="drawerTab" windowed :w="s.w" @key="plannerKey" />
        </template>
      </RoomWindow>
      <RoomWindow id="notes" title="Scratchpad" icon="notes" :ctl="ctl" :stacked="narrow" :tip="tipOf('notes')" @tip-done="tipDone">
        <NotesPanel />
      </RoomWindow>
      <RoomWindow id="scene" title="Scene and music" icon="sparkles" :ctl="ctl" :stacked="narrow" :tip="tipOf('scene')" @tip-done="tipDone">
        <ScenePanel
          :ui="ui"
          :level="level"
          :onboarded="onboarded"
          @scene="(id) => has(id) && (ui.scene = id)"
          @style="setStyle"
          @decorate="decorate"
        />
      </RoomWindow>

      <!-- snap guides while dragging -->
      <template v-if="!narrow">
        <i v-if="ctl.wm.guides.x != null" class="guide guide-x" :style="{ left: ctl.wm.guides.x + 'px' }" />
        <i v-if="ctl.wm.guides.y != null" class="guide guide-y" :style="{ top: ctl.wm.guides.y + 'px' }" />
      </template>
    </div>

    <RoomDock
      v-if="panels && (!narrow || (!phoneFull && WINDOWS.some((w) => ctl.wm.wins[w.id]?.min)))"
      :ctl="ctl"
      :items="WINDOWS"
      :stacked="narrow"
      :hint="HINT"
      :class="narrow ? 'fixed inset-x-3 bottom-3 z-40' : 'absolute bottom-3 left-1/2 z-[15] -translate-x-1/2'"
      @reset="resetLayout"
    />

    <!-- decorate: the tray and the avatar editor, and its one-time tip -->
    <div
      v-if="decorating && tipOf('decorate')"
      class="z-30"
      :class="
        narrow
          ? 'relative'
          : [
              'absolute left-5 w-80',
              decorTab === 'avatar' || decorTab === 'room' || decorTab === 'shop' ? 'bottom-[334px]' : 'bottom-[280px]',
            ]
      "
    >
      <RoomTip name="Decorate" :text="tipOf('decorate')" side="inline" @done="tipDone" />
    </div>
    <DecoratePanel
      v-if="decorating"
      v-model:tab="decorTab"
      :start-drag="startDrag"
      class="z-20"
      :class="
        narrow
          ? 'relative m-3'
          : ['absolute inset-x-5 bottom-4', decorTab === 'avatar' || decorTab === 'room' || decorTab === 'shop' ? 'h-[306px]' : 'h-[252px]']
      "
      @close="decorating = false"
      @scene="(id) => has(id) && (ui.scene = id)"
      @style="setStyle"
    />

    <!-- the starter gift, once: how coins work, and enough for one small thing (after the intro) -->
    <BlockingWays
      v-if="startCard"
      variant="card"
      class="z-30"
      :class="narrow ? 'fixed inset-x-3 bottom-28 mx-auto' : 'absolute top-20 right-4'"
      @setup="startWay"
      @dismiss="markSeen('flags', 'blocking-start-seen')"
    />
    <WelcomeGift
      v-if="onboarded && giftPending && panels && !tour.id && !startCard"
      class="z-30"
      :class="narrow ? 'fixed inset-x-3 bottom-28 mx-auto' : 'absolute top-20 right-4'"
      @shop="((giftPending = false), decorate('shop'))"
      @close="giftPending = false"
    />

    <!-- panels hidden: only a small timer and the player -->
    <div
      v-if="hidden"
      class="room-glass room-pill fixed bottom-4 left-1/2 z-20 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 py-1.5 pr-1.5 pl-4 text-sm font-bold"
    >
      <RoomClock compact class="whitespace-nowrap" />
      <BlockingPill dot />
      <span v-if="track" class="max-w-44 truncate text-xs font-semibold text-muted max-sm:hidden" :title="`Now playing: ${track.name}`">{{
        track.name
      }}</span>
      <button
        class="room-on grid h-9 w-9 shrink-0 place-items-center rounded-(--fg-room-btn-radius)"
        :aria-label="lofiState.playing ? 'Pause (space)' : 'Play (space)'"
        @click="toggle"
      >
        <Icon :name="lofiState.playing ? 'pause' : 'play'" :size="15" />
      </button>
      <button
        class="room-hover grid h-9 w-9 shrink-0 place-items-center rounded-(--fg-room-btn-radius)"
        aria-label="Show panels (Z)"
        title="Show panels (Z)"
        @click="hidden = false"
      >
        <RoomIcon name="eye" :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.room-scroll {
  scrollbar-width: none;
}
.room-scroll::-webkit-scrollbar {
  display: none;
}
.guide {
  position: absolute;
  z-index: 2000;
  pointer-events: none;
  background: color-mix(in srgb, var(--fg-accent) 70%, transparent);
}
.guide-x {
  top: 0;
  bottom: 0;
  width: 1px;
}
.guide-y {
  left: 0;
  right: 0;
  height: 1px;
}
</style>
