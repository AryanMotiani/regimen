<script setup>
import { computed, reactive, ref } from 'vue'
import { addDays, startOfDay, dateKey, isHabitDue, isHabitDone, habitStreak, habitRate, habitBestStreak, yearGrid, XP } from '@regimen/core'
import { store, call, attempt } from '../lib/store.js'
import { askYesNo } from '../lib/dialogs.js'
import { DAY_NAMES, daysLabel } from '../lib/format.js'
import Icon from '../components/Icon.vue'
import HelpButton from '../components/help/HelpButton.vue'
import Modal from '../components/Modal.vue'
import DayPicker from '../components/DayPicker.vue'
import YearHeatmap from '../components/viz/YearHeatmap.vue'
import { popXp, playHabit, isGame, currentXp } from '../lib/rewards.js'

const COLORS = { violet: '#7c6cf2', amber: '#e09a3e', green: '#2fa877', rose: '#e0607a', sky: '#3b9bd9', slate: '#6b7280' }
const EMOJI = ['💧', '📚', '🏃', '🧘', '🛏️', '🥗', '✍️', '🎸', '🧹', '💊', '🌱', '📵']
const habits = computed(() => store.state.habits.filter((h) => !h.archived))
const archived = computed(() => store.state.habits.filter((h) => h.archived))
const week = computed(() => Array.from({ length: 7 }, (_, i) => addDays(startOfDay(store.minute), i - 6)))
// HabitKit style year grid per habit; fewer weeks on narrow screens
const WEEKS = window.innerWidth < 640 ? 22 : 53
const minute = computed(() => store.minute)
const grids = computed(() =>
  Object.fromEntries(habits.value.map((h) => [h.id, yearGrid(store.state, minute.value, { kind: 'habit', habit: h, weeks: WEEKS })])),
)
const form = ref(null)

function openForm(h) {
  form.value = reactive(
    h
      ? { id: h.id, name: h.name, emoji: h.emoji, color: h.color, days: [...h.days] }
      : { name: '', emoji: '💧', color: 'violet', days: [1, 2, 3, 4, 5, 6, 7] },
  )
}
async function save() {
  const f = form.value
  if (f.id) await attempt(() => call('habits.update', { id: f.id, patch: { name: f.name, emoji: f.emoji, color: f.color, days: f.days } }))
  else await attempt(() => call('habits.create', f), 'Habit added')
  form.value = null
}
async function remove(h) {
  if (
    await askYesNo(`Delete “${h.name}”?`, 'Its history is deleted too. Archive it instead if you might come back to it.', {
      yes: 'Delete',
      danger: true,
    })
  ) {
    await attempt(() => call('habits.delete', { id: h.id }))
    form.value = null
  }
}
async function toggle(h, d, e) {
  const was = isHabitDone(store.state.habitLogs, h.id, d)
  const el = e?.currentTarget
  const before = currentXp()
  await attempt(() => call('habits.toggle', { id: h.id, date: dateKey(d) })).catch(() => null)
  if (!was && isHabitDone(store.state.habitLogs, h.id, d)) {
    playHabit()
    popXp(el, currentXp() - before)
  }
}
const doneToday = computed(
  () => habits.value.filter((h) => isHabitDue(h, store.minute) && isHabitDone(store.state.habitLogs, h.id, store.minute)).length,
)
const dueToday = computed(() => habits.value.filter((h) => isHabitDue(h, store.minute)).length)
</script>

<template>
  <div class="space-y-6">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="h-display text-4xl">Habits</h1>
        <p class="text-sm text-muted">
          Small things, every day. {{ doneToday }} of {{ dueToday }} done today.<template v-if="isGame"> +{{ XP.habit }} XP each.</template>
        </p>
      </div>
      <div class="flex items-center gap-2">
        <button class="btn btn-primary" data-tour="habits-new" @click="openForm()"><Icon name="plus" :size="16" /> New habit</button>
        <HelpButton page="habits" />
      </div>
    </header>

    <div class="space-y-3" data-tour="habits-list">
      <article v-for="h in habits" :key="h.id" class="card p-4">
        <div class="flex flex-wrap items-center gap-4">
          <button class="flex min-w-0 flex-1 items-center gap-3 text-left" @click="openForm(h)">
            <span class="grid h-11 w-11 shrink-0 place-items-center rounded-2xl text-xl" :style="{ background: COLORS[h.color] + '22' }">{{
              h.emoji || '•'
            }}</span>
            <span class="min-w-0">
              <span class="block truncate font-semibold">{{ h.name }}</span>
              <span class="text-xs text-muted">{{ daysLabel(h.days) }}</span>
              <span class="mt-1 flex flex-wrap gap-1.5 text-[11px] font-bold">
                <span class="chip" :style="{ background: COLORS[h.color] + '22', color: COLORS[h.color] }"
                  ><Icon name="flame" :size="12" /> {{ habitStreak(h, store.state.habitLogs, minute) }}-day streak</span
                >
                <span class="chip">Best: {{ habitBestStreak(h, store.state.habitLogs) }}</span>
                <span v-if="habitRate(h, store.state.habitLogs, minute, 365) !== null" class="chip"
                  >{{ Math.round(habitRate(h, store.state.habitLogs, minute, 365) * 100) }}%</span
                >
              </span>
            </span>
          </button>
          <div class="flex gap-1.5">
            <button
              v-for="d in week"
              :key="d"
              class="flex w-9 flex-col items-center gap-1 text-[10px] text-muted"
              :disabled="!isHabitDue(h, d)"
              :aria-label="`${h.name} on ${new Date(d).toDateString()}`"
              @click="toggle(h, d, $event)"
            >
              <span>{{ DAY_NAMES[(new Date(d).getDay() + 6) % 7].slice(0, 2) }}</span>
              <span
                class="grid h-9 w-9 place-items-center rounded-xl border-2 transition"
                :style="
                  isHabitDone(store.state.habitLogs, h.id, d)
                    ? { background: COLORS[h.color], borderColor: COLORS[h.color], color: 'white' }
                    : {}
                "
                :class="[
                  !isHabitDue(h, d) && 'opacity-30',
                  d === week[6] && !isHabitDone(store.state.habitLogs, h.id, d) ? 'border-ink/40' : 'border-line',
                ]"
              >
                <Icon v-if="isHabitDone(store.state.habitLogs, h.id, d)" name="check" :size="16" />
              </span>
            </button>
          </div>
        </div>
        <div class="mt-4">
          <YearHeatmap :grid="grids[h.id]" :color="COLORS[h.color]" label="done" />
        </div>
      </article>

      <div v-if="!habits.length" class="card flex flex-col items-center gap-3 p-10 text-center">
        <p class="text-3xl">🌱</p>
        <p class="text-sm text-muted">Pick one tiny habit you want to keep. Drink water, read 10 pages, sleep by midnight.</p>
        <button class="btn btn-primary" @click="openForm()">Add your first habit</button>
      </div>
    </div>

    <details v-if="archived.length" class="text-sm">
      <summary class="cursor-pointer text-muted">Archived ({{ archived.length }})</summary>
      <div class="mt-2 space-y-1">
        <div v-for="h in archived" :key="h.id" class="flex items-center justify-between rounded-xl px-3 py-2 hover:bg-sunk">
          <span>{{ h.emoji }} {{ h.name }}</span>
          <button class="btn btn-sm" @click="attempt(() => call('habits.update', { id: h.id, patch: { archived: false } }))">
            Restore
          </button>
        </div>
      </div>
    </details>

    <Modal v-if="form" :title="form.id ? 'Edit habit' : 'New habit'" @close="form = null">
      <form class="space-y-4" @submit.prevent="save">
        <div>
          <label class="label" for="h-name">Habit</label>
          <input id="h-name" v-model="form.name" class="input" placeholder="e.g. Read 10 pages" maxlength="60" required />
        </div>
        <div>
          <span class="label">Icon</span>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="e in EMOJI"
              :key="e"
              type="button"
              class="grid h-9 w-9 place-items-center rounded-xl border text-lg"
              :class="form.emoji === e ? 'border-accent bg-accent-soft' : 'border-line'"
              @click="form.emoji = e"
            >
              {{ e }}
            </button>
          </div>
        </div>
        <div>
          <span class="label">Colour</span>
          <div class="flex gap-2">
            <button
              v-for="(hex, name) in COLORS"
              :key="name"
              type="button"
              class="h-8 w-8 rounded-full ring-offset-2 ring-offset-card"
              :class="form.color === name && 'ring-2 ring-ink'"
              :style="{ background: hex }"
              :aria-label="name"
              @click="form.color = name"
            />
          </div>
        </div>
        <div>
          <span class="label">On these days</span>
          <DayPicker v-model="form.days" />
        </div>
        <div class="flex flex-wrap justify-between gap-2 pt-2">
          <div v-if="form.id" class="flex gap-2">
            <button
              type="button"
              class="btn btn-sm"
              @click="attempt(() => call('habits.update', { id: form.id, patch: { archived: true } })).then(() => (form = null))"
            >
              Archive
            </button>
            <button type="button" class="btn btn-sm text-bad" @click="remove(store.state.habits.find((h) => h.id === form.id))">
              Delete
            </button>
          </div>
          <div class="ml-auto flex gap-2">
            <button type="button" class="btn" @click="form = null">Cancel</button>
            <button type="submit" class="btn btn-primary" :disabled="!form.name.trim() || !form.days.length">Save</button>
          </div>
        </div>
      </form>
    </Modal>
  </div>
</template>
