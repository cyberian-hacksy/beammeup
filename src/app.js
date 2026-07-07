import jsQR from 'jsqr'
import qrcode from 'qrcode-generator'

// Import UI modules
import { initSender, resetSender } from './lib/sender.js'
import { initReceiver, resetReceiver, autoStartReceiver, hasPendingDownload as hasQrPendingDownload } from './lib/receiver.js'

// Import CIMBAR modules
import { initCimbarSender, resetCimbarSender } from './lib/cimbar/cimbar-sender.js'
import { initCimbarReceiver, resetCimbarReceiver, autoStartCimbarReceiver, hasPendingDownload as hasCimbarPendingDownload } from './lib/cimbar/cimbar-receiver.js'
import { checkCompatibility } from './lib/cimbar/cimbar-loader.js'

// Import HDMI-UVC modules
import { initHdmiUvcSender, resetHdmiUvcSender } from './lib/hdmi-uvc/hdmi-uvc-sender.js'
import { initHdmiUvcReceiver, resetHdmiUvcReceiver, autoStartHdmiUvcReceiver, hasPendingDownload as hasHdmiUvcPendingDownload } from './lib/hdmi-uvc/hdmi-uvc-receiver.js'

// Console test suite. Registration and execution are gated behind ?test so
// normal startup does not assign 200+ window.test* globals.
import { registerAllTests, runAllTests } from './test-suite.js'

// Make libraries available globally
window.jsQR = jsQR
window['qrcode'] = qrcode

// ============ ERROR HANDLING ============
let errorHideTimer = null

function showError(message) {
  const banner = document.getElementById('error-banner')
  const messageEl = document.getElementById('error-message')
  messageEl.textContent = message
  banner.classList.remove('hidden')
  // A leftover timer from an earlier error would hide this one early.
  if (errorHideTimer !== null) clearTimeout(errorHideTimer)
  errorHideTimer = setTimeout(hideError, 10000)
}

function hideError() {
  if (errorHideTimer !== null) {
    clearTimeout(errorHideTimer)
    errorHideTimer = null
  }
  document.getElementById('error-banner').classList.add('hidden')
}

document.getElementById('error-dismiss').onclick = hideError

// ============ SCREEN NAVIGATION ============
const screens = {
  modeSelect: document.getElementById('mode-select'),
  sender: document.getElementById('sender'),
  receiver: document.getElementById('receiver'),
  cimbarSender: document.getElementById('cimbar-sender'),
  cimbarReceiver: document.getElementById('cimbar-receiver'),
  hdmiUvcSender: document.getElementById('hdmi-uvc-sender'),
  hdmiUvcReceiver: document.getElementById('hdmi-uvc-receiver')
}

function showScreen(screenId) {
  Object.values(screens).forEach(s => s.classList.remove('active'))
  screens[screenId].classList.add('active')
}

// Mode selection buttons
document.getElementById('btn-send').onclick = () => showScreen('sender')
document.getElementById('btn-receive').onclick = () => {
  showScreen('receiver')
  autoStartReceiver()
}

// CIMBAR mode selection buttons
document.getElementById('btn-cimbar-send').onclick = () => {
  showScreen('cimbarSender')
}

document.getElementById('btn-cimbar-receive').onclick = () => {
  showScreen('cimbarReceiver')
  autoStartCimbarReceiver()
}

// HDMI-UVC mode selection buttons
document.getElementById('btn-hdmi-uvc-send').onclick = () => {
  showScreen('hdmiUvcSender')
}

document.getElementById('btn-hdmi-uvc-receive').onclick = () => {
  showScreen('hdmiUvcReceiver')
  autoStartHdmiUvcReceiver()
}

// Back buttons with cleanup
document.querySelectorAll('.back-btn').forEach(btn => {
  btn.onclick = async () => {
    // A completed transfer that was never downloaded lives only in memory;
    // resetting the modules below would silently discard it.
    if ((hasQrPendingDownload() || hasCimbarPendingDownload() || hasHdmiUvcPendingDownload()) &&
        !confirm('The received file has not been downloaded yet. Leave and discard it?')) {
      return
    }

    // Clean up QR state
    resetSender()
    resetReceiver()

    // Clean up CIMBAR state
    resetCimbarSender()
    resetCimbarReceiver()

    // Clean up HDMI-UVC state
    await resetHdmiUvcSender()
    resetHdmiUvcReceiver()

    // Return to mode selection
    showScreen('modeSelect')
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
