// LT Fountain Encoder with Raptor-Lite Pre-coding
// Encodes file data into a stream of fountain-coded symbols

import { QR_MODE } from './constants.js'
import { deriveSymbolIndices } from './fountain-symbol.js'
import { createPacket } from './packet.js'
import { createMetadataPayload } from './metadata.js'
import { calculateParityParams, generateParityMap, generateParityBlocks } from './precode.js'

export function createEncoder(fileData, filename, mimeType, hash, blockSize = 200, mode = QR_MODE.BW) {
  // Pad file to multiple of blockSize
  const paddedSize = Math.ceil(fileData.byteLength / blockSize) * blockSize
  const paddedData = new Uint8Array(paddedSize)
  paddedData.set(new Uint8Array(fileData))

  const K = paddedSize / blockSize // Source block count
  const fileId = (Math.random() * 0xFFFFFFFF) >>> 0
  const originalSize = fileData.byteLength

  // Split into source blocks
  const sourceBlocks = []
  for (let i = 0; i < K; i++) {
    sourceBlocks.push(paddedData.slice(i * blockSize, (i + 1) * blockSize))
  }

  // Generate Raptor-Lite parity blocks
  const { G } = calculateParityParams(K)
  const parityMap = generateParityMap(K, G)
  const parityBlocks = generateParityBlocks(sourceBlocks, parityMap)

  // Combine source and parity blocks into intermediate blocks
  // Use actual parity count (may differ from estimate due to edge cases)
  const M = parityBlocks.length
  const K_prime = K + M
  const intermediateBlocks = [...sourceBlocks, ...parityBlocks]

  // Create metadata payload and pad to blockSize for consistent QR density
  // Include K so receiver can derive parity parameters, and mode for redundancy
  const rawMetadata = createMetadataPayload(filename, mimeType, originalSize, hash, K, mode)
  const metadataPayload = new Uint8Array(blockSize)
  metadataPayload.set(rawMetadata)

  return {
    fileId,
    k: K,           // Source block count (for compatibility)
    K,              // Source block count
    K_prime,        // Total intermediate block count (K + parity)
    M,              // Parity block count
    originalSize,
    mode,           // QR mode (BW, PCCC, or Palette)

    // Generate symbol by ID
    generateSymbol(symbolId) {
      if (symbolId === 0) {
        // Metadata frame (padded to BLOCK_SIZE)
        return createPacket(fileId, K_prime, 0, metadataPayload, true, blockSize, mode)
      }

      // Symbol id → intermediate-block indices. Shared with the decoder
      // (fountain-symbol.js) so the two derivations can never drift.
      const indices = deriveSymbolIndices(fileId, symbolId, K_prime)

      // XOR selected intermediate blocks
      const payload = new Uint8Array(blockSize)
      for (const idx of indices) {
        for (let i = 0; i < blockSize; i++) {
          payload[i] ^= intermediateBlocks[idx][i]
        }
      }

      return createPacket(fileId, K_prime, symbolId, payload, false, blockSize, mode)
    }
  }
}

// Test encoder
export async function testEncoder() {
  // Create test file
  const testData = new Uint8Array(500)
  for (let i = 0; i < 500; i++) testData[i] = i % 256

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', testData))
  const encoder = createEncoder(testData.buffer, 'test.bin', 'application/octet-stream', hash)

  // Import parsePacket dynamically to avoid circular dependency in test
  const { parsePacket } = await import('./packet.js')
  const { BLOCK_SIZE } = await import('./constants.js')

  const metaPacket = encoder.generateSymbol(0)
  const dataPacket = encoder.generateSymbol(1)

  const meta = parsePacket(metaPacket)
  const data = parsePacket(dataPacket)

  // K=3 (500 bytes / 200), K_prime = 3 + 3*ceil(sqrt(3)) = 3 + 6 = 9
  const pass = meta.isMetadata === true &&
    meta.payload.length === BLOCK_SIZE &&
    data.isMetadata === false &&
    data.payload.length === BLOCK_SIZE &&
    encoder.K === 3 &&
    encoder.K_prime > encoder.K // Has parity blocks

  console.log('Encoder test:', pass ? 'PASS' : 'FAIL', {
    K: encoder.K,
    K_prime: encoder.K_prime,
    M: encoder.M,
    fileId: encoder.fileId
  })
  return pass
}
