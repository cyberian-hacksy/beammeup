// Shared byte<->keystroke codec for the ESP32-S3 keyboard-dongle ARQ transport.
//
// A BLE keyboard sends HID *usage codes* (physical key positions); the sender's
// OS turns those into characters using its own keyboard layout. To keep decoding
// independent of that layout and of Shift state, the alphabet is keyed by
// physical position: the dongle presses a fixed set of keys, and the sender reads
// `event.code` (never `event.key`). The modifier byte is always 0 (no Shift), so
// no layout can remap a symbol.
//
// This table is mirrored byte-for-byte in firmware/include/keymap.h — keep the
// two in sync.

export const ARQ_KEYBOARD_DEVICE_NAME = 'BeamMeUp-Kbd'

// 32-symbol base32 alphabet. Index == base32 value. Each row ties together the
// serial character the receiver writes to the dongle, the physical key the dongle
// presses (its `event.code` on the sender), and the raw HID usage code.
function buildAlphabet() {
  const table = []
  for (let i = 0; i < 26; i++) {
    table.push({
      serialChar: String.fromCharCode(97 + i), // 'a'..'z'
      code: 'Key' + String.fromCharCode(65 + i), // 'KeyA'..'KeyZ'
      usage: 0x04 + i // HID a..z
    })
  }
  for (let d = 0; d < 6; d++) {
    table.push({
      serialChar: String.fromCharCode(48 + d), // '0'..'5'
      code: 'Digit' + d, // 'Digit0'..'Digit5'
      usage: d === 0 ? 0x27 : 0x1d + d // HID: 0 -> 0x27, 1..5 -> 0x1E..0x22
    })
  }
  return table
}

export const KEYBOARD_ALPHABET = buildAlphabet()
export const KEYBOARD_DELIMITER = { serialChar: '\n', code: 'Enter', usage: 0x28 }

// macOS launches the Keyboard Setup Assistant on every fresh pairing of a BLE
// HID keyboard and asks for the key right of left-Shift to detect the layout.
// Writing this serial char makes the dongle press that key (US ANSI 'z',
// event.code 'KeyZ', HID usage 0x1D — firmware KSA_ANSI_USAGE), dismissing the
// dialog. The dongle auto-answers fresh pairings itself; this backs up the
// manual receiver button for when that single shot mistimes.
export const MAC_KSA_IDENTIFY_SERIAL_CHAR = 'z'

const VALUE_TO_CHAR = KEYBOARD_ALPHABET.map(e => e.serialChar)
const CHAR_TO_VALUE = new Map(KEYBOARD_ALPHABET.map((e, i) => [e.serialChar, i]))
const CODE_TO_VALUE = new Map(KEYBOARD_ALPHABET.map((e, i) => [e.code, i]))

// event.code ('KeyA', 'Digit5', ...) -> base32 value, or -1 for keys we do not use.
export function eventCodeToValue(code) {
  const v = CODE_TO_VALUE.get(code)
  return v === undefined ? -1 : v
}

// Unpadded base32 over the alphabet's serial characters. Bytes never exceed a
// handful of buffered bits, so the 20-bit mask keeps the accumulator bounded.
export function encodeBase32(bytes) {
  let value = 0
  let bits = 0
  let out = ''
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xfffff
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += VALUE_TO_CHAR[(value >>> bits) & 31]
    }
  }
  if (bits > 0) out += VALUE_TO_CHAR[(value << (5 - bits)) & 31]
  return out
}

// Decode from an array of base32 values (what the sender accumulates from
// event.code). Unknown values are ignored by the caller before this point.
export function decodeBase32Values(values) {
  let value = 0
  let bits = 0
  const out = []
  for (const v of values) {
    value = ((value << 5) | (v & 31)) & 0xfffff
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return new Uint8Array(out)
}

// Decode from a base32 string (serial characters). Stray characters — including
// the '\n' delimiter or '\r' — are skipped, not treated as data.
export function decodeBase32(str) {
  const values = []
  for (const ch of str) {
    const v = CHAR_TO_VALUE.get(ch)
    if (v !== undefined) values.push(v)
  }
  return decodeBase32Values(values)
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export function testKeyboardBase32Roundtrip() {
  const cases = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([255]),
    new Uint8Array([1, 2, 3, 4, 5]),
    new Uint8Array(37).map((_, i) => (i * 73 + 11) & 0xff),
    new Uint8Array(256).map((_, i) => i & 0xff)
  ]
  for (const bytes of cases) {
    const back = decodeBase32(encodeBase32(bytes))
    if (!bytesEqual(back, bytes)) {
      console.log('keyboard base32 roundtrip: FAIL', bytes.length)
      return false
    }
  }
  console.log('keyboard base32 roundtrip: PASS')
  return true
}

export function testKeyboardAlphabetIsPhysicalAndDistinct() {
  const codes = new Set()
  const usages = new Set()
  const chars = new Set()
  let ok = KEYBOARD_ALPHABET.length === 32
  for (const e of KEYBOARD_ALPHABET) {
    codes.add(e.code)
    usages.add(e.usage)
    chars.add(e.serialChar)
    // Physical letter/digit keys only — never a modifier or Shift-gated symbol.
    if (!/^(Key[A-Z]|Digit[0-9])$/.test(e.code)) ok = false
    if (e.usage < 0x04 || e.usage > 0x27) ok = false
  }
  const pass = ok &&
    codes.size === 32 &&
    usages.size === 32 &&
    chars.size === 32 &&
    KEYBOARD_DELIMITER.code === 'Enter' &&
    KEYBOARD_DELIMITER.usage === 0x28 &&
    !codes.has(KEYBOARD_DELIMITER.code)
  console.log('keyboard alphabet distinct/physical:', pass ? 'PASS' : 'FAIL')
  return pass
}

// Prove the full physical-key round-trip: bytes -> base32 chars -> the dongle's
// event.code for each -> back to values -> decode. This is the property that makes
// the channel layout-independent.
export function testKeyboardCodecRoundtripsThroughEventCodes() {
  const bytes = new Uint8Array(50).map((_, i) => (i * 91 + 7) & 0xff)
  const chars = encodeBase32(bytes)
  const values = []
  for (const ch of chars) {
    const row = KEYBOARD_ALPHABET.find(e => e.serialChar === ch)
    values.push(eventCodeToValue(row.code)) // pretend the dongle pressed row.code
  }
  const back = decodeBase32Values(values)
  const pass = bytesEqual(back, bytes) && eventCodeToValue('F5') === -1
  console.log('keyboard codec via event.code:', pass ? 'PASS' : 'FAIL')
  return pass
}
