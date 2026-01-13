// ModuleGrid - Maps QR module coordinates to image pixel positions
// Uses bilinear interpolation from detected corner positions

/**
 * Calculate distance between two points
 */
function distance(p1, p2) {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2))
}

/**
 * ModuleGrid maps QR module coordinates (row, col) to image pixel positions.
 * Uses bilinear interpolation across the 4 detected corners for perspective correction.
 */
export class ModuleGrid {
  /**
   * @param {Object} qrLocation - jsQR location object with corner points
   * @param {number} qrVersion - QR code version (1-40), default 2 (25x25)
   */
  constructor(qrLocation, qrVersion = 2) {
    this.version = qrVersion
    this.size = 17 + (qrVersion * 4)  // Version 1 = 21, Version 2 = 25, etc.

    // Store corners
    this.topLeft = qrLocation.topLeftCorner
    this.topRight = qrLocation.topRightCorner
    this.bottomLeft = qrLocation.bottomLeftCorner
    this.bottomRight = qrLocation.bottomRightCorner || this.inferBottomRight()

    // Precompute module size estimate
    this._moduleSize = null
  }

  /**
   * Infer bottom-right corner if not provided (jsQR sometimes omits it)
   */
  inferBottomRight() {
    // Use parallelogram geometry: BR = TR + BL - TL
    return {
      x: this.topRight.x + this.bottomLeft.x - this.topLeft.x,
      y: this.topRight.y + this.bottomLeft.y - this.topLeft.y
    }
  }

  /**
   * Get pixel position for module center at (row, col)
   * Uses bilinear interpolation for perspective correction
   * @param {number} row - Module row (0 to size-1)
   * @param {number} col - Module column (0 to size-1)
   * @returns {{x: number, y: number}} Pixel coordinates
   */
  getModuleCenter(row, col) {
    // Normalize to [0, 1] range, centering on module
    const u = (col + 0.5) / this.size
    const v = (row + 0.5) / this.size

    // Bilinear interpolation
    // P = (1-u)(1-v)*TL + u(1-v)*TR + (1-u)v*BL + uv*BR
    const x = (1 - u) * (1 - v) * this.topLeft.x +
              u * (1 - v) * this.topRight.x +
              (1 - u) * v * this.bottomLeft.x +
              u * v * this.bottomRight.x

    const y = (1 - u) * (1 - v) * this.topLeft.y +
              u * (1 - v) * this.topRight.y +
              (1 - u) * v * this.bottomLeft.y +
              u * v * this.bottomRight.y

    return { x, y }
  }

  /**
   * Get approximate module size in pixels
   * @returns {number} Module size
   */
  getModuleSize() {
    if (this._moduleSize === null) {
      // Average of horizontal and vertical spans
      const topWidth = distance(this.topLeft, this.topRight)
      const bottomWidth = distance(this.bottomLeft, this.bottomRight)
      const leftHeight = distance(this.topLeft, this.bottomLeft)
      const rightHeight = distance(this.topRight, this.bottomRight)

      const avgWidth = (topWidth + bottomWidth) / 2
      const avgHeight = (leftHeight + rightHeight) / 2

      this._moduleSize = (avgWidth + avgHeight) / 2 / this.size
    }
    return this._moduleSize
  }

  /**
   * Check if module is part of a fixed pattern (finder, timing, alignment)
   * These should not be color-decoded as they are always black/white
   * @param {number} row
   * @param {number} col
   * @returns {boolean}
   */
  isFixedPattern(row, col) {
    // Finder patterns: 7x7 in three corners
    // Top-left finder
    if (row < 7 && col < 7) return true
    // Top-right finder
    if (row < 7 && col >= this.size - 7) return true
    // Bottom-left finder
    if (row >= this.size - 7 && col < 7) return true

    // Timing patterns: row 6 and column 6 (between finders)
    if (row === 6 && col >= 8 && col < this.size - 8) return true
    if (col === 6 && row >= 8 && row < this.size - 8) return true

    // Alignment patterns (version 2+)
    if (this.version >= 2) {
      const alignPositions = this.getAlignmentPositions()
      for (const pos of alignPositions) {
        if (Math.abs(row - pos.row) <= 2 && Math.abs(col - pos.col) <= 2) {
          // Check it's not overlapping with finder
          if (!this.isFinderArea(pos.row, pos.col)) {
            return true
          }
        }
      }
    }

    // Format information areas (around finders)
    // Row 8, cols 0-8 and size-8 to size-1
    if (row === 8 && (col < 9 || col >= this.size - 8)) return true
    // Col 8, rows 0-8 and size-7 to size-1
    if (col === 8 && (row < 9 || row >= this.size - 7)) return true

    // Dark module (always present at row size-8, col 8)
    if (row === this.size - 8 && col === 8) return true

    return false
  }

  /**
   * Check if position is within a finder pattern area
   */
  isFinderArea(row, col) {
    if (row < 7 && col < 7) return true
    if (row < 7 && col >= this.size - 7) return true
    if (row >= this.size - 7 && col < 7) return true
    return false
  }

  /**
   * Get alignment pattern center positions for this QR version
   * @returns {Array<{row: number, col: number}>}
   */
  getAlignmentPositions() {
    // Alignment pattern positions vary by version
    // For simplicity, using approximate positions for common versions
    const alignmentTable = {
      2: [18],
      3: [22],
      4: [26],
      5: [30],
      6: [34],
      7: [6, 22, 38],
      // Add more as needed
    }

    const coords = alignmentTable[this.version]
    if (!coords) return []

    const positions = []
    for (const r of coords) {
      for (const c of coords) {
        // Skip positions that overlap with finders
        if (!this.isFinderArea(r, c)) {
          positions.push({ row: r, col: c })
        }
      }
    }

    // For version 2, there's just one at (18, 18) for a 25x25 grid
    // But our size formula gives 25 for version 2, so position is size - 7 = 18
    if (this.version === 2) {
      return [{ row: this.size - 7, col: this.size - 7 }]
    }

    return positions
  }

  /**
   * Get the black/white pattern for a fixed module
   * @param {number} row
   * @param {number} col
   * @returns {boolean} true if black, false if white
   */
  getFixedModuleColor(row, col) {
    // Finder pattern (7x7)
    const checkFinder = (r, c) => {
      // Outer ring - black
      if (r === 0 || r === 6 || c === 0 || c === 6) return true
      // Inner ring - white
      if (r === 1 || r === 5 || c === 1 || c === 5) return false
      // Center 3x3 - black
      return true
    }

    // Top-left finder
    if (row < 7 && col < 7) {
      return checkFinder(row, col)
    }
    // Top-right finder
    if (row < 7 && col >= this.size - 7) {
      return checkFinder(row, col - (this.size - 7))
    }
    // Bottom-left finder
    if (row >= this.size - 7 && col < 7) {
      return checkFinder(row - (this.size - 7), col)
    }

    // Timing patterns - alternating, starting with black
    if (row === 6) return col % 2 === 0
    if (col === 6) return row % 2 === 0

    // Alignment pattern (5x5)
    if (this.version >= 2) {
      const alignPos = this.size - 7  // For version 2
      const ar = row - alignPos + 2
      const ac = col - alignPos + 2
      if (ar >= 0 && ar <= 4 && ac >= 0 && ac <= 4) {
        // Outer ring - black
        if (ar === 0 || ar === 4 || ac === 0 || ac === 4) return true
        // Inner ring - white
        if (ar === 1 || ar === 3 || ac === 1 || ac === 3) return false
        // Center - black
        return true
      }
    }

    // Dark module
    if (row === this.size - 8 && col === 8) return true

    // Format/version info - varies, default to white (will be overwritten)
    return false
  }

  /**
   * Get list of all data module positions (non-fixed)
   * @returns {Array<{row: number, col: number}>}
   */
  getDataModules() {
    const modules = []
    for (let row = 0; row < this.size; row++) {
      for (let col = 0; col < this.size; col++) {
        if (!this.isFixedPattern(row, col)) {
          modules.push({ row, col })
        }
      }
    }
    return modules
  }
}
