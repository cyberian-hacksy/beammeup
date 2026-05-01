import { crc32 } from './crc32.js'
import {
  createPacket,
  parsePacket,
  parsePacketHeaderUnchecked,
  PACKET_HEADER_SIZE
} from '../packet.js'

const PAYLOAD_FLIP_WINDOW = 32
const HEADER_FLIP_WINDOW = 16

export function rankBitsByLowConfidence(confidence) {
  if (!confidence || typeof confidence.length !== 'number') return new Uint32Array(0)

  const ranked = new Array(confidence.length)
  for (let i = 0; i < confidence.length; i++) ranked[i] = i
  ranked.sort((a, b) => confidence[a] - confidence[b] || a - b)
  return Uint32Array.from(ranked)
}

function flipBit(bytes, bitIndex) {
  const byteIdx = Math.floor(bitIndex / 8)
  if (byteIdx < 0 || byteIdx >= bytes.length) return false
  const bitOffset = 7 - (bitIndex % 8)
  bytes[byteIdx] ^= (1 << bitOffset)
  return true
}

export function trySalvagePayload(payload, payloadCrc, confidence, maxFlips = 2) {
  if (!payload || !confidence) return null
  if (crc32(payload) === payloadCrc) return new Uint8Array(payload)

  const ranked = rankBitsByLowConfidence(confidence)
  const window = Math.min(PAYLOAD_FLIP_WINDOW, ranked.length, payload.length * 8)
  if (window <= 0 || maxFlips < 1) return null

  const candidate = new Uint8Array(payload)

  for (let i = 0; i < window; i++) {
    flipBit(candidate, ranked[i])
    if (crc32(candidate) === payloadCrc) return new Uint8Array(candidate)
    flipBit(candidate, ranked[i])
  }

  if (maxFlips < 2) return null

  for (let i = 0; i < window; i++) {
    flipBit(candidate, ranked[i])
    for (let j = i + 1; j < window; j++) {
      flipBit(candidate, ranked[j])
      if (crc32(candidate) === payloadCrc) return new Uint8Array(candidate)
      flipBit(candidate, ranked[j])
    }
    flipBit(candidate, ranked[i])
  }

  return null
}

export function packetMatchesSession(parsed, session) {
  if (!parsed) return false
  if (!session) return true
  if (session.fileId != null && parsed.fileId !== session.fileId) return false
  if (session.k != null && parsed.k !== session.k) return false
  if (session.K_prime != null && parsed.k !== session.K_prime) return false
  return true
}

export function trySalvageSlot(slot, slotConfidence, session = null, maxHeaderFlips = 1, maxPayloadFlips = 2) {
  const direct = parsePacket(slot)
  if (packetMatchesSession(direct, session)) {
    return { parsed: direct, packet: slot, salvaged: false }
  }
  if (!slot || !slotConfidence) return null

  const ranked = rankBitsByLowConfidence(slotConfidence)
  const headerBits = PACKET_HEADER_SIZE * 8
  const candidate = new Uint8Array(slot)

  if (maxHeaderFlips >= 1) {
    let triedHeaderBits = 0
    for (const bitIdx of ranked) {
      if (bitIdx >= headerBits) continue
      flipBit(candidate, bitIdx)
      const parsed = parsePacket(candidate)
      if (packetMatchesSession(parsed, session)) {
        return { parsed, packet: new Uint8Array(candidate), salvaged: true }
      }
      flipBit(candidate, bitIdx)
      triedHeaderBits++
      if (triedHeaderBits >= HEADER_FLIP_WINDOW) break
    }
  }

  const header = parsePacketHeaderUnchecked(slot)
  if (!header) return null

  const payloadConfidence = slotConfidence.subarray(headerBits, headerBits + header.payloadLength * 8)
  const recoveredPayload = trySalvagePayload(
    slot.subarray(PACKET_HEADER_SIZE),
    header.payloadCrc,
    payloadConfidence,
    maxPayloadFlips
  )
  if (!recoveredPayload) return null

  candidate.set(slot)
  candidate.set(recoveredPayload, PACKET_HEADER_SIZE)
  const parsed = parsePacket(candidate)
  return packetMatchesSession(parsed, session)
    ? { parsed, packet: new Uint8Array(candidate), salvaged: true }
    : null
}

export function tryParseOrSalvage(slot, frameConfidence, slotByteOffset, session = null) {
  const direct = parsePacket(slot)
  if (packetMatchesSession(direct, session)) {
    return { parsed: direct, packet: slot, salvaged: false }
  }
  if (!frameConfidence || !slot || slotByteOffset == null) return null

  const slotBitStart = slotByteOffset * 8
  const slotBitEnd = slotBitStart + slot.length * 8
  if (slotBitStart < 0 || slotBitEnd > frameConfidence.length) return null

  const slotConfidence = frameConfidence.subarray(slotBitStart, slotBitEnd)
  const recovered = trySalvageSlot(slot, slotConfidence, session, 1, 2)
  if (!recovered) return null
  return {
    parsed: recovered.parsed,
    packet: recovered.packet,
    salvaged: recovered.salvaged
  }
}

export function testRankBitsByLowConfidence() {
  const confidence = new Uint8Array([100, 5, 80, 1, 50])
  const ranked = rankBitsByLowConfidence(confidence)
  const pass = ranked[0] === 3 && ranked[1] === 1 && ranked[2] === 4
  console.log('rankBitsByLowConfidence test:', pass ? 'PASS' : `FAIL ${ranked}`)
  return pass
}

export function testTrySalvageSingleBitFlip() {
  const truth = new Uint8Array([0xAA, 0x55, 0xFF, 0x00])
  const correctCrc = crc32(truth)
  const corrupted = new Uint8Array(truth)
  corrupted[1] ^= 0x10

  const confidence = new Uint8Array(truth.length * 8).fill(100)
  confidence[8 + 3] = 5

  const recovered = trySalvagePayload(corrupted, correctCrc, confidence, 1)
  const pass = recovered && recovered.every((v, i) => v === truth[i])
  console.log('trySalvage single-bit-flip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testTrySalvageSlotHeaderBitFlip() {
  const truthPayload = new Uint8Array([0xAA, 0x55, 0xFF, 0x00])
  const packet = createPacket(0x12345678, 100, 77, truthPayload, false, truthPayload.length)
  const corrupted = new Uint8Array(packet)
  corrupted[11] ^= 0x01

  const confidence = new Uint8Array(corrupted.length * 8).fill(100)
  confidence[11 * 8 + 7] = 1

  const recovered = trySalvageSlot(corrupted, confidence, { fileId: 0x12345678, k: 100 })
  const pass = recovered?.parsed?.symbolId === 77
  console.log('trySalvage slot header-bit-flip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testTryParseOrSalvageUsesFrameConfidenceOffset() {
  const truthPayload = new Uint8Array([0x10, 0x20, 0x30, 0x40])
  const packet = createPacket(0x12345678, 100, 88, truthPayload, false, truthPayload.length)
  const slotOffset = 3
  const framePayload = new Uint8Array(slotOffset + packet.length)
  framePayload.set(packet, slotOffset)
  framePayload[slotOffset + PACKET_HEADER_SIZE + 2] ^= 0x01

  const frameConfidence = new Uint8Array(framePayload.length * 8).fill(100)
  const flippedFrameBit = (slotOffset + PACKET_HEADER_SIZE + 2) * 8 + 7
  frameConfidence[flippedFrameBit] = 1

  const slot = framePayload.subarray(slotOffset, slotOffset + packet.length)
  const recovered = tryParseOrSalvage(slot, frameConfidence, slotOffset, { fileId: 0x12345678, k: 100 })
  const pass = recovered?.parsed?.symbolId === 88 &&
    recovered.salvaged === true &&
    recovered.packet[PACKET_HEADER_SIZE + 2] === truthPayload[2]
  console.log('tryParseOrSalvage frame-confidence offset test:', pass ? 'PASS' : 'FAIL')
  return pass
}
