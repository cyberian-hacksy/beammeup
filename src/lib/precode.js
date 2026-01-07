// Raptor-Lite Pre-coding
// Generates XOR parity blocks for improved fountain code efficiency

import { BLOCK_SIZE, PARITY_LAYERS } from './constants.js'

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
    parityMap.push(indices)
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
 * Generate parity blocks by XORing source blocks according to parityMap
 * @param {Uint8Array[]} sourceBlocks - Array of source blocks
 * @param {number[][]} parityMap - Parity map from generateParityMap
 * @returns {Uint8Array[]} Array of parity blocks
 */
export function generateParityBlocks(sourceBlocks, parityMap) {
  const parityBlocks = []

  for (const indices of parityMap) {
    const parity = new Uint8Array(BLOCK_SIZE)

    for (const idx of indices) {
      const block = sourceBlocks[idx]
      for (let i = 0; i < BLOCK_SIZE; i++) {
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

        // XOR out all known source blocks
        for (const idx of sourceIndices) {
          if (idx !== missingIdx && decodedBlocks[idx]) {
            for (let i = 0; i < BLOCK_SIZE; i++) {
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
  const { G } = calculateParityParams(K)
  const parityMap = generateParityMap(K, G)

  const sourceBlocks = []
  for (let i = 0; i < K; i++) {
    const block = new Uint8Array(BLOCK_SIZE)
    for (let j = 0; j < BLOCK_SIZE; j++) {
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
    for (let i = 0; i < BLOCK_SIZE; i++) {
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
