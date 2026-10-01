import { createRouter, createWebHashHistory } from 'vue-router'
import { store, booted, blockingIssue, sessionRunning } from './lib/store.js'
import { askYesNo } from './lib/dialogs.js'

// Hash history: works on every static host and inside the extension, no rewrites needed.
const routes = [
  { path: '/home', component: () => import('./views/Landing.vue'), meta: { bare: true, public: true, title: 'Regimen' } },
  { path: '/welcome', component: () => import('./views/Onboarding.vue'), meta: { bare: true, public: true, title: 'Set up' } },
  { path: '/install', component: () => import('./views/Install.vue'), meta: { public: true, title: 'Install' } },
  // The study room is home. /room stays public so people can try it before setting anything up.
  { path: '/room', component: () => import('./views/Room.vue'), meta: { bare: true, public: true, title: 'Study room' } },
  { path: '/recover', component: () => import('./views/Recover.vue'), meta: { bare: true, public: true, title: 'Forgot PIN' } },
  { path: '/', component: () => import('./views/Room.vue'), meta: { bare: true, title: 'Study room' } },
  { path: '/today', component: () => import('./views/Dashboard.vue'), meta: { title: 'Today' } },
  { path: '/tasks', component: () => import('./views/Tasks.vue'), meta: { title: 'Tasks' } },
  { path: '/schedule', component: () => import('./views/Schedule.vue'), meta: { title: 'Schedule' } },
  { path: '/blocking', component: () => import('./views/Blocking.vue'), meta: { title: 'Blocking' } },
  { path: '/habits', component: () => import('./views/Habits.vue'), meta: { title: 'Habits' } },
  { path: '/stats', component: () => import('./views/Stats.vue'), meta: { title: 'Accountability' } },
  { path: '/shop', component: () => import('./views/Shop.vue'), meta: { title: 'Shop' } },
  { path: '/settings', component: () => import('./views/Settings.vue'), meta: { title: 'Settings' } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
})

const ROOM = new Set(['/', '/room'])

// Leaving the study room during a session asks first (a friendly nudge, never a trap).
router.beforeEach(async (to, from) => {
  if (!from.matched.length || !ROOM.has(from.path) || ROOM.has(to.path) || !sessionRunning()) return true
  const stay = await askYesNo(
    'Stay focused?',
    blockingIssue.value
      ? 'Your session is still running. Leaving the room does not stop the timer.'
      : 'Your session is still running. Sites stay blocked either way.',
    { yes: 'Stay', no: 'Leave' },
  )
  // Stay, Esc or a click outside all keep you in the room
  return stay === false
})

/**
 * Where someone who is not set up yet goes instead of the app: the landing page for a first
 * visit to the hosted site without the extension, the setup otherwise. null once set up.
 */
export function notSetUpRoute() {
  if (!store.state) return '/home'
  if (store.state.onboarding.completed) return null
  return store.mode === 'local' && !store.state.security.hasPin ? '/home' : '/welcome'
}

router.beforeEach(async (to) => {
  // Older blocked pages link to /?failsafe=… ; the Failsafe flow lives on Today now.
  if (to.path === '/' && to.query.failsafe) return { path: '/today', query: to.query }
  if (to.meta.public) return true
  // decide only once the state is in (main.js also waits for it before the first route)
  if (!store.ready) await booted
  return notSetUpRoute() || true
})

router.afterEach((to) => {
  document.title = to.meta.title && to.meta.title !== 'Regimen' ? `${to.meta.title} · Regimen` : 'Regimen: study without the scroll'
})
