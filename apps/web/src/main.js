import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router.js'
import { init } from './lib/store.js'
import { inExtension } from './lib/api.js'
import './style.css'

// Fetch the first screen's code while the store connects: the landing page for someone new
// to this browser, the study room for everyone else. Both are lazy routes, so this import
// and the router's share one request.
// App.vue saves where the front door led last time (regimen:boot, also read by boot.js).
let landing = !inExtension()
try {
  const boot = JSON.parse(localStorage.getItem('regimen:boot') || 'null')
  if (landing) landing = boot ? !!boot.home : !localStorage.getItem('regimen:v1')
} catch {}
const hash = location.hash
if (hash.startsWith('#/home') || (landing && ['', '#', '#/'].includes(hash))) import('./views/Landing.vue').catch(() => {})
else if (['', '#', '#/', '#/room'].includes(hash)) import('./views/Room.vue').catch(() => {})

// Nothing renders until the first route is decided and its view is loaded. Mounting earlier
// shows whatever the empty start route gives (the app shell and study room colours) for a
// moment before a new visitor is sent to the landing page. Until then index.html shows the
// splash on the page colour public/boot.js picked.
init()
  .catch((e) => console.error(e))
  .finally(async () => {
    const app = createApp(App).use(router)
    await router.isReady().catch((e) => console.error(e))
    app.mount('#app')
    // hand the page colour back to the stylesheet (and the landing page, which sets its own)
    document.documentElement.style.removeProperty('background-color')
    document.documentElement.removeAttribute('data-booting')
  })
