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
   * Uses Moore-Penrose pseudoinverse via SVD for numerical stability
   * Formula: CCM = E * pinv(O) where O is Nx3 observed, E is Nx3 expected
   */
  buildMatrix(observed, expected) {
    const n = observed.length

    // Use SVD-based pseudoinverse for robustness
    // For M * observed^T = expected^T, we solve M = expected^T * pinv(observed^T)
    // observed^T is 3xN, so pinv(observed^T) is Nx3

    // Compute O^T * O (3x3 Gram matrix) for SVD
    const OTO = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]

    for (let i = 0; i < n; i++) {
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          OTO[r][c] += observed[i][r] * observed[i][c]
        }
      }
    }

    // SVD of 3x3 symmetric matrix O^T*O using Jacobi method
    const svd = this.svd3x3Symmetric(OTO)

    if (!svd) {
      console.warn('ColorCorrector: SVD failed, using diagonal')
      this.buildDiagonal(observed, expected)
      return
    }

    // Compute pseudoinverse of singular values with regularization
    // Threshold small values to avoid division by near-zero
    const threshold = 1e-6 * Math.max(...svd.S)
    const Sinv = svd.S.map(s => s > threshold ? 1 / s : 0)

    // pinv(O^T*O) = V * diag(1/S^2) * V^T (since SVD of O^T*O gives squared singular values)
    // But we want pinv(O^T) = V * diag(1/S) * U^T
    // For the Gram matrix, sqrt of eigenvalues gives singular values
    const SinvSqrt = Sinv.map(s => Math.sqrt(s))

    // Compute pinv(O^T*O) = V * diag(Sinv) * V^T
    const pinvOTO = this.reconstructFromSVD(svd.V, Sinv)

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

    // M = EOT * pinv(OTO)
    this.matrix = this.multiply3x3(EOT, pinvOTO)

    // Validate matrix - check for extreme values that indicate instability
    const maxVal = Math.max(...this.matrix.flat().map(Math.abs))
    if (maxVal > 5) {
      console.warn(`ColorCorrector: matrix has extreme values (max=${maxVal.toFixed(2)}), clamping`)
      // Regularize by blending with identity
      const blend = 3 / maxVal
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          const identity = i === j ? 1 : 0
          this.matrix[i][j] = blend * this.matrix[i][j] + (1 - blend) * identity
        }
      }
    }

    this.mode = 'matrix'
  }

  /**
   * SVD of a 3x3 symmetric matrix using Jacobi eigenvalue algorithm
   * Returns {V: eigenvectors (3x3), S: eigenvalues (array of 3)}
   */
  svd3x3Symmetric(A) {
    // Copy matrix
    const a = [
      [...A[0]],
      [...A[1]],
      [...A[2]]
    ]

    // Initialize V as identity
    const V = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1]
    ]

    const maxIter = 50
    const tolerance = 1e-10

    for (let iter = 0; iter < maxIter; iter++) {
      // Find largest off-diagonal element
      let maxOff = 0
      let p = 0, q = 1

      for (let i = 0; i < 3; i++) {
        for (let j = i + 1; j < 3; j++) {
          if (Math.abs(a[i][j]) > maxOff) {
            maxOff = Math.abs(a[i][j])
            p = i
            q = j
          }
        }
      }

      if (maxOff < tolerance) break

      // Compute Jacobi rotation
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
      const t = Math.sign(theta) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1)
      const s = t * c

      // Apply rotation to A: A' = J^T * A * J
      const app = a[p][p], aqq = a[q][q], apq = a[p][q]
      a[p][p] = c * c * app - 2 * c * s * apq + s * s * aqq
      a[q][q] = s * s * app + 2 * c * s * apq + c * c * aqq
      a[p][q] = a[q][p] = 0

      for (let k = 0; k < 3; k++) {
        if (k !== p && k !== q) {
          const akp = a[k][p], akq = a[k][q]
          a[k][p] = a[p][k] = c * akp - s * akq
          a[k][q] = a[q][k] = s * akp + c * akq
        }
      }

      // Update eigenvectors: V' = V * J
      for (let k = 0; k < 3; k++) {
        const vkp = V[k][p], vkq = V[k][q]
        V[k][p] = c * vkp - s * vkq
        V[k][q] = s * vkp + c * vkq
      }
    }

    // Eigenvalues are on diagonal, ensure non-negative
    const S = [Math.max(0, a[0][0]), Math.max(0, a[1][1]), Math.max(0, a[2][2])]

    return { V, S }
  }

  /**
   * Reconstruct matrix from SVD: M = V * diag(S) * V^T
   */
  reconstructFromSVD(V, S) {
    const result = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ]

    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        for (let k = 0; k < 3; k++) {
          result[i][j] += V[i][k] * S[k] * V[j][k]
        }
      }
    }

    return result
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
