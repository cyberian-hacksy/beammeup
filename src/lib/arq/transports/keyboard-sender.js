// Sender-side ARQ transport for the ESP32-S3 keyboard dongle: a keydown
// reader. The dongle types base32 lines as BLE HID keystrokes; this reader
// maps event.code (physical key, layout-independent) back to base32 values
// and hands the decoded bytes to the ARQ controller on Enter. Integrity is
// the ARQ message CRC32 — any dropped or injected keystroke just voids one
// line (see keyboard-codec.js and the 2026-07-06 design doc).

import { KEYBOARD_ALPHABET, decodeBase32Values, encodeBase32, eventCodeToValue } from './keyboard-codec.js'

// Runaway-line guard: the longest legitimate line is a capped NACK
// (~83 symbols); anything past this is noise from typing without the
// dongle, so drop it rather than grow without bound.
export const KEYBOARD_LINE_MAX_SYMBOLS = 512

function makeFakeWindow() {
  return {
    handlers: new Map(),
    addEventListener(type, fn) { this.handlers.set(type, fn) },
    removeEventListener(type) { this.handlers.delete(type) },
    dispatch(event) { this.handlers.get('keydown')?.(event) }
  }
}

function keyEvent(code, mods = {}) {
  return {
    code,
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    ...mods
  }
}

function dispatchLine(win, bytes) {
  for (const ch of encodeBase32(bytes)) {
    const row = KEYBOARD_ALPHABET.find(e => e.serialChar === ch)
    win.dispatch(keyEvent(row.code))
  }
  win.dispatch(keyEvent('Enter'))
}

export async function testKeyboardSenderDecodesKeystrokeLine() {
  const win = makeFakeWindow()
  const t = new KeyboardSenderTransport({ target: win })
  const got = []
  t.onMessage(bytes => got.push(bytes))
  await t.init({})
  const msg = new Uint8Array(23).map((_, i) => (i * 37 + 5) & 0xff)
  let allPrevented = true
  for (const ch of encodeBase32(msg)) {
    const row = KEYBOARD_ALPHABET.find(e => e.serialChar === ch)
    const ev = keyEvent(row.code)
    win.dispatch(ev)
    allPrevented = allPrevented && ev.defaultPrevented
  }
  const enter = keyEvent('Enter')
  win.dispatch(enter)
  const out = got[0] || []
  const pass = got.length === 1 && allPrevented && enter.defaultPrevented &&
    out.length === msg.length && msg.every((v, i) => v === out[i])
  console.log('keyboard sender decodes line:', pass ? 'PASS' : 'FAIL', got.length)
  return pass
}

export async function testKeyboardSenderIgnoresForeignAndModifiedKeys() {
  const win = makeFakeWindow()
  const t = new KeyboardSenderTransport({ target: win })
  const got = []
  t.onMessage(bytes => got.push(bytes))
  await t.init({})
  const msg = new Uint8Array([9, 99, 199])
  const noise = [
    keyEvent('F5'),
    keyEvent('Space'),
    keyEvent('ArrowDown'),
    keyEvent('KeyA', { ctrlKey: true }),
    keyEvent('KeyB', { repeat: true }),
    keyEvent('KeyC', { shiftKey: true }),
    keyEvent('KeyD', { metaKey: true }),
    keyEvent('KeyE', { altKey: true })
  ]
  // Noise interleaved mid-line must be neither consumed nor decoded.
  for (const ch of encodeBase32(msg)) {
    for (const ev of noise) win.dispatch(ev)
    const row = KEYBOARD_ALPHABET.find(e => e.serialChar === ch)
    win.dispatch(keyEvent(row.code))
  }
  win.dispatch(keyEvent('Enter'))
  const out = got[0] || []
  const pass = got.length === 1 &&
    noise.every(ev => !ev.defaultPrevented) &&
    out.length === msg.length && msg.every((v, i) => v === out[i])
  console.log('keyboard sender ignores foreign keys:', pass ? 'PASS' : 'FAIL')
  return pass
}

export async function testKeyboardSenderResetsRunawayLine() {
  const win = makeFakeWindow()
  const t = new KeyboardSenderTransport({ target: win })
  const got = []
  t.onMessage(bytes => got.push(bytes))
  await t.init({})
  // Flood past the cap without Enter: the buffer must reset, so the flush
  // only carries the residue after the reset, and later lines still work.
  const flood = KEYBOARD_LINE_MAX_SYMBOLS + 16
  for (let i = 0; i < flood; i++) win.dispatch(keyEvent('KeyA'))
  win.dispatch(keyEvent('Enter'))
  const residueSymbols = 15
  const residueBytes = (residueSymbols * 5) >> 3
  const msg = new Uint8Array([1, 2, 3])
  dispatchLine(win, msg)
  const pass = got.length === 2 &&
    got[0].length === residueBytes &&
    got[1].length === msg.length && msg.every((v, i) => v === got[1][i])
  console.log('keyboard sender resets runaway line:', pass ? 'PASS' : 'FAIL', got[0]?.length)
  return pass
}

export async function testKeyboardSenderCloseStopsConsuming() {
  const win = makeFakeWindow()
  const t = new KeyboardSenderTransport({ target: win })
  const got = []
  t.onMessage(bytes => got.push(bytes))
  await t.init({})
  const armed = win.handlers.size === 1
  t.close()
  dispatchLine(win, new Uint8Array([5, 6, 7]))
  const pass = armed && got.length === 0 && win.handlers.size === 0
  console.log('keyboard sender close stops consuming:', pass ? 'PASS' : 'FAIL')
  return pass
}

export class KeyboardSenderTransport {
  constructor({ target = null } = {}) {
    // Injectable for tests; the real window is resolved lazily in init so
    // the class constructs in node (registry tests, makeSender).
    this.targetOverride = target
    this.target = null
    this.cb = null
    this.values = []
    this.onStatus = null
    this.handleKeydown = this.handleKeydown.bind(this)
  }

  async init(session = {}) {
    this.onStatus = session.onStatus || null
    this.target = this.targetOverride || globalThis.window
    if (!this.target?.addEventListener) {
      throw new Error('Keyboard transport needs a window to read keydown events from')
    }
    // Capture phase so page-level key handling never swallows dongle
    // traffic; there is no dongle-presence handshake — a keyboard channel
    // is receivable the moment the listener is armed.
    this.target.addEventListener('keydown', this.handleKeydown, true)
    this.onStatus?.('connected')
  }

  onMessage(cb) {
    this.cb = cb
  }

  handleKeydown(event) {
    // The dongle always sends modifier 0, so anything modified or
    // auto-repeated is the user's keystroke, not ours — leave it alone.
    if (event.repeat || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return
    if (event.code === 'Enter') {
      event.preventDefault()
      this.flushLine()
      return
    }
    const value = eventCodeToValue(event.code)
    if (value < 0) return
    event.preventDefault()
    this.values.push(value)
    if (this.values.length > KEYBOARD_LINE_MAX_SYMBOLS) this.values.length = 0
  }

  flushLine() {
    if (this.values.length === 0) return
    const bytes = decodeBase32Values(this.values)
    this.values = []
    // Garbage lines (dropped or user-injected keystrokes) fail the ARQ
    // message CRC downstream and are ignored there.
    this.cb?.(bytes)
  }

  close() {
    if (this.target) {
      this.target.removeEventListener('keydown', this.handleKeydown, true)
      this.target = null
    }
    this.values = []
  }
}
