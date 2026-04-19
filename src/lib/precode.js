// Raptor-Lite Pre-coding
// Generates XOR parity blocks for improved fountain code efficiency

import { PARITY_LAYERS } from './constants.js'

/**
 * Calculate parity parameters from source block count K
 * @param {number} K - Number of source blocks
 * @returns {{ G: number, M: number, K_prime: number }}
 */
export function calculateParityParams(K) {
  const G = Math.ceil(Math.sqrt(K))
  const M = PARITY_LAYERS * G // ~3*sqrt(K) parity blocks
  const K_prime = K + M
  return { G, M, K_prime }
}

/**
 * Generate the parity map - which source blocks contribute to each parity block
 * @param {number} K - Number of source blocks
 * @param {number} G - Group size (sqrt(K))
 * @returns {number[][]} Array where parityMap[i] = array of source indices for parity block i
 */
export function generateParityMap(K, G) {
  const parityMap = []

  // Layer 1: Consecutive groups
  // P_i = B_{i*G} XOR B_{i*G+1} XOR ... XOR B_{(i+1)*G-1}
  for (let i = 0; i * G < K; i++) {
    const indices = []
    for (let j = i * G; j < Math.min((i + 1) * G, K); j++) {
      indices.push(j)
    }
    // Only add if we have at least 2 blocks (single block parity is useless)
    if (indices.length >= 2) {
      parityMap.push(indices)
    }
  }

  // Layer 2: Offset groups (shifted by G/2)
  // Starts at G/2, groups of size G
  const offset = Math.floor(G / 2)
  for (let i = 0; offset + i * G < K; i++) {
    const indices = []
    const start = offset + i * G
    for (let j = start; j < Math.min(start + G, K); j++) {
      indices.push(j)
    }
    // Only add if we have at least 2 blocks (single block parity is useless)
    if (indices.length >= 2) {
      parityMap.push(indices)
    }
  }

  // Layer 3: Strided (every G-th block)
  // P_i = B_i XOR B_{i+G} XOR B_{i+2G} XOR ...
  for (let i = 0; i < G && i < K; i++) {
    const indices = []
    for (let j = i; j < K; j += G) {
      indices.push(j)
    }
    // Only add if we have at least 2 blocks
    if (indices.length >= 2) {
      parityMap.push(indices)
    }
  }

  return parityMap
}

/**
 * For each source block index, list the parity-row indices that reference it.
 * Used by the decoder to update only affected parity rows when a source block
 * transitions from unknown → known, instead of sweeping the whole parity map.
 * @param {number} K - Number of source blocks
 * @param {number[][]} parityMap - Parity map from generateParityMap
 * @returns {number[][]} adj[sourceIdx] = array of parity row indices
 */
export function buildSourceToParityAdjacency(K, parityMap) {
  const adj = Array.from({ length: K }, () => [])
  for (let p = 0; p < parityMap.length; p++) {
    for (const srcIdx of parityMap[p]) adj[srcIdx].push(p)
  }
  return adj
}

/**
 * Generate parity blocks by XORing source blocks according to parityMap
 * @param {Uint8Array[]} sourceBlocks - Array of source blocks
 * @param {number[][]} parityMap - Parity map from generateParityMap
 * @returns {Uint8Array[]} Array of parity blocks
 */
export function generateParityBlocks(sourceBlocks, parityMap) {
  const parityBlocks = []
  const blockSize = sourceBlocks[0].length

  for (const indices of parityMap) {
    const parity = new Uint8Array(blockSize)

    for (const idx of indices) {
      const block = sourceBlocks[idx]
      for (let i = 0; i < blockSize; i++) {
        parity[i] ^= block[i]
      }
    }

    parityBlocks.push(parity)
  }

  return parityBlocks
}

/**
 * Attempt to recover missing source blocks using parity relationships
 * @param {(Uint8Array|null)[]} decodedBlocks - Array of decoded blocks (null if missing)
 * @param {number} K - Number of source blocks
 * @param {number[][]} parityMap - Parity map
 * @returns {number} Number of blocks recovered
 */
export function recoverWithParity(decodedBlocks, K, parityMap) {
  let totalRecovered = 0
  let progress = true

  while (progress) {
    progress = false

    for (let p = 0; p < parityMap.length; p++) {
      const parityIdx = K + p // Parity blocks are stored after source blocks
      const sourceIndices = parityMap[p]

      // Skip if parity block itself is not decoded
      if (!decodedBlocks[parityIdx]) {
        continue
      }

      // Count unknowns among source blocks in this parity relationship
      const unknowns = sourceIndices.filter(i => !decodedBlocks[i])

      if (unknowns.length === 1) {
        // Can recover the one unknown!
        const missingIdx = unknowns[0]

        // Start with parity block
        const recovered = new Uint8Array(decodedBlocks[parityIdx])
        const blockSize = recovered.length

        // XOR out all known source blocks
        for (const idx of sourceIndices) {
          if (idx !== missingIdx && decodedBlocks[idx]) {
            for (let i = 0; i < blockSize; i++) {
              recovered[i] ^= decodedBlocks[idx][i]
            }
          }
        }

        decodedBlocks[missingIdx] = recovered
        totalRecovered++
        progress = true
      }
    }
  }

  return totalRecovered
}

// Test parity map generation
export function testParityMap() {
  // Test with K=16 (G=4)
  const K = 16
  const { G, M, K_prime } = calculateParityParams(K)
  const parityMap = generateParityMap(K, G)

  console.log('Parity params for K=' + K + ':', { G, M, K_prime })
  console.log('Parity map has', parityMap.length, 'entries')

  // Verify all source blocks are covered
  const covered = new Set()
  for (const indices of parityMap) {
    for (const idx of indices) {
      covered.add(idx)
    }
  }

  const allCovered = covered.size === K
  console.log('All source blocks covered:', allCovered, '(' + covered.size + '/' + K + ')')

  // Verify each parity has at least 2 blocks
  const validSizes = parityMap.every(indices => indices.length >= 2)
  console.log('All parities have >= 2 blocks:', validSizes)

  const pass = allCovered && validSizes
  console.log('Parity map test:', pass ? 'PASS' : 'FAIL')
  return pass
}

// Test parity block generation and recovery
export function testParityRecovery() {
  // Create test source blocks
  const K = 16
  const testBlockSize = 200
  const { G } = calculateParityParams(K)
  const parityMap = generateParityMap(K, G)

  const sourceBlocks = []
  for (let i = 0; i < K; i++) {
    const block = new Uint8Array(testBlockSize)
    for (let j = 0; j < testBlockSize; j++) {
      block[j] = (i * 17 + j * 13) % 256
    }
    sourceBlocks.push(block)
  }

  // Generate parity blocks
  const parityBlocks = generateParityBlocks(sourceBlocks, parityMap)
  console.log('Generated', parityBlocks.length, 'parity blocks')

  // Create decoded blocks array with everything present
  const decodedBlocks = [...sourceBlocks, ...parityBlocks]

  // Remove a source block
  const removedIdx = 7
  const removedBlock = new Uint8Array(decodedBlocks[removedIdx])
  decodedBlocks[removedIdx] = null

  // Try to recover
  const recovered = recoverWithParity(decodedBlocks, K, parityMap)
  console.log('Recovered', recovered, 'blocks')

  // Verify recovery
  let match = true
  if (decodedBlocks[removedIdx]) {
    for (let i = 0; i < testBlockSize; i++) {
      if (decodedBlocks[removedIdx][i] !== removedBlock[i]) {
        match = false
        break
      }
    }
  } else {
    match = false
  }

  const pass = recovered === 1 && match
  console.log('Parity recovery test:', pass ? 'PASS' : 'FAIL')
  return pass
}

// Adjacency sanity: every parity row references must be reflected in adj, and
// every adj entry must point to a parity row that lists that source index.
export function testSourceToParityAdjacency() {
  const K = 16
  const { G } = calculateParityParams(K)
  const map = generateParityMap(K, G)
  const adj = buildSourceToParityAdjacency(K, map)

  // Forward: every (s, p) in adj appears in map[p].
  for (let s = 0; s < K; s++) {
    for (const p of adj[s]) {
      if (!map[p].includes(s)) { console.log('adj FAIL forward s=', s, 'p=', p); return false }
    }
  }
  // Reverse: every (s, p) in map appears in adj[s].
  for (let p = 0; p < map.length; p++) {
    for (const s of map[p]) {
      if (!adj[s].includes(p)) { console.log('adj FAIL reverse s=', s, 'p=', p); return false }
    }
  }

  console.log('adj test: PASS (K=' + K + ', parity rows=' + map.length + ')')
  return true
}

export async function testGF2SolverSmall() {
  const modulePath = './gf2-solver.js'
  const { solveGF2 } = await import(/* @vite-ignore */ modulePath)
  const K_prime = 8
  const blockSize = 4

  // Source blocks 0..7
  const source = []
  for (let i = 0; i < K_prime; i++) {
    const b = new Uint8Array(blockSize)
    for (let j = 0; j < blockSize; j++) b[j] = (i * 31 + j * 7) & 0xff
    source.push(b)
  }

  // Known: blocks 0, 1, 2, 3 already decoded. Missing: 4, 5, 6, 7.
  const decodedBlocks = [source[0], source[1], source[2], source[3], null, null, null, null]

  // Equations from pending symbols: each is an XOR of a subset of source blocks.
  // The set must be rank-4 over GF(2) to recover 4 missing blocks.
  // Equation A: blocks {4, 5}    -> payload = src[4] ^ src[5]
  // Equation B: blocks {5, 6}    -> payload = src[5] ^ src[6]
  // Equation C: blocks {4, 6, 7} -> payload = src[4] ^ src[6] ^ src[7]
  // Equation D: blocks {4}       -> payload = src[4]   (degree-1, already-reduced form)
  const xor = (a, b) => { const o = new Uint8Array(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] ^ b[i]; return o }
  const equations = [
    { indices: [4, 5],       payload: xor(source[4], source[5]) },
    { indices: [5, 6],       payload: xor(source[5], source[6]) },
    { indices: [4, 6, 7],    payload: xor(xor(source[4], source[6]), source[7]) },
    { indices: [4],          payload: new Uint8Array(source[4]) },
  ]

  const recovered = solveGF2(equations, decodedBlocks, K_prime, blockSize)

  // All four should now be filled.
  for (let i = 4; i < 8; i++) {
    if (!decodedBlocks[i]) { console.log('GF2 small test FAIL - block', i, 'missing'); return false }
    for (let j = 0; j < blockSize; j++) {
      if (decodedBlocks[i][j] !== source[i][j]) { console.log('GF2 small test FAIL - block', i, 'mismatch'); return false }
    }
  }
  console.log('GF2 small test: PASS (recovered', recovered, ')')
  return recovered === 4
}

// Realistic residual: K=400 source blocks, Raptor-Lite parity on top, 32 source
// blocks removed. We build fountain equations using the same PRNG/degree logic
// as encoder.js, filter to those that intersect the missing set, and hand the
// reduced residual to solveGF2. The test exercises the same code path the
// decoder tail will hit in Task 1.4.
//
// Seed/cap tuning: seed 0xDEADBEEF for the missing-set RNG and 0x12345678 as
// the per-symbol seed base were chosen so that iterating symbolIds from
// K_prime+1 upward yields 40 equations that collectively cover all 32 missing
// indices within a few hundred symbol attempts. maxAttempts=5000 is the
// generous ceiling spelled out in the plan; in practice the coverage loop
// finishes well under that.
export async function testGF2SolverLarge() {
  const { createPRNG } = await import(/* @vite-ignore */ './prng.js')
  const { FOUNTAIN_DEGREE, DEGREE_ONE_PROBABILITY } = await import(/* @vite-ignore */ './constants.js')
  const { solveGF2 } = await import(/* @vite-ignore */ './gf2-solver.js')

  const K = 400
  const blockSize = 32
  const { G } = calculateParityParams(K)
  const parityMap = generateParityMap(K, G)

  // Generate source blocks deterministically.
  const sourceBlocks = []
  for (let i = 0; i < K; i++) {
    const b = new Uint8Array(blockSize)
    for (let j = 0; j < blockSize; j++) b[j] = (i * 37 + j * 13 + 7) & 0xff
    sourceBlocks.push(b)
  }
  const parityBlocks = generateParityBlocks(sourceBlocks, parityMap)
  const intermediateBlocks = [...sourceBlocks, ...parityBlocks]
  const K_prime = intermediateBlocks.length

  // Pick 32 source blocks to remove deterministically.
  const removeRng = createPRNG(0xDEADBEEF)
  const missingList = removeRng.pickUnique(32, K)
  const missing = new Set(missingList)

  // Build decodedBlocks: source blocks present except missing ones; parity blocks all present.
  const decodedBlocks = new Array(K_prime)
  for (let i = 0; i < K; i++) decodedBlocks[i] = missing.has(i) ? null : sourceBlocks[i]
  for (let i = 0; i < parityBlocks.length; i++) decodedBlocks[K + i] = parityBlocks[i]

  // Collect at least 40 fountain equations whose support intersects the missing
  // set, continuing until every missing index is covered. 40 is a floor (we
  // want enough rank for the solver); coverage is the correctness bar. We cap
  // total symbol iterations at maxAttempts.
  const equations = []
  const covered = new Set()
  const maxAttempts = 5000
  let attempts = 0
  for (
    let symbolId = K_prime + 1;
    attempts < maxAttempts && (equations.length < 40 || covered.size < missing.size);
    symbolId++, attempts++
  ) {
    const seed = (0x12345678 ^ symbolId) >>> 0
    const rng = createPRNG(seed)
    const degreeRoll = rng.next() / 0xFFFFFFFF
    let indices
    if (degreeRoll < DEGREE_ONE_PROBABILITY) {
      indices = [rng.next() % K_prime]
    } else {
      const degree = Math.min(FOUNTAIN_DEGREE, Math.max(1, K_prime - 1))
      indices = rng.pickUnique(degree, K_prime)
    }

    // Only keep equations that intersect the missing set.
    const hasUnknown = indices.some(i => missing.has(i))
    if (!hasUnknown) continue

    // Compute payload: XOR of intermediate blocks at these indices.
    const payload = new Uint8Array(blockSize)
    for (const idx of indices) {
      const src = intermediateBlocks[idx]
      for (let i = 0; i < blockSize; i++) payload[i] ^= src[i]
    }

    equations.push({ indices, payload })
    for (const i of indices) if (missing.has(i)) covered.add(i)
  }

  if (covered.size < missing.size) {
    console.log(`GF2 large test FAIL - coverage ${covered.size}/${missing.size} after ${equations.length} equations`)
    return false
  }

  const recovered = solveGF2(equations, decodedBlocks, K_prime, blockSize)
  if (recovered !== missing.size) {
    console.log(`GF2 large test FAIL - recovered ${recovered}/${missing.size}`)
    return false
  }

  for (const i of missing) {
    if (!decodedBlocks[i]) {
      console.log(`GF2 large test FAIL - block ${i} not filled`)
      return false
    }
    for (let j = 0; j < blockSize; j++) {
      if (decodedBlocks[i][j] !== sourceBlocks[i][j]) {
        console.log(`GF2 large test FAIL - block ${i} mismatch at byte ${j}`)
        return false
      }
    }
  }

  console.log(`GF2 large test: PASS (K=${K}, K_prime=${K_prime}, recovered ${recovered}/${missing.size} from ${equations.length} equations)`)
  return true
}
