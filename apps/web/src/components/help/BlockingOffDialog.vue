<script setup>
// Big, clear "Blocking is off in this browser" dialog. Opened by ensureBlocking() (guard.js)
// before a focus session or a rule starts, by the red "Blocking is off" boxes and by the
// fixes in the Blocking status checklist.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { guard, closeGuard } from './guard.js'
import { store, requestHostAccess } from '../../lib/store.js'
import { browser, browserName as name, installTarget, PHONE_NOTE } from './install.js'
import Modal from '../Modal.vue'
import Icon from '../Icon.vue'
import ApproveGuide from './ApproveGuide.vue'

const router = useRouter()

const title = computed(() => {
  if (guard.issue === 'not-approved') return 'Connect this site to the extension'
  if (guard.issue === 'no-access') return 'The extension can not block yet'
  return 'Blocking is off in this browser'
})

const goOn = computed(() => ({ focus: 'Start anyway', rule: 'Save it anyway', test: null, info: null })[guard.context] ?? null)

/** One-click install target for this browser: a store page when live, else the zip. */
const install = computed(installTarget)
const manual = computed(() => install.value && !install.value.store)
const extPage = { edge: 'edge://extensions', brave: 'brave://extensions', opera: 'opera://extensions' }[browser] || 'chrome://extensions'

function openInstall() {
  closeGuard(false)
  router.push('/install')
}
async function grant() {
  if (await requestHostAccess()) closeGuard(guard.context !== 'info' && guard.context !== 'test')
}
</script>

<template>
  <Modal v-if="guard.open" :title="title" wide @close="closeGuard(false)">
    <div data-blocking-off class="space-y-4 text-sm">
      <div class="flex items-start gap-3 rounded-xl border-2 border-bad bg-bad-soft p-4 text-ink">
        <Icon name="alert" :size="22" class="mt-0.5 shrink-0 text-bad" />
        <p v-if="guard.issue === 'no-extension'">
          <b class="text-bad">Nothing will be blocked.</b> Regimen blocks sites with its free browser extension, and it is not installed in
          {{ name }}. YouTube, Reddit and every other site still open.
          <template v-if="guard.context === 'focus'">The timer still runs, so you can focus without blocking.</template>
          <template v-else>The timer, tasks and the study room work without it.</template>
        </p>
        <p v-else-if="guard.issue === 'not-approved'">
          <b class="text-bad">Nothing will be blocked yet.</b> The Regimen extension is installed, but this website is not connected to it,
          so it is running on its own and blocks nothing.
        </p>
        <p v-else>
          <b class="text-bad">Nothing will be blocked yet.</b> {{ name }} has not given Regimen access to websites, so it can not stop them
          from loading.
        </p>
      </div>

      <!-- how to fix it -->
      <template v-if="guard.issue === 'no-extension'">
        <p v-if="browser === 'safari'">
          Safari can not run the extension. Open Regimen in Chrome, Edge, Brave or Firefox, or install the lock agent from the Install page,
          which blocks in every browser on your computer.
        </p>
        <p v-else-if="browser === 'phone'" data-phone-note>{{ PHONE_NOTE }}</p>
        <ol v-else-if="manual" class="list-decimal space-y-1 pl-5 text-muted">
          <template v-if="browser === 'firefox'">
            <li>Download the extension and unzip it.</li>
            <li>Open <code>about:debugging</code>, This Firefox, <b>Load Temporary Add-on</b>, and pick <code>manifest.json</code>.</li>
            <li>When Firefox asks, allow access to all websites.</li>
          </template>
          <template v-else>
            <li>Download the extension and unzip it into a folder you keep.</li>
            <li>
              Open <code>{{ extPage }}</code
              >, turn on <b>Developer mode</b>, click <b>Load unpacked</b> and pick the folder.
            </li>
            <li>Come back to this tab, click the Regimen icon (under the puzzle piece) and press <b>Allow</b>.</li>
          </template>
        </ol>
        <p v-else class="text-muted">It takes one click. Then come back to this tab and press Allow in the Regimen icon.</p>
      </template>
      <ApproveGuide v-else-if="guard.issue === 'not-approved'" />
      <p v-else-if="store.mode === 'extension'" class="text-muted">Press the button and choose Allow. Blocking starts right away.</p>
      <ol v-else class="list-decimal space-y-1 pl-5 text-muted">
        <li>Click the Regimen icon in the toolbar (in Firefox it may be under the puzzle piece).</li>
        <li>Press <b>Grant access</b> and choose Allow.</li>
      </ol>

      <div class="flex flex-wrap items-center gap-2 pt-1">
        <template v-if="guard.issue === 'no-extension'">
          <a v-if="install" :href="install.url" class="btn btn-primary" target="_blank" rel="noopener"
            ><Icon name="puzzle" :size="16" /> {{ install.label }}</a
          >
          <button v-if="browser !== 'phone'" class="btn" :class="!install && 'btn-primary'" @click="openInstall">Install guide</button>
        </template>
        <button v-else-if="guard.issue === 'no-access' && store.mode === 'extension'" class="btn btn-primary" @click="grant">
          <Icon name="shield" :size="16" /> Allow access to websites
        </button>
        <span class="flex-1" />
        <button v-if="goOn" class="btn btn-ghost" data-go-on @click="closeGuard(true)">{{ goOn }}</button>
        <button v-else class="btn btn-ghost" @click="closeGuard(false)">Close</button>
      </div>
    </div>
  </Modal>
</template>
