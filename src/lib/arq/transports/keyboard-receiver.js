// Receiver-side ARQ transport for the ESP32-S3 keyboard dongle. Each ARQ
// message goes out over Web Serial as one base32 line ('\n'-delimited); the
// dongle turns the line into BLE HID keystrokes on the sender (see
// keyboard-codec.js and the 2026-07-06 design doc).

import { encodeBase32 } from './keyboard-codec.js'

export const KEYBOARD_SERIAL_BAUD_RATE = 115200

function makeFakeSerialRig() {
  const written = []
  const port = {
    openedWith: null,
    closed: false,
    async open(opts) { this.openedWith = opts },
    writable: {
      getWriter: () => ({
        write: async chunk => { written.push(chunk) },
        releaseLock() {}
      })
    },
    async close() { this.closed = true }
  }
  return { port, written }
}

export async function testKeyboardReceiverSendsOneBase32LinePerMessage() {
  const { port, written } = makeFakeSerialRig()
  let requested = 0
  const t = new KeyboardReceiverTransport({
    serial: { requestPort: async () => { requested++; return port } }
  })
  await t.init({})
  const msg = new Uint8Array([1, 254, 7, 0, 42])
  await t.send(msg)
  const text = written[0] ? new TextDecoder().decode(written[0]) : ''
  const pass = requested === 1 &&
    port.openedWith?.baudRate === KEYBOARD_SERIAL_BAUD_RATE &&
    text === encodeBase32(msg) + '\n'
  console.log('keyboard receiver sends base32 line:', pass ? 'PASS' : 'FAIL', JSON.stringify(text))
  return pass
}

export async function testKeyboardReceiverReusePortIsGestureFree() {
  const { port } = makeFakeSerialRig()
  const gestureError = () => { throw new Error('requestPort needs a user gesture') }
  const t = new KeyboardReceiverTransport({
    serial: { getPorts: async () => [port], requestPort: gestureError }
  })
  let reused = true
  try {
    await t.init({ reusePort: true })
  } catch {
    reused = false
  }
  const t2 = new KeyboardReceiverTransport({
    serial: { getPorts: async () => [], requestPort: gestureError }
  })
  let emptyRejected = false
  try {
    await t2.init({ reusePort: true })
  } catch {
    emptyRejected = true
  }
  const pass = reused && emptyRejected
  console.log('keyboard receiver reusePort gesture-free:', pass ? 'PASS' : 'FAIL')
  return pass
}

export class KeyboardReceiverTransport {
  constructor({ serial = null, baudRate = KEYBOARD_SERIAL_BAUD_RATE } = {}) {
    // Injectable for tests; the real navigator.serial is resolved lazily in
    // init so the class constructs in node (registry tests, makeReceiver).
    this.serialOverride = serial
    this.baudRate = baudRate
    this.port = null
    this.writer = null
    this.onStatus = null
    this.textEncoder = new TextEncoder()
    this.handleDisconnect = this.handleDisconnect.bind(this)
  }

  async init(session = {}) {
    this.onStatus = session.onStatus || null
    const serial = this.serialOverride || globalThis.navigator?.serial
    if (!serial) {
      throw new Error('Web Serial is not available in this browser — use Chrome or Edge')
    }
    if (session.reusePort) {
      // Gesture-free auto-connect path: only reopens a port the user already
      // authorized via the manual connect button (requestPort needs a click).
      const ports = await serial.getPorts()
      this.port = ports?.[0] || null
      if (!this.port) {
        throw new Error('No authorized keyboard dongle yet — use the connect button once to grant serial access')
      }
    } else {
      this.port = await serial.requestPort()
    }
    await this.port.open({ baudRate: this.baudRate })
    this.port.addEventListener?.('disconnect', this.handleDisconnect)
    this.writer = this.port.writable.getWriter()
    this.onStatus?.('connected')
  }

  onMessage() {
    // Receiver-side transport is an emitter only.
  }

  handleDisconnect() {
    this.writer = null
    this.port = null
    this.onStatus?.('disconnected')
  }

  async send(bytes) {
    if (!this.writer) throw new Error('Keyboard dongle serial port is not connected')
    await this.writer.write(this.textEncoder.encode(encodeBase32(bytes) + '\n'))
  }

  close() {
    const port = this.port
    const writer = this.writer
    this.port = null
    this.writer = null
    if (writer) {
      try {
        writer.releaseLock()
      } catch {
        // Stream already errored or closed — nothing to release.
      }
    }
    if (port) {
      port.removeEventListener?.('disconnect', this.handleDisconnect)
      Promise.resolve().then(() => port.close?.()).catch(() => {})
    }
  }
}
