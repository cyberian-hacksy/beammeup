// LT Fountain Decoder with Belief Propagation and Raptor-Lite Parity Recovery
// Decodes fountain-coded symbols back into original file

import { FOUNTAIN_DEGREE, DEGREE_ONE_PROBABILITY } from './constants.js'
import { createPRNG } from './prng.js'
import { parsePacket } from './packet.js'
import { parseMetadataPayload } from './metadata.js'
import { calculateParityParams, generateParityMap, buildSourceToParityAdjacency } from './precode.js'
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

  // Event-driven parity recovery state. adj[s] lists parity rows referencing
  // source block s; parityUnknownCount[p] tracks remaining unknowns in row p;
  // parityKnown[p] latches when the parity block at K+p has been decoded;
  // dirtyParities queues rows whose state changed since the last drain.
  let adj = null
  let parityUnknownCount = null
  let parityKnown = null
  const dirtyParities = new Set()

  // Rebuild adjacency bookkeeping from current decodedBlocks state. Called on
  // metadata ingest (K becomes known) and after bulk mutations like the GF(2)
  // tail solver that bypass markSourceSolved/markParitySolved.
  function initParityAdjacency() {
    if (!parityMap || K === null || !decodedBlocks) return
    adj = buildSourceToParityAdjacency(K, parityMap)
    parityUnknownCount = new Uint16Array(parityMap.length)
    parityKnown = new Uint8Array(parityMap.length)
    dirtyParities.clear()
    for (let p = 0; p < parityMap.length; p++) {
      let unk = 0
      const srcIndices = parityMap[p]
      for (const s of srcIndices) {
        if (!decodedBlocks[s]) unk++
      }
      parityUnknownCount[p] = unk
      if (decodedBlocks[K + p]) {
        parityKnown[p] = 1
        if (unk === 1) dirtyParities.add(p)
      }
    }
  }

  // Record that source block `idx` transitioned from unknown → known.
  // Decrements unknown counts for each parity row that references it and
  // queues rows that are now one-unknown-and-parity-known.
  function markSourceSolved(idx) {
    if (!adj || K === null || idx >= K) return
    const parities = adj[idx]
    for (let i = 0; i < parities.length; i++) {
      const p = parities[i]
      if (parityUnknownCount[p] > 0) parityUnknownCount[p]--
      if (parityKnown[p] && parityUnknownCount[p] === 1) dirtyParities.add(p)
    }
  }

  // Record that parity block p transitioned from unknown → known.
  function markParitySolved(p) {
    if (!parityKnown || p < 0 || p >= parityKnown.length) return
    if (parityKnown[p]) return
    parityKnown[p] = 1
    if (parityUnknownCount[p] === 1) dirtyParities.add(p)
  }

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
            // Track source blocks separately (only if K is known). When K is
            // known we also update the event-driven parity bookkeeping so a
            // subsequent parityRecovery() can drain only the affected rows.
            if (K !== null) {
              if (idx < K) {
                solvedSource++
                markSourceSolved(idx)
              } else {
                markParitySolved(idx - K)
              }
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

  // Event-driven parity recovery. Instead of sweeping every parity row on every
  // accepted packet, we drain `dirtyParities` — rows that transitioned to "one
  // unknown source and the parity block is known" since the last mutation.
  // Drain/propagate alternate until nothing new is enqueued: recoveries inside
  // the drain call markSourceSolved (re-populating the queue), and propagate()
  // after each drain may peel pending symbols that were waiting on the newly
  // recovered blocks (also re-populating the queue via mark*Solved).
  function parityRecovery() {
    if (!parityMap || K === null || !adj) return 0
    // Skip idle calls. Incrementing parityNoProgressSweeps only when there
    // was at least one dirty row keeps the counter a real signal of
    // "attempted parity work that produced nothing" instead of counting
    // every no-op invocation from ingestParsedPacket.
    if (dirtyParities.size === 0) return 0

    let totalRecovered = 0
    let recoveredThisRound
    do {
      recoveredThisRound = 0
      while (dirtyParities.size > 0) {
        // Pop one entry without constructing an iterator array.
        const p = dirtyParities.values().next().value
        dirtyParities.delete(p)
        if (!parityKnown[p]) continue
        if (parityUnknownCount[p] !== 1) continue

        const srcIndices = parityMap[p]
        let missingIdx = -1
        for (let i = 0; i < srcIndices.length; i++) {
          const s = srcIndices[i]
          if (!decodedBlocks[s]) { missingIdx = s; break }
        }
        if (missingIdx === -1) continue // State drifted; skip.

        const out = new Uint8Array(decodedBlocks[K + p])
        for (let i = 0; i < srcIndices.length; i++) {
          const s = srcIndices[i]
          if (s === missingIdx) continue
          const known = decodedBlocks[s]
          for (let j = 0; j < out.length; j++) out[j] ^= known[j]
        }
        decodedBlocks[missingIdx] = out
        solved++
        solvedSource++
        recoveredThisRound++
        markSourceSolved(missingIdx)
      }
      if (recoveredThisRound > 0) {
        propagate()
      }
      totalRecovered += recoveredThisRound
    } while (recoveredThisRound > 0 && dirtyParities.size > 0)

    // Proxy counter for "parity-recovery call finished without progress." With
    // the event-driven queue this mostly ticks on no-op drains — still useful
    // for distinguishing active parity work from idle calls in telemetry.
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

        // Seed event-driven parity bookkeeping from whatever state
        // decodedBlocks already holds (symbols that arrived before metadata).
        initParityAdjacency()
        // Pending symbols accepted before metadata may now collapse to
        // degree-1 once they're reduced against already-known blocks.
        propagate()
        parityRecovery()
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
      // GF(2) mutated decodedBlocks directly, bypassing mark*Solved. Rebuild
      // the event-driven bookkeeping from the current state before propagate
      // so any follow-on parity recovery uses accurate counts.
      initParityAdjacency()
      propagate()
      if (dirtyParities.size > 0) parityRecovery()
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
      adj = null
      parityUnknownCount = null
      parityKnown = null
      dirtyParities.clear()
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

// Metadata can arrive mid-stream (every 10th frame in QR mode; longer gaps on
// HDMI). This test sends a mix of systematic, parity, and fountain symbols
// *before* metadata, holds metadata until the end of the initial burst, and
// then checks that the decoder still completes. Exercises the
// initParityAdjacency / replay-propagate path in the metadata branch.
export async function testCodecRoundtripDeferredMetadata() {
  const { createEncoder } = await import('./encoder.js')

  const fileSize = 20000
  const originalData = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) {
    originalData[i] = (i * 23 + 41) & 0xff
  }
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', originalData))
  const encoder = createEncoder(originalData.buffer, 'deferred.bin', 'application/octet-stream', hash)
  const decoder = createDecoder()

  // Burst 1: every systematic symbol (1..K_prime) plus a fountain tail,
  // delivered before metadata. This includes parity symbols
  // (K < symbolId <= K_prime) which exercise markParitySolved via propagate.
  const preMetadataCount = encoder.K_prime + 30
  for (let id = 1; id <= preMetadataCount; id++) {
    decoder.receive(encoder.generateSymbol(id))
  }

  if (decoder.K !== null) {
    console.log('Deferred-metadata test FAIL - K leaked before metadata')
    return false
  }

  // Burst 2: metadata arrives now. initParityAdjacency should seed from the
  // blocks already filled in by propagate(), then replay propagate + parity
  // recovery in the metadata branch so no symbol is wasted.
  decoder.receive(encoder.generateSymbol(0))

  // Burst 3 (tail): a few more fountain symbols in case burst 1 wasn't enough.
  for (let id = preMetadataCount + 1; id <= preMetadataCount + 200 && !decoder.isComplete(); id++) {
    decoder.receive(encoder.generateSymbol(id))
  }

  if (!decoder.isComplete()) {
    console.log('Deferred-metadata test FAIL - incomplete after', decoder.uniqueSymbols, 'symbols')
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

  const pass = verified && dataMatch
  console.log('Deferred-metadata test:', pass ? 'PASS' : 'FAIL', {
    verified,
    dataMatch,
    K: encoder.K,
    K_prime: encoder.K_prime,
    symbolsReceived: decoder.uniqueSymbols,
    parityNoProgressSweeps: decoder.telemetry.parityNoProgressSweeps,
  })

  return pass
}
