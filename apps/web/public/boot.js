// Runs before anything else (a plain script in <head>, so the extension's script-src 'self'
// allows it): paints the very first frame in the colours the page is about to open with.
// App.vue keeps what the app looked like last time under regimen:boot. Without it, the
// defaults: the landing page for the website's front door, the default theme elsewhere.
;(function () {
  var root = document.documentElement
  var boot = null
  var saved = false
  var landingDark = false
  try {
    var get = function (k) {
      // this runs before the app copies data from the old FocusGateway keys (lib/legacy.js)
      return localStorage.getItem('regimen:' + k) || localStorage.getItem('focusgateway:' + k)
    }
    boot = JSON.parse(localStorage.getItem('regimen:boot') || 'null')
    saved = !!get('v1')
    landingDark = get('landing-theme') === 'dark'
  } catch (e) {}
  var hash = location.hash
  var front = hash === '' || hash === '#' || hash === '#/'
  var ext = /^(chrome|moz)-extension:$/.test(location.protocol)
  // the front door leads to the landing page for someone new to this browser (router.js)
  var landing = !ext && (hash.indexOf('#/home') === 0 || (front && (boot ? boot.home : !saved)))
  root.setAttribute('data-theme-id', (boot && boot.theme) || 'sunny')
  if (boot && boot.mode) root.setAttribute('data-mode', boot.mode)
  if (landing) {
    // the landing page has its own light and dark, independent of the app's theme
    root.style.backgroundColor = landingDark ? '#0e0c18' : '#fcfaf7'
    root.setAttribute('data-booting', landingDark ? 'dark' : 'light')
  } else {
    if (boot && boot.dark) root.classList.add('dark')
    root.setAttribute('data-booting', boot && boot.dark ? 'dark' : 'light')
  }
})()
