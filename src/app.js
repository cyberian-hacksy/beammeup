import jsQR from 'jsqr'
import qrcode from 'qrcode-generator'

// Import test functions
import { testPRNG } from './lib/prng.js'
import { testPacketRoundtrip } from './lib/packet.js'
import { testMetadataRoundtrip } from './lib/metadata.js'
import { testEncoder } from './lib/encoder.js'
import { testCodecRoundtrip } from './lib/decoder.js'
import { testParityMap, testParityRecovery } from './lib/precode.js'

// Import UI modules
import { initSender, resetSender } from './lib/sender.js'
import { initReceiver, resetReceiver, autoStartReceiver } from './lib/receiver.js'

// Import CIMBAR modules
import { initCimbarSender, resetCimbarSender } from './lib/cimbar/cimbar-sender.js'
import { initCimbarReceiver, resetCimbarReceiver, autoStartCimbarReceiver } from './lib/cimbar/cimbar-receiver.js'
import { checkCompatibility } from './lib/cimbar/cimbar-loader.js'

// Import HDMI-UVC modules
import { initHdmiUvcSender, resetHdmiUvcSender } from './lib/hdmi-uvc/hdmi-uvc-sender.js'
import { initHdmiUvcReceiver, resetHdmiUvcReceiver, autoStartHdmiUvcReceiver } from './lib/hdmi-uvc/hdmi-uvc-receiver.js'
import { testCrc32 } from './lib/hdmi-uvc/crc32.js'
import {
  testHeaderRoundtrip,
  testPayloadGrayRoundtrip,
  testPayloadRGBRoundtrip,
  testPayloadCompatRoundtrip,
  testFrameRoundtrip
} from './lib/hdmi-uvc/hdmi-uvc-frame.js'

// Make libraries available globally
window.jsQR = jsQR
window['qrcode'] = qrcode

// Expose tests globally for console verification
window.testPRNG = testPRNG
window.testPacketRoundtrip = testPacketRoundtrip
window.testMetadataRoundtrip = testMetadataRoundtrip
window.testEncoder = testEncoder
window.testCodecRoundtrip = testCodecRoundtrip
window.testParityMap = testParityMap
window.testParityRecovery = testParityRecovery

// HDMI-UVC tests
window.testCrc32 = testCrc32
window.testHdmiHeaderRoundtrip = testHeaderRoundtrip
window.testHdmiPayloadGray = testPayloadGrayRoundtrip
window.testHdmiPayloadRGB = testPayloadRGBRoundtrip
window.testHdmiPayloadCompat = testPayloadCompatRoundtrip
window.testHdmiFrameRoundtrip = testFrameRoundtrip

// ============ ERROR HANDLING ============
function showError(message) {
  const banner = document.getElementById('error-banner')
  const messageEl = document.getElementById('error-message')
  messageEl.textContent = message
  banner.classList.remove('hidden')
  setTimeout(hideError, 10000)
}

function hideError() {
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
  btn.onclick = () => {
    // Clean up QR state
    resetSender()
    resetReceiver()

    // Clean up CIMBAR state
    resetCimbarSender()
    resetCimbarReceiver()

    // Clean up HDMI-UVC state
    resetHdmiUvcSender()
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
  const cimbarBtns = [
    document.getElementById('btn-cimbar-send'),
    document.getElementById('btn-cimbar-receive')
  ]
  cimbarBtns.forEach(btn => {
    btn.disabled = true
    btn.title = 'Not supported: ' + compat.issues.join(', ')
  })
}

// ============ TEST SUITE ============
async function runAllTests() {
  console.log('=== BEAM ME UP TEST SUITE ===')

  const results = {
    prng: testPRNG(),
    packet: testPacketRoundtrip(),
    metadata: testMetadataRoundtrip(),
    parityMap: testParityMap(),
    parityRecovery: testParityRecovery(),
    encoder: await testEncoder(),
    codec: await testCodecRoundtrip(),
    // HDMI-UVC tests
    crc32: testCrc32(),
    hdmiHeader: testHeaderRoundtrip(),
    hdmiPayloadGray: testPayloadGrayRoundtrip(),
    hdmiPayloadRGB: testPayloadRGBRoundtrip(),
    hdmiPayloadCompat: testPayloadCompatRoundtrip(),
    hdmiFrame: testFrameRoundtrip()
  }

  const passed = Object.values(results).every(r => r)
  console.log('=== RESULTS ===')
  console.table(results)
  console.log(passed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED')

  return passed
}

// Expose test runner globally
window.runAllTests = runAllTests

// Auto-run tests if ?test query param present
if (location.search.includes('test')) {
  runAllTests()
}
