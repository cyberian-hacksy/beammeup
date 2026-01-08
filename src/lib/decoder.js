// LT Fountain Decoder with Belief Propagation and Raptor-Lite Parity Recovery
// Decodes fountain-coded symbols back into original file

import { FOUNTAIN_DEGREE, DEGREE_ONE_PROBABILITY } from './constants.js'
import { createPRNG } from './prng.js'
import { parsePacket } from './packet.js'
import { parseMetadataPayload } from './metadata.js'
import { calculateParityParams, generateParityMap } from './precode.js'

export function createDecoder() {
  let fileId = null
  let K = null          // Source block count
  let K_prime = null    // Intermediate block count (K + parity)
  let G = null          // Group size for parity
  let parityMap = null  // Parity relationships
  let metadata = null
  let blockSize = 200   // Block size from packet header
  let decodedBlocks = null
  let solved = 0        // Total intermediate blocks decoded
  let solvedSource = 0  // Source blocks decoded (first K blocks)
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
          if (!decodedBlocks[idx]) {
            decodedBlocks[idx] = reduced.payload
            solved++
            // Track source blocks separately (only if K is known)
            if (K !== null && idx < K) {
              solvedSource++
            }
          }
          pendingSymbols.splice(i, 1)
          changed = true
        } else {
          // Update with reduced form
          pendingSymbols[i] = reduced
        }
      }
    }
  }

  // Parity recovery phase - try to recover missing blocks using parity relationships
  function parityRecovery() {
    if (!parityMap || !K) return 0

    let totalRecovered = 0
    let progress = true

    while (progress) {
      progress = false

      for (let p = 0; p < parityMap.length; p++) {
        const parityIdx = K + p
        const sourceIndices = parityMap[p]

        // Skip if parity block itself is not decoded
        if (!decodedBlocks[parityIdx]) {
          continue
        }

        // Count unknowns among source blocks in this parity relationship
        const unknowns = sourceIndices.filter(i => !decodedBlocks[i])

        if (unknowns.length === 1) {
          // Can recover the one unknown
          const missingIdx = unknowns[0]

          // Start with parity block
          const recovered = new Uint8Array(decodedBlocks[parityIdx])

          // XOR out all known source blocks
          for (const idx of sourceIndices) {
            if (idx !== missingIdx && decodedBlocks[idx]) {
              for (let i = 0; i < recovered.length; i++) {
                recovered[i] ^= decodedBlocks[idx][i]
              }
            }
          }

          decodedBlocks[missingIdx] = recovered
          solved++
          solvedSource++
          totalRecovered++
          progress = true
        }
      }

      // Re-run LT propagation after each parity pass
      if (progress) {
        propagate()
      }
    }

    return totalRecovered
  }

  return {
    get fileId() { return fileId },
    get k() { return K },        // Source block count (for compatibility)
    get K() { return K },        // Source block count
    get K_prime() { return K_prime },  // Intermediate block count
    get metadata() { return metadata },
    get solved() { return solvedSource },  // Report source blocks solved
    get solvedTotal() { return solved },   // All intermediate blocks solved
    get uniqueSymbols() { return receivedSymbols.size },
    get progress() { return K ? solvedSource / K : 0 },

    isComplete() { return K !== null && solvedSource === K },

    // Reset decoder state for a new session
    reset() {
      fileId = null
      K = null
      K_prime = null
      G = null
      parityMap = null
      metadata = null
      blockSize = 200
      decodedBlocks = null
      solved = 0
      solvedSource = 0
      receivedSymbols = new Set()
      pendingSymbols = []
    },

    receive(packet) {
      const parsed = parsePacket(packet)
      if (!parsed) return false

      // First packet sets session
      if (fileId === null) {
        fileId = parsed.fileId
        K_prime = parsed.k  // Packet contains K' (intermediate block count)
        blockSize = parsed.blockSize  // Store block size from packet
        decodedBlocks = new Array(K_prime).fill(null)
      } else if (parsed.fileId !== fileId) {
        // New session detected - return special value so receiver can reset
        return 'new_session'
      }

      // Track unique symbols
      if (receivedSymbols.has(parsed.symbolId)) {
        return false // Duplicate
      }
      receivedSymbols.add(parsed.symbolId)

      // Handle metadata - extract K and set up parity
      if (parsed.isMetadata || parsed.symbolId === 0) {
        if (!metadata) {
          metadata = parseMetadataPayload(parsed.payload)
          // Extract K from metadata and set up parity parameters
          K = metadata.K
          const params = calculateParityParams(K)
          G = params.G
          parityMap = generateParityMap(K, G)
          // K_prime is K + actual parity count (may differ from estimate)
          const newK_prime = K + parityMap.length

          // Resize array if needed, preserve existing decoded blocks
          if (K_prime !== newK_prime) {
            const oldBlocks = decodedBlocks || []
            K_prime = newK_prime
            decodedBlocks = new Array(K_prime).fill(null)
            // Copy over any previously decoded blocks
            for (let i = 0; i < Math.min(oldBlocks.length, K_prime); i++) {
              if (oldBlocks[i]) {
                decodedBlocks[i] = oldBlocks[i]
              }
            }
          }

          // Recount solved blocks now that K is known
          solved = 0
          solvedSource = 0
          for (let i = 0; i < K_prime; i++) {
            if (decodedBlocks[i]) {
              solved++
              if (i < K) solvedSource++
            }
          }
        }
        return true
      }

      // Reconstruct indices using same logic as encoder
      const seed = (fileId ^ parsed.symbolId) >>> 0
      const rng = createPRNG(seed)

      // Match encoder's systematic/fountain logic (using K_prime)
      let degree, indices
      if (parsed.symbolId <= K_prime) {
        // Systematic symbol: just one intermediate block
        degree = 1
        indices = [(parsed.symbolId - 1) % K_prime]
      } else {
        // Fountain-coded symbol
        const degreeRoll = rng.next() / 0xFFFFFFFF
        if (degreeRoll < DEGREE_ONE_PROBABILITY) {
          degree = 1
          indices = [rng.next() % K_prime]
        } else {
          degree = Math.min(FOUNTAIN_DEGREE, Math.max(1, K_prime - 1))
          indices = rng.pickUnique(degree, K_prime)
        }
      }

      // Add to pending and propagate
      pendingSymbols.push({ indices, payload: new Uint8Array(parsed.payload) })
      propagate()

      // Try parity recovery after each symbol if we have metadata
      if (!this.isComplete() && parityMap) {
        parityRecovery()
      }

      return true
    },

    reconstruct() {
      if (!this.isComplete()) return null

      // Concatenate source blocks (first K) and trim to original size
      const result = new Uint8Array(metadata.fileSize)
      for (let i = 0; i < K; i++) {
        const block = decodedBlocks[i]
        const start = i * blockSize
        const end = Math.min(start + blockSize, metadata.fileSize)
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

// Test full codec roundtrip with Raptor-Lite pre-coding
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

  console.log('Codec test: K=' + encoder.K + ', K_prime=' + encoder.K_prime + ', generating symbols...')

  // Generate ~1.2x K_prime symbols (should be enough with parity recovery)
  const symbolCount = Math.ceil(encoder.K_prime * 1.2)
  const symbolIds = [0] // Start with metadata
  for (let i = 1; i <= symbolCount; i++) {
    symbolIds.push(i)
  }

  // Feed symbols to decoder
  for (const id of symbolIds) {
    const packet = encoder.generateSymbol(id)
    decoder.receive(packet)

    if (decoder.isComplete()) {
      console.log('Decoded after ' + decoder.uniqueSymbols + ' symbols (K=' + encoder.K + ', K_prime=' + encoder.K_prime + ')')
      break
    }
  }

  if (!decoder.isComplete()) {
    console.log('Codec roundtrip test: FAIL - incomplete after', decoder.uniqueSymbols, 'symbols')
    console.log('  Solved:', decoder.solved, '/', encoder.K, 'source blocks')
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
    K: encoder.K,
    K_prime: encoder.K_prime,
    symbolsNeeded: decoder.uniqueSymbols
  })

  return pass
}
