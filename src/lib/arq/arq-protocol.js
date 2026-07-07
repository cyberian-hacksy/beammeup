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
  const cases = [
    [], [1], [1, 2, 3], [5, 9, 100, 101, 5000], [1, 3, 5, 7, 9, 11, 13],
    // Bursty sets exercise the range encoding (tag 2), including at the top
    // of the uint32 id space.
    [7, 8, 9, 10, 50, 51, 52, 900],
    Array.from({ length: 256 }, (_, i) => (0xFFFFFF00 + i) >>> 0)
  ]
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
  const alternating = Array.from({ length: 200 }, (_, i) => 1000 + i * 2)
  const run = Array.from({ length: 400 }, (_, i) => 1000 + i)
  const sparseTag = encodeMissingSet(sparse)[0]
  const alternatingTag = encodeMissingSet(alternating)[0]
  const runTag = encodeMissingSet(run)[0]
  const pass = sparseTag === 0 && alternatingTag === 1 && runTag === 2
  console.log('missing-set adaptive:', pass ? 'PASS' : 'FAIL', { sparseTag, alternatingTag, runTag })
  return pass
}

export function testMissingSetRangeEncodingCompressesBursts() {
  // Frame drops lose contiguous block-id runs; ranges must collapse each
  // burst to a few bytes where the delta list pays ~1 byte per id.
  const ids = []
  for (const start of [1000, 5000, 9000]) {
    for (let i = 0; i < 40; i++) ids.push(start + i)
  }
  const encoded = encodeMissingSet(ids)
  const back = decodeMissingSet(encoded)
  const pass = encoded[0] === 2 && encoded.length <= 12 &&
    back.length === ids.length && back.every((v, i) => v === ids[i])
  console.log('missing-set range encoding bursts:', pass ? 'PASS' : 'FAIL', encoded.length)
  return pass
}

export function testMissingSetCappedFitsBudgetAndKeepsPrefix() {
  // Alternating ids defeat run collapsing, so the encoding grows with count
  // and the cap has to cut the set down to a prefix.
  const ids = Array.from({ length: 100 }, (_, i) => 1 + i * 2)
  const capped = encodeMissingSetCapped(ids, 12)
  const back = decodeMissingSet(capped)
  const uncapped = decodeMissingSet(encodeMissingSetCapped(ids, 1000))
  const floor = decodeMissingSet(encodeMissingSetCapped([0xFFFFFFFF], 1))
  const pass = capped.length <= 12 &&
    back.length >= 1 && back.length < ids.length &&
    back.every((v, i) => v === ids[i]) &&
    uncapped.length === ids.length &&
    floor.length === 1 && floor[0] === 0xFFFFFFFF
  console.log('missing-set capped prefix:', pass ? 'PASS' : 'FAIL', { bytes: capped.length, ids: back.length })
  return pass
}

export function testEncodeNackHonorsPayloadCap() {
  const ids = Array.from({ length: 100 }, (_, i) => 1 + i * 2)
  const capped = decodeArqMessage(encodeNack(1, 1, ids, 12))
  const full = decodeArqMessage(encodeNack(1, 1, ids))
  const missing = decodeMissingSet(capped.payload)
  const pass = capped.payload.length <= 12 &&
    missing.length >= 1 && missing.every((v, i) => v === ids[i]) &&
    decodeMissingSet(full.payload).length === ids.length
  console.log('encode nack payload cap:', pass ? 'PASS' : 'FAIL', capped.payload.length)
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

// tag 0 = delta-varint list, tag 1 = bitmap, tag 2 = (gap, length) run list.
// ids must be sorted ascending and unique.
export function encodeMissingSet(ids) {
  const list = [0]
  let prev = 0
  for (const id of ids) {
    writeVarint(list, id - prev)
    prev = id
  }

  let winner = list

  if (ids.length > 0) {
    // Frame drops lose contiguous runs of block ids, so run-length pairs
    // usually collapse a burst to a few bytes.
    const ranges = [2]
    let prevEnd = 0
    let runStart = ids[0]
    let runLen = 1
    const flushRun = () => {
      writeVarint(ranges, runStart - prevEnd)
      writeVarint(ranges, runLen)
      prevEnd = runStart + runLen - 1
    }
    for (let i = 1; i < ids.length; i++) {
      if (ids[i] === ids[i - 1] + 1) {
        runLen++
        continue
      }
      flushRun()
      runStart = ids[i]
      runLen = 1
    }
    flushRun()
    if (ranges.length < winner.length) winner = ranges

    const base = ids[0]
    const range = ids[ids.length - 1] - base + 1
    const bitmapHeader = [1]
    writeVarint(bitmapHeader, base)
    writeVarint(bitmapHeader, range)
    const bitmapBytes = (range + 7) >> 3
    // Only built when header + payload beat the current winner.
    if (bitmapHeader.length + bitmapBytes < winner.length) {
      const bytes = new Uint8Array(bitmapBytes)
      for (const id of ids) bytes[(id - base) >> 3] |= 1 << ((id - base) & 7)
      winner = bitmapHeader
      for (const byte of bytes) winner.push(byte)
    }
  }

  return new Uint8Array(winner)
}

// Defensive bound for run lengths: CRC gates real messages, but a decoder
// must never let a corrupt varint allocate unbounded ids.
const MAX_RANGE_DECODE_IDS = 1 << 22

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

  if (bytes[0] === 2) {
    let pos = 1
    let prevEnd = 0
    while (pos < bytes.length && ids.length < MAX_RANGE_DECODE_IDS) {
      let gap, len
      ;[gap, pos] = readVarint(bytes, pos)
      ;[len, pos] = readVarint(bytes, pos)
      const start = prevEnd + gap
      const bounded = Math.min(len, MAX_RANGE_DECODE_IDS - ids.length)
      for (let i = 0; i < bounded; i++) ids.push((start + i) >>> 0)
      prevEnd = start + len - 1
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

// Longest prefix of ids whose encoding fits capBytes — always at least one
// id, so a capped NACK still makes progress. Valid because every encoding's
// size is non-decreasing as the prefix grows (min of non-decreasing sizes).
export function encodeMissingSetCapped(ids, capBytes) {
  const full = encodeMissingSet(ids)
  if (!(capBytes > 0) || full.length <= capBytes || ids.length <= 1) return full
  let lo = 2
  let hi = ids.length - 1
  let best = encodeMissingSet(ids.slice(0, 1))
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const enc = encodeMissingSet(ids.slice(0, mid))
    if (enc.length <= capBytes) {
      best = enc
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return best
}

export function encodeNack(fileId, seq, missingIds, payloadCapBytes = 0) {
  const payload = payloadCapBytes > 0
    ? encodeMissingSetCapped(missingIds, payloadCapBytes)
    : encodeMissingSet(missingIds)
  return encodeArqMessage(ARQ_MSG.NACK, fileId, seq, payload)
}

export function encodeComplete(fileId, seq) {
  return encodeArqMessage(ARQ_MSG.COMPLETE, fileId, seq)
}
