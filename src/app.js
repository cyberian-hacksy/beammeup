// Import UI modules
import { initSender, resetSender, isSenderBusy as isQrSenderBusy } from './lib/sender.js'
import { initReceiver, resetReceiver, autoStartReceiver, hasPendingDownload as hasQrPendingDownload, isReceiving as isQrReceiving } from './lib/receiver.js'

// Import CIMBAR modules
import { initCimbarSender, resetCimbarSender, isSenderBusy as isCimbarSenderBusy } from './lib/cimbar/cimbar-sender.js'
import { initCimbarReceiver, resetCimbarReceiver, autoStartCimbarReceiver, hasPendingDownload as hasCimbarPendingDownload, isReceiving as isCimbarReceiving } from './lib/cimbar/cimbar-receiver.js'
import { checkCompatibility } from './lib/cimbar/cimbar-loader.js'

// Import HDMI-UVC modules
import { initHdmiUvcSender, resetHdmiUvcSender, isSenderBusy as isHdmiUvcSenderBusy } from './lib/hdmi-uvc/hdmi-uvc-sender.js'
import { initHdmiUvcReceiver, resetHdmiUvcReceiver, autoStartHdmiUvcReceiver, hasPendingDownload as hasHdmiUvcPendingDownload, isReceiving as isHdmiUvcReceiving } from './lib/hdmi-uvc/hdmi-uvc-receiver.js'

// Console test suite. Registration and execution are gated behind ?test so
// normal startup does not assign 200+ window.test* globals.
import { registerAllTests, runAllTests } from './test-suite.js'

import { confirmDialog } from './lib/confirm-dialog.js'

// ============ ERROR HANDLING ============
// Errors stay up until dismissed: auto-hiding a role="alert" the user
// glanced away from means they never see it. A newer error replaces the text.
function showError(message) {
  const banner = document.getElementById('error-banner')
  const messageEl = document.getElementById('error-message')
  messageEl.textContent = message
  banner.classList.remove('hidden')
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden')
}

document.getElementById('error-dismiss').onclick = hideError

// ============ SCREEN NAVIGATION ============
// Screens are driven by location.hash so each screen is deep-linkable and the
// browser Back button returns to mode selection instead of leaving the app.
const screens = {
  modeSelect: document.getElementById('mode-select'),
  sender: document.getElementById('sender'),
  receiver: document.getElementById('receiver'),
  cimbarSender: document.getElementById('cimbar-sender'),
  cimbarReceiver: document.getElementById('cimbar-receiver'),
  hdmiUvcSender: document.getElementById('hdmi-uvc-sender'),
  hdmiUvcReceiver: document.getElementById('hdmi-uvc-receiver')
}

const HASH_TO_SCREEN = {
  'sender': 'sender',
  'receiver': 'receiver',
  'cimbar-sender': 'cimbarSender',
  'cimbar-receiver': 'cimbarReceiver',
  'hdmi-uvc-sender': 'hdmiUvcSender',
  'hdmi-uvc-receiver': 'hdmiUvcReceiver'
}
const SCREEN_TO_HASH = Object.fromEntries(
  Object.entries(HASH_TO_SCREEN).map(([hash, screen]) => [screen, hash])
)

let activeScreen = 'modeSelect'
let suppressHashHandler = false

function showScreen(screenId) {
  // Errors are screen-scoped (camera blocked, file too large); leaving the
  // screen dismisses a stale banner instead of carrying it along.
  hideError()

  Object.values(screens).forEach(s => s.classList.remove('active'))
  const screen = screens[screenId]
  screen.classList.add('active')
  activeScreen = screenId

  // Move focus onto the new screen's heading; without this, keyboard and
  // screen-reader focus stays on the now display:none button that navigated.
  const heading = screen.querySelector('h1')
  if (heading) {
    heading.setAttribute('tabindex', '-1')
    heading.focus()
  }
}

function hasPendingDownload() {
  return hasQrPendingDownload() || hasCimbarPendingDownload() || hasHdmiUvcPendingDownload()
}

async function cleanupModules() {
  // Clean up QR state
  resetSender()
  resetReceiver()

  // Clean up CIMBAR state
  resetCimbarSender()
  resetCimbarReceiver()

  // Clean up HDMI-UVC state
  await resetHdmiUvcSender()
  resetHdmiUvcReceiver()
}

async function handleHashChange() {
  if (suppressHashHandler) {
    suppressHashHandler = false
    return
  }

  const target = HASH_TO_SCREEN[location.hash.replace(/^#/, '')] || 'modeSelect'
  if (target === activeScreen) return

  if (activeScreen !== 'modeSelect') {
    // A completed transfer that was never downloaded lives only in memory;
    // resetting the modules below would silently discard it.
    if (hasPendingDownload() &&
        !(await confirmDialog('The received file has not been downloaded yet. Leave and discard it?'))) {
      suppressHashHandler = true
      location.hash = SCREEN_TO_HASH[activeScreen]
      return
    }
    await cleanupModules()
  }

  showScreen(target)

  if (target === 'receiver') autoStartReceiver()
  else if (target === 'cimbarReceiver') autoStartCimbarReceiver()
  else if (target === 'hdmiUvcReceiver') autoStartHdmiUvcReceiver()
}

window.addEventListener('hashchange', handleHashChange)

// Mode selection buttons navigate via the hash so browser history stays usable.
document.getElementById('btn-send').onclick = () => { location.hash = 'sender' }
document.getElementById('btn-receive').onclick = () => { location.hash = 'receiver' }
document.getElementById('btn-cimbar-send').onclick = () => { location.hash = 'cimbar-sender' }
document.getElementById('btn-cimbar-receive').onclick = () => { location.hash = 'cimbar-receiver' }
document.getElementById('btn-hdmi-uvc-send').onclick = () => { location.hash = 'hdmi-uvc-sender' }
document.getElementById('btn-hdmi-uvc-receive').onclick = () => { location.hash = 'hdmi-uvc-receiver' }

// Back buttons route through the hash handler, which owns cleanup and the
// pending-download confirmation.
document.querySelectorAll('.back-btn').forEach(btn => {
  btn.onclick = () => { location.hash = '' }
})

// Warn before the tab closes mid-transfer or with an undownloaded file; both
// live only in memory.
window.addEventListener('beforeunload', (e) => {
  if (hasPendingDownload() ||
      isQrSenderBusy() || isCimbarSenderBusy() || isHdmiUvcSenderBusy() ||
      isQrReceiving() || isCimbarReceiving() || isHdmiUvcReceiving()) {
    e.preventDefault()
    e.returnValue = ''
  }
})

// ============ INITIALIZE MODULES ============
initSender(showError)
initReceiver(showError)

// Initialize CIMBAR modules
initCimbarSender(showError)
initCimbarReceiver(showError)

// Initialize HDMI-UVC modules
initHdmiUvcSender(showError)
initHdmiUvcReceiver(showError)

// Check CIMBAR compatibility and disable buttons if not supported
const compat = checkCompatibility()
if (!compat.compatible) {
  const reason = 'Not supported: ' + compat.issues.join(', ')
  const cimbarBtns = [
    document.getElementById('btn-cimbar-send'),
    document.getElementById('btn-cimbar-receive')
  ]
  cimbarBtns.forEach(btn => {
    btn.disabled = true
    btn.title = reason
  })
  // Tooltips are invisible on touch devices; say why in the section itself.
  const desc = document.getElementById('cimbar-desc')
  if (desc) desc.textContent = reason
}

// Deep link: entering with a screen hash (e.g. #receiver) lands directly on
// that screen.
if (HASH_TO_SCREEN[location.hash.replace(/^#/, '')]) {
  handleHashChange()
}

// ============ TEST SUITE ============
// Expose the test runner globally; registration of the individual
// window.test* helpers happens on first use, not at startup.
window.runAllTests = () => {
  registerAllTests()
  return runAllTests()
}

// Auto-run tests if ?test query param present. Exact param match: substring
// matching would fire on any query string that merely contains "test".
if (new URLSearchParams(location.search).has('test')) {
  window.runAllTests()
}
