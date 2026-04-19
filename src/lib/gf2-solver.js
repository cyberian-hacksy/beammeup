// GF(2) row-echelon solver for the decoder tail.
// Input: equations = [{ indices: number[], payload: Uint8Array }] already reduced
//        against known decodedBlocks. decodedBlocks array is mutated in place.
// Output: count of source blocks newly recovered.
//
// Algorithm: Gauss-Jordan elimination over GF(2) using bit-packed row bitmaps
// (Uint32Array, ceil(K_prime/32) words) and per-row Uint8Array payloads. Each
// pivot row is "consumed" so it can never be re-used as the pivot for a later
// column — this is the standard requirement for reduced row-echelon form. After
// elimination any row that ended up with a single bit set yields a recovered
// source/parity block.

export function solveGF2(equations, decodedBlocks, K_prime, blockSize) {
  const words = (K_prime + 31) >>> 5
  const rows = []

  // Build rows: (bitmap, payload) from equations, skipping those already satisfied.
  for (const eq of equations) {
    // Reduce against anything already known (defensive; caller usually did this).
    let pay = eq.payload
    let payCopied = false
    const unknowns = []
    for (const idx of eq.indices) {
      if (decodedBlocks[idx]) {
        if (!payCopied) {
          pay = new Uint8Array(pay) // copy-on-write
          payCopied = true
        }
        const k = decodedBlocks[idx]
        for (let i = 0; i < blockSize; i++) pay[i] ^= k[i]
      } else {
        unknowns.push(idx)
      }
    }
    if (unknowns.length === 0) continue
    const bm = new Uint32Array(words)
    for (const u of unknowns) bm[u >>> 5] |= (1 << (u & 31))
    // Always carry our own payload — XOR mutations during elimination must not
    // bleed back into the caller's equation object.
    rows.push({ bm, payload: payCopied ? pay : new Uint8Array(pay) })
  }

  // Gauss-Jordan elimination. `nextPivotRow` advances each time we lock a row
  // in as a pivot, ensuring no row ever serves as pivot for two columns.
  const pivotForCol = new Int32Array(K_prime).fill(-1)
  let nextPivotRow = 0
  for (let col = 0; col < K_prime; col++) {
    if (decodedBlocks[col]) continue
    const mask = 1 << (col & 31)
    const word = col >>> 5
    // Find pivot among the not-yet-consumed rows.
    let pivot = -1
    for (let r = nextPivotRow; r < rows.length; r++) {
      if ((rows[r].bm[word] & mask) !== 0) { pivot = r; break }
    }
    if (pivot === -1) continue
    // Swap pivot into position so consumed rows occupy [0, nextPivotRow).
    if (pivot !== nextPivotRow) {
      const tmp = rows[pivot]
      rows[pivot] = rows[nextPivotRow]
      rows[nextPivotRow] = tmp
    }
    pivot = nextPivotRow
    pivotForCol[col] = pivot
    nextPivotRow++

    // Eliminate this column from all other rows (Gauss-Jordan: above and below).
    const pbm = rows[pivot].bm
    const ppay = rows[pivot].payload
    for (let r = 0; r < rows.length; r++) {
      if (r === pivot) continue
      if ((rows[r].bm[word] & mask) === 0) continue
      const rbm = rows[r].bm
      for (let w = 0; w < words; w++) rbm[w] ^= pbm[w]
      const rpay = rows[r].payload
      for (let i = 0; i < blockSize; i++) rpay[i] ^= ppay[i]
    }
  }

  // Back-extract: any pivot row that is now degree-1 (exactly one bit set)
  // solves its column. Iterate to a fixed point so newly-solved blocks can
  // collapse other pivot rows that referenced them.
  let recovered = 0
  let progress = true
  while (progress) {
    progress = false
    for (let col = 0; col < K_prime; col++) {
      const pivot = pivotForCol[col]
      if (pivot === -1) continue
      if (decodedBlocks[col]) continue
      const bm = rows[pivot].bm
      // Reduce this row against any newly-decoded blocks discovered in earlier
      // back-extract iterations.
      for (let w = 0; w < words; w++) {
        let x = bm[w]
        while (x) {
          const bit = x & -x
          const idx = (w << 5) + (31 - Math.clz32(bit))
          if (decodedBlocks[idx]) {
            bm[w] &= ~bit
            const k = decodedBlocks[idx]
            const pay = rows[pivot].payload
            for (let i = 0; i < blockSize; i++) pay[i] ^= k[i]
          }
          x &= x - 1
        }
      }
      // Count remaining set bits.
      let popcount = 0
      let onlyCol = -1
      for (let w = 0; w < words; w++) {
        let x = bm[w]
        while (x) {
          popcount++
          if (popcount > 1) break
          const bit = x & -x
          // 31 - Math.clz32(bit) returns the bit position (0..31) of a power-of-two.
          // Avoids the implicit float conversion of Math.log2.
          onlyCol = (w << 5) + (31 - Math.clz32(bit))
          x &= x - 1
        }
        if (popcount > 1) break
      }
      if (popcount === 1 && !decodedBlocks[onlyCol]) {
        decodedBlocks[onlyCol] = rows[pivot].payload
        recovered++
        progress = true
      }
    }
  }

  return recovered
}
