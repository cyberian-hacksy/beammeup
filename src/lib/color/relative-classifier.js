// RelativeColorClassifier - Lighting-invariant color classification
// Uses relative channel differences (R-G, G-B, B-R) instead of absolute values

/**
 * CMY color targets with their relative tuples and bit patterns
 * Relative tuple: (R-G, G-B, B-R)
 */
const CMY_TARGETS = [
  { bits: [0, 0, 0], name: 'white',   rel: [0, 0, 0] },      // White: neutral
  { bits: [1, 0, 0], name: 'cyan',    rel: [-1, 0, 1] },     // Cyan: low R
  { bits: [0, 1, 0], name: 'magenta', rel: [1, -1, 0] },     // Magenta: low G
  { bits: [0, 0, 1], name: 'yellow',  rel: [0, 1, -1] },     // Yellow: low B
  { bits: [1, 1, 0], name: 'blue',    rel: [0, -1, 1] },     // Blue: C+M (low R, low G)
  { bits: [1, 0, 1], name: 'green',   rel: [-1, 1, 0] },     // Green: C+Y (low R, low B)
  { bits: [0, 1, 1], name: 'red',     rel: [1, 0, -1] },     // Red: M+Y (low G, low B)
  { bits: [1, 1, 1], name: 'black',   rel: [0, 0, 0] }       // Black: neutral (dark)
]

/**
 * RelativeColorClassifier classifies colors using channel relationships
 * rather than absolute values, making it robust to lighting changes.
 *
 * Key insight: A cyan pixel under warm lighting still has R < G and R < B,
 * even if absolute RGB values shift.
 */
export class RelativeColorClassifier {
  constructor() {
    // Normalize target relative tuples to unit vectors for comparison
    this.targets = CMY_TARGETS.map((t, i) => ({
      ...t,
      colorIndex: i,
      relNorm: this.normalizeRelative(t.rel)
    }))

    // Brightness thresholds for black/white detection
    this.blackThreshold = 80    // Below this is considered black
    this.whiteThreshold = 200   // Above this is considered white
  }

  /**
   * Normalize a relative tuple to unit length (for comparison)
   */
  normalizeRelative(rel) {
    const len = Math.sqrt(rel[0] * rel[0] + rel[1] * rel[1] + rel[2] * rel[2])
    if (len < 0.001) return [0, 0, 0]  // Neutral colors
    return [rel[0] / len, rel[1] / len, rel[2] / len]
  }

  /**
   * Compute relative tuple from RGB
   * @param {number} r - Red [0-255]
   * @param {number} g - Green [0-255]
   * @param {number} b - Blue [0-255]
   * @returns {[number, number, number]} Relative tuple
   */
  toRelative(r, g, b) {
    return [r - g, g - b, b - r]
  }

  /**
   * Compute distance between two relative tuples
   */
  relativeDistance(a, b) {
    return Math.pow(a[0] - b[0], 2) +
           Math.pow(a[1] - b[1], 2) +
           Math.pow(a[2] - b[2], 2)
  }

  /**
   * Classify a color-corrected RGB value
   * @param {number} r - Red [0-255]
   * @param {number} g - Green [0-255]
   * @param {number} b - Blue [0-255]
   * @returns {{bits: [number,number,number], confidence: number, colorIndex: number, colorName: string}}
   */
  classify(r, g, b) {
    const brightness = (r + g + b) / 3

    // Handle black/white by brightness (they have the same relative tuple)
    if (brightness < this.blackThreshold) {
      const conf = this.brightnessConfidence(brightness, 'dark')
      return {
        bits: [1, 1, 1],
        confidence: conf,
        colorIndex: 7,
        colorName: 'black'
      }
    }

    if (brightness > this.whiteThreshold) {
      const conf = this.brightnessConfidence(brightness, 'light')
      return {
        bits: [0, 0, 0],
        confidence: conf,
        colorIndex: 0,
        colorName: 'white'
      }
    }

    // For chromatic colors, compute relative tuple and find nearest match
    const rel = this.toRelative(r, g, b)
    const relNorm = this.normalizeRelative(rel)

    // Find best and second-best matches among chromatic colors (indices 1-6)
    let bestDist = Infinity
    let secondDist = Infinity
    let bestTarget = null

    for (const target of this.targets) {
      // Skip black/white for chromatic matching
      if (target.colorIndex === 0 || target.colorIndex === 7) continue

      const dist = this.relativeDistance(relNorm, target.relNorm)

      if (dist < bestDist) {
        secondDist = bestDist
        bestDist = dist
        bestTarget = target
      } else if (dist < secondDist) {
        secondDist = dist
      }
    }

    // Compute confidence based on separation between best and second-best
    const confidence = this.computeConfidence(bestDist, secondDist)

    // If confidence is very low, fall back to brightness-based decision
    if (confidence < 0.2) {
      // Ambiguous - check if closer to black or white by brightness
      if (brightness < 128) {
        return {
          bits: [1, 1, 1],
          confidence: 0.1,
          colorIndex: 7,
          colorName: 'black (fallback)'
        }
      } else {
        return {
          bits: [0, 0, 0],
          confidence: 0.1,
          colorIndex: 0,
          colorName: 'white (fallback)'
        }
      }
    }

    return {
      bits: bestTarget.bits,
      confidence,
      colorIndex: bestTarget.colorIndex,
      colorName: bestTarget.name
    }
  }

  /**
   * Compute confidence based on distance ratio
   * High confidence when best match is much closer than second-best
   */
  computeConfidence(bestDist, secondDist) {
    if (secondDist === 0) return 0  // Degenerate case
    if (bestDist === 0) return 1    // Perfect match

    // Ratio-based confidence: confident when bestDist << secondDist
    const ratio = bestDist / secondDist
    return Math.max(0, Math.min(1, 1 - ratio))
  }

  /**
   * Compute confidence for black/white classification based on brightness
   */
  brightnessConfidence(brightness, type) {
    if (type === 'dark') {
      // More confident as brightness approaches 0
      return Math.min(1, (this.blackThreshold - brightness) / this.blackThreshold)
    } else {
      // More confident as brightness approaches 255
      return Math.min(1, (brightness - this.whiteThreshold) / (255 - this.whiteThreshold))
    }
  }

  /**
   * Alternative classification using simple threshold approach
   * This is faster but less robust than relative distance matching
   * @param {number} r - Red [0-255]
   * @param {number} g - Green [0-255]
   * @param {number} b - Blue [0-255]
   * @returns {{bits: [number,number,number], confidence: number}}
   */
  classifyThreshold(r, g, b) {
    const brightness = (r + g + b) / 3

    // Black/white by brightness
    if (brightness < this.blackThreshold) {
      return { bits: [1, 1, 1], confidence: 0.8 }
    }
    if (brightness > this.whiteThreshold) {
      return { bits: [0, 0, 0], confidence: 0.8 }
    }

    // For chromatic colors, check each channel relative to average
    // Cyan = low R relative to others
    // Magenta = low G relative to others
    // Yellow = low B relative to others

    const avg = brightness
    const margin = 30  // How far below average to trigger

    const cyanBit = (r < avg - margin) ? 1 : 0
    const magentaBit = (g < avg - margin) ? 1 : 0
    const yellowBit = (b < avg - margin) ? 1 : 0

    // Confidence based on how clearly the bits are set
    const cyanMargin = Math.abs(r - avg)
    const magentaMargin = Math.abs(g - avg)
    const yellowMargin = Math.abs(b - avg)
    const minMargin = Math.min(cyanMargin, magentaMargin, yellowMargin)

    const confidence = Math.min(1, minMargin / 50)

    return {
      bits: [cyanBit, magentaBit, yellowBit],
      confidence
    }
  }

  /**
   * Get the expected RGB for a color index (for debugging/visualization)
   */
  getExpectedRGB(colorIndex) {
    const rgbTable = [
      [255, 255, 255], // 0: White
      [0, 255, 255],   // 1: Cyan
      [255, 0, 255],   // 2: Magenta
      [255, 255, 0],   // 3: Yellow
      [0, 0, 255],     // 4: Blue
      [0, 255, 0],     // 5: Green
      [255, 0, 0],     // 6: Red
      [0, 0, 0]        // 7: Black
    ]
    return rgbTable[colorIndex] || [128, 128, 128]
  }
}
