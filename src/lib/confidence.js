// Confidence metrics for color classification

/**
 * Confidence for threshold-based decoding (layered approaches)
 * Returns confidence based on distance from threshold
 * @param {number} value - Normalized channel value [0, 1]
 * @param {number} threshold - Decision threshold (typically 0.5)
 * @param {number} range - Expected value range (e.g., 0.3 for values in [0.2, 0.8])
 * @returns {number} Confidence [0, 1]
 */
export function thresholdConfidence(value, threshold = 0.5, range = 0.3) {
  const distance = Math.abs(value - threshold)
  return Math.min(1.0, distance / range)
}

/**
 * Combined confidence for 3-channel layered decode
 * Returns minimum confidence across all channels
 */
export function layeredConfidence(r, g, b, threshold = 0.5, range = 0.3) {
  const cr = thresholdConfidence(r, threshold, range)
  const cg = thresholdConfidence(g, threshold, range)
  const cb = thresholdConfidence(b, threshold, range)
  return Math.min(cr, cg, cb)
}

/**
 * Confidence for nearest-neighbor palette classification
 * Based on ratio of best to second-best distance
 * @param {number[]} distances - Array of distances to each palette color
 * @returns {number} Confidence [0, 1]
 */
export function paletteConfidence(distances) {
  if (distances.length < 2) return 1

  const sorted = [...distances].sort((a, b) => a - b)
  const best = sorted[0]
  const secondBest = sorted[1]

  if (secondBest === 0) return 0 // Degenerate case
  if (best === 0) return 1 // Perfect match

  // Ratio approach: confident if best is much smaller than second-best
  const ratio = best / secondBest
  return Math.max(0, 1 - ratio)
}

/**
 * Get confidence level for UI display
 * @returns {'high' | 'medium' | 'low'}
 */
export function confidenceLevel(confidence) {
  if (confidence > 0.7) return 'high'
  if (confidence >= 0.4) return 'medium'
  return 'low'
}

/**
 * Get confidence color for UI overlay
 */
export function confidenceColor(confidence) {
  if (confidence > 0.7) return '#00ff00' // Green
  if (confidence >= 0.4) return '#ffff00' // Yellow
  return '#ff0000' // Red
}
