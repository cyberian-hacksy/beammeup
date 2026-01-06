// LT Fountain Decoder with Belief Propagation
// Decodes fountain-coded symbols back into original file

import { FOUNTAIN_DEGREE } from './constants.js'
import { createPRNG } from './prng.js'
import { parsePacket } from './packet.js'
import { parseMetadataPayload } from './metadata.js'

export function createDecoder() {
  let fileId = null
  let k = null
  let metadata = null
  let decodedBlocks = null
  let solved = 0
  let receivedSymbols = new Set()
  let pendingSymbols = [] // { indices: [], payload: Uint8Array }

  function reduce(symbol) {
    // Remove known blocks from symbol
    const remaining = []
    let payload = new Uint8Array(symbol.payload)

    for (const idx of symbol.indices) {
      if (decodedBlocks[idx]) {
        // XOR out known block
        const known = decodedBlocks[idx]
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= known[i]
        }
      } else {
        remaining.push(idx)
      }
    }

    return { indices: remaining, payload }
  }

  function propagate() {
    let changed = true
    while (changed) {
      changed = false

      for (let i = pendingSymbols.length - 1; i >= 0; i--) {
        const sym = pendingSymbols[i]
        const reduced = reduce(sym)

        if (reduced.indices.length === 0) {
          // Fully reduced, discard
          pendingSymbols.splice(i, 1)
          changed = true
        } else if (reduced.indices.length === 1) {
          // Degree 1 - decode!
          const idx = reduced.indices[0]
          decodedBlocks[idx] = reduced.payload
          solved++
          pendingSymbols.splice(i, 1)
          changed = true
        } else {
          // Update with reduced form
          pendingSymbols[i] = reduced
        }
      }
    }
  }

  return {
    get fileId() { return fileId },
    get k() { return k },
    get metadata() { return metadata },
    get solved() { return solved },
    get uniqueSymbols() { return receivedSymbols.size },
    get progress() { return k ? solved / k : 0 },

    isComplete() { return k !== null && solved === k },

    receive(packet) {
      const parsed = parsePacket(packet)
      if (!parsed) return false

      // First packet sets session
      if (fileId === null) {
        fileId = parsed.fileId
        k = parsed.k
        decodedBlocks = new Array(k).fill(null)
      } else if (parsed.fileId !== fileId) {
        console.warn('FileId mismatch, ignoring')
        return false
      }

      // Track unique symbols
      if (receivedSymbols.has(parsed.symbolId)) {
        return false // Duplicate
      }
      receivedSymbols.add(parsed.symbolId)

      // Handle metadata
      if (parsed.isMetadata || parsed.symbolId === 0) {
        if (!metadata) {
          metadata = parseMetadataPayload(parsed.payload)
        }
        return true
      }

      // Reconstruct indices using same PRNG seed
      const seed = (fileId ^ parsed.symbolId) >>> 0
      const rng = createPRNG(seed)
      const degree = Math.min(FOUNTAIN_DEGREE, k)
      const indices = rng.pickUnique(degree, k)

      // Add to pending and propagate
      pendingSymbols.push({ indices, payload: new Uint8Array(parsed.payload) })
      propagate()

      return true
    },

    reconstruct() {
      if (!this.isComplete()) return null

      // Concatenate all blocks and trim to original size
      const result = new Uint8Array(metadata.fileSize)
      for (let i = 0; i < k; i++) {
        const block = decodedBlocks[i]
        const start = i * 200 // BLOCK_SIZE
        const end = Math.min(start + 200, metadata.fileSize)
        result.set(block.slice(0, end - start), start)
      }

      return result
    },

    async verify() {
      const data = this.reconstruct()
      if (!data) return false

      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))

      // Compare hashes
      if (hash.length !== metadata.hash.length) return false
      for (let i = 0; i < hash.length; i++) {
        if (hash[i] !== metadata.hash[i]) return false
      }
      return true
    }
  }
}

// Test full codec roundtrip
export async function testCodecRoundtrip() {
  // Import encoder dynamically to avoid circular dependency
  const { createEncoder } = await import('./encoder.js')

  // Create test file with known content
  const originalData = new Uint8Array(450) // Just over 2 blocks
  for (let i = 0; i < originalData.length; i++) {
    originalData[i] = (i * 7 + 13) % 256
  }

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const encoder = createEncoder(originalData.buffer, 'roundtrip.bin', 'application/octet-stream', hash)
  const decoder = createDecoder()

  console.log('Codec test: k=' + encoder.k + ', generating symbols...')

  // Generate ~1.5x symbols (with some randomness in order)
  const symbolCount = Math.ceil(encoder.k * 1.5)
  const symbolIds = [0] // Start with metadata
  for (let i = 1; i <= symbolCount; i++) {
    symbolIds.push(i)
  }

  // Feed symbols to decoder
  for (const id of symbolIds) {
    const packet = encoder.generateSymbol(id)
    decoder.receive(packet)

    if (decoder.isComplete()) {
      console.log('Decoded after ' + decoder.uniqueSymbols + ' symbols (k=' + encoder.k + ')')
      break
    }
  }

  if (!decoder.isComplete()) {
    console.log('Codec roundtrip test: FAIL - incomplete after', decoder.uniqueSymbols, 'symbols')
    return false
  }

  const verified = await decoder.verify()
  const reconstructed = decoder.reconstruct()

  // Compare data
  let dataMatch = reconstructed.length === originalData.length
  if (dataMatch) {
    for (let i = 0; i < originalData.length; i++) {
      if (reconstructed[i] !== originalData[i]) {
        dataMatch = false
        break
      }
    }
  }

  const pass = verified && dataMatch
  console.log('Codec roundtrip test:', pass ? 'PASS' : 'FAIL', {
    verified: verified,
    dataMatch: dataMatch,
    k: encoder.k,
    symbolsNeeded: decoder.uniqueSymbols
  })

  return pass
}
