<script setup>
// The music window: what is playing, the controls, music and ambience switches and the
// track list. It grows into its space: small shows the essentials and a row of sound
// switches (levels and the track list in a popover), taller shows the ambience levels
// inline, big shows the track list inline too.
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { trackById, trackStyle } from '@regimen/core'
import { lofi, lofiState } from '../../../lib/lofi.js'
import RoomIcon from '../RoomIcon.vue'
import EqBars from './EqBars.vue'
import TrackList from './TrackList.vue'
import AmbienceMixer from './AmbienceMixer.vue'

const props = defineProps({
  w: { type: Number, default: 360 },
  h: { type: Number, default: 0 },
  max: Boolean,
  ui: { type: Object, required: true },
  level: { type: Number, default: 1 },
})
const emit = defineEmits(['toggle', 'choose'])
const player = lofi()
// the room's sound settings: a reactive object owned by Room.vue, changed right here
const sound = props.ui

const track = computed(() => trackById(lofiState.track))
const styleName = computed(() => trackStyle(track.value)?.name || 'Lofi')
const natural = computed(() => !props.h)
const inlineAmbience = computed(() => (natural.value ? true : props.h >= 310))
const inlineList = computed(() => (natural.value ? props.max : props.h >= 390 && props.w >= 320))
const wide = computed(() => props.w >= 440)
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const progress = computed(() => Math.min(1, (lofiState.position || 0) / (lofiState.length || 1)))

// the popover for a small window, placed next to its button, on top of everything
const pop = ref(null)
const popBtn = ref(null)
function openPop() {
  if (pop.value) return (pop.value = null)
  const r = popBtn.value.getBoundingClientRect()
  const width = Math.min(340, window.innerWidth - 16)
  const below = window.innerHeight - r.bottom - 12
  const above = r.top - 12
  const height = Math.min(460, Math.max(below, above))
  const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))
  pop.value = below >= above ? { left, top: r.bottom + 6, width, height } : { left, bottom: window.innerHeight - r.top + 6, width, height }
  nextTick(() => {
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', esc, true)
  })
}
function closePop() {
  pop.value = null
  document.removeEventListener('pointerdown', outside, true)
  document.removeEventListener('keydown', esc, true)
}
function outside(e) {
  if (!e.target.closest('[data-track-pop]') && !popBtn.value?.contains(e.target)) closePop()
}
function esc(e) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    closePop()
    popBtn.value?.focus()
  }
}
onBeforeUnmount(closePop)
const choose = (t) => emit('choose', t)
const iconBtn = 'room-hover grid h-8 w-8 shrink-0 place-items-center rounded-(--fg-room-btn-radius) text-muted transition'
// a pressed toggle (shuffle, repeat, the open track list)
const on = '!bg-(--fg-room-hover) !text-accent'
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-3">
    <!-- now playing -->
    <div class="flex items-center gap-3">
      <button
        class="room-on grid h-11 w-11 shrink-0 place-items-center rounded-(--fg-room-btn-radius) shadow-md transition hover:scale-105"
        :aria-label="lofiState.playing ? 'Pause (space)' : 'Play (space)'"
        :title="lofiState.playing ? 'Pause (space)' : 'Play (space)'"
        @click="emit('toggle')"
      >
        <RoomIcon :name="lofiState.playing ? 'pause' : 'play'" :size="18" />
      </button>
      <div class="min-w-0 flex-1">
        <p class="hud-label flex items-center gap-2 text-muted">
          <EqBars :playing="lofiState.playing" :bpm="track?.bpm" small />{{ lofiState.playing ? 'Now playing' : 'Paused' }}
        </p>
        <p class="truncate font-display text-base leading-tight font-semibold" data-now-playing :title="track?.name">{{ track?.name }}</p>
        <p class="truncate text-[11px] text-muted">
          {{ styleName }}<template v-if="wide"> · {{ track?.key }} · {{ track?.bpm }} BPM · {{ track?.mood }}</template>
        </p>
      </div>
    </div>

    <!-- position in the track -->
    <div class="flex items-center gap-2 text-[11px] text-muted">
      <span class="num w-7">{{ mmss(lofiState.position || 0) }}</span>
      <span class="relative h-1 flex-1 overflow-hidden rounded-full bg-line"
        ><i class="absolute inset-y-0 left-0 rounded-full bg-accent" :style="{ width: progress * 100 + '%' }"
      /></span>
      <span class="num w-7 text-right">{{ mmss(lofiState.length || 0) }}</span>
    </div>

    <!-- controls -->
    <div class="flex items-center gap-0.5">
      <button :class="iconBtn" aria-label="Previous track" title="Previous track" @click="player.prev()">
        <RoomIcon name="skipBack" :size="15" />
      </button>
      <button :class="iconBtn" aria-label="Next track" title="Next track" @click="player.next()">
        <RoomIcon name="skipForward" :size="15" />
      </button>
      <button
        :class="[iconBtn, lofiState.shuffle && on]"
        :aria-pressed="lofiState.shuffle"
        aria-label="Shuffle"
        title="Shuffle"
        @click="player.setShuffle(!lofiState.shuffle)"
      >
        <RoomIcon name="shuffle" :size="15" />
      </button>
      <button
        :class="[iconBtn, lofiState.repeatOne && on]"
        :aria-pressed="lofiState.repeatOne"
        aria-label="Repeat this track"
        title="Repeat this track"
        @click="player.setRepeatOne(!lofiState.repeatOne)"
      >
        <RoomIcon name="repeatOne" :size="15" />
      </button>
      <label class="ml-1 flex min-w-0 flex-1 items-center gap-1.5 text-muted" title="Volume">
        <RoomIcon name="volume" :size="15" />
        <input
          v-model.number="sound.volume"
          type="range"
          min="0"
          max="1"
          step="0.01"
          class="room-range w-full min-w-0"
          aria-label="Volume"
        />
      </label>
      <button
        v-if="!inlineList || !inlineAmbience"
        ref="popBtn"
        :class="[iconBtn, pop && on]"
        :aria-expanded="!!pop"
        aria-haspopup="dialog"
        :aria-label="inlineAmbience ? 'Track list' : 'Track list and ambience'"
        :title="inlineAmbience ? 'Track list' : 'Track list and ambience'"
        data-track-list-button
        @click="openPop"
      >
        <RoomIcon name="playlist" :size="16" />
      </button>
    </div>

    <!-- music and ambience: switches always in view, levels when there is room -->
    <div v-if="inlineAmbience" class="room-well p-2.5">
      <AmbienceMixer :ui="sound" />
    </div>
    <AmbienceMixer v-else :ui="sound" compact />

    <!-- the track list, inline when there is room -->
    <div v-if="inlineList" class="-mx-2 min-h-0 flex-1 overflow-y-auto border-t border-line px-1 pt-2">
      <TrackList :current="lofiState.track" :level="level" :playing="lofiState.playing" @choose="choose" />
    </div>

    <Teleport to="body">
      <div
        v-if="pop"
        data-track-pop
        role="dialog"
        aria-label="Tracks"
        class="room-ui room-glass fixed z-[70] flex flex-col overflow-hidden rounded-(--fg-room-radius) bg-(--fg-room-base)"
        :style="{
          left: pop.left + 'px',
          top: pop.top != null ? pop.top + 'px' : null,
          bottom: pop.bottom != null ? pop.bottom + 'px' : null,
          width: pop.width + 'px',
          maxHeight: pop.height + 'px',
        }"
      >
        <div class="flex h-9 items-center justify-between border-b border-line pr-1.5 pl-3">
          <p class="room-title">Tracks</p>
          <button :class="iconBtn" class="!h-7 !w-7" aria-label="Close" @click="closePop"><RoomIcon name="x" :size="14" /></button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
          <TrackList :current="lofiState.track" :level="level" :playing="lofiState.playing" @choose="choose" />
        </div>
        <div v-if="!inlineAmbience" class="border-t border-line p-3">
          <AmbienceMixer :ui="sound" />
        </div>
      </div>
    </Teleport>
  </div>
</template>
