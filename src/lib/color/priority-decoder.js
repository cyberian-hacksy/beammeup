// PriorityDecoder - Confidence-ordered module classification
// Decodes modules starting from high-confidence anchors near finder patterns

/**
 * PriorityDecoder decodes QR modules in order of confidence, starting from
 * stable "anchor" modules near finder patterns and propagating outward.
 *
 * Algorithm:
 * 1. Seed queue with modules adjacent to finder patterns
 * 2. Pop highest-priority module from queue
 * 3. Classify with drift tracking
 * 4. If confident, propagate drift to neighbors and add them to queue
 * 5. Repeat until all data modules classified
 */
export class PriorityDecoder {
  /**
   * @param {ModuleGrid} moduleGrid - Module position mapper
   * @param {DriftTracker} driftTracker - Per-module drift tracker
   * @param {ColorCorrector} colorCorrector - Color correction
   * @param {RelativeColorClassifier} classifier - Color classifier
   */
  constructor(moduleGrid, driftTracker, colorCorrector, classifier) {
    this.grid = moduleGrid
    this.drift = driftTracker
    this.corrector = colorCorrector
    this.classifier = classifier

    this.size = moduleGrid.size

    // Results: Map<"row,col" -> classification result>
    this.results = new Map()

    // Priority queue: [{row, col, priority}]
    this.queue = []

    // Track which modules are queued to avoid duplicates
    this.queued = new Set()
  }

  /**
   * Decode all data modules in priority order
   * @param {ImageData} imageData - Frame pixel data
   * @returns {Map<string, Object>} Map of module results
   */
  decodeAll(imageData) {
    this.results.clear()
    this.queue = []
    this.queued.clear()

    // Phase 1: Seed with modules adjacent to finder patterns
    this.seedFromFinderPatterns()

    // Phase 2: Process queue in priority order
    while (this.queue.length > 0) {
      // Sort by priority (descending) - simple approach, could use heap for efficiency
      this.queue.sort((a, b) => b.priority - a.priority)

      const { row, col } = this.queue.shift()
      const key = `${row},${col}`

      // Skip if already processed
      if (this.results.has(key)) continue

      // Skip fixed patterns (finder, timing, alignment)
      if (this.grid.isFixedPattern(row, col)) continue

      // Classify with drift tracking
      const result = this.drift.classifyWithDrift(
        row, col,
        this.grid, imageData,
        this.corrector, this.classifier
      )

      if (result) {
        this.results.set(key, result)

        // Propagate drift to neighbors if confident
        if (result.confidence > 0.6) {
          this.drift.propagateToNeighbors(row, col)
          this.addNeighborsToQueue(row, col, result.confidence)
        }
      } else {
        // Failed to classify - mark with low confidence
        this.results.set(key, {
          bits: [0, 0, 0],
          confidence: 0,
          failed: true,
          colorName: 'failed'
        })
      }
    }

    // Phase 3: Handle any remaining unvisited modules
    this.processRemaining(imageData)

    return this.results
  }

  /**
   * Seed queue with modules adjacent to the three finder patterns
   * These are our highest-confidence starting points
   */
  seedFromFinderPatterns() {
    const finderAdjacent = []

    // Modules just outside top-left finder (7x7 at position 0,0)
    // Row 7, cols 0-7 (below finder)
    for (let c = 0; c <= 7; c++) {
      finderAdjacent.push([7, c])
    }
    // Rows 0-7, col 7 (right of finder)
    for (let r = 0; r <= 7; r++) {
      finderAdjacent.push([r, 7])
    }

    // Modules just outside top-right finder (at position 0, size-7)
    // Row 7, cols size-8 to size-1 (below finder)
    for (let c = this.size - 8; c < this.size; c++) {
      finderAdjacent.push([7, c])
    }
    // Rows 0-7, col size-8 (left of finder)
    for (let r = 0; r <= 7; r++) {
      finderAdjacent.push([r, this.size - 8])
    }

    // Modules just outside bottom-left finder (at position size-7, 0)
    // Row size-8, cols 0-7 (above finder)
    for (let c = 0; c <= 7; c++) {
      finderAdjacent.push([this.size - 8, c])
    }
    // Rows size-8 to size-1, col 7 (right of finder)
    for (let r = this.size - 8; r < this.size; r++) {
      finderAdjacent.push([r, 7])
    }

    // Add to queue with high initial priority
    for (const [row, col] of finderAdjacent) {
      this.addToQueue(row, col, 100)
    }

    this.seededCount = this.queue.length
  }

  /**
   * Add a module to the priority queue if not already queued/processed
   */
  addToQueue(row, col, priority) {
    // Bounds check
    if (row < 0 || row >= this.size || col < 0 || col >= this.size) return

    const key = `${row},${col}`

    // Skip if already processed or queued
    if (this.results.has(key)) return
    if (this.queued.has(key)) return

    // Skip fixed patterns
    if (this.grid.isFixedPattern(row, col)) return

    this.queue.push({ row, col, priority })
    this.queued.add(key)
  }

  /**
   * Add unvisited neighbors to queue with priority based on parent's confidence
   */
  addNeighborsToQueue(row, col, parentConfidence) {
    const neighbors = [
      [row - 1, col],
      [row + 1, col],
      [row, col - 1],
      [row, col + 1]
    ]

    // Priority decays as we move away from anchors
    const priority = parentConfidence * 0.9

    for (const [nr, nc] of neighbors) {
      this.addToQueue(nr, nc, priority)
    }
  }

  /**
   * Process any modules not reached by flood-fill
   * This handles isolated regions or modules we missed
   */
  processRemaining(imageData) {
    for (let row = 0; row < this.size; row++) {
      for (let col = 0; col < this.size; col++) {
        const key = `${row},${col}`

        // Skip if already processed
        if (this.results.has(key)) continue

        // Skip fixed patterns
        if (this.grid.isFixedPattern(row, col)) continue

        // Classify without drift hints (no neighbors to help)
        const result = this.drift.classifyWithDrift(
          row, col,
          this.grid, imageData,
          this.corrector, this.classifier
        )

        this.results.set(key, result || {
          bits: [0, 0, 0],
          confidence: 0,
          failed: true,
          colorName: 'failed (remaining)'
        })
      }
    }
  }

  /**
   * Build binary channel images from classification results
   * These are passed to jsQR for final decoding
   * Uses pixel-by-pixel approach for complete coverage (no gaps)
   * @param {number} width - Output image width
   * @param {number} height - Output image height
   * @returns {{ch0: Uint8ClampedArray, ch1: Uint8ClampedArray, ch2: Uint8ClampedArray, size: number}}
   */
  buildChannelImages(width, height) {
    const ch0 = new Uint8ClampedArray(width * height * 4)
    const ch1 = new Uint8ClampedArray(width * height * 4)
    const ch2 = new Uint8ClampedArray(width * height * 4)

    // Get QR bounds in pixel coordinates
    const tl = this.grid.topLeft
    const tr = this.grid.topRight
    const bl = this.grid.bottomLeft
    const br = this.grid.bottomRight

    // Compute bounding box
    const minX = Math.floor(Math.min(tl.x, tr.x, bl.x, br.x))
    const maxX = Math.ceil(Math.max(tl.x, tr.x, bl.x, br.x))
    const minY = Math.floor(Math.min(tl.y, tr.y, bl.y, br.y))
    const maxY = Math.ceil(Math.max(tl.y, tr.y, bl.y, br.y))

    // Process every pixel in the image
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const idx = (py * width + px) * 4

        // Default: white (outside QR area)
        let g0 = 255, g1 = 255, g2 = 255

        // Check if pixel is within QR bounding box
        if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
          // Map pixel to module coordinates using inverse bilinear
          const moduleCoord = this.pixelToModule(px, py)

          if (moduleCoord) {
            const { row, col } = moduleCoord

            // Check if this is a fixed pattern
            if (this.grid.isFixedPattern(row, col)) {
              const isBlack = this.grid.getFixedModuleColor(row, col)
              const value = isBlack ? 0 : 255
              g0 = g1 = g2 = value
            } else {
              // Look up classification result
              const key = `${row},${col}`
              const result = this.results.get(key)

              if (result) {
                const bits = result.bits || [0, 0, 0]
                g0 = bits[0] ? 0 : 255
                g1 = bits[1] ? 0 : 255
                g2 = bits[2] ? 0 : 255
              }
            }
          }
        }

        // Write to all three channels
        ch0[idx] = ch0[idx + 1] = ch0[idx + 2] = g0; ch0[idx + 3] = 255
        ch1[idx] = ch1[idx + 1] = ch1[idx + 2] = g1; ch1[idx + 3] = 255
        ch2[idx] = ch2[idx + 1] = ch2[idx + 2] = g2; ch2[idx + 3] = 255
      }
    }

    return { ch0, ch1, ch2, size: width }
  }

  /**
   * Map a pixel coordinate back to module (row, col)
   * Uses inverse bilinear interpolation with iterative refinement
   * @param {number} px - Pixel X
   * @param {number} py - Pixel Y
   * @returns {{row: number, col: number}|null}
   */
  pixelToModule(px, py) {
    const tl = this.grid.topLeft
    const tr = this.grid.topRight
    const bl = this.grid.bottomLeft
    const br = this.grid.bottomRight

    // Use iterative inverse bilinear interpolation
    // Initial guess using simple linear approximation
    const qrWidth = (tr.x - tl.x + br.x - bl.x) / 2
    const qrHeight = (bl.y - tl.y + br.y - tr.y) / 2

    let u = (px - tl.x) / qrWidth
    let v = (py - tl.y) / qrHeight

    // Quick bounds check
    if (u < -0.1 || u > 1.1 || v < -0.1 || v > 1.1) return null

    // Refine using Newton-Raphson iteration (2-3 iterations usually enough)
    for (let iter = 0; iter < 3; iter++) {
      // Forward bilinear: compute where (u, v) maps to
      const fx = (1 - u) * (1 - v) * tl.x + u * (1 - v) * tr.x +
                 (1 - u) * v * bl.x + u * v * br.x
      const fy = (1 - u) * (1 - v) * tl.y + u * (1 - v) * tr.y +
                 (1 - u) * v * bl.y + u * v * br.y

      // Error
      const ex = px - fx
      const ey = py - fy

      // Check convergence
      if (Math.abs(ex) < 0.5 && Math.abs(ey) < 0.5) break

      // Jacobian partial derivatives
      const dxdu = (1 - v) * (tr.x - tl.x) + v * (br.x - bl.x)
      const dxdv = (1 - u) * (bl.x - tl.x) + u * (br.x - tr.x)
      const dydu = (1 - v) * (tr.y - tl.y) + v * (br.y - bl.y)
      const dydv = (1 - u) * (bl.y - tl.y) + u * (br.y - tr.y)

      // Solve 2x2 linear system using Cramer's rule
      const det = dxdu * dydv - dxdv * dydu
      if (Math.abs(det) < 0.0001) break  // Degenerate

      const du = (ex * dydv - ey * dxdv) / det
      const dv = (dxdu * ey - dydu * ex) / det

      u += du
      v += dv
    }

    // Final bounds check
    if (u < 0 || u > 1 || v < 0 || v > 1) return null

    // Convert u, v to module coordinates
    const col = Math.floor(u * this.size)
    const row = Math.floor(v * this.size)

    // Validate bounds
    if (row < 0 || row >= this.size || col < 0 || col >= this.size) return null

    return { row, col }
  }

  /**
   * Paint a single module onto a channel buffer
   */
  paintModule(buffer, width, height, cx, cy, moduleSize, value) {
    const halfSize = moduleSize / 2
    const startX = Math.max(0, Math.floor(cx - halfSize))
    const endX = Math.min(width, Math.ceil(cx + halfSize))
    const startY = Math.max(0, Math.floor(cy - halfSize))
    const endY = Math.min(height, Math.ceil(cy + halfSize))

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        const idx = (y * width + x) * 4
        buffer[idx] = buffer[idx + 1] = buffer[idx + 2] = value
        buffer[idx + 3] = 255
      }
    }
  }

  /**
   * Paint fixed patterns (finder, timing, alignment) onto channel buffers
   * These are always black/white regardless of color mode
   */
  paintFixedPatterns(ch0, ch1, ch2, width, height) {
    for (let row = 0; row < this.size; row++) {
      for (let col = 0; col < this.size; col++) {
        if (this.grid.isFixedPattern(row, col)) {
          const pos = this.grid.getModuleCenter(row, col)
          const moduleSize = this.grid.getModuleSize()

          // Get the expected black/white value for this fixed module
          const isBlack = this.grid.getFixedModuleColor(row, col)
          const value = isBlack ? 0 : 255

          // Fixed patterns are the same in all channels
          this.paintModule(ch0, width, height, pos.x, pos.y, moduleSize, value)
          this.paintModule(ch1, width, height, pos.x, pos.y, moduleSize, value)
          this.paintModule(ch2, width, height, pos.x, pos.y, moduleSize, value)
        }
      }
    }
  }

  /**
   * Get statistics about the decoding results
   */
  getStats() {
    let totalConfidence = 0
    let count = 0
    let lowCount = 0
    let failedCount = 0

    for (const [, result] of this.results) {
      if (result.failed) {
        failedCount++
        continue
      }
      totalConfidence += result.confidence || 0
      count++
      if ((result.confidence || 0) < 0.5) {
        lowCount++
      }
    }

    return {
      avgConfidence: count > 0 ? totalConfidence / count : 0,
      totalModules: this.results.size,
      classifiedModules: count,
      lowConfidenceCount: lowCount,
      failedCount
    }
  }

  /**
   * Get color distribution statistics (for debugging)
   */
  getColorDistribution() {
    const counts = new Array(8).fill(0)

    for (const [, result] of this.results) {
      if (!result.failed && result.colorIndex !== undefined) {
        counts[result.colorIndex]++
      }
    }

    return counts
  }
}
