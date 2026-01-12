// Packet serialization for QR code transfer protocol
// Packet structure: 16-byte header + payload
// Offset 0:    Version (1 byte)
// Offset 1-4:  File ID (4 bytes)
// Offset 5-8:  K total blocks (4 bytes)
// Offset 9-12: Symbol ID (4 bytes)
// Offset 13-14: Block size (2 bytes)
// Offset 15:   Flags (1 byte)
//              - bit 0: hasMetadata
//              - bits 1-2: mode (00=BW, 01=PCCC, 10=Palette, 11=Spatial)
//              - bits 3-4: spatialPos (0-2 for spatial mode, 0 otherwise)
//              - bits 5-7: reserved

import { PROTOCOL_VERSION, QR_MODE } from './constants.js'

export function createPacket(fileId, k, symbolId, payload, isMetadata = false, blockSize = 200, mode = QR_MODE.BW, spatialPos = 0) {
  const header = new ArrayBuffer(16)
  const view = new DataView(header)

  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint32(1, fileId, false) // big-endian
  view.setUint32(5, k, false)
  view.setUint32(9, symbolId, false)
  view.setUint16(13, blockSize, false)

  // Flags: bit 0 = isMetadata, bits 1-2 = mode, bits 3-4 = spatialPos
  const flags = (isMetadata ? 1 : 0) | ((mode & 0x03) << 1) | ((spatialPos & 0x03) << 3)
  view.setUint8(15, flags)

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

  const flags = view.getUint8(15)

  return {
    fileId: view.getUint32(1, false),
    k: view.getUint32(5, false),
    symbolId: view.getUint32(9, false),
    blockSize: view.getUint16(13, false),
    isMetadata: (flags & 1) === 1,
    mode: (flags >> 1) & 0x03,
    spatialPos: (flags >> 3) & 0x03,
    payload: data.slice(16)
  }
}

// Test packet serialization roundtrip
export function testPacketRoundtrip() {
  const payload = new Uint8Array([1, 2, 3, 4, 5])

  // Test BW mode (default)
  const packet1 = createPacket(0xDEADBEEF, 100, 42, payload, false)
  const parsed1 = parsePacket(packet1)
  const pass1 = parsed1 !== null &&
    parsed1.fileId === 0xDEADBEEF &&
    parsed1.k === 100 &&
    parsed1.symbolId === 42 &&
    parsed1.isMetadata === false &&
    parsed1.mode === QR_MODE.BW &&
    parsed1.payload.length === 5

  // Test PCCC mode with metadata
  const packet2 = createPacket(0x12345678, 200, 1, payload, true, 200, QR_MODE.PCCC)
  const parsed2 = parsePacket(packet2)
  const pass2 = parsed2 !== null &&
    parsed2.isMetadata === true &&
    parsed2.mode === QR_MODE.PCCC

  // Test Palette mode
  const packet3 = createPacket(0xCAFEBABE, 150, 99, payload, false, 300, QR_MODE.PALETTE)
  const parsed3 = parsePacket(packet3)
  const pass3 = parsed3 !== null &&
    parsed3.mode === QR_MODE.PALETTE &&
    parsed3.blockSize === 300

  // Test Spatial mode with position
  const packet4 = createPacket(0xBEEFCAFE, 100, 50, payload, false, 200, QR_MODE.SPATIAL, 2)
  const parsed4 = parsePacket(packet4)
  const pass4 = parsed4 !== null &&
    parsed4.mode === QR_MODE.SPATIAL &&
    parsed4.spatialPos === 2

  const pass = pass1 && pass2 && pass3 && pass4
  console.log('Packet roundtrip test:', pass ? 'PASS' : 'FAIL')
  console.log('  BW mode:', pass1 ? 'PASS' : 'FAIL')
  console.log('  PCCC mode:', pass2 ? 'PASS' : 'FAIL')
  console.log('  Palette mode:', pass3 ? 'PASS' : 'FAIL')
  console.log('  Spatial mode:', pass4 ? 'PASS' : 'FAIL')
  return pass
}
