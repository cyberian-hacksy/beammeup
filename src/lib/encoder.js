// LT Fountain Encoder
// Encodes file data into a stream of fountain-coded symbols

import { BLOCK_SIZE, FOUNTAIN_DEGREE, DEGREE_ONE_PROBABILITY } from './constants.js'
import { createPRNG } from './prng.js'
import { createPacket } from './packet.js'
import { createMetadataPayload } from './metadata.js'

export function createEncoder(fileData, filename, mimeType, hash) {
  // Pad file to multiple of BLOCK_SIZE
  const paddedSize = Math.ceil(fileData.byteLength / BLOCK_SIZE) * BLOCK_SIZE
  const paddedData = new Uint8Array(paddedSize)
  paddedData.set(new Uint8Array(fileData))

  const k = paddedSize / BLOCK_SIZE
  const fileId = (Math.random() * 0xFFFFFFFF) >>> 0
  const originalSize = fileData.byteLength

  // Split into source blocks
  const sourceBlocks = []
  for (let i = 0; i < k; i++) {
    sourceBlocks.push(paddedData.slice(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE))
  }

  // Create metadata payload and pad to BLOCK_SIZE for consistent QR density
  const rawMetadata = createMetadataPayload(filename, mimeType, originalSize, hash)
  const metadataPayload = new Uint8Array(BLOCK_SIZE)
  metadataPayload.set(rawMetadata)

  return {
    fileId,
    k,
    originalSize,

    // Generate symbol by ID
    generateSymbol(symbolId) {
      if (symbolId === 0) {
        // Metadata frame (padded to BLOCK_SIZE)
        return createPacket(fileId, k, 0, metadataPayload, true)
      }

      // Seed PRNG with fileId XOR symbolId
      const seed = (fileId ^ symbolId) >>> 0
      const rng = createPRNG(seed)

      // For small k, we need degree-1 symbols to bootstrap decoding
      // Symbol IDs 1 to k are "systematic" (degree-1, one block each)
      // Symbol IDs > k use fountain coding with degree capped at k-1
      let degree, indices
      if (symbolId <= k) {
        // Systematic symbol: just one block
        degree = 1
        indices = [(symbolId - 1) % k]
      } else {
        // Fountain-coded symbol: mix of degree-1 and degree-3
        // Use PRNG's first value to decide degree (deterministic per symbol)
        const degreeRoll = rng.next() / 0xFFFFFFFF
        if (degreeRoll < DEGREE_ONE_PROBABILITY) {
          // Degree-1: single random block (helps complete missing blocks faster)
          degree = 1
          indices = [rng.next() % k]
        } else {
          // Degree-3: XOR of multiple blocks, but never all
          degree = Math.min(FOUNTAIN_DEGREE, Math.max(1, k - 1))
          indices = rng.pickUnique(degree, k)
        }
      }

      // XOR selected blocks
      const payload = new Uint8Array(BLOCK_SIZE)
      for (const idx of indices) {
        for (let i = 0; i < BLOCK_SIZE; i++) {
          payload[i] ^= sourceBlocks[idx][i]
        }
      }

      return createPacket(fileId, k, symbolId, payload, false)
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

  const pass = meta.isMetadata === true &&
    meta.payload.length === BLOCK_SIZE && // Metadata now padded to BLOCK_SIZE
    data.isMetadata === false &&
    data.payload.length === BLOCK_SIZE &&
    encoder.k === 3 // 500 bytes / 200 = 3 blocks

  console.log('Encoder test:', pass ? 'PASS' : 'FAIL', { k: encoder.k, fileId: encoder.fileId })
  return pass
}
