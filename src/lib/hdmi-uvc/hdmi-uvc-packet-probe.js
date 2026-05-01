// Shared HDMI-UVC frame-payload packet probing.
//
// Outer HDMI-UVC frames already have their own CRC. This module slices a
// CRC-valid frame payload into fixed-size Beam Me Up packets and validates
// each inner packet CRC before decoder ingestion.

import { createPacket, PACKET_HEADER_SIZE, parsePacket } from '../packet.js'
import { tryParseOrSalvage } from './hdmi-uvc-salvage.js'

export const MAX_FRAME_PACKET_SLOTS = 32

export function tryVariableFramePackets(framePayload) {
  // HDMI-UVC batching uses equal-sized packets inside each frame payload.
  // Keep the variable-path disabled so bootstrap salvage relies on the more
  // reliable equal-chunk probe instead of stale block-size header offsets.
  return []
}

function normalizeProbeOptions(options) {
  if (!options || typeof options === 'number') {
    return {
      confidence: null,
      session: null,
      maxPackets: typeof options === 'number' ? options : MAX_FRAME_PACKET_SLOTS
    }
  }
  return {
    confidence: options.confidence || null,
    session: options.session || null,
    maxPackets: options.maxPackets || MAX_FRAME_PACKET_SLOTS
  }
}

function parseSlot(packet, frameConfidence, slotByteOffset, session) {
  return tryParseOrSalvage(packet, frameConfidence, slotByteOffset, session)
}

export function tryEqualChunkFramePackets(framePayload, maxPackets = MAX_FRAME_PACKET_SLOTS, options = {}) {
  const { confidence, session } = normalizeProbeOptions(options)
  let best = null

  for (let slotCount = 2; slotCount <= maxPackets; slotCount++) {
    if (framePayload.length % slotCount !== 0) continue

    const packetSize = framePayload.length / slotCount
    if (packetSize < PACKET_HEADER_SIZE) continue

    const packets = []
    const parsedPackets = []
    let salvaged = 0
    for (let offset = 0; offset < framePayload.length; offset += packetSize) {
      const packet = framePayload.subarray(offset, offset + packetSize)
      const result = parseSlot(packet, confidence, offset, session)
      if (result) {
        packets.push(result.packet)
        parsedPackets.push(result.parsed)
        if (result.salvaged) salvaged++
      }
    }

    if (packets.length === 0) continue

    const validBytes = packets.length * packetSize
    if (
      !best ||
      packets.length > best.packets.length ||
      (packets.length === best.packets.length && validBytes > best.validBytes) ||
      (packets.length === best.packets.length && validBytes === best.validBytes && slotCount > best.slotCount)
    ) {
      best = { packets, parsedPackets, slotCount, packetSize, validBytes, salvaged }
    }
  }

  return best
}

export function probeFramePackets(framePayload, expectedPacketSize = null, options = {}) {
  const opts = normalizeProbeOptions(options)
  if (!framePayload) {
    return { packets: [], parsedPackets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'none', salvaged: 0 }
  }

  if (expectedPacketSize && expectedPacketSize >= PACKET_HEADER_SIZE) {
    if (framePayload.length % expectedPacketSize !== 0) {
      return { packets: [], parsedPackets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'expected', salvaged: 0 }
    }

    const packets = []
    const parsedPackets = []
    let salvaged = 0
    for (let offset = 0; offset < framePayload.length; offset += expectedPacketSize) {
      const packet = framePayload.subarray(offset, offset + expectedPacketSize)
      const result = parseSlot(packet, opts.confidence, offset, opts.session)
      if (result) {
        packets.push(result.packet)
        parsedPackets.push(result.parsed)
        if (result.salvaged) salvaged++
      }
    }
    return {
      packets,
      parsedPackets,
      slotCount: Math.floor(framePayload.length / expectedPacketSize),
      packetSize: expectedPacketSize,
      strategy: 'expected',
      salvaged
    }
  }

  const variablePackets = tryVariableFramePackets(framePayload)
  if (variablePackets.length > 0) {
    return {
      packets: variablePackets,
      parsedPackets: variablePackets.map(packet => parsePacket(packet)).filter(Boolean),
      slotCount: variablePackets.length,
      packetSize: variablePackets[0]?.length ?? null,
      strategy: 'variable',
      salvaged: 0
    }
  }

  const equalChunk = tryEqualChunkFramePackets(framePayload, opts.maxPackets, opts)
  if (equalChunk) {
    return {
      packets: equalChunk.packets,
      parsedPackets: equalChunk.parsedPackets,
      slotCount: equalChunk.slotCount,
      packetSize: equalChunk.packetSize,
      strategy: 'equal',
      salvaged: equalChunk.salvaged || 0
    }
  }

  return { packets: [], parsedPackets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'none', salvaged: 0 }
}

export function extractFramePackets(framePayload, expectedPacketSize = null, options = {}) {
  return probeFramePackets(framePayload, expectedPacketSize, options).packets
}

export function extractParsedFramePackets(framePayload, expectedPacketSize = null, options = {}) {
  const probe = probeFramePackets(framePayload, expectedPacketSize, options)
  return {
    packets: probe.parsedPackets,
    slotCount: probe.slotCount,
    packetSize: probe.packetSize,
    strategy: probe.strategy,
    salvaged: probe.salvaged || 0
  }
}

export function getFramePacketSlotCount(framePayload, expectedPacketSize = null) {
  return probeFramePackets(framePayload, expectedPacketSize).slotCount
}

export function testEqualChunkProbeFinds24PacketFrame() {
  const blockSize = 980
  const slotCount = 24
  const packetSize = PACKET_HEADER_SIZE + blockSize
  const framePayload = new Uint8Array(packetSize * slotCount)

  for (let slot = 0; slot < slotCount; slot++) {
    const payload = new Uint8Array(blockSize)
    payload.fill(slot + 1)
    const packet = createPacket(0x12345678, 6063, slot + 1, payload, false, blockSize)
    framePayload.set(packet, slot * packetSize)
  }

  const probe = probeFramePackets(framePayload)
  const pass = probe.packets.length === slotCount &&
    probe.parsedPackets.length === slotCount &&
    probe.slotCount === slotCount &&
    probe.packetSize === packetSize &&
    probe.strategy === 'equal'

  console.log('Equal chunk 24-packet probe test:', pass ? 'PASS' : 'FAIL', {
    packets: probe.packets.length,
    slotCount: probe.slotCount,
    packetSize: probe.packetSize,
    strategy: probe.strategy
  })
  return pass
}

export function testPacketProbeSalvagesLowConfidenceBit() {
  const blockSize = 4
  const slotCount = 2
  const packetSize = PACKET_HEADER_SIZE + blockSize
  const framePayload = new Uint8Array(packetSize * slotCount)

  for (let slot = 0; slot < slotCount; slot++) {
    const payload = new Uint8Array(blockSize)
    payload.fill(slot + 1)
    const packet = createPacket(0x12345678, 100, slot + 1, payload, false, blockSize)
    framePayload.set(packet, slot * packetSize)
  }

  const flippedByte = packetSize + PACKET_HEADER_SIZE + 2
  framePayload[flippedByte] ^= 0x01

  const confidence = new Uint8Array(framePayload.length * 8).fill(100)
  confidence[flippedByte * 8 + 7] = 1

  const probe = probeFramePackets(framePayload, packetSize, {
    confidence,
    session: { fileId: 0x12345678, k: 100 }
  })
  const pass = probe.packets.length === slotCount &&
    probe.parsedPackets.length === slotCount &&
    probe.salvaged === 1 &&
    probe.strategy === 'expected'

  console.log('Packet probe soft salvage test:', pass ? 'PASS' : 'FAIL', {
    packets: probe.packets.length,
    salvaged: probe.salvaged,
    strategy: probe.strategy
  })
  return pass
}
