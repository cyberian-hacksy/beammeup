export function testBackchannelRegistry() {
  const impl = { makeSender: () => ({ side: 'sender' }), makeReceiver: () => ({ side: 'receiver' }) }
  registerTransport('test-registry', impl)
  const pass = getTransport('test-registry') === impl
  console.log('arq backchannel registry:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBackchannelDefaultMtuIsBleSafe() {
  const pass = DEFAULT_FRAGMENT_MTU <= 20
  console.log('arq backchannel default mtu:', pass ? 'PASS' : 'FAIL', DEFAULT_FRAGMENT_MTU)
  return pass
}

// Shared by the Web Bluetooth reader and the local helper. The short 16-bit
// UUIDs match the Phase-0 spike so Chrome can filter by service.
export const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb'
export const ARQ_NOTIFY_CHARACTERISTIC_UUID = '0000fff1-0000-1000-8000-00805f9b34fb'
export const DEFAULT_WS_URL = 'ws://127.0.0.1:8787'
export const DEFAULT_FRAGMENT_MTU = 20
export const DEFAULT_BACKCHANNEL_TRANSPORT = 'ble-gatt'

export const TRANSPORTS = {}

export function registerTransport(name, impl) {
  TRANSPORTS[name] = impl
}

export function getTransport(name) {
  return TRANSPORTS[name]
}
