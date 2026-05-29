// Shared symbol-plan derivation for the LT fountain codec.
//
// The encoder and decoder MUST agree on which intermediate blocks each symbol
// id XORs together. Keeping that logic in one place makes divergence
// structurally impossible — previously it was duplicated verbatim in
// encoder.js and decoder.js.
//
// The degree distribution is selected by the denseBinaryDegree diagnostic
// (?dense-degree=, default 'classic'), read identically by encoder and decoder.

import { createPRNG } from './prng.js'
import { FOUNTAIN_DEGREE, DEGREE_ONE_PROBABILITY } from './constants.js'
import { getDenseBinaryDegree } from './hdmi-uvc/hdmi-uvc-diagnostics.js'

// Given a symbol id, return the intermediate-block indices it combines.
// Systematic ids (1..K_prime) carry exactly one block; ids > K_prime are
// fountain-coded with a degree drawn from the selected distribution. The PRNG
// is seeded deterministically from (fileId ^ symbolId), so encoder and decoder
// reconstruct identical plans without any side channel.
export function deriveSymbolIndices(fileId, symbolId, K_prime, variant = getDenseBinaryDegree()) {
  if (symbolId <= K_prime) {
    return [(symbolId - 1) % K_prime]
  }

  const rng = createPRNG((fileId ^ symbolId) >>> 0)

  if (variant === 'ripple') {
    // Endgame-friendly: more degree-1/2 keeps the decoding ripple alive so the
    // last few source blocks resolve quickly, instead of the coupon-collector
    // stall pure degree-3 produces near completion.
    const roll = rng.next() / 0xFFFFFFFF
    let degree
    if (roll < 0.30) degree = 1
    else if (roll < 0.60) degree = 2
    else degree = Math.min(FOUNTAIN_DEGREE, Math.max(1, K_prime - 1))
    if (degree === 1) return [rng.next() % K_prime]
    return rng.pickUnique(degree, K_prime)
  }

  // 'classic' (default): 15% degree-1, otherwise degree-3.
  const degreeRoll = rng.next() / 0xFFFFFFFF
  if (degreeRoll < DEGREE_ONE_PROBABILITY) {
    return [rng.next() % K_prime]
  }
  const degree = Math.min(FOUNTAIN_DEGREE, Math.max(1, K_prime - 1))
  return rng.pickUnique(degree, K_prime)
}

export function testFountainRippleVariant() {
  const fileId = 0x12345678
  const K_prime = 1000

  // Determinism: identical args → identical plan (this is exactly why the
  // encoder and decoder stay in sync when they call this function).
  const a = deriveSymbolIndices(fileId, 5000, K_prime, 'ripple')
  const b = deriveSymbolIndices(fileId, 5000, K_prime, 'ripple')
  const deterministic = a.length === b.length && a.every((v, i) => v === b[i])

  // Systematic ids are variant-independent (one block, id-1).
  const sysSame = deriveSymbolIndices(fileId, 7, K_prime, 'ripple')[0] === 6 &&
    deriveSymbolIndices(fileId, 7, K_prime, 'classic')[0] === 6

  // Distribution: 'ripple' yields markedly more low-degree (<=2) symbols.
  const countLowDegree = (variant) => {
    let low = 0
    for (let id = K_prime + 1; id <= K_prime + 2000; id++) {
      if (deriveSymbolIndices(fileId, id, K_prime, variant).length <= 2) low++
    }
    return low
  }
  const rippleLow = countLowDegree('ripple')
  const classicLow = countLowDegree('classic')

  // Every index must be a valid intermediate-block reference.
  let inRange = true
  for (let id = K_prime + 1; id <= K_prime + 300; id++) {
    for (const idx of deriveSymbolIndices(fileId, id, K_prime, 'ripple')) {
      if (idx < 0 || idx >= K_prime) inRange = false
    }
  }

  const pass = deterministic && sysSame && inRange && rippleLow > classicLow * 1.5
  console.log('Fountain ripple variant test:', pass ? 'PASS' : 'FAIL',
    { rippleLow, classicLow, deterministic, sysSame, inRange })
  return pass
}
