// Metadata frame encoding/decoding
// Metadata frame payload:
// - Filename length (1 byte) + filename (UTF-8)
// - MIME type length (1 byte) + MIME type
// - Original file size (4 bytes)
// - SHA-256 hash (32 bytes)
// - Source block count K (4 bytes) - for Raptor-Lite parity derivation
// - Mode (1 byte) - QR mode (0=BW, 1=PCCC, 2=Palette)

import { QR_MODE } from './constants.js'

export function createMetadataPayload(filename, mimeType, fileSize, hash, K, mode = QR_MODE.BW) {
  const encoder = new TextEncoder()
  const filenameBytes = encoder.encode(filename.slice(0, 255))
  const mimeBytes = encoder.encode(mimeType.slice(0, 255))

  const payload = new Uint8Array(1 + filenameBytes.length + 1 + mimeBytes.length + 4 + 32 + 4 + 1)
  let offset = 0

  payload[offset++] = filenameBytes.length
  payload.set(filenameBytes, offset)
  offset += filenameBytes.length

  payload[offset++] = mimeBytes.length
  payload.set(mimeBytes, offset)
  offset += mimeBytes.length

  new DataView(payload.buffer).setUint32(offset, fileSize, false)
  offset += 4

  payload.set(hash, offset)
  offset += 32

  new DataView(payload.buffer).setUint32(offset, K, false)
  offset += 4

  payload[offset] = mode & 0x03

  return payload
}

export function parseMetadataPayload(payload) {
  const decoder = new TextDecoder()
  let offset = 0

  const filenameLen = payload[offset++]
  const filename = decoder.decode(payload.slice(offset, offset + filenameLen))
  offset += filenameLen

  const mimeLen = payload[offset++]
  const mimeType = decoder.decode(payload.slice(offset, offset + mimeLen))
  offset += mimeLen

  const fileSize = new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(0, false)
  offset += 4

  const hash = payload.slice(offset, offset + 32)
  offset += 32

  const K = new DataView(payload.buffer, payload.byteOffset + offset, 4).getUint32(0, false)
  offset += 4

  // Mode is optional for backwards compatibility with old metadata frames
  const mode = offset < payload.length ? (payload[offset] & 0x03) : QR_MODE.BW

  return { filename, mimeType, fileSize, hash, K, mode }
}

// Test metadata roundtrip
export function testMetadataRoundtrip() {
  const hash = new Uint8Array(32)
  hash.fill(0xAB)

  // Test BW mode (default)
  const payload1 = createMetadataPayload('test.pdf', 'application/pdf', 12345, hash, 500)
  const parsed1 = parseMetadataPayload(payload1)
  const pass1 = parsed1.filename === 'test.pdf' &&
    parsed1.mimeType === 'application/pdf' &&
    parsed1.fileSize === 12345 &&
    parsed1.hash.length === 32 &&
    parsed1.K === 500 &&
    parsed1.mode === QR_MODE.BW

  // Test PCCC mode
  const payload2 = createMetadataPayload('image.png', 'image/png', 54321, hash, 250, QR_MODE.PCCC)
  const parsed2 = parseMetadataPayload(payload2)
  const pass2 = parsed2.mode === QR_MODE.PCCC &&
    parsed2.filename === 'image.png'

  // Test Palette mode
  const payload3 = createMetadataPayload('doc.txt', 'text/plain', 1000, hash, 100, QR_MODE.PALETTE)
  const parsed3 = parseMetadataPayload(payload3)
  const pass3 = parsed3.mode === QR_MODE.PALETTE

  const pass = pass1 && pass2 && pass3
  console.log('Metadata roundtrip test:', pass ? 'PASS' : 'FAIL')
  console.log('  BW mode:', pass1 ? 'PASS' : 'FAIL')
  console.log('  PCCC mode:', pass2 ? 'PASS' : 'FAIL')
  console.log('  Palette mode:', pass3 ? 'PASS' : 'FAIL')
  return pass
}
