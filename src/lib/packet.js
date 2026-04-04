// Packet serialization for QR code transfer protocol
// Packet structure: 15-byte header + payload
// Offset 0:    Version/flags (1 byte)
//              - bit 0: hasMetadata
//              - bits 1-2: mode (00=BW, 01=PCCC, 10=Palette)
//              - bits 3-7: protocol version
// Offset 1-4:  File ID (4 bytes)
// Offset 5-7:  K' total intermediate blocks (24-bit big-endian)
// Offset 8-10: Symbol ID (24-bit big-endian)
// Offset 11-14: CRC32 of payload (4 bytes)
//
// Block size is inferred from packet.length - PACKET_HEADER_SIZE, which removes
// redundant per-packet bytes without affecting fixed-size HDMI-UVC batching.

import { PROTOCOL_VERSION, QR_MODE } from './constants.js'
import { crc32 } from './hdmi-uvc/crc32.js'

export const PACKET_HEADER_SIZE = 15

function writeUint24(view, offset, value) {
  view.setUint8(offset, (value >>> 16) & 0xFF)
  view.setUint8(offset + 1, (value >>> 8) & 0xFF)
  view.setUint8(offset + 2, value & 0xFF)
}

function readUint24(view, offset) {
  return (
    (view.getUint8(offset) << 16) |
    (view.getUint8(offset + 1) << 8) |
    view.getUint8(offset + 2)
  ) >>> 0
}

export function createPacket(fileId, k, symbolId, payload, isMetadata = false, blockSize = 200, mode = QR_MODE.BW) {
  if (payload.length !== blockSize) {
    throw new Error(`Packet payload length ${payload.length} does not match block size ${blockSize}`)
  }
  if (k > 0xFFFFFF || symbolId > 0xFFFFFF) {
    throw new Error(`Packet fields exceed compact header capacity (k=${k}, symbolId=${symbolId})`)
  }

  const header = new ArrayBuffer(PACKET_HEADER_SIZE)
  const view = new DataView(header)

  const versionAndFlags = ((PROTOCOL_VERSION & 0x1F) << 3) | (isMetadata ? 1 : 0) | ((mode & 0x03) << 1)
  view.setUint8(0, versionAndFlags)
  view.setUint32(1, fileId, false) // big-endian
  writeUint24(view, 5, k)
  writeUint24(view, 8, symbolId)
  view.setUint32(11, crc32(payload), false)

  // Combine header and payload
  const packet = new Uint8Array(PACKET_HEADER_SIZE + payload.length)
  packet.set(new Uint8Array(header), 0)
  packet.set(payload, PACKET_HEADER_SIZE)

  return packet
}

export function parsePacket(data) {
  if (data.length < PACKET_HEADER_SIZE) return null

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const versionAndFlags = view.getUint8(0)
  const version = versionAndFlags >> 3

  if (version !== PROTOCOL_VERSION) {
    return null
  }

  const flags = versionAndFlags & 0x07
  const payload = data.slice(PACKET_HEADER_SIZE)
  const blockSize = payload.length
  if (blockSize < 1) return null

  const payloadCrc = view.getUint32(11, false)
  if (crc32(payload) !== payloadCrc) return null

  return {
    fileId: view.getUint32(1, false),
    k: readUint24(view, 5),
    symbolId: readUint24(view, 8),
    blockSize,
    isMetadata: (flags & 1) === 1,
    mode: (flags >> 1) & 0x03,
    payloadCrc,
    payload
  }
}

// Test packet serialization roundtrip
export function testPacketRoundtrip() {
  const payload = new Uint8Array([1, 2, 3, 4, 5])
  const blockSize = payload.length

  // Test BW mode (default)
  const packet1 = createPacket(0xDEADBEEF, 100, 42, payload, false, blockSize)
  const parsed1 = parsePacket(packet1)
  const pass1 = parsed1 !== null &&
    parsed1.fileId === 0xDEADBEEF &&
    parsed1.k === 100 &&
    parsed1.symbolId === 42 &&
    parsed1.isMetadata === false &&
    parsed1.mode === QR_MODE.BW &&
    parsed1.payload.length === blockSize

  // Test PCCC mode with metadata
  const packet2 = createPacket(0x12345678, 200, 1, payload, true, blockSize, QR_MODE.PCCC)
  const parsed2 = parsePacket(packet2)
  const pass2 = parsed2 !== null &&
    parsed2.isMetadata === true &&
    parsed2.mode === QR_MODE.PCCC &&
    parsed2.blockSize === blockSize

  // Test Palette mode
  const packet3 = createPacket(0xCAFEBABE, 150, 99, payload, false, blockSize, QR_MODE.PALETTE)
  const parsed3 = parsePacket(packet3)
  const pass3 = parsed3 !== null &&
    parsed3.mode === QR_MODE.PALETTE &&
    parsed3.blockSize === blockSize

  const pass = pass1 && pass2 && pass3
  console.log('Packet roundtrip test:', pass ? 'PASS' : 'FAIL')
  console.log('  BW mode:', pass1 ? 'PASS' : 'FAIL')
  console.log('  PCCC mode:', pass2 ? 'PASS' : 'FAIL')
  console.log('  Palette mode:', pass3 ? 'PASS' : 'FAIL')
  return pass
}
