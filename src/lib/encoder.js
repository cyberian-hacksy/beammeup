// LT Fountain Encoder with Raptor-Lite Pre-coding
// Encodes file data into a stream of fountain-coded symbols

import { BLOCK_SIZE, FOUNTAIN_DEGREE, DEGREE_ONE_PROBABILITY } from './constants.js'
import { createPRNG } from './prng.js'
import { createPacket } from './packet.js'
import { createMetadataPayload } from './metadata.js'
import { calculateParityParams, generateParityMap, generateParityBlocks } from './precode.js'

export function createEncoder(fileData, filename, mimeType, hash) {
  // Pad file to multiple of BLOCK_SIZE
  const paddedSize = Math.ceil(fileData.byteLength / BLOCK_SIZE) * BLOCK_SIZE
  const paddedData = new Uint8Array(paddedSize)
  paddedData.set(new Uint8Array(fileData))

  const K = paddedSize / BLOCK_SIZE // Source block count
  const fileId = (Math.random() * 0xFFFFFFFF) >>> 0
  const originalSize = fileData.byteLength

  // Split into source blocks
  const sourceBlocks = []
  for (let i = 0; i < K; i++) {
    sourceBlocks.push(paddedData.slice(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE))
  }

  // Generate Raptor-Lite parity blocks
  const { G, M, K_prime } = calculateParityParams(K)
  const parityMap = generateParityMap(K, G)
  const parityBlocks = generateParityBlocks(sourceBlocks, parityMap)

  // Combine source and parity blocks into intermediate blocks
  const intermediateBlocks = [...sourceBlocks, ...parityBlocks]

  // Create metadata payload and pad to BLOCK_SIZE for consistent QR density
  // Include K so receiver can derive parity parameters
  const rawMetadata = createMetadataPayload(filename, mimeType, originalSize, hash, K)
  const metadataPayload = new Uint8Array(BLOCK_SIZE)
  metadataPayload.set(rawMetadata)

  return {
    fileId,
    k: K,           // Source block count (for compatibility)
    K,              // Source block count
    K_prime,        // Total intermediate block count (K + parity)
    M,              // Parity block count
    originalSize,

    // Generate symbol by ID
    generateSymbol(symbolId) {
      if (symbolId === 0) {
        // Metadata frame (padded to BLOCK_SIZE)
        return createPacket(fileId, K_prime, 0, metadataPayload, true)
      }

      // Seed PRNG with fileId XOR symbolId
      const seed = (fileId ^ symbolId) >>> 0
      const rng = createPRNG(seed)

      // Symbol IDs 1 to K_prime are "systematic" (degree-1, one block each)
      // Symbol IDs > K_prime use fountain coding
      let degree, indices
      if (symbolId <= K_prime) {
        // Systematic symbol: just one intermediate block
        degree = 1
        indices = [(symbolId - 1) % K_prime]
      } else {
        // Fountain-coded symbol: mix of degree-1 and degree-3
        // Use PRNG's first value to decide degree (deterministic per symbol)
        const degreeRoll = rng.next() / 0xFFFFFFFF
        if (degreeRoll < DEGREE_ONE_PROBABILITY) {
          // Degree-1: single random block (helps complete missing blocks faster)
          degree = 1
          indices = [rng.next() % K_prime]
        } else {
          // Degree-3: XOR of multiple blocks, but never all
          degree = Math.min(FOUNTAIN_DEGREE, Math.max(1, K_prime - 1))
          indices = rng.pickUnique(degree, K_prime)
        }
      }

      // XOR selected intermediate blocks
      const payload = new Uint8Array(BLOCK_SIZE)
      for (const idx of indices) {
        for (let i = 0; i < BLOCK_SIZE; i++) {
          payload[i] ^= intermediateBlocks[idx][i]
        }
      }

      return createPacket(fileId, K_prime, symbolId, payload, false)
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
