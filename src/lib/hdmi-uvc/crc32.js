// CRC32 implementation for frame integrity checking

// Pre-computed CRC32 table (IEEE polynomial)
const CRC_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
  }
  CRC_TABLE[i] = c
}

export function crc32(data) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// Test CRC32
export function testCrc32() {
  const testData = new TextEncoder().encode('123456789')
  const expected = 0xCBF43926 // Known CRC32 of "123456789"
  const result = crc32(testData)
  const pass = result === expected
  console.log('CRC32 test:', pass ? 'PASS' : 'FAIL', { expected, result })
  return pass
}
