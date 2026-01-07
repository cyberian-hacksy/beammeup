// PRNG: xorshift128 - deterministic random number generator
// Used for reproducible block selection in fountain coding

export function createPRNG(seed) {
  // Initialize state from 32-bit seed
  let s0 = seed >>> 0
  let s1 = (seed * 1812433253 + 1) >>> 0
  let s2 = (s1 * 1812433253 + 1) >>> 0
  let s3 = (s2 * 1812433253 + 1) >>> 0

  return {
    // Returns raw 32-bit unsigned integer
    next() {
      // xorshift128 algorithm
      let t = s0 ^ (s0 << 11)
      s0 = s1
      s1 = s2
      s2 = s3
      s3 = (s3 ^ (s3 >>> 19)) ^ (t ^ (t >>> 8))
      return s3 >>> 0
    },

    // Returns 0 to max-1
    nextInt(max) {
      return this.next() % max
    },

    // Pick n unique indices from 0 to max-1
    pickUnique(n, max) {
      const indices = []
      const used = new Set()
      while (indices.length < n) {
        const idx = this.nextInt(max)
        if (!used.has(idx)) {
          used.add(idx)
          indices.push(idx)
        }
      }
      return indices
    }
  }
}

// Test for PRNG determinism
export function testPRNG() {
  const rng1 = createPRNG(12345)
  const rng2 = createPRNG(12345)
  const results1 = [rng1.nextInt(100), rng1.nextInt(100), rng1.nextInt(100)]
  const results2 = [rng2.nextInt(100), rng2.nextInt(100), rng2.nextInt(100)]
  const pass = JSON.stringify(results1) === JSON.stringify(results2)
  console.log('PRNG determinism test:', pass ? 'PASS' : 'FAIL', results1)
  return pass
}
