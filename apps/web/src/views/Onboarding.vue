<script setup>
import { computed, ref, watch } from 'vue'
import { inExtension } from '../lib/api.js'
import { useRouter } from 'vue-router'
import { store, call, toast } from '../lib/store.js'
import { withPin } from '../lib/actions.js'
import { download } from '../lib/format.js'
import Icon from '../components/Icon.vue'
import PinField from '../components/PinField.vue'
import FailsafeFlow from '../components/FailsafeFlow.vue'
import RuleEditor from '../components/RuleEditor.vue'
import ThemePicker from '../components/look/ThemePicker.vue'
import ColorModeSwitch from '../components/look/ColorModeSwitch.vue'
import QuickTheme from '../components/look/QuickTheme.vue'
import logo from '../assets/logo.svg'

const router = useRouter()
const s = computed(() => store.state)
const STEPS = ['Welcome', 'PIN', 'Recovery code', 'Practice Failsafe', 'Emergency exits', 'Blocking everywhere', 'First rule', 'Summary']
const initial = () => {
  const st = s.value.onboarding.steps
  if (!s.value.security.hasPin) return 0
  if (!st.recoverySaved) return 2
  if (!st.failsafeDryRunDone) return 3
  if (!st.emergencyHelp) return 4
  if (!st.dohReviewed) return 5
  return 6
}
const step = ref(initial())
const pin = ref('')
const pin2 = ref('')
const code = ref('')
const saved = ref(false)
const err = ref('')
const practicing = ref(false)
const ruleOpen = ref(false)
const seen = ref({ failsafe: false, recovery: false, agent: false })

async function createPin() {
  err.value = ''
  if (pin.value.length < 6) return (err.value = 'Use at least 6 characters.')
  if (pin.value !== pin2.value) return (err.value = "The PINs don't match.")
  try {
    code.value = (await call('setup.pin', { pin: pin.value })).recoveryCode
    saveCode()
    step.value = 2
  } catch (e) {
    err.value = e.message
  }
}
function saveCode() {
  download(
    'regimen-recovery-code.txt',
    `Regimen recovery code\n\n${code.value}\n\nIf you forget your PIN, open Regimen > Settings > Forgot PIN and enter this code.\nIt works once. Keep it somewhere safe, away from this computer (a photo on your phone or on paper).\n`,
  )
}
async function regenerate() {
  const r = await withPin('security.newRecoveryCode', {}, { always: true, title: 'Enter the PIN you just created' })
  if (r) {
    code.value = r.recoveryCode
    saveCode()
  }
}
async function mark(stepName, next) {
  try {
    await call('setup.step', { step: stepName })
    step.value = next
  } catch (e) {
    toast(e.message, 'error')
  }
}
async function finish() {
  try {
    await call('setup.complete')
    router.replace('/')
  } catch (e) {
    toast(e.message, 'error')
  }
}
// If setup gets finished elsewhere (the website handing its setup to the extension),
// leave the tutorial right away.
watch(
  () => s.value.onboarding.completed,
  (done) => done && router.replace('/'),
  { immediate: true },
)
const extensionTab = inExtension()

// Look and feel, picked up front so the rest of setup already looks the way you like.
const uiMode = computed(() => s.value.settings.uiMode || 'game')
const MODES = [
  {
    id: 'game',
    name: 'Game',
    icon: 'sparkles',
    text: 'XP, levels, streak flames and badges. Finishing tasks pops, the room unlocks new scenes.',
  },
  {
    id: 'minimal',
    name: 'Calm',
    icon: 'moon',
    text: 'Quiet and editorial. Same features and progress, no pops or sounds. Numbers stay in the background.',
  },
]
function pickMode(id) {
  call('settings.update', { patch: { uiMode: id } }).catch((e) => toast(e.message, 'error'))
}
async function start() {
  await call('setup.step', { step: 'uiMode' }).catch(() => {})
  step.value = 1
}

const practiced = computed(() => !!s.value.onboarding.steps.failsafeDryRunDone)
const firstRule = computed(() => s.value.rules[0])
</script>

<template>
  <div
    class="min-h-screen bg-[radial-gradient(900px_500px_at_10%_-10%,var(--fg-accent-soft),transparent),radial-gradient(700px_400px_at_110%_110%,var(--fg-warm-soft),transparent)] px-4 py-8"
  >
    <div class="mx-auto max-w-xl">
      <div class="mb-6 flex items-center justify-between">
        <div class="flex items-center gap-2"><img :src="logo" alt="" class="h-8 w-8" /><span class="font-semibold">Regimen</span></div>
        <span class="flex items-center gap-2 text-xs text-muted">Step {{ step + 1 }} of {{ STEPS.length }} <QuickTheme /></span>
      </div>
      <div class="mb-6 flex gap-1" aria-hidden="true">
        <span v-for="(n, i) in STEPS" :key="n" class="h-1.5 flex-1 rounded-full" :class="i <= step ? 'bg-accent' : 'bg-line'" />
      </div>

      <section class="card p-6 sm:p-8">
        <!-- 1 -->
        <div v-if="step === 0" class="space-y-4">
          <h1 class="h-display text-4xl">Let's protect your focus.</h1>
          <p class="text-muted">
            Regimen blocks distracting sites while you work, and only unlocks them when your tasks are actually done. Setup takes about
            three minutes and it's worth doing properly.
          </p>
          <ul class="space-y-2 text-sm">
            <li class="flex gap-2">
              <Icon name="lock" :size="16" class="mt-0.5 text-accent" /> Task-gated windows: finish your work, then the sites open.
            </li>
            <li class="flex gap-2"><Icon name="shield" :size="16" class="mt-0.5 text-accent" /> Hard blocks for sleep and exam season.</li>
            <li class="flex gap-2">
              <Icon name="headphones" :size="16" class="mt-0.5 text-accent" /> A lofi study room, habits and an honest history.
            </li>
          </ul>
          <div v-if="store.mode === 'local'" class="rounded-xl bg-warm-soft p-4 text-sm">
            <b>No extension detected.</b> You can set up now and use tasks, habits and the study room right away. For blocking,
            <RouterLink to="/install" class="font-semibold text-accent underline">install the extension</RouterLink> first. Its own setup
            opens automatically.
          </div>
          <div v-else class="rounded-xl bg-good-soft p-4 text-sm text-good">
            <b>Extension connected.</b> Blocking will work in this browser.
          </div>
          <div v-if="extensionTab" class="rounded-xl border border-line p-4 text-sm text-muted">
            <b class="text-ink">Already set up on the Regimen website?</b> Go back to that tab instead. It reloads by itself; click the
            Regimen icon in your toolbar, press <b>Allow</b>, and your PIN and rules move over. No need to do this again.
          </div>
          <div>
            <p class="label">Pick a style (change it any time from the palette button)</p>
            <div class="grid gap-2 sm:grid-cols-2">
              <button
                v-for="m in MODES"
                :key="m.id"
                type="button"
                class="rounded-2xl border-2 p-4 text-left transition"
                :class="uiMode === m.id ? 'border-accent bg-accent-soft' : 'border-line hover:border-ink/30'"
                :aria-pressed="uiMode === m.id"
                @click="pickMode(m.id)"
              >
                <span class="flex items-center gap-2 font-bold"><Icon :name="m.icon" :size="16" class="text-accent" /> {{ m.name }}</span>
                <span class="mt-1 block text-xs text-muted">{{ m.text }}</span>
              </button>
            </div>
          </div>
          <div>
            <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <p class="label !mb-0">And a theme</p>
              <ColorModeSwitch />
            </div>
            <ThemePicker :mode="uiMode" compact />
          </div>
          <button class="btn btn-primary w-full py-3" @click="start">Start setup</button>
        </div>

        <!-- 2 -->
        <div v-else-if="step === 1" class="space-y-4">
          <h1 class="text-2xl font-semibold">Create your PIN</h1>
          <p class="text-sm text-muted">
            Your PIN is the key to <b>Failsafe</b>, the emergency override, and to editing rules while they run. It is not asked for
            everyday things. Pick something you'll remember but wouldn't type on impulse. Letters are fine.
          </p>
          <form class="space-y-3" @submit.prevent="createPin">
            <PinField v-model="pin" placeholder="PIN (6+ characters)" autocomplete="new-password" />
            <PinField v-model="pin2" placeholder="Same PIN again" autocomplete="new-password" />
            <p v-if="err" class="text-sm text-bad">{{ err }}</p>
            <button class="btn btn-primary w-full py-3" :disabled="pin.length < 6 || !pin2">Create PIN</button>
          </form>
        </div>

        <!-- 3 -->
        <div v-else-if="step === 2" class="space-y-4">
          <h1 class="text-2xl font-semibold">Save your recovery code</h1>
          <p class="text-sm text-muted">
            If you forget your PIN, this code is the <b>only</b> way to reset it. We just downloaded it as a text file. Also take a photo or
            write it down, and keep it away from this computer.
          </p>
          <template v-if="code">
            <p class="rounded-2xl bg-sunk p-5 text-center font-mono text-xl tracking-[0.2em] sm:text-2xl">{{ code }}</p>
            <button class="btn btn-sm" @click="saveCode"><Icon name="download" :size="14" /> Download again</button>
          </template>
          <div v-else class="rounded-xl bg-warm-soft p-4 text-sm">
            The code is only shown once and this page was reloaded.
            <button class="font-semibold text-accent underline" @click="regenerate">Make a new code</button>
          </div>
          <label class="flex items-start gap-2 rounded-xl border border-line p-3 text-sm">
            <input v-model="saved" type="checkbox" class="mt-0.5" :disabled="!code" /> I saved this code somewhere safe. I understand that
            losing both my PIN and this code means no Failsafe.
          </label>
          <button class="btn btn-primary w-full py-3" :disabled="!saved" @click="mark('recoverySaved', 3)">Continue</button>
        </div>

        <!-- 4 -->
        <div v-else-if="step === 3" class="space-y-4">
          <h1 class="text-2xl font-semibold">Practice the Failsafe once</h1>
          <p class="text-sm text-muted">
            Failsafe is your emergency exit. It is deliberately slow: confirm, enter your PIN, wait, then type why. Walk through it now so
            you know it works (and know it's annoying).
          </p>
          <ol class="space-y-2 text-sm">
            <li>1. "Are you sure?" You can walk away with <b>I'm Honorable</b>.</li>
            <li>2. Your PIN.</li>
            <li>3. A forced wait ({{ s.settings.failsafeWaitSeconds }}s normally, 10s for practice).</li>
            <li>4. Type the sentence and your reason. No pasting.</li>
          </ol>
          <button v-if="!practiced" class="btn btn-primary w-full py-3" @click="practicing = true">Start practice run</button>
          <template v-else>
            <p class="rounded-xl bg-good-soft p-3 text-sm text-good">Practice done.</p>
            <button class="btn btn-primary w-full py-3" @click="mark('failsafeDryRun', 4)">Continue</button>
          </template>
          <FailsafeFlow v-if="practicing" :target="{ type: 'practice' }" @close="practicing = false" />
        </div>

        <!-- 5 -->
        <div v-else-if="step === 4" class="space-y-4">
          <h1 class="text-2xl font-semibold">Your emergency exits</h1>
          <p class="text-sm text-muted">Know these before you need them. Tap each one to confirm you've read it.</p>
          <button
            class="flex w-full gap-3 rounded-xl border p-4 text-left text-sm"
            :class="seen.failsafe ? 'border-good bg-good-soft' : 'border-line'"
            @click="seen.failsafe = true"
          >
            <Icon name="unlock" class="text-accent" /><span
              ><b>Failsafe</b> is on the dashboard, the Blocking page and the blocked-site page, next to any rule that allows it. Rules you
              created without a failsafe can't be opened until they end.</span
            >
          </button>
          <button
            class="flex w-full gap-3 rounded-xl border p-4 text-left text-sm"
            :class="seen.recovery ? 'border-good bg-good-soft' : 'border-line'"
            @click="seen.recovery = true"
          >
            <Icon name="key" class="text-accent" /><span
              ><b>Forgot PIN</b> is under Settings. It needs the recovery code you just saved.</span
            >
          </button>
          <button
            class="flex w-full gap-3 rounded-xl border p-4 text-left text-sm"
            :class="seen.agent ? 'border-good bg-good-soft' : 'border-line'"
            @click="seen.agent = true"
          >
            <Icon name="terminal" class="text-accent" /><span
              ><b>If something breaks</b> (sites stay blocked after the lock agent crashed): run
              <code class="rounded bg-sunk px-1">regimen-agent recover</code>, or open <b>TROUBLESHOOTING.md</b> in the install folder. The
              recovery tool refuses to run while the agent is healthy, so it can't be used as a shortcut.</span
            >
          </button>
          <button
            class="btn btn-primary w-full py-3"
            :disabled="!seen.failsafe || !seen.recovery || !seen.agent"
            @click="mark('emergencyHelp', 5)"
          >
            I know my exits
          </button>
        </div>

        <!-- 6 -->
        <div v-else-if="step === 5" class="space-y-4">
          <h1 class="text-2xl font-semibold">Block everywhere (optional)</h1>
          <p class="text-sm text-muted">
            The browser extension blocks sites in this browser. That's enough for most people. If you want it to be really hard to wriggle
            out of, add the <b>lock agent</b>. It is a small free program that:
          </p>
          <ul class="space-y-1.5 text-sm">
            <li class="flex gap-2">
              <Icon name="check" :size="16" class="mt-0.5 text-good" /> blocks the same sites in every browser and app on this computer
            </li>
            <li class="flex gap-2">
              <Icon name="check" :size="16" class="mt-0.5 text-good" /> switches off "Secure DNS", the usual way around system blockers
            </li>
            <li class="flex gap-2">
              <Icon name="check" :size="16" class="mt-0.5 text-good" /> turns off private/incognito windows and can stop the extension from
              being removed
            </li>
            <li class="flex gap-2">
              <Icon name="check" :size="16" class="mt-0.5 text-good" /> keeps a running rule enforced even if you delete it here
            </li>
          </ul>
          <p class="text-sm text-muted">It needs admin rights once to install. You can add it later from Settings.</p>
          <div class="flex flex-wrap gap-2">
            <RouterLink to="/install" target="_blank" class="btn">How to install the agent</RouterLink>
            <button class="btn btn-primary flex-1" @click="mark('dohReviewed', 6)">Continue</button>
          </div>
        </div>

        <!-- 7 -->
        <div v-else-if="step === 6" class="space-y-4">
          <h1 class="text-2xl font-semibold">Create your first rule</h1>
          <p class="text-sm text-muted">
            Start small. A good first rule: <b>weekdays 4 to 7 pm, Instagram and YouTube blocked until today's homework is done.</b>
          </p>
          <div v-if="firstRule" class="rounded-xl bg-good-soft p-4 text-sm text-good">
            Created “{{ firstRule.name }}”. You can add more any time.
          </div>
          <button class="btn w-full py-3" :class="!firstRule && 'btn-primary'" @click="ruleOpen = true">
            <Icon name="plus" :size="16" /> {{ firstRule ? 'Add another rule' : 'Create a rule' }}
          </button>
          <button class="btn w-full" :class="firstRule && 'btn-primary'" @click="firstRule ? mark('firstRule', 7) : (step = 7)">
            {{ firstRule ? 'Continue' : 'Skip for now' }}
          </button>
          <RuleEditor v-if="ruleOpen" @close="ruleOpen = false" />
        </div>

        <!-- 8 -->
        <div v-else-if="step === 7" class="space-y-4">
          <h1 class="text-2xl font-semibold">All set. Screenshot this page.</h1>
          <p class="text-sm text-muted">Everything important, in one place:</p>
          <dl class="divide-y divide-line rounded-2xl border border-line text-sm">
            <div class="flex justify-between gap-4 p-3">
              <dt class="text-muted">PIN</dt>
              <dd class="font-medium">Set ✓ (only for Failsafe and live rule edits)</dd>
            </div>
            <div class="flex justify-between gap-4 p-3">
              <dt class="text-muted">Recovery code</dt>
              <dd class="text-right font-medium">regimen-recovery-code.txt in your downloads</dd>
            </div>
            <div class="flex justify-between gap-4 p-3">
              <dt class="text-muted">Failsafe</dt>
              <dd class="text-right font-medium">Dashboard, Blocking page, blocked-site page</dd>
            </div>
            <div class="flex justify-between gap-4 p-3">
              <dt class="text-muted">Forgot PIN</dt>
              <dd class="text-right font-medium">Settings → Forgot PIN</dd>
            </div>
            <div class="flex justify-between gap-4 p-3">
              <dt class="text-muted">Agent broken?</dt>
              <dd class="text-right font-medium">regimen-agent recover, TROUBLESHOOTING.md</dd>
            </div>
            <div class="flex justify-between gap-4 p-3">
              <dt class="text-muted">Blocking</dt>
              <dd class="text-right font-medium">
                {{
                  store.mode === 'local'
                    ? 'Off until you install the extension'
                    : s.agent.paired
                      ? 'Extension + lock agent'
                      : 'Extension (this browser)'
                }}
              </dd>
            </div>
          </dl>
          <button class="btn btn-primary w-full py-3" @click="finish">Go to my dashboard</button>
        </div>
      </section>
      <button v-if="step >= 4 && step < 7" class="mt-4 text-sm text-muted hover:text-ink" @click="step = Math.max(0, step - 1)">
        ← Back
      </button>
    </div>
  </div>
</template>
