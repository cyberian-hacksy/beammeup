// Metadata frame encoding/decoding
// Metadata frame payload:
// - Filename length (1 byte) + filename (UTF-8)
// - MIME type length (1 byte) + MIME type
// - Original file size (4 bytes)
// - SHA-256 hash (32 bytes)
// - Source block count K (4 bytes) - for Raptor-Lite parity derivation

export function createMetadataPayload(filename, mimeType, fileSize, hash, K) {
  const encoder = new TextEncoder()
  const filenameBytes = encoder.encode(filename.slice(0, 255))
  const mimeBytes = encoder.encode(mimeType.slice(0, 255))

  const payload = new Uint8Array(1 + filenameBytes.length + 1 + mimeBytes.length + 4 + 32 + 4)
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

  return { filename, mimeType, fileSize, hash, K }
}

// Test metadata roundtrip
export function testMetadataRoundtrip() {
  const hash = new Uint8Array(32)
  hash.fill(0xAB)

  const payload = createMetadataPayload('test.pdf', 'application/pdf', 12345, hash, 500)
  const parsed = parseMetadataPayload(payload)

  const pass = parsed.filename === 'test.pdf' &&
    parsed.mimeType === 'application/pdf' &&
    parsed.fileSize === 12345 &&
    parsed.hash.length === 32 &&
    parsed.K === 500

  console.log('Metadata roundtrip test:', pass ? 'PASS' : 'FAIL', parsed)
  return pass
}
