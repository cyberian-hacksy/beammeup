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
  receiver: document.getElementById('receiver')
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

// Back buttons with cleanup
document.querySelectorAll('.back-btn').forEach(btn => {
  btn.onclick = () => {
    // Clean up sender state
    resetSender()

    // Clean up receiver state
    resetReceiver()

    // Return to mode selection
    showScreen('modeSelect')
  }
})

// ============ INITIALIZE MODULES ============
initSender(showError)
initReceiver(showError)

// ============ TEST SUITE ============
async function runAllTests() {
  console.log('=== QRIOSITY TEST SUITE ===')

  const results = {
    prng: testPRNG(),
    packet: testPacketRoundtrip(),
    metadata: testMetadataRoundtrip(),
    parityMap: testParityMap(),
    parityRecovery: testParityRecovery(),
    encoder: await testEncoder(),
    codec: await testCodecRoundtrip()
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
