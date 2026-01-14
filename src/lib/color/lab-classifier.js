// LABColorClassifier - Color classification using CIE LAB color space
// LAB separates lightness (L) from chromaticity (a, b), making it robust to brightness changes

/**
 * CMY color targets with their LAB chromaticity coordinates (a, b)
 * L is used only to distinguish black/white from chromatic colors
 *
 * Reference LAB values for pure sRGB colors:
 * - White (255,255,255): L=100, a≈0, b≈0
 * - Black (0,0,0): L=0, a≈0, b≈0
 * - Cyan (0,255,255): L≈91, a≈-48, b≈-14
 * - Magenta (255,0,255): L≈60, a≈98, b≈-61
 * - Yellow (255,255,0): L≈97, a≈-21, b≈94
 * - Blue (0,0,255): L≈32, a≈79, b≈-108
 * - Green (0,255,0): L≈88, a≈-86, b≈83
 * - Red (255,0,0): L≈53, a≈80, b≈67
 */
const LAB_TARGETS = [
  { bits: [0, 0, 0], name: 'white',   a: 0,   b: 0,    isNeutral: true },
  { bits: [1, 0, 0], name: 'cyan',    a: -48, b: -14,  isNeutral: false },
  { bits: [0, 1, 0], name: 'magenta', a: 98,  b: -61,  isNeutral: false },
  { bits: [0, 0, 1], name: 'yellow',  a: -21, b: 94,   isNeutral: false },
  { bits: [1, 1, 0], name: 'blue',    a: 79,  b: -108, isNeutral: false },
  { bits: [1, 0, 1], name: 'green',   a: -86, b: 83,   isNeutral: false },
  { bits: [0, 1, 1], name: 'red',     a: 80,  b: 67,   isNeutral: false },
  { bits: [1, 1, 1], name: 'black',   a: 0,   b: 0,    isNeutral: true }
]

/**
 * LABColorClassifier classifies colors in CIE LAB space.
 * Key advantage: Chromaticity (a,b) is independent of Lightness (L).
 */
export class LABColorClassifier {
  constructor() {
    this.targets = LAB_TARGETS.map((t, i) => ({
      ...t,
      colorIndex: i
    }))

    // Thresholds for neutral color detection
    this.neutralChromaThreshold = 25  // Below this chroma = neutral (black or white)
    this.blackLThreshold = 40         // L below this = black
    this.whiteLThreshold = 70         // L above this = white
  }

  /**
   * Convert sRGB [0-255] to CIE LAB
   * Uses D65 illuminant (standard daylight)
   */
  rgbToLab(r, g, b) {
    // Step 1: sRGB to linear RGB
    let rLin = r / 255
    let gLin = g / 255
    let bLin = b / 255

    // Inverse gamma correction (sRGB)
    rLin = rLin > 0.04045 ? Math.pow((rLin + 0.055) / 1.055, 2.4) : rLin / 12.92
    gLin = gLin > 0.04045 ? Math.pow((gLin + 0.055) / 1.055, 2.4) : gLin / 12.92
    bLin = bLin > 0.04045 ? Math.pow((bLin + 0.055) / 1.055, 2.4) : bLin / 12.92

    // Step 2: Linear RGB to XYZ (sRGB matrix, D65)
    const x = rLin * 0.4124564 + gLin * 0.3575761 + bLin * 0.1804375
    const y = rLin * 0.2126729 + gLin * 0.7151522 + bLin * 0.0721750
    const z = rLin * 0.0193339 + gLin * 0.1191920 + bLin * 0.9503041

    // Step 3: XYZ to LAB (D65 reference white: Xn=0.95047, Yn=1.0, Zn=1.08883)
    const xn = 0.95047, yn = 1.0, zn = 1.08883

    const fx = this.labF(x / xn)
    const fy = this.labF(y / yn)
    const fz = this.labF(z / zn)

    const L = 116 * fy - 16
    const a = 500 * (fx - fy)
    const labB = 200 * (fy - fz)

    return { L, a, b: labB }
  }

  /**
   * LAB f function for the nonlinear transformation
   */
  labF(t) {
    const delta = 6 / 29
    if (t > delta * delta * delta) {
      return Math.cbrt(t)
    } else {
      return t / (3 * delta * delta) + 4 / 29
    }
  }

  /**
   * Compute chroma (saturation) in LAB space
   */
  chroma(a, b) {
    return Math.sqrt(a * a + b * b)
  }

  /**
   * Classify a color in RGB [0-255]
   * @param {number} r - Red [0-255]
   * @param {number} g - Green [0-255]
   * @param {number} b - Blue [0-255]
   * @returns {{bits: [number,number,number], confidence: number, colorIndex: number, colorName: string}}
   */
  classify(r, g, b) {
    const lab = this.rgbToLab(r, g, b)
    const c = this.chroma(lab.a, lab.b)

    // Handle neutral colors (low chroma) by lightness
    if (c < this.neutralChromaThreshold) {
      if (lab.L < this.blackLThreshold) {
        // Confidence increases as L approaches 0
        const conf = Math.min(1, (this.blackLThreshold - lab.L) / this.blackLThreshold)
        return {
          bits: [1, 1, 1],
          confidence: Math.max(0.3, conf),
          colorIndex: 7,
          colorName: 'black'
        }
      } else if (lab.L > this.whiteLThreshold) {
        // Confidence increases as L approaches 100
        const conf = Math.min(1, (lab.L - this.whiteLThreshold) / (100 - this.whiteLThreshold))
        return {
          bits: [0, 0, 0],
          confidence: Math.max(0.3, conf),
          colorIndex: 0,
          colorName: 'white'
        }
      } else {
        // Ambiguous neutral - use L to decide
        if (lab.L < 50) {
          return {
            bits: [1, 1, 1],
            confidence: 0.4,
            colorIndex: 7,
            colorName: 'black (neutral)'
          }
        } else {
          return {
            bits: [0, 0, 0],
            confidence: 0.4,
            colorIndex: 0,
            colorName: 'white (neutral)'
          }
        }
      }
    }

    // For chromatic colors, find nearest match in a,b plane
    let bestDist = Infinity
    let secondDist = Infinity
    let bestTarget = null

    for (const target of this.targets) {
      // Skip neutrals for chromatic matching
      if (target.isNeutral) continue

      // Distance in a,b chromaticity plane
      const dist = Math.pow(lab.a - target.a, 2) + Math.pow(lab.b - target.b, 2)

      if (dist < bestDist) {
        secondDist = bestDist
        bestDist = dist
        bestTarget = target
      } else if (dist < secondDist) {
        secondDist = dist
      }
    }

    // Confidence based on:
    // 1. How much closer best is than second-best
    // 2. How strong the chroma is (more saturated = more confident)
    const separation = secondDist > 0 ? 1 - (bestDist / secondDist) : 0
    const chromaConf = Math.min(1, c / 60)  // Full confidence at chroma >= 60
    const confidence = 0.5 * separation + 0.5 * chromaConf

    return {
      bits: bestTarget.bits,
      confidence: Math.max(0.1, Math.min(1, confidence)),
      colorIndex: bestTarget.colorIndex,
      colorName: bestTarget.name
    }
  }

  /**
   * Get LAB values for debugging
   */
  getLab(r, g, b) {
    return this.rgbToLab(r, g, b)
  }

  /**
   * Get the expected RGB for a color index
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
