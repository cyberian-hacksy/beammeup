// LT Fountain Decoder with Belief Propagation and Raptor-Lite Parity Recovery
// Decodes fountain-coded symbols back into original file

import { FOUNTAIN_DEGREE, DEGREE_ONE_PROBABILITY } from './constants.js'
import { createPRNG } from './prng.js'
import { parsePacket } from './packet.js'
import { parseMetadataPayload } from './metadata.js'
import { calculateParityParams, generateParityMap } from './precode.js'
import { solveGF2 } from './gf2-solver.js'

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
  let paritySweepComplete = false          // True once the full parity-symbol-id sweep (K+1..K_prime) has been received (latches)
  let uniqueParitySymbolsSeen = 0          // Count of distinct parity symbolIds received (K < symbolId <= K_prime)
  let parityNoProgressSweeps = 0           // Count of parityRecovery() calls that swept the full map without recovering anything
  let stallFramesSinceLastSolve = 0        // Frames signalled via noteFrameBoundary() since last source solve
  let tailSolveTriggerCount = 0            // How many times the GF(2) fallback has been invoked (Phase 1)
  let lastSolvedSourceCount = 0            // Tracking value for stall detection
  let lastTailSolveSignature = -1          // (pendingSymbols.length, solved) snapshot — skip redundant solves

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

    // Full-sweep no-progress counter: a proxy for expensive parity work that
    // returned nothing, which is the cost signal Phase 2 (event-driven parity)
    // is intended to eliminate.
    if (totalRecovered === 0) {
      parityNoProgressSweeps++
    }

    return totalRecovered
  }

  // Returns true iff every parity block has been decoded. O(M) worst case.
  function hasAllParitySymbolsDecoded() {
    if (!parityMap || K === null || !decodedBlocks) return false
    for (let p = 0; p < parityMap.length; p++) {
      if (!decodedBlocks[K + p]) return false
    }
    return true
  }

  // Rescan decodedBlocks[0..K_prime] and rebuild solved / solvedSource counts.
  function recountSolved() {
    solved = 0
    solvedSource = 0
    if (!decodedBlocks || K_prime === null) return
    for (let i = 0; i < K_prime; i++) {
      if (decodedBlocks[i]) {
        solved++
        if (K !== null && i < K) solvedSource++
      }
    }
  }

  // Remove any pendingSymbols whose indices all resolve in decodedBlocks.
  function pruneFullyReducedPending() {
    if (!decodedBlocks) return
    for (let i = pendingSymbols.length - 1; i >= 0; i--) {
      const sym = pendingSymbols[i]
      let fullyResolved = true
      for (const idx of sym.indices) {
        if (!decodedBlocks[idx]) { fullyResolved = false; break }
      }
      if (fullyResolved) pendingSymbols.splice(i, 1)
    }
  }

  function ingestParsedPacket(parsed) {
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

    // Track unique parity-symbol IDs as they arrive. Until K is known we
    // cannot classify; on metadata we'll do a single backfill scan.
    if (K !== null && K_prime !== null &&
        parsed.symbolId > K && parsed.symbolId <= K_prime) {
      uniqueParitySymbolsSeen++
    }

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

        // Backfill parity-symbol-id count from previously received symbols.
        uniqueParitySymbolsSeen = 0
        for (const sid of receivedSymbols) {
          if (sid > K && sid <= K_prime) uniqueParitySymbolsSeen++
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

    // Latch parity-sweep-complete once we've received the whole (K, K_prime]
    // systematic parity range. This is a *schedule* observation matching the
    // `par=` count in the receiver log — not "parity blocks are decoded."
    if (!paritySweepComplete && K !== null && K_prime !== null &&
        uniqueParitySymbolsSeen >= (K_prime - K)) {
      paritySweepComplete = true
    }

    return true
  }

  // Evaluate the stall counter + GF(2) tail-solver trigger at a frame
  // boundary. The receiver calls this once per video frame (after all packets
  // from that frame have been ingested). The decoder alone can't know where
  // frame boundaries are — HDMI-UVC batches ~6 packets per frame, QR is 1:1 —
  // so keeping the frame signal out of ingest avoids miscounting.
  function runFrameBoundary() {
    if (K === null || !parityMap || !decodedBlocks) return 0

    if (solvedSource === lastSolvedSourceCount) stallFramesSinceLastSolve++
    else { stallFramesSinceLastSolve = 0; lastSolvedSourceCount = solvedSource }

    if (solvedSource >= K) return 0

    const missing = K - solvedSource
    const signature = (pendingSymbols.length * 0x10000) + solved
    const shouldTrySolver = missing > 0 && missing <= 64 &&
      signature !== lastTailSolveSignature &&
      (paritySweepComplete || stallFramesSinceLastSolve >= 30)
    if (!shouldTrySolver) return 0

    lastTailSolveSignature = signature
    tailSolveTriggerCount++
    const equations = []
    for (const sym of pendingSymbols) {
      equations.push({ indices: sym.indices, payload: sym.payload })
    }
    for (let p = 0; p < parityMap.length; p++) {
      const pIdx = K + p
      if (!decodedBlocks[pIdx]) continue
      const srcIdx = parityMap[p]
      let unknownCount = 0
      for (const i of srcIdx) {
        if (!decodedBlocks[i]) {
          unknownCount++
          if (unknownCount >= 2) break
        }
      }
      if (unknownCount >= 2) {
        equations.push({ indices: srcIdx, payload: decodedBlocks[pIdx] })
      }
    }
    const got = solveGF2(equations, decodedBlocks, K_prime, blockSize)
    if (got > 0) {
      recountSolved()
      pruneFullyReducedPending()
      propagate()
    }
    return got
  }

  function getReceivedSymbolBreakdown() {
    let metadataCount = 0
    let sourceCount = 0
    let parityCount = 0
    let fountainCount = 0

    for (const symbolId of receivedSymbols) {
      if (symbolId === 0) {
        metadataCount++
      } else if (K_prime !== null && symbolId > K_prime) {
        fountainCount++
      } else if (K !== null && symbolId > K) {
        parityCount++
      } else {
        sourceCount++
      }
    }

    return { metadataCount, sourceCount, parityCount, fountainCount }
  }

  return {
    get fileId() { return fileId },
    get k() { return K },        // Source block count (for compatibility)
    get K() { return K },        // Source block count
    get K_prime() { return K_prime },  // Intermediate block count
    get metadata() { return metadata },
    get blockSize() { return blockSize },
    get solved() { return solvedSource },  // Report source blocks solved
    get solvedTotal() { return solved },   // All intermediate blocks solved
    get uniqueSymbols() { return receivedSymbols.size },
    get symbolBreakdown() { return getReceivedSymbolBreakdown() },
    get telemetry() {
      return {
        paritySweepComplete,
        parityNoProgressSweeps,
        stallFramesSinceLastSolve,
        tailSolveTriggerCount,
        pendingSymbolCount: pendingSymbols.length,
        uniqueParitySymbolsSeen,
      }
    },
    get pendingSymbolCount() { return pendingSymbols.length },
    get unresolvedSourceCount() { return K !== null ? Math.max(0, K - solvedSource) : null },
    get unresolvedIntermediateCount() { return K_prime !== null ? Math.max(0, K_prime - solved) : null },
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
      paritySweepComplete = false
      uniqueParitySymbolsSeen = 0
      parityNoProgressSweeps = 0
      stallFramesSinceLastSolve = 0
      tailSolveTriggerCount = 0
      lastSolvedSourceCount = 0
      lastTailSolveSignature = -1
    },

    receive(packet) {
      const parsed = parsePacket(packet)
      return ingestParsedPacket.call(this, parsed)
    },

    receiveParsed(parsed) {
      return ingestParsedPacket.call(this, parsed)
    },

    // Call once per video frame after all packets from that frame have been
    // ingested. Updates stallFramesSinceLastSolve and, if appropriate, fires
    // the GF(2) tail solver. Returns the number of blocks recovered by the
    // solver (0 if it didn't run or didn't make progress).
    noteFrameBoundary() {
      return runFrameBoundary()
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

// Codec roundtrip with deliberate symbol loss — exercises the GF(2) tail solver.
// We drop a handful of systematic symbols (so the decoder stalls with a small
// residual set of unknown source blocks) and rely on fountain symbols plus
// parity equations for the tail solver to finish.
export async function testCodecRoundtripWithLoss() {
  const { createEncoder } = await import('./encoder.js')

  // K ≈ 100: 100 blocks × 200 bytes = 20000 bytes.
  const fileSize = 20000
  const originalData = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) {
    originalData[i] = (i * 11 + 29) & 0xff
  }

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const encoder = createEncoder(originalData.buffer, 'lossy.bin', 'application/octet-stream', hash)
  const decoder = createDecoder()

  // Deterministically pick systematic source symbol IDs to drop (1-indexed;
  // symbolId i corresponds to source block i-1). The chosen set forms a
  // "stopping set" for Raptor-Lite parity recovery: a 2x2 grid across both the
  // consecutive-group axis and the strided axis. Every parity row that
  // references these blocks sees >=2 unknowns, so parityRecovery() cannot
  // make progress and the decoder must fall back to the GF(2) tail solver.
  //
  // For K=100, G=10: source blocks {0, 1, 10, 11} lie at rows 0-1 x cols 0-1.
  //   consecutive row 0 (blocks 0..9): {0, 1} -> 2 unknowns
  //   consecutive row 1 (blocks 10..19): {10, 11} -> 2 unknowns
  //   strided row 0 (blocks 0,10,20,...): {0, 10} -> 2 unknowns
  //   strided row 1 (blocks 1,11,21,...): {1, 11} -> 2 unknowns
  //   (offset rows start at index 5, none of these blocks intersect)
  const dropSet = new Set([1, 2, 11, 12])
  console.log('Codec-with-loss test: K=' + encoder.K + ', K_prime=' + encoder.K_prime +
    ', dropping systematic symbol IDs: ' + [...dropSet].join(','))

  // Send metadata first, then enough data symbols (systematic + fountain) to
  // give the GF(2) solver the independent equations it needs. The stopping set
  // has rank 3 in the parity rows alone; we need fountain symbols that touch
  // the missing set to raise it to rank 4. A 3x K_prime budget gives enough
  // fountain headroom (~270 fountain symbols → ~25 expected to touch the
  // missing set).
  const maxSymbolId = encoder.K_prime * 3
  decoder.receive(encoder.generateSymbol(0))
  decoder.noteFrameBoundary()
  for (let id = 1; id <= maxSymbolId; id++) {
    if (dropSet.has(id)) continue
    const packet = encoder.generateSymbol(id)
    decoder.receive(packet)
    // One packet per simulated frame — matches QR-mode assumption.
    decoder.noteFrameBoundary()
    if (decoder.isComplete()) break
  }

  if (!decoder.isComplete()) {
    console.log('Codec-with-loss test: FAIL - incomplete after', decoder.uniqueSymbols, 'symbols')
    console.log('  Solved:', decoder.solved, '/', encoder.K, 'source blocks')
    console.log('  Telemetry:', decoder.telemetry)
    return false
  }

  const verified = await decoder.verify()
  const reconstructed = decoder.reconstruct()

  let dataMatch = reconstructed.length === originalData.length
  if (dataMatch) {
    for (let i = 0; i < originalData.length; i++) {
      if (reconstructed[i] !== originalData[i]) { dataMatch = false; break }
    }
  }

  const tailFired = decoder.telemetry.tailSolveTriggerCount > 0
  const pass = verified && dataMatch && tailFired
  console.log('Codec-with-loss test:', pass ? 'PASS' : 'FAIL', {
    verified,
    dataMatch,
    tailSolveTriggerCount: decoder.telemetry.tailSolveTriggerCount,
    K: encoder.K,
    K_prime: encoder.K_prime,
    symbolsReceived: decoder.uniqueSymbols
  })

  return pass
}
