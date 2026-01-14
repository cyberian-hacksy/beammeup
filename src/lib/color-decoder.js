// ColorQRDecoder - Main orchestrator for color QR decoding
// Applies libcimbar techniques: relative colors, color correction, drift tracking, priority decoding

// Debug mode - enabled via ?test URL parameter
const DEBUG_MODE = typeof location !== 'undefined' && location.search.includes('test')

import { ModuleGrid } from './color/module-grid.js'
import { ColorCorrector } from './color/color-corrector.js'
import { RelativeColorClassifier } from './color/relative-classifier.js'
import { LABColorClassifier } from './color/lab-classifier.js'
import { DriftTracker } from './color/drift-tracker.js'
import { PriorityDecoder } from './color/priority-decoder.js'

/**
 * ColorQRDecoder orchestrates the color QR decoding pipeline:
 * 1. Build module grid from detected QR position
 * 2. Build color correction matrix from finder patterns
 * 3. Decode modules in priority order with drift tracking
 * 4. Generate binary channel images for jsQR
 */
export class ColorQRDecoder {
  constructor(classifierType = 'lab') {
    this.grid = null
    this.corrector = new ColorCorrector()
    this.classifierType = classifierType
    this.classifier = this.createClassifier(classifierType)
    this.drift = null
    this.decoder = null

    // Persist drift tracker across frames for continuity
    this.persistentDrift = null
    this.lastGridSize = 0
  }

  /**
   * Create a color classifier of the specified type
   * @param {string} type - 'lab' or 'relative'
   */
  createClassifier(type) {
    switch (type) {
      case 'lab':
        return new LABColorClassifier()
      case 'relative':
      default:
        return new RelativeColorClassifier()
    }
  }

  /**
   * Switch to a different classifier type
   * @param {string} type - 'lab' or 'relative'
   */
  setClassifierType(type) {
    if (this.classifierType !== type) {
      this.classifierType = type
      this.classifier = this.createClassifier(type)
      if (DEBUG_MODE) console.log(`[ColorQRDecoder] switched to ${type} classifier`)
    }
  }

  /**
   * Main entry point: decode a color QR frame
   * @param {ImageData} imageData - Frame pixel data
   * @param {Object} qrLocation - jsQR location object with corner points
   * @param {number} qrVersion - QR code version (auto-detected if not provided)
   * @returns {{channels, results, stats}}
   */
  decode(imageData, qrLocation, qrVersion = null) {
    // Step 1: Detect QR version if not provided
    if (qrVersion === null) {
      qrVersion = this.detectVersion(qrLocation)
    }

    // Step 1b: Build module grid from detected QR position
    this.grid = new ModuleGrid(qrLocation, qrVersion)
    if (DEBUG_MODE) console.log(`[ColorQRDecoder] version=${qrVersion}, gridSize=${this.grid.size}, moduleSize=${this.grid.getModuleSize().toFixed(1)}px`)

    // Step 2: Initialize or reset drift tracker
    // Keep drift across frames if grid size matches (same QR code)
    if (!this.persistentDrift || this.lastGridSize !== this.grid.size) {
      this.persistentDrift = new DriftTracker(this.grid.size)
      this.lastGridSize = this.grid.size
    } else {
      this.persistentDrift.resetForNewFrame()
    }
    this.drift = this.persistentDrift

    // Step 3: Build color correction matrix from finder patterns
    const references = this.sampleFinderReferences(imageData, qrLocation)
    this.corrector.buildFromReferences(references.observed, references.expected)

    // Step 4: Create priority decoder and decode all modules
    this.decoder = new PriorityDecoder(
      this.grid,
      this.drift,
      this.corrector,
      this.classifier
    )

    const results = this.decoder.decodeAll(imageData)

    // Step 5: Build binary channel images (per-pixel classification)
    const channels = this.decoder.buildChannelImages(imageData.width, imageData.height, imageData)
    if (DEBUG_MODE) console.log(`[ColorQRDecoder] built channel images ${channels.size}x${channels.size}`)

    // Step 6: Compute statistics
    const decoderStats = this.decoder.getStats()
    const driftStats = this.drift.getStats()
    const colorDist = this.decoder.getColorDistribution()

    const stats = {
      ...decoderStats,
      avgDrift: driftStats.avgDrift,
      maxDrift: driftStats.maxDrift,
      colorDistribution: colorDist,
      correctorMode: this.corrector.getDebugInfo(),
      classifierType: this.classifierType
    }

    return { channels, results, stats }
  }

  /**
   * Sample known colors from finder patterns for color correction
   * @param {ImageData} imageData
   * @param {Object} qrLocation - jsQR location with corners
   * @returns {{observed: Array, expected: Array}}
   */
  sampleFinderReferences(imageData, qrLocation) {
    const observed = []
    const expected = []

    // Sample black from finder pattern centers
    const blackSamples = this.sampleFinderCenters(imageData, qrLocation)
    if (blackSamples.length > 0) {
      const avgBlack = this.averageColors(blackSamples)
      observed.push(avgBlack)
      expected.push([0, 0, 0])
    }

    // Sample white from finder pattern rings
    const whiteSamples = this.sampleFinderRings(imageData, qrLocation)
    if (whiteSamples.length > 0) {
      const avgWhite = this.averageColors(whiteSamples)
      observed.push(avgWhite)
      expected.push([255, 255, 255])
    }

    return { observed, expected }
  }

  /**
   * Detect QR version from the location data
   * Finder patterns are always 7 modules, so we can estimate version from QR size
   */
  detectVersion(qrLocation) {
    const { topLeftCorner, topRightCorner, bottomLeftCorner } = qrLocation

    // Calculate QR dimensions in pixels
    const qrWidth = Math.sqrt(
      Math.pow(topRightCorner.x - topLeftCorner.x, 2) +
      Math.pow(topRightCorner.y - topLeftCorner.y, 2)
    )
    const qrHeight = Math.sqrt(
      Math.pow(bottomLeftCorner.x - topLeftCorner.x, 2) +
      Math.pow(bottomLeftCorner.y - topLeftCorner.y, 2)
    )

    const avgSize = (qrWidth + qrHeight) / 2

    // Find the version that gives module size closest to ideal (8-12 pixels)
    // Version n has size = 17 + 4*n modules
    let bestVersion = 2
    let bestScore = Infinity

    for (let v = 1; v <= 10; v++) {
      const moduleCount = 17 + 4 * v
      const moduleSize = avgSize / moduleCount

      // Skip if module size is unreasonable
      if (moduleSize < 3 || moduleSize > 30) continue

      // Score: prefer module sizes around 8-12 pixels (optimal for cameras)
      const idealSize = 10
      const score = Math.abs(moduleSize - idealSize)

      if (score < bestScore) {
        bestScore = score
        bestVersion = v
      }
    }

    // Store detected info for debugging
    this.detectedQrSize = avgSize
    this.detectedModuleSize = avgSize / (17 + 4 * bestVersion)

    return bestVersion
  }

  /**
   * Sample black centers of finder patterns
   */
  sampleFinderCenters(imageData, qrLocation) {
    const samples = []
    const { topLeftCorner, topRightCorner, bottomLeftCorner } = qrLocation

    // Calculate approximate module size and offset to center
    const qrWidth = Math.sqrt(
      Math.pow(topRightCorner.x - topLeftCorner.x, 2) +
      Math.pow(topRightCorner.y - topLeftCorner.y, 2)
    )
    const moduleSize = qrWidth / this.grid.size
    const offsetToCenter = moduleSize * 3.5  // Center is 3.5 modules in from corner

    // Direction vectors
    const toRight = {
      x: (topRightCorner.x - topLeftCorner.x) / qrWidth,
      y: (topRightCorner.y - topLeftCorner.y) / qrWidth
    }
    const toBottom = {
      x: (bottomLeftCorner.x - topLeftCorner.x) / qrWidth,
      y: (bottomLeftCorner.y - topLeftCorner.y) / qrWidth
    }

    // Top-left finder center
    const tlCenterX = topLeftCorner.x + offsetToCenter * toRight.x + offsetToCenter * toBottom.x
    const tlCenterY = topLeftCorner.y + offsetToCenter * toRight.y + offsetToCenter * toBottom.y
    samples.push(this.samplePixel(imageData, tlCenterX, tlCenterY))

    // Top-right finder center
    const trCenterX = topRightCorner.x - offsetToCenter * toRight.x + offsetToCenter * toBottom.x
    const trCenterY = topRightCorner.y - offsetToCenter * toRight.y + offsetToCenter * toBottom.y
    samples.push(this.samplePixel(imageData, trCenterX, trCenterY))

    // Bottom-left finder center
    const blCenterX = bottomLeftCorner.x + offsetToCenter * toRight.x - offsetToCenter * toBottom.x
    const blCenterY = bottomLeftCorner.y + offsetToCenter * toRight.y - offsetToCenter * toBottom.y
    samples.push(this.samplePixel(imageData, blCenterX, blCenterY))

    return samples.filter(s => s !== null)
  }

  /**
   * Sample white rings inside finder patterns
   */
  sampleFinderRings(imageData, qrLocation) {
    const samples = []
    const { topLeftCorner, topRightCorner, bottomLeftCorner } = qrLocation

    const qrWidth = Math.sqrt(
      Math.pow(topRightCorner.x - topLeftCorner.x, 2) +
      Math.pow(topRightCorner.y - topLeftCorner.y, 2)
    )
    const moduleSize = qrWidth / this.grid.size

    // Direction vectors
    const toRight = {
      x: (topRightCorner.x - topLeftCorner.x) / qrWidth,
      y: (topRightCorner.y - topLeftCorner.y) / qrWidth
    }
    const toBottom = {
      x: (bottomLeftCorner.x - topLeftCorner.x) / qrWidth,
      y: (bottomLeftCorner.y - topLeftCorner.y) / qrWidth
    }

    // White ring is at 1.5 modules from corner, 3.5 modules along each edge
    const whiteOffset = moduleSize * 1.5
    const whiteMidOffset = moduleSize * 3.5

    // Top edge of white ring (top-left finder)
    const tlWhiteTopX = topLeftCorner.x + whiteMidOffset * toRight.x + whiteOffset * toBottom.x
    const tlWhiteTopY = topLeftCorner.y + whiteMidOffset * toRight.y + whiteOffset * toBottom.y
    samples.push(this.samplePixel(imageData, tlWhiteTopX, tlWhiteTopY))

    // Left edge of white ring (top-left finder)
    const tlWhiteLeftX = topLeftCorner.x + whiteOffset * toRight.x + whiteMidOffset * toBottom.x
    const tlWhiteLeftY = topLeftCorner.y + whiteOffset * toRight.y + whiteMidOffset * toBottom.y
    samples.push(this.samplePixel(imageData, tlWhiteLeftX, tlWhiteLeftY))

    // Bottom edge of white ring (top-left finder)
    const tlWhiteBottomX = topLeftCorner.x + whiteMidOffset * toRight.x + (moduleSize * 5.5) * toBottom.x
    const tlWhiteBottomY = topLeftCorner.y + whiteMidOffset * toRight.y + (moduleSize * 5.5) * toBottom.y
    samples.push(this.samplePixel(imageData, tlWhiteBottomX, tlWhiteBottomY))

    return samples.filter(s => s !== null)
  }

  /**
   * Sample a pixel with 3x3 median for noise reduction
   */
  samplePixel(imageData, cx, cy) {
    const pixels = imageData.data
    const width = imageData.width
    const height = imageData.height

    const rs = [], gs = [], bs = []

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = Math.max(0, Math.min(width - 1, Math.floor(cx + dx)))
        const py = Math.max(0, Math.min(height - 1, Math.floor(cy + dy)))
        const idx = (py * width + px) * 4
        rs.push(pixels[idx])
        gs.push(pixels[idx + 1])
        bs.push(pixels[idx + 2])
      }
    }

    rs.sort((a, b) => a - b)
    gs.sort((a, b) => a - b)
    bs.sort((a, b) => a - b)

    return [rs[4], gs[4], bs[4]]  // Median
  }

  /**
   * Average multiple color samples
   */
  averageColors(samples) {
    if (samples.length === 0) return [128, 128, 128]

    let r = 0, g = 0, b = 0
    for (const s of samples) {
      r += s[0]
      g += s[1]
      b += s[2]
    }

    return [
      Math.round(r / samples.length),
      Math.round(g / samples.length),
      Math.round(b / samples.length)
    ]
  }

  /**
   * Reset decoder state (e.g., when switching to a new QR code)
   */
  reset() {
    if (this.persistentDrift) {
      this.persistentDrift.reset()
    }
    this.lastGridSize = 0
  }
}
