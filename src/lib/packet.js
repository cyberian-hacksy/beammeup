// Packet serialization for QR code transfer protocol
// Packet structure: 16-byte header + payload
// Offset 0:    Version (1 byte)
// Offset 1-4:  File ID (4 bytes)
// Offset 5-8:  K total blocks (4 bytes)
// Offset 9-12: Symbol ID (4 bytes)
// Offset 13-14: Block size (2 bytes)
// Offset 15:   Flags (1 byte) - bit0 = hasMetadata

import { PROTOCOL_VERSION, BLOCK_SIZE } from './constants.js'

export function createPacket(fileId, k, symbolId, payload, isMetadata = false) {
  const header = new ArrayBuffer(16)
  const view = new DataView(header)

  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint32(1, fileId, false) // big-endian
  view.setUint32(5, k, false)
  view.setUint32(9, symbolId, false)
  view.setUint16(13, BLOCK_SIZE, false)
  view.setUint8(15, isMetadata ? 1 : 0)

  // Combine header and payload
  const packet = new Uint8Array(16 + payload.length)
  packet.set(new Uint8Array(header), 0)
  packet.set(payload, 16)

  return packet
}

export function parsePacket(data) {
  if (data.length < 16) return null

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const version = view.getUint8(0)

  if (version !== PROTOCOL_VERSION) {
    console.warn('Unknown protocol version:', version)
    return null
  }

  return {
    fileId: view.getUint32(1, false),
    k: view.getUint32(5, false),
    symbolId: view.getUint32(9, false),
    blockSize: view.getUint16(13, false),
    isMetadata: (view.getUint8(15) & 1) === 1,
    payload: data.slice(16)
  }
}

// Test packet serialization roundtrip
export function testPacketRoundtrip() {
  const payload = new Uint8Array([1, 2, 3, 4, 5])
  const packet = createPacket(0xDEADBEEF, 100, 42, payload, false)
  const parsed = parsePacket(packet)

  const pass = parsed !== null &&
    parsed.fileId === 0xDEADBEEF &&
    parsed.k === 100 &&
    parsed.symbolId === 42 &&
    parsed.isMetadata === false &&
    parsed.payload.length === 5

  console.log('Packet roundtrip test:', pass ? 'PASS' : 'FAIL', parsed)
  return pass
}
