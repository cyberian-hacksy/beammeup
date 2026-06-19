export const ARQ_HELPER_STATUS = {
  OFFLINE: 'offline',
  CHECKING: 'checking',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  UNAVAILABLE: 'unavailable',
  DISCONNECTED: 'disconnected',
  SEND_FAILED: 'send-failed'
}

export function getArqHelperStatusView(status) {
  switch (status) {
    case ARQ_HELPER_STATUS.CHECKING:
      return { text: 'Checking helper...', buttonText: 'Checking...', connected: false, disabled: true }
    case ARQ_HELPER_STATUS.CONNECTING:
      return { text: 'Connecting helper...', buttonText: 'Connecting...', connected: false, disabled: true }
    case ARQ_HELPER_STATUS.CONNECTED:
      return { text: 'Helper connected', buttonText: 'Reconnect helper', connected: true, disabled: false }
    case ARQ_HELPER_STATUS.DISCONNECTED:
      return { text: 'Helper disconnected', buttonText: 'Reconnect helper', connected: false, disabled: false }
    case ARQ_HELPER_STATUS.SEND_FAILED:
      return { text: 'Helper send failed', buttonText: 'Reconnect helper', connected: false, disabled: false }
    case ARQ_HELPER_STATUS.UNAVAILABLE:
      return { text: 'Start BeamMeUp Helper', buttonText: 'Retry helper', connected: false, disabled: false }
    case ARQ_HELPER_STATUS.OFFLINE:
    default:
      return { text: 'Helper offline', buttonText: 'Connect helper', connected: false, disabled: false }
  }
}

export function shouldAutoConnectArqHelper({ connected = false, connecting = false, attempted = false } = {}) {
  return !connected && !connecting && !attempted
}

export function testArqHelperStatusView() {
  const unavailable = getArqHelperStatusView(ARQ_HELPER_STATUS.UNAVAILABLE)
  const connected = getArqHelperStatusView(ARQ_HELPER_STATUS.CONNECTED)
  const pass = unavailable.text === 'Start BeamMeUp Helper' &&
    unavailable.buttonText === 'Retry helper' &&
    unavailable.connected === false &&
    connected.text === 'Helper connected' &&
    connected.buttonText === 'Reconnect helper' &&
    connected.connected === true
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
