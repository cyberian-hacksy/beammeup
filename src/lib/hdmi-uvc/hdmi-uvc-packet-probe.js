// Shared HDMI-UVC frame-payload packet probing.
//
// Outer HDMI-UVC frames already have their own CRC. This module slices a
// CRC-valid frame payload into fixed-size Beam Me Up packets and validates
// each inner packet CRC before decoder ingestion.

import { createPacket, PACKET_HEADER_SIZE, parsePacket } from '../packet.js'

export const MAX_FRAME_PACKET_SLOTS = 32

export function tryVariableFramePackets(framePayload) {
  // HDMI-UVC batching uses equal-sized packets inside each frame payload.
  // Keep the variable-path disabled so bootstrap salvage relies on the more
  // reliable equal-chunk probe instead of stale block-size header offsets.
  return []
}

export function tryEqualChunkFramePackets(framePayload, maxPackets = MAX_FRAME_PACKET_SLOTS) {
  let best = null

  for (let slotCount = 2; slotCount <= maxPackets; slotCount++) {
    if (framePayload.length % slotCount !== 0) continue

    const packetSize = framePayload.length / slotCount
    if (packetSize < PACKET_HEADER_SIZE) continue

    const packets = []
    const parsedPackets = []
    for (let offset = 0; offset < framePayload.length; offset += packetSize) {
      const packet = framePayload.slice(offset, offset + packetSize)
      const parsed = parsePacket(packet)
      if (parsed) {
        packets.push(packet)
        parsedPackets.push(parsed)
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
      best = { packets, parsedPackets, slotCount, packetSize, validBytes }
    }
  }

  return best
}

export function probeFramePackets(framePayload, expectedPacketSize = null, maxPackets = MAX_FRAME_PACKET_SLOTS) {
  if (!framePayload) {
    return { packets: [], parsedPackets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'none' }
  }

  if (expectedPacketSize && expectedPacketSize >= PACKET_HEADER_SIZE) {
    if (framePayload.length % expectedPacketSize !== 0) {
      return { packets: [], parsedPackets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'expected' }
    }

    const packets = []
    const parsedPackets = []
    for (let offset = 0; offset < framePayload.length; offset += expectedPacketSize) {
      const packet = framePayload.slice(offset, offset + expectedPacketSize)
      const parsed = parsePacket(packet)
      if (parsed) {
        packets.push(packet)
        parsedPackets.push(parsed)
      }
    }
    return {
      packets,
      parsedPackets,
      slotCount: Math.floor(framePayload.length / expectedPacketSize),
      packetSize: expectedPacketSize,
      strategy: 'expected'
    }
  }

  const variablePackets = tryVariableFramePackets(framePayload)
  if (variablePackets.length > 0) {
    return {
      packets: variablePackets,
      parsedPackets: variablePackets.map(packet => parsePacket(packet)).filter(Boolean),
      slotCount: variablePackets.length,
      packetSize: variablePackets[0]?.length ?? null,
      strategy: 'variable'
    }
  }

  const equalChunk = tryEqualChunkFramePackets(framePayload, maxPackets)
  if (equalChunk) {
    return {
      packets: equalChunk.packets,
      parsedPackets: equalChunk.parsedPackets,
      slotCount: equalChunk.slotCount,
      packetSize: equalChunk.packetSize,
      strategy: 'equal'
    }
  }

  return { packets: [], parsedPackets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'none' }
}

export function extractFramePackets(framePayload, expectedPacketSize = null) {
  return probeFramePackets(framePayload, expectedPacketSize).packets
}

export function extractParsedFramePackets(framePayload, expectedPacketSize = null) {
  const probe = probeFramePackets(framePayload, expectedPacketSize)
  return {
    packets: probe.parsedPackets,
    slotCount: probe.slotCount,
    packetSize: probe.packetSize,
    strategy: probe.strategy
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
