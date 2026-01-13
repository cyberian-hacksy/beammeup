// ColorCorrector - Builds and applies color correction matrix
// Uses known reference colors (black/white from finders) to correct for lighting

/**
 * ColorCorrector builds a transformation matrix that maps observed colors
 * to expected colors, compensating for lighting and camera sensor bias.
 *
 * Modes:
 * - Diagonal (2-point): Black + white only -> per-channel scale/offset
 * - Full matrix (3+ points): Full 3x3 matrix via pseudoinverse
 */
export class ColorCorrector {
  constructor() {
    this.mode = 'identity'  // 'identity', 'diagonal', 'matrix'
    this.matrix = null      // 3x3 matrix for 'matrix' mode
    this.scale = null       // [r, g, b] scales for 'diagonal' mode
    this.offset = null      // [r, g, b] offsets for 'diagonal' mode
  }

  /**
   * Build correction from arbitrary reference color pairs
   * @param {Array<[number,number,number]>} observed - Sampled colors from image
   * @param {Array<[number,number,number]>} expected - Target colors
   */
  buildFromReferences(observed, expected) {
    if (!observed || !expected || observed.length === 0) {
      this.mode = 'identity'
      return
    }

    if (observed.length !== expected.length) {
      console.warn('ColorCorrector: observed/expected length mismatch')
      this.mode = 'identity'
      return
    }

    if (observed.length === 2) {
      // Two points (black/white) - use diagonal scaling
      this.buildDiagonal(observed, expected)
    } else if (observed.length >= 3) {
      // 3+ points - use full matrix
      this.buildMatrix(observed, expected)
    } else {
      // Single point - not enough for correction
      this.mode = 'identity'
    }
  }

  /**
   * Build correction from just black and white reference points
   * @param {[number,number,number]} black - Observed black RGB
   * @param {[number,number,number]} white - Observed white RGB
   */
  buildFromBlackWhite(black, white) {
    this.buildDiagonal([black, white], [[0, 0, 0], [255, 255, 255]])
  }

  /**
   * Build diagonal (per-channel) correction
   * corrected = (observed - offset) * scale
   */
  buildDiagonal(observed, expected) {
    // Find black and white from the pairs
    let black = null, white = null
    let blackExp = null, whiteExp = null

    for (let i = 0; i < observed.length; i++) {
      const brightness = observed[i][0] + observed[i][1] + observed[i][2]
      const expBrightness = expected[i][0] + expected[i][1] + expected[i][2]

      if (expBrightness < 128 * 3) {
        // This is expected to be dark
        if (!black || brightness < (black[0] + black[1] + black[2])) {
          black = observed[i]
          blackExp = expected[i]
        }
      } else {
        // This is expected to be light
        if (!white || brightness > (white[0] + white[1] + white[2])) {
          white = observed[i]
          whiteExp = expected[i]
        }
      }
    }

    // Fallback if we don't have both
    if (!black) black = [0, 0, 0]
    if (!white) white = [255, 255, 255]
    if (!blackExp) blackExp = [0, 0, 0]
    if (!whiteExp) whiteExp = [255, 255, 255]

    // Calculate scale and offset per channel
    // corrected = (observed - black) * scale
    // where scale = (whiteExp - blackExp) / (white - black)

    // Clamp black offset to avoid clipping mid-tone colors
    // Black reference should be < 80 typically
    this.offset = [
      Math.min(black[0], 60),
      Math.min(black[1], 60),
      Math.min(black[2], 60)
    ]

    // Calculate scale with clamped offset
    const effectiveBlack = this.offset
    this.scale = [
      (whiteExp[0] - blackExp[0]) / Math.max(50, white[0] - effectiveBlack[0]),
      (whiteExp[1] - blackExp[1]) / Math.max(50, white[1] - effectiveBlack[1]),
      (whiteExp[2] - blackExp[2]) / Math.max(50, white[2] - effectiveBlack[2])
    ]

    // Clamp scale to avoid over-amplification
    // Max 1.5 to preserve color relationships
    this.scale = this.scale.map(s => Math.min(s, 1.5))

    this.mode = 'diagonal'
  }

  /**
   * Build full 3x3 correction matrix using least squares
   * Uses Moore-Penrose pseudoinverse: CCM = expected^T * pinv(observed^T)
   */
  buildMatrix(observed, expected) {
    // For numerical stability and simplicity, we'll use a simplified approach:
    // Solve for the matrix M such that M * observed ≈ expected
    // Using normal equations: M = expected * observed^T * (observed * observed^T)^-1

    const n = observed.length

    // Build observed matrix (3 x n) and expected matrix (3 x n)
    // Then solve M * O = E for M (3x3)

    // For small n, we can use direct computation
    // O^T * O gives us a 3x3 matrix (Gram matrix)
    // M = E * O^T * inv(O * O^T)

    // Compute O * O^T (3x3)
    const OOT = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]

    for (let i = 0; i < n; i++) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          OOT[r][c] += observed[i][r] * observed[i][c]
        }
      }
    }

    // Compute E * O^T (3x3)
    const EOT = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]

    for (let i = 0; i < n; i++) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          EOT[r][c] += expected[i][r] * observed[i][c]
        }
      }
    }

    // Invert OOT (3x3 matrix inversion)
    const invOOT = this.invert3x3(OOT)

    if (!invOOT) {
      // Matrix not invertible, fall back to diagonal
      console.warn('ColorCorrector: matrix not invertible, using diagonal')
      this.buildDiagonal(observed, expected)
      return
    }

    // M = EOT * invOOT
    this.matrix = this.multiply3x3(EOT, invOOT)
    this.mode = 'matrix'
  }

  /**
   * Invert a 3x3 matrix
   * @returns {Array<Array<number>>|null} Inverted matrix or null if singular
   */
  invert3x3(m) {
    const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
                m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
                m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])

    if (Math.abs(det) < 1e-10) return null

    const invDet = 1 / det

    return [
      [
        (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * invDet,
        (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * invDet,
        (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * invDet
      ],
      [
        (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * invDet,
        (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * invDet,
        (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * invDet
      ],
      [
        (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * invDet,
        (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * invDet,
        (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * invDet
      ]
    ]
  }

  /**
   * Multiply two 3x3 matrices
   */
  multiply3x3(a, b) {
    const result = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          result[i][j] += a[i][k] * b[k][j]
        }
      }
    }

    return result
  }

  /**
   * Apply color correction to an observed RGB value
   * @param {number} r - Red [0-255]
   * @param {number} g - Green [0-255]
   * @param {number} b - Blue [0-255]
   * @returns {[number, number, number]} Corrected RGB
   */
  correct(r, g, b) {
    if (this.mode === 'identity') {
      return [r, g, b]
    }

    if (this.mode === 'diagonal') {
      return [
        Math.max(0, Math.min(255, (r - this.offset[0]) * this.scale[0])),
        Math.max(0, Math.min(255, (g - this.offset[1]) * this.scale[1])),
        Math.max(0, Math.min(255, (b - this.offset[2]) * this.scale[2]))
      ]
    }

    if (this.mode === 'matrix') {
      const m = this.matrix
      return [
        Math.max(0, Math.min(255, m[0][0] * r + m[0][1] * g + m[0][2] * b)),
        Math.max(0, Math.min(255, m[1][0] * r + m[1][1] * g + m[1][2] * b)),
        Math.max(0, Math.min(255, m[2][0] * r + m[2][1] * g + m[2][2] * b))
      ]
    }

    return [r, g, b]
  }

  /**
   * Get debug info about the current correction
   */
  getDebugInfo() {
    if (this.mode === 'identity') {
      return 'identity'
    }
    if (this.mode === 'diagonal') {
      return `diagonal s:[${this.scale.map(v => v.toFixed(2)).join(',')}] o:[${this.offset.join(',')}]`
    }
    if (this.mode === 'matrix') {
      return `matrix 3x3`
    }
    return 'unknown'
  }
}
