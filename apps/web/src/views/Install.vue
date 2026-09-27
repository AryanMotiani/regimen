<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { store, call, refresh } from '../lib/store.js'
import {
  REPO_URL,
  RELEASES_URL,
  CHROME_STORE_URL,
  EDGE_STORE_URL,
  FIREFOX_ADDONS_URL,
  PRIVACY_URL,
  AGENT_GUIDE_URL,
  ASSETS,
  download,
} from '../config.js'
import Icon from '../components/Icon.vue'
import HelpButton from '../components/help/HelpButton.vue'
import BlockingTest from '../components/help/BlockingTest.vue'

// ------------------------------------------------------------ what are we running on
const ua = navigator.userAgent
function detectBrowser() {
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Edg\//.test(ua)) return 'edge'
  if (/OPR\/|Opera/.test(ua)) return 'opera'
  if (navigator.brave) return 'brave'
  if (/Chrome\/|Chromium\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}
const browser = detectBrowser()
const BROWSER_NAME = {
  firefox: 'Firefox',
  edge: 'Edge',
  opera: 'Opera',
  brave: 'Brave',
  chrome: 'Chrome',
  safari: 'Safari',
  other: 'your browser',
}
const chromium = ['chrome', 'brave', 'opera', 'edge'].includes(browser) || browser === 'other'

function detectOs() {
  const p = (navigator.userAgentData?.platform || navigator.platform || '') + ' ' + ua
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(p)) return 'none'
  if (/Win/i.test(p)) return 'win'
  if (/Mac/i.test(p)) return 'mac'
  if (/Linux|X11/i.test(p)) return 'linux'
  return 'none'
}
const os = detectOs()

/** The one store button for this browser, or null when that listing isn't live yet. */
const storeButton = computed(() => {
  if (browser === 'firefox' && FIREFOX_ADDONS_URL) return { label: 'Add to Firefox', url: FIREFOX_ADDONS_URL }
  if (browser === 'edge' && EDGE_STORE_URL) return { label: 'Get it for Edge', url: EDGE_STORE_URL }
  if (['chrome', 'brave', 'opera', 'other'].includes(browser) && CHROME_STORE_URL)
    return { label: `Add to ${BROWSER_NAME[browser]}`, url: CHROME_STORE_URL }
  return null
})
const otherStores = computed(() =>
  [
    browser !== 'firefox' && FIREFOX_ADDONS_URL && { label: 'Firefox Add-ons', url: FIREFOX_ADDONS_URL },
    browser !== 'edge' && EDGE_STORE_URL && { label: 'Edge Add-ons', url: EDGE_STORE_URL },
    !['chrome', 'brave', 'opera'].includes(browser) && CHROME_STORE_URL && { label: 'Chrome Web Store', url: CHROME_STORE_URL },
  ].filter(Boolean),
)
const extensionReady = computed(() => store.mode !== 'local')
const reload = () => location.reload()

const AGENT = {
  win: { label: 'Download lock agent for Windows', asset: ASSETS.windowsSetup, note: 'Windows 10 and 11, Intel and ARM' },
  mac: { label: 'Download lock agent for macOS', asset: ASSETS.macPkg, note: 'macOS 11 or newer, Apple silicon and Intel' },
  linux: { label: 'Download lock agent for Linux', asset: ASSETS.debAmd64, note: 'Ubuntu, Debian, Mint and friends (64-bit Intel/AMD)' },
}
const agentMain = AGENT[os] || null
const otherDownloads = [
  { label: 'Windows installer', asset: ASSETS.windowsSetup },
  { label: 'macOS package', asset: ASSETS.macPkg },
  { label: 'Linux .deb (x64)', asset: ASSETS.debAmd64 },
  { label: 'Linux .deb (ARM64)', asset: ASSETS.debArm64 },
  { label: 'Linux .rpm (x64)', asset: ASSETS.rpmX64 },
  { label: 'Linux .rpm (ARM64)', asset: ASSETS.rpmArm64 },
].filter((d) => d.asset !== agentMain?.asset)
const installLine = `curl -fsSL ${download(ASSETS.installSh)} | sh`

const copied = ref('')
function copy(t) {
  navigator.clipboard?.writeText(t)
  copied.value = t
  setTimeout(() => (copied.value = ''), 1500)
}

// ------------------------------------------------------------ one-click pairing
// After installing, the agent opens this page as #/install?pair=<one-time code>.
// The code lives after the #, so it never reaches a web server. We take it out of
// the address bar right away and keep it only in this tab until it is used.
const PAIR_KEY = 'regimen:pair-link'
const PAIR_TTL = 30 * 60_000
const route = useRoute()
const router = useRouter()
const pair = ref({ status: 'idle', message: '' }) // idle | waiting | connecting | connected | already | error | timeout
// Stop watching after this long if the agent never answers, and offer a retry instead
const PAIR_WATCH_MS = 2 * 60_000
const manualCode = ref('')
let pollTimer = null
let lastCode = null

function readPending() {
  try {
    const p = JSON.parse(sessionStorage.getItem(PAIR_KEY) || 'null')
    if (p && Date.now() - p.at < PAIR_TTL) return p.code
    sessionStorage.removeItem(PAIR_KEY)
  } catch {}
  return null
}
function clearPending() {
  try {
    sessionStorage.removeItem(PAIR_KEY)
  } catch {}
}

function takeCodeFromUrl() {
  const code = route.query.pair
  if (typeof code !== 'string' || !code.trim()) return
  try {
    sessionStorage.setItem(PAIR_KEY, JSON.stringify({ code: code.trim(), at: Date.now() }))
  } catch {}
  router.replace({ path: '/install' })
  if (pair.value.status === 'idle') pair.value = { status: 'waiting', message: '' }
}

function stopPolling() {
  clearInterval(pollTimer)
  pollTimer = null
}

/** The extension exchanges the code with the agent in the background. Watch for the result. */
function watchPairing() {
  stopPolling()
  const started = Date.now()
  pollTimer = setInterval(async () => {
    await refresh()
    const a = store.state?.agent
    if (!a) return
    if (a.paired) {
      stopPolling()
      pair.value = { status: 'connected', message: '' }
    } else if (a.lastError && (!a.pairing || Date.now() - started > 20_000)) {
      stopPolling()
      pair.value = { status: 'error', message: a.lastError }
    } else if (Date.now() - started > PAIR_WATCH_MS) {
      stopPolling()
      pair.value = { status: 'timeout', message: '' }
    }
  }, 1000)
}

async function connect(code) {
  lastCode = code
  pair.value = { status: 'connecting', message: '' }
  try {
    await call('agent.configure', { pairCode: code })
    watchPairing()
  } catch (e) {
    pair.value = { status: 'error', message: e.message }
  }
}

function retryPairing() {
  if (store.state?.agent?.paired) {
    pair.value = { status: 'connected', message: '' }
    return
  }
  if (lastCode) return connect(lastCode)
  pair.value = { status: 'connecting', message: '' }
  watchPairing()
}

function tryPendingCode() {
  const code = readPending()
  if (!code) return
  if (!store.ready || !extensionReady.value || store.pendingApproval || !store.state) {
    pair.value = { status: 'waiting', message: '' }
    return
  }
  clearPending()
  if (store.state.agent?.paired) {
    // Already connected: re-pairing needs the PIN, which lives in Settings.
    pair.value = { status: 'already', message: '' }
    return
  }
  connect(code)
}

function connectManual() {
  const code = manualCode.value.trim()
  if (!code) return
  if (store.state?.agent?.paired) {
    pair.value = { status: 'already', message: '' }
    return
  }
  connect(code)
  manualCode.value = ''
}

watch(() => route.query.pair, takeCodeFromUrl)
watch(() => [store.ready, store.mode, store.pendingApproval, !!store.state], tryPendingCode)
onMounted(() => {
  takeCodeFromUrl()
  tryPendingCode()
})
onBeforeUnmount(stopPolling)

const agentPaired = computed(() => !!store.state?.agent?.paired)
</script>

<template>
  <div class="max-w-3xl space-y-6">
    <header class="flex items-start justify-between gap-3">
      <div>
        <h1 class="h-display text-4xl">Install</h1>
        <p class="mt-1 text-muted">
          Two free pieces, two minutes. The extension is all most people need. The lock agent makes blocks apply everywhere.
        </p>
      </div>
      <HelpButton page="install" />
    </header>

    <!-- pairing status: appears when the agent opened this page, or after typing a code -->
    <section
      v-if="pair.status !== 'idle'"
      class="card p-5"
      role="status"
      aria-live="polite"
      :class="{
        'border-good': pair.status === 'connected',
        'border-bad': pair.status === 'error',
      }"
    >
      <template v-if="pair.status === 'connected'">
        <p class="flex items-center gap-2 font-semibold text-good"><Icon name="check" :size="18" /> Lock agent connected</p>
        <p class="mt-1 text-sm text-muted">
          Your blocks now apply to every browser and app on this computer. Restart your browsers once so the new settings apply.
        </p>
      </template>
      <template v-else-if="pair.status === 'connecting'">
        <p class="flex items-center gap-2 font-semibold"><Icon name="clock" :size="18" /> Connecting the lock agent...</p>
        <p class="mt-1 text-sm text-muted">This takes a few seconds.</p>
      </template>
      <template v-else-if="pair.status === 'waiting'">
        <p class="flex items-center gap-2 font-semibold"><Icon name="key" :size="18" /> The lock agent is installed</p>
        <p class="mt-1 text-sm text-muted">
          {{
            store.pendingApproval
              ? 'Approve this site in the Regimen extension (toolbar icon, Allow). The agent connects right after.'
              : 'Add the browser extension below. The agent connects as soon as the extension is ready, no code to type.'
          }}
        </p>
      </template>
      <template v-else-if="pair.status === 'already'">
        <p class="flex items-center gap-2 font-semibold text-good"><Icon name="check" :size="18" /> Already connected</p>
        <p class="mt-1 text-sm text-muted">
          The lock agent is paired with this extension. To pair it again, disconnect it first in
          <RouterLink to="/settings" class="text-accent underline">Settings, Lock agent</RouterLink> (needs your PIN).
        </p>
      </template>
      <template v-else-if="pair.status === 'timeout'">
        <p class="flex items-center gap-2 font-semibold"><Icon name="clock" :size="18" /> The lock agent has not answered yet</p>
        <p class="mt-1 text-sm text-muted">
          Check that the agent is installed and running on this computer, then try again. If it still does not connect, open the lock agent
          again for a fresh link or type the code it shows below.
        </p>
        <button class="btn btn-primary mt-3" @click="retryPairing">Try again</button>
      </template>
      <template v-else-if="pair.status === 'error'">
        <p class="flex items-center gap-2 font-semibold text-bad"><Icon name="alert" :size="18" /> Could not connect: {{ pair.message }}</p>
        <p class="mt-1 text-sm text-muted">
          Pairing links work once and for 30 minutes. Open the lock agent again (or run <code>regimen-agent pair</code> as admin) for a
          fresh link, or type the code it shows below.
        </p>
      </template>
    </section>

    <!-- Step 1: extension -->
    <section class="card p-6">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="chip !bg-accent-soft !text-accent">Step 1</p>
          <h2 class="mt-2 text-xl font-semibold">Browser extension</h2>
        </div>
        <span v-if="extensionReady" class="chip !bg-good-soft !text-good"><Icon name="check" :size="12" /> Installed</span>
      </div>
      <div v-if="extensionReady" class="mt-4">
        <BlockingTest />
      </div>
      <p class="mt-2 text-sm text-muted">Blocks sites on your schedule and keeps your data on this computer. Free, no account.</p>

      <div v-if="!extensionReady && store.health.extension" class="mt-4 rounded-xl border-2 border-bad bg-bad-soft p-4 text-sm">
        <p class="font-semibold text-bad">The extension is installed, but this site is not connected to it, so nothing is blocked.</p>
        <p class="mt-1 text-muted">Reload, then click the puzzle piece, Regimen, and press Allow.</p>
        <button class="btn btn-primary btn-sm mt-3" @click="reload">Connect now</button>
      </div>
      <template v-if="!extensionReady">
        <div v-if="browser === 'safari'" class="mt-4 text-sm">
          <p>
            Safari does not run the Regimen extension. Install the <b>lock agent</b> in step 2: it blocks in Safari and every other app.
            Using another browser too? Open this page there.
          </p>
        </div>

        <div class="mt-4 flex flex-wrap items-center gap-2">
          <a v-if="storeButton" :href="storeButton.url" class="btn btn-primary" target="_blank" rel="noopener"
            ><Icon name="puzzle" :size="16" /> {{ storeButton.label }}</a
          >
          <a
            v-else-if="browser !== 'safari'"
            :href="download(browser === 'firefox' ? ASSETS.firefoxZip : ASSETS.chromiumZip)"
            class="btn btn-primary"
            ><Icon name="download" :size="16" /> Download for {{ BROWSER_NAME[browser] }}</a
          >
          <a v-for="s in otherStores" :key="s.url" :href="s.url" class="btn" target="_blank" rel="noopener">{{ s.label }}</a>
        </div>

        <div v-if="!storeButton && browser !== 'safari'" class="mt-4 space-y-2 text-sm">
          <p v-if="chromium && browser !== 'edge'" class="text-muted">
            The Chrome Web Store listing is on its way. Until then it takes four clicks by hand.
            <template v-if="EDGE_STORE_URL || FIREFOX_ADDONS_URL">Have Edge or Firefox? The store buttons above are one click.</template>
          </p>
          <ol v-if="browser !== 'firefox'" class="list-decimal space-y-1 pl-5 text-muted">
            <li>Unzip the download into a folder you will keep (for example Documents/Regimen).</li>
            <li>
              Open
              <code
                >{{
                  browser === 'edge' ? 'edge' : browser === 'brave' ? 'brave' : browser === 'opera' ? 'opera' : 'chrome'
                }}://extensions</code
              >
              and turn on <b>Developer mode</b>.
            </li>
            <li>Click <b>Load unpacked</b> and pick the unzipped folder.</li>
            <li>
              Come back to this tab and reload it. Click the <b>puzzle piece</b> in the toolbar, then <b>Regimen</b>, and press
              <b>Allow</b>. Anything you set up here moves in. Until you allow it, nothing is blocked.
            </li>
          </ol>
          <p v-else class="text-muted">
            Firefox keeps only signed add-ons, so use the Firefox Add-ons button once it is live. To try it now: open
            <code>about:debugging</code>, This Firefox, <b>Load Temporary Add-on</b>, and pick <code>manifest.json</code> from the unzipped
            download (it lasts until Firefox restarts). When Firefox asks, allow access to all websites: without it, nothing is blocked.
          </p>
        </div>
      </template>
    </section>

    <!-- Step 2: lock agent -->
    <section class="card p-6">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="chip">Step 2 · recommended</p>
          <h2 class="mt-2 text-xl font-semibold">Lock agent</h2>
        </div>
        <span v-if="agentPaired" class="chip !bg-good-soft !text-good"><Icon name="check" :size="12" /> Connected</span>
      </div>
      <p class="mt-2 text-sm text-muted">
        One small program (about 7 MB, nothing else to install). It applies your blocks to every browser and app, turns off Secure DNS and
        private windows, and keeps running if the extension is removed.
      </p>

      <div v-if="agentMain" class="mt-4">
        <a :href="download(agentMain.asset)" class="btn btn-primary"><Icon name="download" :size="16" /> {{ agentMain.label }}</a>
        <p class="mt-1.5 text-xs text-muted">{{ agentMain.note }}</p>
      </div>
      <p v-else class="mt-4 text-sm">The lock agent runs on Windows, macOS and Linux computers. Open this page on one of those.</p>

      <ol v-if="agentMain" class="mt-4 list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>Open the download and follow the prompts. It asks for admin rights once.</li>
        <li>Your browser opens this page again and connects the agent by itself.</li>
      </ol>
      <p v-if="os === 'win' || os === 'mac'" class="mt-3 text-xs text-muted">
        <template v-if="os === 'win'">
          Windows may say it "protected your PC" because the free installer is not code-signed yet. Click <b>More info</b>, then
          <b>Run anyway</b>.
        </template>
        <template v-else>
          macOS may say it can't verify the package because it is not notarized yet. Click <b>Done</b>, then open System Settings, Privacy
          &amp; Security and click <b>Open Anyway</b> (older macOS: right-click the file, <b>Open</b>).
        </template>
        <a :href="AGENT_GUIDE_URL" target="_blank" rel="noopener" class="text-accent underline">Step-by-step guide</a>
      </p>

      <div v-if="os === 'linux'" class="mt-3">
        <p class="text-xs text-muted">Or in a terminal (any distro, picks the right package):</p>
        <div class="mt-1 flex items-center gap-2 rounded-xl bg-[#151129] px-3 py-2 font-mono text-[13px] text-[#e9e4ff]">
          <span class="flex-1 overflow-x-auto whitespace-nowrap">{{ installLine }}</span>
          <button class="shrink-0 rounded-md px-2 py-0.5 text-xs text-white/60 hover:bg-white/10" @click="copy(installLine)">
            {{ copied === installLine ? 'Copied' : 'Copy' }}
          </button>
        </div>
      </div>

      <details class="mt-4 text-sm">
        <summary class="cursor-pointer text-muted">Other platforms and options</summary>
        <ul class="mt-2 space-y-1">
          <li v-for="d in otherDownloads" :key="d.asset">
            <a :href="download(d.asset)" class="text-accent underline">{{ d.label }}</a>
          </li>
          <li><a :href="RELEASES_URL" target="_blank" rel="noopener" class="text-accent underline">All files of the latest release</a></li>
        </ul>
        <p class="mt-3 text-muted">
          Want the extensions page and developer tools locked too? Run <code>regimen-agent install --strict</code> as admin. Remove it with
          <code>regimen-agent uninstall</code> (refused while a no-failsafe block is running).
        </p>
      </details>

      <div v-if="extensionReady && !agentPaired" class="mt-4 border-t border-line pt-4">
        <p class="text-sm font-semibold">Have a pairing code?</p>
        <p class="text-xs text-muted">Only needed if the browser did not open by itself after installing.</p>
        <form class="mt-2 flex flex-wrap gap-2" @submit.prevent="connectManual">
          <input v-model="manualCode" class="input max-w-xs font-mono" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" aria-label="Pairing code" />
          <button class="btn" :disabled="!manualCode.trim()">Connect</button>
        </form>
      </div>
    </section>

    <p class="text-sm text-muted">
      Open source: <a :href="REPO_URL" target="_blank" rel="noopener" class="text-accent underline">read the code</a> before you give it
      admin rights. You should, with any program. Nothing leaves your computer:
      <a :href="PRIVACY_URL" target="_blank" rel="noopener" class="text-accent underline">privacy policy</a>.
    </p>
  </div>
</template>
