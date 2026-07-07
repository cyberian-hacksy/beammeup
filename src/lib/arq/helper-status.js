export const ARQ_HELPER_STATUS = {
  OFFLINE: 'offline',
  CHECKING: 'checking',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  UNAVAILABLE: 'unavailable',
  DISCONNECTED: 'disconnected',
  SEND_FAILED: 'send-failed'
}

// The receiver-side connection UI is shared by every back-channel
// transport; only the words change. Default (BLE-GATT) keeps the original
// "helper" copy; the keyboard dongle gets its own.
export function getArqHelperStatusView(status, transportName = 'ble-gatt') {
  const keyboard = transportName === 'keyboard'
  const noun = keyboard ? 'Dongle' : 'Helper'
  const verb = keyboard ? 'dongle' : 'helper'
  switch (status) {
    case ARQ_HELPER_STATUS.CHECKING:
      return { text: `Checking ${verb}…`, buttonText: 'Checking…', connected: false, disabled: true }
    case ARQ_HELPER_STATUS.CONNECTING:
      return { text: `Connecting ${verb}…`, buttonText: 'Connecting…', connected: false, disabled: true }
    case ARQ_HELPER_STATUS.CONNECTED:
      return { text: `${noun} connected`, buttonText: `Reconnect ${verb}`, connected: true, disabled: false }
    case ARQ_HELPER_STATUS.DISCONNECTED:
      return { text: `${noun} disconnected`, buttonText: `Reconnect ${verb}`, connected: false, disabled: false }
    case ARQ_HELPER_STATUS.SEND_FAILED:
      return { text: `${noun} send failed`, buttonText: `Reconnect ${verb}`, connected: false, disabled: false }
    case ARQ_HELPER_STATUS.UNAVAILABLE:
      if (keyboard) {
        return {
          text: 'Connect keyboard dongle',
          buttonText: 'Connect dongle',
          connected: false,
          disabled: false,
          hint: 'Plug the ESP32 dongle into this machine, click Connect and pick its serial port ' +
            '(first time only). Pair "BeamMeUp-Kbd" as a keyboard on the sender once.'
        }
      }
      return {
        text: 'Start BeamMeUp Helper',
        buttonText: 'Retry helper',
        connected: false,
        disabled: false,
        hint: 'Run "python helper/server.py" on this machine. First connection asks for approval in the helper\'s terminal (y/N).'
      }
    case ARQ_HELPER_STATUS.OFFLINE:
    default:
      return { text: `${noun} offline`, buttonText: `Connect ${verb}`, connected: false, disabled: false }
  }
}

// Sender-side status line shown while the back-channel connects. BLE opens
// the browser device chooser; the keyboard transport just arms a keydown
// listener (no chooser, connects instantly).
export function getArqSenderConnectPrompt(transportName) {
  return transportName === 'keyboard' ? 'Arming keyboard listener…' : 'Select BeamMeUp-ARQ...'
}

export function shouldAutoConnectArqHelper({ connected = false, connecting = false, attempted = false } = {}) {
  return !connected && !connecting && !attempted
}

export function testArqHelperStatusViewIsTransportAware() {
  const kb = status => getArqHelperStatusView(status, 'keyboard')
  const unavailable = kb(ARQ_HELPER_STATUS.UNAVAILABLE)
  const connected = kb(ARQ_HELPER_STATUS.CONNECTED)
  const offline = kb(ARQ_HELPER_STATUS.OFFLINE)
  const defaultConnected = getArqHelperStatusView(ARQ_HELPER_STATUS.CONNECTED)
  const pass = unavailable.text === 'Connect keyboard dongle' &&
    unavailable.buttonText === 'Connect dongle' &&
    typeof unavailable.hint === 'string' &&
    unavailable.hint.includes('BeamMeUp-Kbd') &&
    !unavailable.hint.includes('helper/server.py') &&
    connected.text === 'Dongle connected' &&
    connected.buttonText === 'Reconnect dongle' &&
    offline.buttonText === 'Connect dongle' &&
    // The BLE-GATT copy must be untouched, with or without the argument.
    defaultConnected.text === 'Helper connected' &&
    getArqHelperStatusView(ARQ_HELPER_STATUS.CONNECTED, 'ble-gatt').text === 'Helper connected' &&
    getArqSenderConnectPrompt('keyboard') === 'Arming keyboard listener…' &&
    getArqSenderConnectPrompt('ble-gatt') === 'Select BeamMeUp-ARQ...'
  console.log('arq helper status transport-aware:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqHelperStatusView() {
  const unavailable = getArqHelperStatusView(ARQ_HELPER_STATUS.UNAVAILABLE)
  const connected = getArqHelperStatusView(ARQ_HELPER_STATUS.CONNECTED)
  const pass = unavailable.text === 'Start BeamMeUp Helper' &&
    unavailable.buttonText === 'Retry helper' &&
    unavailable.connected === false &&
    typeof unavailable.hint === 'string' &&
    unavailable.hint.includes('helper/server.py') &&
    connected.text === 'Helper connected' &&
    connected.buttonText === 'Reconnect helper' &&
    connected.connected === true &&
    connected.hint === undefined
  console.log('arq helper status view:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testShouldAutoConnectArqHelper() {
  const pass = shouldAutoConnectArqHelper() === true &&
    shouldAutoConnectArqHelper({ attempted: true }) === false &&
    shouldAutoConnectArqHelper({ connecting: true }) === false &&
    shouldAutoConnectArqHelper({ connected: true }) === false
  console.log('arq helper auto-connect policy:', pass ? 'PASS' : 'FAIL')
  return pass
}
