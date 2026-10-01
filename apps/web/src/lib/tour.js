// First-run coach marks and the help drawer.
//
// A tour is a list of steps, each pointing at an element by CSS selector (mostly
// [data-tour="..."] attributes in the views). components/help/TourHost.vue draws the dim
// overlay, the spotlight, the arrow and the card. Only two show by themselves, once each:
// the room intro (what can not be minimized: the blocking pill, help, the eye and the dock),
// and, when someone lands on another page first after setup, one welcome step pointing at the
// "?" button. Every page tour is still there, started from the help drawer (HelpDrawer.vue).
// The room's windows get their own one-time tips when first opened (roomTips below).
// What was seen is kept by lib/seen.js: in the saved state, so the website and the extension
// share it, and in localStorage.
import { reactive } from 'vue'
import { isSeen, markSeen } from './seen.js'

/** Route path to page id, shared by tours and help. */
export function pageFor(path) {
  return (
    {
      '/': 'room',
      '/room': 'room',
      '/today': 'today',
      '/tasks': 'tasks',
      '/schedule': 'schedule',
      '/blocking': 'blocking',
      '/habits': 'habits',
      '/stats': 'stats',
      '/settings': 'settings',
      '/install': 'install',
    }[path] || null
  )
}

// ---------------------------------------------------------------- the tours
const helpStep = {
  target: '[data-help-button]',
  title: 'Help is always here',
  text: 'Press ? any time to see what everything on this page does, or to replay this tour.',
}

export const TOURS = {
  // The room intro: only what can not be minimized. Everything else explains itself the first
  // time it is opened (the first-open tips in views/Room.vue).
  room: [
    {
      target: '[data-blocking-pill]',
      title: 'Blocking on or off',
      text: 'This pill always tells you if site blocking works in this browser. Click it to see why, or to fix it.',
    },
    {
      target: '[data-help-button]',
      title: 'Help is on every page',
      text: 'Every page has this ? button. Explore anything, and press ? whenever something is unclear. The palette next to it changes the look.',
    },
    {
      target: '[data-tour="room-eye"]',
      title: 'Clear everything',
      text: 'Press the eye to clear everything and just enjoy the room. Press it again, or Z, to bring things back.',
    },
    {
      target: 'nav[aria-label="Room windows"]',
      title: 'Everything else lives here',
      text: 'Open anything to explore it, each part explains itself the first time you open it. Reset tidies the room again. Have fun!',
    },
  ],
  today: [
    {
      target: '[data-tour="status"]',
      title: 'Your status',
      text: 'Level, XP and streak on the left. What is blocked right now, the focus timer and the music on the right. It sits on top of every page.',
    },
    {
      target: '[data-tour="today-blocks"]',
      title: 'What is blocked now',
      text: 'Every rule or focus session that is blocking right now, and what unlocks it. When nothing is blocked, it shows what comes next.',
    },
    {
      target: '[data-tour="today-tasks"]',
      title: "Today's tasks",
      text: 'Everything due today. Tick a task to finish it. Tasks attached to a blocking window unlock its sites when they are done.',
    },
    {
      target: '[data-tour="today-add"]',
      title: 'Add a task',
      text: 'Give it a deadline and, if you like, attach it to a task-gated window so the sites stay blocked until it is done.',
    },
    {
      target: '[data-tour="today-focus"]',
      title: 'Focus session',
      text: 'Block sites right now, no schedule needed. Pick a preset, choose the sites, press Start focus.',
    },
    {
      target: '[data-tour="today-habits"]',
      title: 'Habits',
      text: 'Tap a habit to mark it done for today. Streaks grow every day you keep it.',
    },
    {
      target: 'aside nav[aria-label="Main"], nav[aria-label="Quick"]',
      title: 'Pages',
      text: 'Move between the study room and every page from here.',
    },
    helpStep,
  ],
  tasks: [
    {
      target: '[data-tour="tasks-new"]',
      title: 'New task',
      text: 'Add a task with a deadline, priority, tag, subtasks, and optionally a blocking window.',
    },
    {
      target: '[data-tour="tasks-view"]',
      title: 'List or board',
      text: 'List groups tasks by when they are due. Board shows them as columns you can scan at a glance.',
    },
    {
      target: '[data-tour="tasks-filters"]',
      title: 'Filters',
      text: 'Search, and narrow by status, tag, priority or the window a task belongs to.',
    },
    {
      target: '[data-tour="tasks-list"]',
      title: 'Your tasks',
      text: 'Tick to finish, click to edit. Finishing every task of a task-gated window opens its sites.',
    },
    helpStep,
  ],
  schedule: [
    { target: '[data-tour="schedule-nav"]', title: 'Pick a week', text: 'Step back and forward a week, or jump back to this week.' },
    {
      target: '[data-tour="schedule-week"]',
      title: 'The week',
      text: 'Blocking windows and task deadlines, day by day. Drag a task to another day to move its deadline. Click a window to edit it.',
    },
    { target: '[data-tour="schedule-legend"]', title: 'Colours', text: 'Purple is a task-gated window, red is a hard block.' },
    helpStep,
  ],
  blocking: [
    {
      target: '[data-tour="blocking-new"]',
      title: 'New rule',
      text: 'Create a task-gated window or a hard block: pick the sites, the days and the times.',
    },
    {
      target: '[data-tour="blocking-gated"]',
      title: 'Task-gated windows',
      text: 'Blocked during the window until the tasks attached to it are done. Unfinished work keeps the sites blocked after it ends.',
    },
    {
      target: '[data-tour="blocking-hard"]',
      title: 'Hard blocks',
      text: 'Blocked for the whole window, no matter what. Good for sleep and exams. You can even switch off the Failsafe.',
    },
    {
      target: '[data-rule-why]',
      title: 'Blocking now or not?',
      text: 'Every rule says whether it is blocking right now, and if not, why: outside its hours, tasks done, or unlocked with Failsafe.',
    },
    { target: '[data-tour="blocking-focus"]', title: 'Focus mode', text: 'Block sites right now for a set time, no rule needed.' },
    helpStep,
  ],
  habits: [
    { target: '[data-tour="habits-new"]', title: 'New habit', text: 'Pick a name, an emoji, a colour and the days it is due.' },
    {
      target: '[data-tour="habits-list"]',
      title: 'Your habits',
      text: 'Tap the circle to mark today done. The row of days shows your recent streak.',
    },
    helpStep,
  ],
  stats: [
    {
      target: '[data-tour="stats-overview"]',
      title: 'Overview',
      text: 'Your level, streak, focus time this week and how many promises you kept. Click the level to see your badges.',
    },
    {
      target: '[data-tour="stats-tabs"]',
      title: 'Four views',
      text: 'Calendar shows every day, cleared or not. Badges, Numbers and History show the rest. Arrow keys switch tabs.',
    },
    helpStep,
  ],
  settings: [
    {
      target: '#look',
      title: 'Look',
      text: 'Game or Calm style, the theme, and Light or Dark for every theme. The sun and moon button next to the palette flips it from any page.',
    },
    {
      target: '[data-tour="settings-test"]',
      title: 'Test blocking',
      text: 'One click opens a test site with a one minute block and tells you if this browser really blocks.',
    },
    {
      target: '[data-tour="settings-pin"]',
      title: 'Your PIN',
      text: 'Protects your rules. You need it to edit a live rule, delete a rule or use Failsafe.',
    },
    {
      target: '[data-tour="settings-agent"]',
      title: 'Lock agent',
      text: 'An optional small program that applies your blocks to every browser and app on this computer.',
    },
    helpStep,
  ],
  // the first time someone enters the app after setup, on a page other than the room
  welcome: [
    {
      target: '[data-help-button]',
      title: 'Help is on every page',
      text: 'Every page has this. Explore anything, and press ? whenever something is unclear.',
    },
  ],
  decorate: [
    {
      target: '[data-room-tray] [role="tablist"]',
      title: 'Decorate',
      text: 'Items and badges go into the room. Avatar and Room change how you and the room look.',
    },
    {
      target: '[data-room-tray]',
      title: 'Place things',
      text: 'Drag an item into the room, or tap to place it. Drag it back here, or tap again, to put it away. Locked items open as you level up.',
    },
    {
      target: '[data-room-tray] button.ml-auto',
      title: 'Done',
      text: 'Saves your room and brings the windows back. D toggles decorate mode too.',
    },
  ],
}

// ---------------------------------------------------------------- seen list
/** Seen here or anywhere else (the website, the extension), or every tour switched off ("*"). */
export function tourSeen(id) {
  return isSeen('tours', id) || isSeen('tours', '*')
}
export function markTourSeen(id) {
  markSeen('tours', id)
}

// ---------------------------------------------------------------- running a tour
export const tour = reactive({ id: null, steps: [], index: 0 })
// section: the id of a help section to scroll to when the drawer opens ("Learn more" links)
export const help = reactive({ open: false, page: null, section: null })

/** A step's element, if it is on screen now (hidden elements do not count). */
export function stepTarget(step) {
  for (const sel of step.target.split(/,\s*(?![^[]*\])/)) {
    let els
    try {
      els = [...document.querySelectorAll(sel)]
    } catch {
      continue
    }
    const el = els.find((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'
    })
    if (el) return el
  }
  return null
}

const phone = () => window.innerWidth < 640
function available(steps) {
  return steps.filter((s) => !(s.desktop && phone()) && stepTarget(s))
}

/** Something else is on top: a dialog, the help drawer, the blocking-off prompt. */
export function modalOpen() {
  return help.open || !!document.querySelector('[aria-modal="true"]:not([data-tour-card])')
}

export function startTour(id, { force = false } = {}) {
  const all = TOURS[id]
  if (!all) return false
  if (!force && tourSeen(id)) return false
  const steps = available(all)
  if (!steps.length) return false
  help.open = false
  Object.assign(tour, { id, steps, index: 0 })
  return true
}

/**
 * Shows a tour by itself the first time, once the page has drawn and nothing else is open.
 * Waits (up to ~20 s) for a dialog to close instead of showing on top of it.
 */
export async function autoTour(id, { delay = 700 } = {}) {
  if (!TOURS[id] || tourSeen(id) || tour.id) return
  await new Promise((r) => setTimeout(r, delay))
  for (let i = 0; i < 40 && modalOpen(); i++) await new Promise((r) => setTimeout(r, 500))
  if (modalOpen() || tour.id || tourSeen(id)) return
  startTour(id)
}

/**
 * The only tours that start by themselves. In the room: the room intro (trial room too).
 * Anywhere else, once set up: a single step pointing at the help button. The room intro
 * covers the help button too, so after it the welcome step never shows.
 */
export function autoIntro(page, { onboarded = false } = {}) {
  if (page === 'room') return autoTour('room', { delay: 1000 })
  if (onboarded && page && page !== 'install' && !tourSeen('room')) return autoTour('welcome', { delay: 700 })
}

export function nextStep() {
  if (!tour.id) return
  // a target may have gone away since the tour started (window closed, tab switched)
  let i = tour.index + 1
  while (i < tour.steps.length && !stepTarget(tour.steps[i])) i++
  if (i >= tour.steps.length) return endTour()
  tour.index = i
}
export function prevStep() {
  if (!tour.id) return
  let i = tour.index - 1
  while (i >= 0 && !stepTarget(tour.steps[i])) i--
  if (i >= 0) tour.index = i
}
/** Finish or skip: either way it will not show by itself again. */
export function endTour() {
  if (tour.id) markTourSeen(tour.id)
  if (tour.id === 'room') markTourSeen('welcome')
  Object.assign(tour, { id: null, steps: [], index: 0 })
}

export function openHelp(page, section = null) {
  if (tour.id) endTour()
  Object.assign(help, { open: true, page, section })
}
export function closeHelp() {
  help.open = false
}

// ---------------------------------------------------------------- room tips
// A small one-time tip the first time each study room window is opened from the dock, and the
// first time decorate mode opens. "Got it" (or closing the window) and it never shows again.
export const ROOM_TIPS = {
  status: 'Your level, XP, streak and what is blocked right now, always in view. Finish tasks, habits and focus sessions to fill the bar.',
  focus:
    'Pick a length or a preset, choose the sites to block and press Start focus. Sites stay blocked for the whole session, and every finished session earns XP and coins.',
  player:
    'Press play for lofi radio made right in your browser, skip ahead or pick a track. Rain and a fireplace are there too, off until you switch them on.',
  drawer: 'Your tasks, habits, active blocks and progress in tabs, without leaving the room. Keys T, H, B and S switch tabs.',
  notes: 'Jot down whatever pops into your head so it does not pull you out of focus. Notes stay on this device.',
  scene: 'Change the view outside the window and the style of music. More scenes and styles come from the shop and from leveling up.',
  decorate:
    'Drag an item into the room, or tap it to place it, and tap again to put it away. Avatar and Room change how you and the room look, Done saves.',
}
/** Seen, or every tour switched off (tests set tours-seen to ["*"]). */
export function tipSeen(id) {
  return isSeen('tips', id) || isSeen('tours', '*')
}
export function markTipSeen(id) {
  markSeen('tips', id)
}
