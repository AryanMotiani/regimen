<script setup>
import { computed, onMounted, ref } from 'vue'
import { store, call, attempt, toast, meta } from '../lib/store.js'
import { withPin, withConfirm } from '../lib/actions.js'
import { askPin } from '../lib/dialogs.js'
import { download } from '../lib/format.js'
import { hasLocalData, clearLocalData, createLocalAdapter } from '../lib/api.js'
import Icon from '../components/Icon.vue'
import HelpButton from '../components/help/HelpButton.vue'
import BlockingStatus from '../components/help/BlockingStatus.vue'
import Modal from '../components/Modal.vue'
import PinField from '../components/PinField.vue'
import ThemePicker from '../components/look/ThemePicker.vue'
import ColorModeSwitch from '../components/look/ColorModeSwitch.vue'
import { lookMode } from '../lib/look.js'

const s = computed(() => store.state)
const wait = ref(s.value.settings.failsafeWaitSeconds)
const changing = ref(false)
const pins = ref({ old: '', next: '', again: '' })
const recoveryCode = ref('')
const agentToken = ref('')
const agentUrl = ref(s.value.agent.url)
const origins = ref([])
const localData = ref(store.mode !== 'local' && hasLocalData())

onMounted(async () => {
  const r = await meta('origins')
  if (r?.ok) origins.value = r.data
})

async function saveWait() {
  const r = await withPin(
    'settings.update',
    { patch: { failsafeWaitSeconds: wait.value } },
    { title: 'Shorter wait needs your PIN' },
  ).catch(() => undefined)
  if (r) toast('Failsafe wait updated', 'success')
  else wait.value = s.value.settings.failsafeWaitSeconds
}
const set = (patch) => attempt(() => call('settings.update', { patch }))

async function changePin() {
  if (pins.value.next !== pins.value.again) return toast("New PINs don't match", 'error')
  await attempt(() => call('security.changePin', { oldPin: pins.value.old, newPin: pins.value.next }), 'PIN changed')
  changing.value = false
  pins.value = { old: '', next: '', again: '' }
}
async function newRecovery() {
  const r = await withPin(
    'security.newRecoveryCode',
    {},
    { always: true, title: 'New recovery code', message: 'Your old code stops working.' },
  )
  if (!r) return
  recoveryCode.value = r.recoveryCode
  download(
    'regimen-recovery-code.txt',
    `Regimen recovery code\n\n${r.recoveryCode}\n\nUse it at Settings > Forgot PIN if you lose your PIN. It works once.\n`,
  )
}

async function pairAgent() {
  await attempt(
    () => call('agent.configure', { url: agentUrl.value.trim(), pairCode: agentToken.value.trim() }),
    'Saved. Connecting to the agent…',
  )
  agentToken.value = ''
}
const unpair = () =>
  withPin(
    'agent.unpair',
    {},
    {
      always: true,
      title: 'Disconnect the lock agent?',
      message: 'The agent drops your rules, except a no-failsafe block that is running right now. That one stays until it ends.',
    },
  )

async function exportData() {
  const r = await attempt(() => call('data.export'))
  download(`regimen-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(r, null, 2), 'application/json')
}
async function importData(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  let data
  try {
    data = JSON.parse(await file.text())
  } catch {
    return toast('That file is not valid JSON.', 'error')
  }
  const r = await withPin(
    'data.import',
    { data },
    { always: s.value.security.hasPin, title: 'Import replaces your current data', message: 'Enter your PIN to continue.' },
  ).catch(() => null)
  if (r) toast(`Imported ${r.tasks} tasks, ${r.rules} rules, ${r.habits} habits`, 'success')
}
async function reset() {
  const pin = await askPin('Delete everything?', 'This wipes all tasks, rules, habits and history on this device. There is no undo.')
  if (!pin) return
  const r = await withConfirm('data.reset', { pin }, 'reset_data', '', { title: 'Last check' }).catch(() => null)
  if (r !== undefined) location.hash = '#/welcome'
}
function discardLocal() {
  clearLocalData()
  localData.value = false
}
async function moveLocal() {
  const local = createLocalAdapter()
  const dump = await local.call('data.export')
  if (!dump.ok) return
  const r = await withPin(
    'data.import',
    { data: dump.data },
    {
      always: true,
      title: 'Move data into the extension',
      message: 'This replaces what the extension has with the data saved in this browser tab. Enter your extension PIN.',
    },
  ).catch(() => null)
  if (r) {
    clearLocalData()
    localData.value = false
    toast('Moved. Blocking now uses these rules.', 'success')
  }
}
async function revoke(o) {
  await meta('approve', { origin: o, allow: false })
  origins.value = origins.value.filter((x) => x !== o)
}
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <header class="flex items-center justify-between gap-3">
      <h1 class="h-display text-4xl">Settings</h1>
      <HelpButton page="settings" />
    </header>

    <section v-if="localData" class="card border-accent p-5">
      <h2 class="font-semibold">Data found from before the extension</h2>
      <p class="mt-1 text-sm text-muted">
        You used Regimen in this browser without the extension. Move those tasks, rules and habits into the extension so they are enforced.
      </p>
      <div class="mt-3 flex gap-2">
        <button class="btn btn-primary" @click="moveLocal">Move my data</button
        ><button class="btn" @click="discardLocal">Discard it</button>
      </div>
    </section>

    <section class="card divide-y divide-line">
      <div class="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="font-semibold">Style</h2>
          <p class="text-sm text-muted">Game: XP pops, levels and sounds. Calm: the same features, quiet and minimal.</p>
        </div>
        <div class="flex rounded-xl border border-line p-0.5 text-sm">
          <button
            v-for="[m, l] in [
              ['game', 'Game'],
              ['minimal', 'Calm'],
            ]"
            :key="m"
            class="rounded-lg px-3 py-1.5"
            :class="(s.settings.uiMode || 'game') === m ? 'bg-accent-soft font-semibold text-accent' : 'text-muted'"
            @click="set({ uiMode: m })"
          >
            {{ l }}
          </button>
        </div>
      </div>
      <div id="look" class="space-y-5 p-5">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0 flex-1 basis-64">
            <h2 class="font-semibold">Theme</h2>
            <p class="text-sm text-muted">
              Themes for {{ lookMode === 'game' ? 'Game' : 'Calm' }}. Each one has its own typefaces, colours and surfaces, in a light and a
              dark version, and applies the moment you pick it.
            </p>
          </div>
          <div data-settings-color-mode>
            <p class="label">Light or dark</p>
            <ColorModeSwitch auto />
          </div>
        </div>
        <ThemePicker :mode="lookMode" />
        <p class="text-xs text-muted">
          Light or dark applies to every theme. Auto follows your device. The sun and moon button next to the palette button flips it from
          any page.
        </p>
      </div>
      <div v-if="(s.settings.uiMode || 'game') === 'game'" class="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="font-semibold">Sounds</h2>
          <p class="text-sm text-muted">Soft clicks when you finish a task or habit, a chime when you level up.</p>
        </div>
        <label class="flex items-center gap-2 text-sm"
          ><input type="checkbox" :checked="s.settings.sounds !== false" @change="set({ sounds: $event.target.checked })" /> On</label
        >
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="font-semibold">Weekly focus goal</h2>
          <p class="text-sm text-muted">Closes the focus ring on the Accountability page.</p>
        </div>
        <select
          class="input !w-auto"
          :value="s.settings.weeklyFocusGoalMin || 300"
          @change="set({ weeklyFocusGoalMin: Number($event.target.value) })"
        >
          <option v-for="m in [60, 120, 180, 300, 420, 600, 900, 1200]" :key="m" :value="m">{{ m / 60 }} hours</option>
        </select>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="font-semibold">Notifications</h2>
          <p class="text-sm text-muted">When a block starts or ends (extension only).</p>
        </div>
        <label class="flex items-center gap-2 text-sm"
          ><input type="checkbox" :checked="s.settings.notifications" @change="set({ notifications: $event.target.checked })" /> On</label
        >
      </div>
      <div class="p-5">
        <h2 class="font-semibold">Failsafe wait</h2>
        <p class="text-sm text-muted">
          How long you must sit with the decision before an override unlocks. Longer is harder to give in to. We recommend at least a
          minute.
        </p>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <input
            v-model.number="wait"
            type="range"
            min="30"
            max="300"
            step="15"
            class="w-56 accent-[var(--fg-accent)]"
            aria-label="Failsafe wait"
          />
          <span class="w-20 font-mono text-sm">{{ Math.floor(wait / 60) }}:{{ String(wait % 60).padStart(2, '0') }}</span>
          <button class="btn btn-sm" :disabled="wait === s.settings.failsafeWaitSeconds" @click="saveWait">Save</button>
        </div>
        <p class="mt-1 text-xs text-muted">Making it longer is free. Making it shorter needs your PIN.</p>
      </div>
    </section>

    <div data-tour="settings-test"><BlockingStatus /></div>

    <section class="card divide-y divide-line" data-tour="settings-pin">
      <div class="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="font-semibold">PIN</h2>
          <p class="text-sm text-muted">Used only for Failsafe and for changing rules while they run.</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-sm" @click="changing = true"><Icon name="key" :size="14" /> Change PIN</button>
          <button class="btn btn-sm" @click="newRecovery">New recovery code</button>
          <RouterLink to="/recover" class="btn btn-sm btn-ghost">Forgot PIN</RouterLink>
        </div>
      </div>
      <div v-if="recoveryCode" class="p-5">
        <p class="text-sm">Your new recovery code (also downloaded as a file):</p>
        <p class="mt-2 rounded-xl bg-sunk p-3 text-center font-mono text-lg tracking-widest">{{ recoveryCode }}</p>
      </div>
    </section>

    <section class="card p-5" data-tour="settings-agent">
      <h2 class="flex items-center gap-2 font-semibold"><Icon name="terminal" :size="18" /> Lock agent</h2>
      <p class="mt-1 text-sm text-muted">
        The optional agent enforces your blocks in every browser and app on this computer and turns off the tricks people use to get around
        blockers. <RouterLink to="/install" class="text-accent underline">How to install it</RouterLink>
      </p>
      <template v-if="store.mode === 'local'">
        <p class="mt-3 text-sm text-warm">Install the browser extension first. The agent gets its rules from it.</p>
      </template>
      <template v-else-if="s.agent.pairing && !s.agent.paired">
        <p class="mt-3 text-sm" :class="s.agent.lastError ? 'text-bad' : 'text-muted'">
          {{ s.agent.lastError ? `Could not pair: ${s.agent.lastError}` : 'Connecting to the agent…' }}
        </p>
      </template>
      <template v-else-if="s.agent.paired">
        <p class="mt-3 text-sm" :class="s.agent.lastError ? 'text-bad' : 'text-good'">
          {{
            s.agent.lastError
              ? `Problem: ${s.agent.lastError}`
              : `Connected. Last sync ${s.agent.lastSyncAt ? new Date(s.agent.lastSyncAt).toLocaleTimeString() : 'pending'}.`
          }}
        </p>
        <button class="btn btn-sm mt-3" @click="unpair">Disconnect</button>
      </template>
      <div v-else class="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
        <input v-model="agentToken" class="input font-mono" placeholder="Pairing code from the installer" aria-label="Pairing code" />
        <input v-model="agentUrl" class="input font-mono text-xs" aria-label="Agent address" />
        <button class="btn btn-primary" :disabled="!agentToken.trim()" @click="pairAgent">Connect</button>
      </div>
    </section>

    <section v-if="store.mode !== 'local' && origins.length" class="card p-5">
      <h2 class="font-semibold">Connected websites</h2>
      <p class="text-sm text-muted">Hosted copies of Regimen allowed to use this extension.</p>
      <div v-for="o in origins" :key="o" class="mt-2 flex items-center justify-between rounded-xl bg-sunk px-3 py-2 text-sm">
        <code>{{ o }}</code
        ><button class="btn btn-sm" @click="revoke(o)">Remove</button>
      </div>
    </section>

    <section class="card p-5">
      <h2 class="font-semibold">Secure DNS reminder</h2>
      <p class="mt-1 text-sm text-muted">
        "Secure DNS" (DNS over HTTPS) lets browsers skip the lock agent's system-level block. The agent switches it off for Chrome, Edge,
        Brave and Firefox automatically. If you only use the extension this does not matter, because the extension blocks inside the browser
        itself.
      </p>
    </section>

    <section class="card divide-y divide-line">
      <div class="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="font-semibold">Backup</h2>
          <p class="text-sm text-muted">Everything lives on this device. Export a file to back up or move to another computer.</p>
        </div>
        <div class="flex gap-2">
          <button class="btn btn-sm" @click="exportData"><Icon name="download" :size="14" /> Export</button>
          <label class="btn btn-sm cursor-pointer"
            ><Icon name="upload" :size="14" /> Import<input
              type="file"
              accept="application/json,.json"
              class="sr-only"
              @change="importData"
          /></label>
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-3 p-5">
        <div>
          <h2 class="font-semibold text-bad">Delete all data</h2>
          <p class="text-sm text-muted">Needs your PIN and a typed reason. Not possible while a no-failsafe block is running.</p>
        </div>
        <button class="btn btn-sm text-bad" @click="reset">Delete everything</button>
      </div>
    </section>

    <section class="text-xs text-muted">
      <p>
        Regimen is free and open source (MIT). Running in <b>{{ store.mode === 'local' ? 'standalone' : store.mode }}</b> mode.
      </p>
      <p class="mt-1">
        It is a commitment tool, not a prison. Someone with admin rights on this computer can always undo it with enough effort. The point
        is to make giving in slow, deliberate and visible.
      </p>
    </section>

    <Modal v-if="changing" title="Change PIN" @close="changing = false">
      <form class="space-y-3" @submit.prevent="changePin">
        <PinField v-model="pins.old" placeholder="Current PIN" />
        <PinField v-model="pins.next" placeholder="New PIN (6+ characters)" autocomplete="new-password" />
        <PinField v-model="pins.again" placeholder="New PIN again" autocomplete="new-password" />
        <div class="flex justify-end gap-2 pt-2">
          <button type="button" class="btn" @click="changing = false">Cancel</button
          ><button class="btn btn-primary" :disabled="pins.next.length < 6">Change</button>
        </div>
      </form>
    </Modal>
  </div>
</template>
