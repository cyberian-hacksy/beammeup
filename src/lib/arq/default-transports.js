import {
  DEFAULT_BACKCHANNEL_TRANSPORT,
  KEYBOARD_BACKCHANNEL_TRANSPORT,
  KEYBOARD_NACK_PAYLOAD_CAP_BYTES,
  getTransport,
  registerTransport
} from './backchannel.js'
import { BleGattSenderTransport } from './transports/ble-gatt-sender.js'
import { BleGattReceiverTransport } from './transports/ble-gatt-receiver.js'
import { KeyboardSenderTransport } from './transports/keyboard-sender.js'
import { KeyboardReceiverTransport } from './transports/keyboard-receiver.js'

registerTransport(DEFAULT_BACKCHANNEL_TRANSPORT, {
  makeSender: () => new BleGattSenderTransport(),
  makeReceiver: () => new BleGattReceiverTransport()
})

registerTransport(KEYBOARD_BACKCHANNEL_TRANSPORT, {
  makeSender: () => new KeyboardSenderTransport(),
  makeReceiver: () => new KeyboardReceiverTransport(),
  // Bounds each NACK to one short keystroke line; BLE stays uncapped.
  nackPayloadCapBytes: KEYBOARD_NACK_PAYLOAD_CAP_BYTES
})

export const DEFAULT_ARQ_TRANSPORT = DEFAULT_BACKCHANNEL_TRANSPORT

// ?arq-transport=<name> beats localStorage['arq-transport']; anything empty
// or unregistered falls back to the default so a stray value can never
// disable the back-channel.
export function resolveArqTransportName(search, storageGet) {
  let requested = null
  try {
    requested = new URLSearchParams(search || '').get('arq-transport')
  } catch {
    requested = null
  }
  if (!requested) {
    try {
      requested = storageGet?.('arq-transport') || null
    } catch {
      requested = null
    }
  }
  return requested && getTransport(requested) ? requested : DEFAULT_ARQ_TRANSPORT
}

export function getSelectedArqTransportName() {
  return resolveArqTransportName(
    globalThis.location?.search ?? '',
    key => globalThis.localStorage?.getItem(key) ?? null
  )
}

export function testKeyboardTransportRegisteredWithNackCap() {
  const impl = getTransport(KEYBOARD_BACKCHANNEL_TRANSPORT)
  const sender = impl?.makeSender?.()
  const receiver = impl?.makeReceiver?.()
  const pass = sender instanceof KeyboardSenderTransport &&
    receiver instanceof KeyboardReceiverTransport &&
    impl.nackPayloadCapBytes === KEYBOARD_NACK_PAYLOAD_CAP_BYTES &&
    getTransport(DEFAULT_ARQ_TRANSPORT)?.nackPayloadCapBytes === undefined
  console.log('keyboard transport registered with cap:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testResolveArqTransportNamePrefersQueryThenStorage() {
  const storedKeyboard = key => (key === 'arq-transport' ? 'keyboard' : null)
  const pass = resolveArqTransportName('?arq-transport=keyboard', () => null) === 'keyboard' &&
    resolveArqTransportName('', storedKeyboard) === 'keyboard' &&
    resolveArqTransportName('?arq-transport=ble-gatt', storedKeyboard) === 'ble-gatt' &&
    resolveArqTransportName('?arq-transport=bogus', () => null) === DEFAULT_ARQ_TRANSPORT &&
    resolveArqTransportName('', () => 'bogus') === DEFAULT_ARQ_TRANSPORT &&
    resolveArqTransportName('', () => null) === DEFAULT_ARQ_TRANSPORT &&
    resolveArqTransportName(undefined, undefined) === DEFAULT_ARQ_TRANSPORT
  console.log('resolve arq transport name:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testGetSelectedArqTransportNameAlwaysRegistered() {
  // Works with or without a DOM (node tests have no location/localStorage)
  // and never returns an unregistered name — a stray stored value must not
  // disable the back-channel.
  const name = getSelectedArqTransportName()
  const pass = typeof name === 'string' && !!getTransport(name)
  console.log('selected arq transport registered:', pass ? 'PASS' : 'FAIL', name)
  return pass
}
