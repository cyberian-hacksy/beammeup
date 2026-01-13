// DriftTracker - Per-module position tracking for camera shake compensation
// Implements libcimbar's cell drift tracking with 9-point offset grid

/**
 * 9-point offset grid for drift tracking
 * Ordered by distance from center (prefer smaller adjustments)
 */
const OFFSET_GRID = [
  [0, 0],    // Center (no drift)
  [-1, 0], [1, 0], [0, -1], [0, 1],  // Cardinal directions
  [-1, -1], [1, -1], [-1, 1], [1, 1] // Diagonals
]

/**
 * DriftTracker tracks per-module position offsets to handle camera shake
 * and local distortions.
 *
 * Key mechanisms:
 * - Try 9-point offset grid to find best sampling position
 * - Cumulative drift up to ±maxDrift pixels
 * - Cooldown prevents oscillation between positions
 * - Successful drift propagates to neighbors
 */
export class DriftTracker {
  /**
   * @param {number} gridSize - QR module grid size (e.g., 25 for version 2)
   */
  constructor(gridSize) {
    this.gridSize = gridSize
    this.maxDrift = 7  // Maximum cumulative drift per direction

    // Per-module drift state: Map<"row,col" -> DriftState>
    this.drifts = new Map()
  }

  /**
   * Get current drift state for a module
   * @param {number} row
   * @param {number} col
   * @returns {{dx: number, dy: number, confidence: number, cooldown: Set}}
   */
  getDrift(row, col) {
    const key = `${row},${col}`
    let drift = this.drifts.get(key)

    if (!drift) {
      drift = {
        dx: 0,
        dy: 0,
        confidence: 0,
        cooldown: new Set()
      }
      this.drifts.set(key, drift)
    }

    return drift
  }

  /**
   * Set drift state for a module
   */
  setDrift(row, col, state) {
    const key = `${row},${col}`
    this.drifts.set(key, state)
  }

  /**
   * Try to classify a module, testing offsets if needed
   * @param {number} row - Module row
   * @param {number} col - Module column
   * @param {ModuleGrid} moduleGrid - Grid for position mapping
   * @param {ImageData} imageData - Frame pixel data
   * @param {ColorCorrector} colorCorrector - Color correction
   * @param {RelativeColorClassifier} classifier - Color classifier
   * @returns {{bits, confidence, drift, sampledRGB, correctedRGB}|null}
   */
  classifyWithDrift(row, col, moduleGrid, imageData, colorCorrector, classifier) {
    const drift = this.getDrift(row, col)
    const basePos = moduleGrid.getModuleCenter(row, col)
    const moduleSize = moduleGrid.getModuleSize()

    let bestResult = null
    let bestConfidence = -1
    let bestOffset = [0, 0]

    // Try offsets, prioritizing current drift and nearby adjustments
    const offsetsToTry = this.prioritizeOffsets(drift)

    for (const [ox, oy] of offsetsToTry) {
      // Check cumulative drift limits
      const newDx = drift.dx + ox
      const newDy = drift.dy + oy
      if (Math.abs(newDx) > this.maxDrift || Math.abs(newDy) > this.maxDrift) {
        continue
      }

      // Check cooldown (avoid recently-failed offsets)
      const offsetKey = `${ox},${oy}`
      if (drift.cooldown.has(offsetKey)) {
        continue
      }

      // Sample at offset position
      const sampleX = basePos.x + newDx
      const sampleY = basePos.y + newDy

      const rgb = this.sampleModule(imageData, sampleX, sampleY, moduleSize)
      if (!rgb) continue

      // Apply color correction and classify
      const corrected = colorCorrector.correct(rgb[0], rgb[1], rgb[2])
      const result = classifier.classify(corrected[0], corrected[1], corrected[2])

      if (result.confidence > bestConfidence) {
        bestConfidence = result.confidence
        bestResult = {
          ...result,
          sampledRGB: rgb,
          correctedRGB: corrected
        }
        bestOffset = [ox, oy]

        // Early exit on high confidence
        if (bestConfidence > 0.85) break
      }
    }

    if (!bestResult) return null

    // Update drift state based on result
    if (bestConfidence > 0.5) {
      // Good confidence - update drift
      this.setDrift(row, col, {
        dx: drift.dx + bestOffset[0],
        dy: drift.dy + bestOffset[1],
        confidence: bestConfidence,
        cooldown: new Set()  // Clear cooldown on success
      })
    } else {
      // Low confidence - add offset to cooldown
      drift.cooldown.add(`${bestOffset[0]},${bestOffset[1]}`)
    }

    // Return result with final drift
    return {
      ...bestResult,
      drift: {
        dx: drift.dx + bestOffset[0],
        dy: drift.dy + bestOffset[1]
      }
    }
  }

  /**
   * Prioritize offsets: prefer staying at current position, then small adjustments
   */
  prioritizeOffsets(drift) {
    // Start with standard grid (already sorted by distance)
    return [...OFFSET_GRID]
  }

  /**
   * Sample a module's color from image data
   * Uses center region average for noise reduction
   * @param {ImageData} imageData
   * @param {number} centerX - Sample center X
   * @param {number} centerY - Sample center Y
   * @param {number} moduleSize - Approximate module size in pixels
   * @returns {[number, number, number]|null} RGB or null if out of bounds
   */
  sampleModule(imageData, centerX, centerY, moduleSize) {
    const pixels = imageData.data
    const width = imageData.width
    const height = imageData.height

    // Sample center 50% of module to avoid edge effects
    const sampleRadius = Math.max(1, moduleSize * 0.25)

    let rSum = 0, gSum = 0, bSum = 0, count = 0

    const startX = Math.floor(centerX - sampleRadius)
    const endX = Math.ceil(centerX + sampleRadius)
    const startY = Math.floor(centerY - sampleRadius)
    const endY = Math.ceil(centerY + sampleRadius)

    for (let py = startY; py <= endY; py++) {
      for (let px = startX; px <= endX; px++) {
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const idx = (py * width + px) * 4
          rSum += pixels[idx]
          gSum += pixels[idx + 1]
          bSum += pixels[idx + 2]
          count++
        }
      }
    }

    if (count === 0) return null

    return [
      Math.round(rSum / count),
      Math.round(gSum / count),
      Math.round(bSum / count)
    ]
  }

  /**
   * Propagate drift from a successfully classified module to its neighbors
   * Only propagates if source has high confidence
   * @param {number} row
   * @param {number} col
   */
  propagateToNeighbors(row, col) {
    const sourceDrift = this.getDrift(row, col)

    // Only propagate high-confidence drift
    if (sourceDrift.confidence < 0.7) return

    const neighbors = [
      [row - 1, col],
      [row + 1, col],
      [row, col - 1],
      [row, col + 1]
    ]

    for (const [nr, nc] of neighbors) {
      // Bounds check
      if (nr < 0 || nr >= this.gridSize || nc < 0 || nc >= this.gridSize) {
        continue
      }

      const neighborKey = `${nr},${nc}`
      const neighborDrift = this.drifts.get(neighborKey)

      // Only seed neighbors that haven't been classified yet (confidence = 0)
      if (!neighborDrift || neighborDrift.confidence === 0) {
        this.drifts.set(neighborKey, {
          dx: sourceDrift.dx,
          dy: sourceDrift.dy,
          confidence: 0,  // Not classified yet, just seeded with drift hint
          cooldown: new Set()
        })
      }
    }
  }

  /**
   * Reset for a new frame
   * Keeps drift estimates but clears cooldowns and decays confidence
   */
  resetForNewFrame() {
    for (const [key, drift] of this.drifts) {
      drift.cooldown.clear()
      // Decay confidence to allow re-evaluation
      drift.confidence *= 0.9
    }
  }

  /**
   * Full reset (e.g., when QR code changes)
   */
  reset() {
    this.drifts.clear()
  }

  /**
   * Get statistics about current drift state
   */
  getStats() {
    let totalDx = 0, totalDy = 0, count = 0
    let maxDx = 0, maxDy = 0

    for (const [, drift] of this.drifts) {
      if (drift.confidence > 0) {
        totalDx += Math.abs(drift.dx)
        totalDy += Math.abs(drift.dy)
        maxDx = Math.max(maxDx, Math.abs(drift.dx))
        maxDy = Math.max(maxDy, Math.abs(drift.dy))
        count++
      }
    }

    return {
      avgDrift: count > 0 ? (totalDx + totalDy) / count / 2 : 0,
      maxDrift: Math.max(maxDx, maxDy),
      trackedModules: count
    }
  }
}
