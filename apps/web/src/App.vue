<script setup>
import { computed, ref, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { isDark, lookMode, activeTheme } from './lib/look.js'
import { store, blocks, useLocalInstead } from './lib/store.js'
import Icon from './components/Icon.vue'
import logo from './assets/logo.svg'
import Toasts from './components/Toasts.vue'
import DialogHost from './components/DialogHost.vue'
import TourHost from './components/help/TourHost.vue'
import HelpDrawer from './components/help/HelpDrawer.vue'
import BlockingOffDialog from './components/help/BlockingOffDialog.vue'
import BlockingStatusDialog from './components/help/BlockingStatusDialog.vue'
import FirstVisitDialog from './components/help/FirstVisitDialog.vue'
import ExtensionBanner from './components/help/ExtensionBanner.vue'
import ApproveGuide from './components/help/ApproveGuide.vue'
import QuickTheme from './components/look/QuickTheme.vue'
import StatusStrip from './components/StatusStrip.vue'
import TodayRail from './components/TodayRail.vue'
import Celebrate from './components/Celebrate.vue'
import { startRewardWatch, isGame } from './lib/rewards.js'
import { startSeenSync } from './lib/seen.js'
import { lofiState } from './lib/lofi.js'
import { freshAffordable } from './lib/shop.js'

const route = useRoute()
const menu = ref(false)

// Mode and theme. App wraps every route, bare ones like onboarding too, so this is the
// one place <html> gets its attributes.
watchEffect(() => {
  // game (bold, pressable) or minimal (Calm): picked in onboarding, changeable in Settings
  const root = document.documentElement
  root.dataset.mode = lookMode.value
  // the whole theme (colours, typefaces, surfaces) is pure CSS from here, see style.css
  root.dataset.themeId = activeTheme.value.id
  // .dark picks the theme's dark variant (settings.colorMode), so text and surfaces
  // always come from the same variant
  root.classList.toggle('dark', isDark.value)
})
startRewardWatch()
startSeenSync()

// The study room is home. Everything else is one click away and shares the status strip.
const nav = [
  { to: '/', label: 'Study room', short: 'Room', icon: 'headphones' },
  { to: '/today', label: 'Today', short: 'Today', icon: 'home' },
  { to: '/tasks', label: 'Tasks', short: 'Tasks', icon: 'list' },
  { to: '/schedule', label: 'Schedule', short: 'Plan', icon: 'calendar' },
  { to: '/blocking', label: 'Blocking', short: 'Blocks', icon: 'shield' },
  { to: '/habits', label: 'Habits', short: 'Habits', icon: 'target' },
  { to: '/stats', label: 'Accountability', short: 'Stats', icon: 'chart' },
  { to: '/shop', label: 'Shop', short: 'Shop', icon: 'bag' },
  { to: '/settings', label: 'Settings', short: 'Settings', icon: 'settings' },
]
const mobileNav = [nav[0], nav[1], nav[2], nav[5], nav[6], nav[7]]
// a dot on the shop when something new is affordable
const shopNew = computed(() => freshAffordable.value.length)
const activeCount = computed(() => blocks.value.blocks.length)
const showRail = computed(() => !['/today', '/tasks', '/habits'].includes(route.path))
</script>

<template>
  <div v-if="store.pendingApproval" class="relative grid min-h-screen place-items-center p-4 sm:p-6" data-pending-approval>
    <div class="absolute top-3 right-3"><QuickTheme /></div>
    <div class="card w-full max-w-xl p-5 sm:p-6">
      <div class="text-center">
        <img :src="logo" alt="" class="mx-auto h-12 w-12" />
        <h1 class="mt-3 text-xl font-semibold">Approve this site in the extension</h1>
        <p class="mt-1.5 text-sm text-muted">The Regimen extension is installed. Two quick steps let this site use it to block sites.</p>
      </div>
      <div class="mt-4">
        <ApproveGuide />
      </div>
      <div class="mt-4 border-t border-line pt-3 text-center">
        <button class="btn btn-ghost btn-sm" @click="useLocalInstead">Continue without blocking</button>
        <p class="mt-1 text-xs font-semibold text-bad">Without approving, nothing is blocked in this browser.</p>
      </div>
    </div>
  </div>

  <template v-else>
    <RouterView v-if="route.meta.bare" />
    <div v-else class="min-h-screen lg:flex">
      <!-- sidebar -->
      <aside class="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line px-4 py-5 lg:flex">
        <RouterLink to="/" class="mb-6 flex items-center gap-2.5 px-2">
          <img :src="logo" alt="" class="h-8 w-8" />
          <span class="text-[17px] font-semibold tracking-tight game:font-black">Regimen</span>
        </RouterLink>
        <nav class="flex flex-1 flex-col gap-0.5" aria-label="Main">
          <RouterLink
            v-for="n in nav"
            :key="n.to"
            :to="n.to"
            class="flex items-center gap-3 rounded-xl px-3 py-2 text-sm font-medium text-muted transition hover:bg-sunk hover:text-ink game:font-bold"
            :exact-active-class="
              isGame ? '!bg-accent !text-on-accent shadow-[inset_0_-3px_0_var(--fg-accent-deep)]' : '!bg-accent-soft !text-accent'
            "
          >
            <Icon :name="n.icon" /> {{ n.label }}
            <span
              v-if="n.to === '/blocking' && activeCount"
              class="ml-auto rounded-full bg-accent px-2 text-[11px] font-bold text-on-accent"
              >{{ activeCount }}</span
            >
            <span v-if="n.to === '/' && lofiState.playing" class="ml-auto h-2 w-2 animate-pulse rounded-full bg-warm" />
            <span
              v-if="n.to === '/shop' && shopNew"
              class="ml-auto grid h-5 min-w-5 place-items-center rounded-full bg-[#ff5d8f] px-1.5 text-[11px] font-bold text-white"
              :title="`${shopNew} new thing${shopNew === 1 ? '' : 's'} you can afford`"
              data-shop-dot
              >{{ shopNew }}</span
            >
          </RouterLink>
        </nav>
        <div class="space-y-2">
          <div class="flex items-center justify-between px-1"><QuickTheme label /></div>
          <RouterLink v-if="store.mode === 'local'" to="/install" class="block rounded-xl bg-warm-soft p-3 text-xs">
            <b class="text-warm">Blocking is off.</b> <span class="text-muted">Install the free extension to block sites.</span>
          </RouterLink>
          <p v-else-if="!store.state?.agent?.paired" class="px-3 text-xs text-muted">
            Extension active. <RouterLink to="/install" class="text-accent underline">Add the lock agent</RouterLink> for every browser.
          </p>
          <p v-else class="px-3 text-xs text-good">Extension + lock agent active</p>
        </div>
      </aside>

      <!-- mobile top bar -->
      <header class="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-paper px-4 py-3 lg:hidden">
        <RouterLink to="/" class="flex items-center gap-2"
          ><img :src="logo" alt="" class="h-7 w-7" /><span class="font-semibold">Regimen</span></RouterLink
        >
        <div class="flex items-center gap-1">
          <QuickTheme />
          <button class="btn btn-ghost btn-sm" aria-label="Menu" @click="menu = !menu"><Icon name="menu" /></button>
        </div>
      </header>
      <div v-if="menu" class="fixed inset-0 z-40 bg-paper p-4 lg:hidden" @click="menu = false">
        <div class="mb-4 flex justify-end">
          <button class="btn btn-ghost btn-sm" aria-label="Close menu"><Icon name="x" /></button>
        </div>
        <RouterLink v-for="n in nav" :key="n.to" :to="n.to" class="flex items-center gap-3 rounded-xl px-3 py-3 font-medium"
          ><Icon :name="n.icon" /> {{ n.label }}</RouterLink
        >
        <RouterLink to="/install" class="flex items-center gap-3 rounded-xl px-3 py-3 font-medium"
          ><Icon name="puzzle" /> Install</RouterLink
        >
      </div>

      <div class="min-w-0 flex-1">
        <div class="sticky top-[57px] z-20 bg-paper px-4 pt-3 pb-2 sm:px-6 lg:top-0 lg:px-10 lg:pt-5">
          <div class="mx-auto max-w-5xl" data-tour="status"><StatusStrip /></div>
        </div>
        <main class="mx-auto w-full max-w-5xl px-4 pt-4 pb-28 sm:px-6 lg:px-10 lg:pt-6 lg:pb-12">
          <ExtensionBanner class="mb-4" />
          <RouterView />
        </main>
      </div>
      <TodayRail v-if="showRail" />

      <!-- mobile bottom nav -->
      <nav
        class="fixed inset-x-0 bottom-0 z-30 grid grid-cols-6 border-t border-line bg-paper pb-[env(safe-area-inset-bottom)] lg:hidden"
        aria-label="Quick"
      >
        <RouterLink
          v-for="n in mobileNav"
          :key="n.to"
          :to="n.to"
          class="relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-muted"
          exact-active-class="!text-accent"
        >
          <Icon :name="n.icon" :size="20" /> {{ n.short }}
          <span v-if="n.to === '/shop' && shopNew" class="absolute top-1.5 left-1/2 ml-2 h-2.5 w-2.5 rounded-full bg-[#ff5d8f]" />
        </RouterLink>
      </nav>
    </div>
  </template>

  <Toasts />
  <DialogHost />
  <BlockingOffDialog />
  <BlockingStatusDialog />
  <FirstVisitDialog />
  <HelpDrawer />
  <TourHost />
  <Celebrate />
</template>
