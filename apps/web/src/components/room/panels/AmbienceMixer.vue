<script setup>
// What plays in the room: the lofi radio and the two ambience sounds, each switched on or
// off on its own, so music alone, ambience alone or both are one click each.
// compact: one row of switches (the levels live in the popover). Otherwise each sound gets
// its level slider next to its switch.
import { AMBIENCE_NAMES } from '../../../lib/lofi.js'
import RoomIcon from '../RoomIcon.vue'

const props = defineProps({ ui: { type: Object, required: true }, compact: Boolean })
const sound = props.ui
const SOUNDS = [
  { key: 'rain', icon: 'rain' },
  { key: 'fire', icon: 'flame' },
]
const pill =
  'flex shrink-0 items-center gap-1.5 rounded-(--fg-room-btn-radius) px-2.5 py-1 text-xs font-bold transition focus-visible:outline-2 focus-visible:outline-accent'
const chip = (on) => (on ? 'room-on' : 'bg-sunk text-muted room-hover')
const toggle = (k) => (sound.ambience[k] = !sound.ambience[k])
</script>

<template>
  <div v-if="compact" class="flex flex-wrap items-center gap-1.5" data-sound-switches>
    <button
      :class="[pill, chip(sound.music)]"
      :aria-pressed="sound.music"
      :title="sound.music ? 'Turn music off' : 'Turn music on'"
      @click="sound.music = !sound.music"
    >
      <RoomIcon name="music" :size="12" /> Music
    </button>
    <button
      v-for="s in SOUNDS"
      :key="s.key"
      :class="[pill, chip(sound.ambience[s.key])]"
      :aria-pressed="sound.ambience[s.key]"
      :title="(sound.ambience[s.key] ? 'Turn off ' : 'Turn on ') + AMBIENCE_NAMES[s.key].toLowerCase()"
      :data-ambience="s.key"
      @click="toggle(s.key)"
    >
      <RoomIcon :name="s.icon" :size="12" /> {{ AMBIENCE_NAMES[s.key] }}
    </button>
  </div>

  <div v-else class="space-y-2" data-sound-mixer>
    <div class="flex items-center justify-between gap-2">
      <p class="hud-label text-muted">Ambience</p>
      <button
        :class="[pill, chip(sound.music)]"
        :aria-pressed="sound.music"
        :title="sound.music ? 'Turn music off, keep the ambience' : 'Turn music on'"
        @click="sound.music = !sound.music"
      >
        <RoomIcon name="music" :size="12" /> Music {{ sound.music ? 'on' : 'off' }}
      </button>
    </div>
    <div v-for="s in SOUNDS" :key="s.key" class="flex items-center gap-2.5">
      <button
        :class="[pill, chip(sound.ambience[s.key]), 'w-[7.5rem]']"
        :aria-pressed="sound.ambience[s.key]"
        :title="(sound.ambience[s.key] ? 'Turn off ' : 'Turn on ') + AMBIENCE_NAMES[s.key].toLowerCase()"
        :data-ambience="s.key"
        @click="toggle(s.key)"
      >
        <RoomIcon :name="s.icon" :size="13" /> {{ AMBIENCE_NAMES[s.key] }}
        <span class="ml-auto h-1.5 w-1.5 rounded-full" :class="sound.ambience[s.key] ? 'bg-current' : 'bg-line'" aria-hidden="true" />
      </button>
      <input
        v-model.number="sound.mix[s.key]"
        type="range"
        min="0"
        max="1"
        step="0.01"
        class="room-range w-full min-w-0 transition-opacity"
        :class="!sound.ambience[s.key] && 'opacity-40'"
        :aria-label="AMBIENCE_NAMES[s.key] + ' volume'"
        @input="sound.ambience[s.key] = true"
      />
    </div>
    <p v-if="!sound.music && !sound.ambience.rain && !sound.ambience.fire" class="text-[11px] text-muted">
      Everything is off. Turn on music or a sound.
    </p>
  </div>
</template>
