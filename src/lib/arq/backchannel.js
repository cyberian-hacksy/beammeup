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

export function testKeyboardNackCapFitsOneShortLine() {
  // §2.5 of the dongle design: cap + 11-byte envelope, base32-expanded
  // (8/5) plus the Enter delimiter, must stay a short line (~1 s of
  // keystrokes) so one dropped report only ever voids a cheap retry.
  const keystrokes = Math.ceil(((KEYBOARD_NACK_PAYLOAD_CAP_BYTES + 11) * 8) / 5) + 1
  const pass = KEYBOARD_NACK_PAYLOAD_CAP_BYTES > 0 && keystrokes <= 100
  console.log('keyboard nack cap fits one line:', pass ? 'PASS' : 'FAIL', keystrokes)
  return pass
}

// Shared by the Web Bluetooth reader and the local helper. The short 16-bit
// UUIDs match the Phase-0 spike so Chrome can filter by service.
export const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb'
export const ARQ_NOTIFY_CHARACTERISTIC_UUID = '0000fff1-0000-1000-8000-00805f9b34fb'
export const DEFAULT_WS_URL = 'ws://127.0.0.1:8787'
export const DEFAULT_FRAGMENT_MTU = 20
export const DEFAULT_BACKCHANNEL_TRANSPORT = 'ble-gatt'
export const KEYBOARD_BACKCHANNEL_TRANSPORT = 'keyboard'
// The keyboard channel moves ~50–100 B/s, so each NACK is bounded to a
// short keystroke line: 40 payload bytes + 11 envelope ≈ 83 keystrokes.
// Capped NACKs carry the lowest missing ids; idempotent re-NACK drains the
// rest (§2.5 of the 2026-07-06 dongle design).
export const KEYBOARD_NACK_PAYLOAD_CAP_BYTES = 40
export { ARQ_KEYBOARD_DEVICE_NAME } from './transports/keyboard-codec.js'

export const TRANSPORTS = {}

export function registerTransport(name, impl) {
  TRANSPORTS[name] = impl
}

export function getTransport(name) {
  return TRANSPORTS[name]
}
