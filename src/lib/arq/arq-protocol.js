import { crc32 } from '../hdmi-uvc/crc32.js'

export const ARQ_MSG = { NACK: 1, COMPLETE: 2 }

export function testArqMessageRoundtrip() {
  const payload = new Uint8Array([10, 20, 30])
  const msg = encodeArqMessage(ARQ_MSG.NACK, 0xDEADBEEF, 1234, payload)
  const d = decodeArqMessage(msg)
  const pass = d !== null &&
    d.type === ARQ_MSG.NACK &&
    d.fileId === 0xDEADBEEF &&
    d.seq === 1234 &&
    d.payload.length === 3 && d.payload[0] === 10 && d.payload[2] === 30
  console.log('arq message roundtrip:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqMessageRejectsCorruption() {
  const msg = encodeArqMessage(ARQ_MSG.COMPLETE, 0x11223344, 7)
  msg[2] ^= 0xFF
  const pass = decodeArqMessage(msg) === null
  console.log('arq message rejects corruption:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testMissingSetCodecRoundtrip() {
  const cases = [[], [1], [1, 2, 3], [5, 9, 100, 101, 5000], [1, 3, 5, 7, 9, 11, 13]]
  for (const ids of cases) {
    const back = decodeMissingSet(encodeMissingSet(ids))
    if (back.length !== ids.length || back.some((v, i) => v !== ids[i])) {
      console.log('missing-set roundtrip: FAIL', ids)
      return false
    }
  }
  console.log('missing-set roundtrip: PASS')
  return true
}

export function testMissingSetAdaptiveChoosesSmaller() {
  const sparse = [1, 9000, 18000]
  const dense = Array.from({ length: 400 }, (_, i) => 1000 + i)
  const sparseTag = encodeMissingSet(sparse)[0]
  const denseTag = encodeMissingSet(dense)[0]
  const pass = sparseTag === 0 && denseTag === 1
  console.log('missing-set adaptive:', pass ? 'PASS' : 'FAIL', { sparseTag, denseTag })
  return pass
}

export function testMissingSetCodecHighUint32Roundtrip() {
  const ids = [0xF0000000, 0xF0000001, 0xFFFFFFFF]
  const back = decodeMissingSet(encodeMissingSet(ids))
  const pass = back.length === ids.length && back.every((v, i) => v === ids[i])
  console.log('missing-set high uint32 roundtrip:', pass ? 'PASS' : 'FAIL', back)
  return pass
}

export function testMissingSetSparseLargeRangeUsesDeltaEncoding() {
  const encoded = encodeMissingSet([1, 220000])
  const pass = encoded[0] === 0
  console.log('missing-set sparse large range uses delta:', pass ? 'PASS' : 'FAIL', encoded[0])
  return pass
}

export function testMissingSetBitmapDecodeBoundsToPayload() {
  const encoded = new Uint8Array([1, 5, 100, 0b00000101])
  const decoded = decodeMissingSet(encoded)
  const pass = decoded.join(',') === '5,7'
  console.log('missing-set bitmap decode bound:', pass ? 'PASS' : 'FAIL', decoded)
  return pass
}

// Wire format: [ type(1) | fileId(4 BE) | seq(2 BE) | payload(N) | crc32(4 BE) ]
export function encodeArqMessage(type, fileId, seq, payload = new Uint8Array(0)) {
  const bodyLength = 7 + payload.length
  const out = new Uint8Array(bodyLength + 4)
  const view = new DataView(out.buffer)

  out[0] = type & 0xFF
  view.setUint32(1, fileId >>> 0, false)
  view.setUint16(5, seq & 0xFFFF, false)
  out.set(payload, 7)
  view.setUint32(bodyLength, crc32(out.subarray(0, bodyLength)), false)

  return out
}

export function decodeArqMessage(bytes) {
  if (bytes.length < 11) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const payloadLen = bytes.length - 11
  const crcOffset = 7 + payloadLen
  const expected = view.getUint32(crcOffset, false)
  if (crc32(bytes.subarray(0, crcOffset)) !== expected) return null

  return {
    type: bytes[0],
    fileId: view.getUint32(1, false),
    seq: view.getUint16(5, false),
    payload: bytes.subarray(7, crcOffset)
  }
}

function writeVarint(arr, value) {
  let v = value >>> 0
  while (v > 0x7F) {
    arr.push((v & 0x7F) | 0x80)
    v >>>= 7
  }
  arr.push(v)
}

function readVarint(bytes, pos) {
  let result = 0
  let factor = 1
  let b = 0
  do {
    if (pos >= bytes.length) return [result >>> 0, pos]
    b = bytes[pos++]
    result += (b & 0x7F) * factor
    factor *= 128
  } while (b & 0x80)
  return [result >>> 0, pos]
}

// tag 0 = delta-varint list, tag 1 = bitmap. ids must be sorted ascending and unique.
export function encodeMissingSet(ids) {
  const list = [0]
  let prev = 0
  for (const id of ids) {
    writeVarint(list, id - prev)
    prev = id
  }

  let bitmap = null
  if (ids.length > 0) {
    const base = ids[0]
    const range = ids[ids.length - 1] - base + 1
    const bitmapHeader = [1]
    writeVarint(bitmapHeader, base)
    writeVarint(bitmapHeader, range)
    const bitmapBytes = (range + 7) >> 3
    if (bitmapHeader.length + bitmapBytes < list.length) {
      bitmap = bitmapHeader
      const bytes = new Uint8Array(bitmapBytes)
      for (const id of ids) bytes[(id - base) >> 3] |= 1 << ((id - base) & 7)
      for (const byte of bytes) bitmap.push(byte)
    }
  }

  const pick = bitmap && bitmap.length < list.length ? bitmap : list
  return new Uint8Array(pick)
}

export function decodeMissingSet(bytes) {
  if (bytes.length === 0) return []
  const ids = []

  if (bytes[0] === 0) {
    let pos = 1
    let prev = 0
    while (pos < bytes.length) {
      const [delta, nextPos] = readVarint(bytes, pos)
      prev += delta
      pos = nextPos
      ids.push(prev)
    }
    return ids
  }

  let [base, pos] = readVarint(bytes, 1)
  let range
  ;[range, pos] = readVarint(bytes, pos)
  const availableBits = Math.max(0, bytes.length - pos) * 8
  const boundedRange = Math.min(range, availableBits)
  for (let i = 0; i < boundedRange; i++) {
    if (bytes[pos + (i >> 3)] & (1 << (i & 7))) ids.push((base + i) >>> 0)
  }
  return ids
}

export function encodeNack(fileId, seq, missingIds) {
  return encodeArqMessage(ARQ_MSG.NACK, fileId, seq, encodeMissingSet(missingIds))
}

export function encodeComplete(fileId, seq) {
  return encodeArqMessage(ARQ_MSG.COMPLETE, fileId, seq)
}
