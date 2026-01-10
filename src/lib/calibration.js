// Color calibration utilities for QR code decoding

import { gammaDecode } from './gamma.js'

/**
 * Sample average RGB from a region of ImageData
 * Samples center portion to avoid edge effects
 * @param {ImageData} imageData
 * @param {number} x - Region left
 * @param {number} y - Region top
 * @param {number} w - Region width
 * @param {number} h - Region height
 * @param {number} margin - Margin ratio to skip (default 0.25 = skip outer 25%)
 * @returns {[number, number, number] | null} RGB [0,255] or null if invalid
 */
export function sampleRegion(imageData, x, y, w, h, margin = 0.25) {
  const pixels = imageData.data
  const width = imageData.width
  let rSum = 0, gSum = 0, bSum = 0, count = 0

  const marginX = Math.floor(w * margin)
  const marginY = Math.floor(h * margin)
  const startX = Math.max(0, Math.floor(x) + marginX)
  const startY = Math.max(0, Math.floor(y) + marginY)
  const endX = Math.min(width, Math.floor(x + w) - marginX)
  const endY = Math.min(imageData.height, Math.floor(y + h) - marginY)

  for (let py = startY; py < endY; py++) {
    for (let px = startX; px < endX; px++) {
      const idx = (py * width + px) * 4
      rSum += pixels[idx]
      gSum += pixels[idx + 1]
      bSum += pixels[idx + 2]
      count++
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
 * Sample a single pixel with 3x3 median for noise reduction
 * @param {ImageData} imageData
 * @param {number} cx - Center X
 * @param {number} cy - Center Y
 * @returns {[number, number, number]} RGB [0,255]
 */
export function samplePixelMedian(imageData, cx, cy) {
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

  return [rs[4], gs[4], bs[4]] // Median is middle element
}

/**
 * Normalize RGB against white and black reference points
 * @param {number} r - Red [0,255]
 * @param {number} g - Green [0,255]
 * @param {number} b - Blue [0,255]
 * @param {[number,number,number]} white - White reference RGB
 * @param {[number,number,number]} black - Black reference RGB
 * @param {boolean} applyGamma - Whether to gamma decode first
 * @returns {[number, number, number]} Normalized [0,1]
 */
export function normalizeRgb(r, g, b, white, black, applyGamma = true) {
  let rVal = r, gVal = g, bVal = b
  let wR = white[0], wG = white[1], wB = white[2]
  let bR = black[0], bG = black[1], bB = black[2]

  if (applyGamma) {
    [rVal, gVal, bVal] = gammaDecode(r, g, b)
    ;[wR, wG, wB] = gammaDecode(white[0], white[1], white[2])
    ;[bR, bG, bB] = gammaDecode(black[0], black[1], black[2])
  } else {
    rVal /= 255; gVal /= 255; bVal /= 255
    wR /= 255; wG /= 255; wB /= 255
    bR /= 255; bG /= 255; bB /= 255
  }

  const rangeR = wR - bR || 1
  const rangeG = wG - bG || 1
  const rangeB = wB - bB || 1

  return [
    Math.max(0, Math.min(1, (rVal - bR) / rangeR)),
    Math.max(0, Math.min(1, (gVal - bG) / rangeG)),
    Math.max(0, Math.min(1, (bVal - bB) / rangeB))
  ]
}

/**
 * Build 8-color CMY palette from 4 corner calibration colors
 * Uses linear interpolation: RGB(c,m,y) = W + c*(C-W) + m*(M-W) + y*(Y-W)
 * @param {[number,number,number]} white - White reference RGB
 * @param {[number,number,number]} cyan - Cyan reference RGB
 * @param {[number,number,number]} magenta - Magenta reference RGB
 * @param {[number,number,number]} yellow - Yellow reference RGB
 * @returns {Array<[number,number,number]>} 8 interpolated RGB colors
 */
export function buildPaletteFromCorners(white, cyan, magenta, yellow) {
  const W = white, C = cyan, M = magenta, Y = yellow

  const cmyPatterns = [
    [0, 0, 0], // 0: White
    [1, 0, 0], // 1: Cyan
    [0, 1, 0], // 2: Magenta
    [0, 0, 1], // 3: Yellow
    [1, 1, 0], // 4: Blue (C+M)
    [1, 0, 1], // 5: Green (C+Y)
    [0, 1, 1], // 6: Red (M+Y)
    [1, 1, 1]  // 7: Black (C+M+Y)
  ]

  return cmyPatterns.map(([c, m, y]) => {
    const r = W[0] + c * (C[0] - W[0]) + m * (M[0] - W[0]) + y * (Y[0] - W[0])
    const g = W[1] + c * (C[1] - W[1]) + m * (M[1] - W[1]) + y * (Y[1] - W[1])
    const b = W[2] + c * (C[2] - W[2]) + m * (M[2] - W[2]) + y * (Y[2] - W[2])
    return [
      Math.max(0, Math.min(255, Math.round(r))),
      Math.max(0, Math.min(255, Math.round(g))),
      Math.max(0, Math.min(255, Math.round(b)))
    ]
  })
}

/**
 * Find QR finder pattern white/black for calibration
 * @param {Object} qrLocation - jsQR location object
 * @param {ImageData} imageData
 * @returns {{white: [number,number,number], black: [number,number,number]} | null}
 */
export function calibrateFromFinders(qrLocation, imageData) {
  const { topLeftCorner, topRightCorner, bottomLeftCorner } = qrLocation

  // Calculate QR module size from finder pattern distance
  const qrWidth = Math.sqrt(
    Math.pow(topRightCorner.x - topLeftCorner.x, 2) +
    Math.pow(topRightCorner.y - topLeftCorner.y, 2)
  )
  const moduleSize = qrWidth / 25 // Conservative estimate

  // Black samples: sample the CENTER of each finder pattern
  const blackSamples = []
  const offsetToCenter = moduleSize * 3.5

  // Direction vectors
  const toRightDir = {
    x: (topRightCorner.x - topLeftCorner.x) / qrWidth,
    y: (topRightCorner.y - topLeftCorner.y) / qrWidth
  }
  const toBottomDir = {
    x: (bottomLeftCorner.x - topLeftCorner.x) / qrWidth,
    y: (bottomLeftCorner.y - topLeftCorner.y) / qrWidth
  }

  // Sample center of top-left finder
  const tlCenterX = topLeftCorner.x + offsetToCenter * toRightDir.x + offsetToCenter * toBottomDir.x
  const tlCenterY = topLeftCorner.y + offsetToCenter * toRightDir.y + offsetToCenter * toBottomDir.y
  blackSamples.push(samplePixelMedian(imageData, tlCenterX, tlCenterY))

  // Sample center of top-right finder
  const trCenterX = topRightCorner.x - offsetToCenter * toRightDir.x + offsetToCenter * toBottomDir.x
  const trCenterY = topRightCorner.y - offsetToCenter * toRightDir.y + offsetToCenter * toBottomDir.y
  blackSamples.push(samplePixelMedian(imageData, trCenterX, trCenterY))

  // Sample center of bottom-left finder
  const blCenterX = bottomLeftCorner.x + offsetToCenter * toRightDir.x - offsetToCenter * toBottomDir.x
  const blCenterY = bottomLeftCorner.y + offsetToCenter * toRightDir.y - offsetToCenter * toBottomDir.y
  blackSamples.push(samplePixelMedian(imageData, blCenterX, blCenterY))

  // White samples: sample the white ring inside finder patterns
  const whiteSamples = []
  const whiteOffset = moduleSize * 1.5
  const whiteMidOffset = moduleSize * 3.5

  // Top edge of white ring
  const tlWhiteTopX = topLeftCorner.x + whiteMidOffset * toRightDir.x + whiteOffset * toBottomDir.x
  const tlWhiteTopY = topLeftCorner.y + whiteMidOffset * toRightDir.y + whiteOffset * toBottomDir.y
  whiteSamples.push(samplePixelMedian(imageData, tlWhiteTopX, tlWhiteTopY))

  // Left edge of white ring
  const tlWhiteLeftX = topLeftCorner.x + whiteOffset * toRightDir.x + whiteMidOffset * toBottomDir.x
  const tlWhiteLeftY = topLeftCorner.y + whiteOffset * toRightDir.y + whiteMidOffset * toBottomDir.y
  whiteSamples.push(samplePixelMedian(imageData, tlWhiteLeftX, tlWhiteLeftY))

  if (blackSamples.length === 0 || whiteSamples.length === 0) return null

  // Filter out null samples
  const validBlack = blackSamples.filter(s => s !== null)
  const validWhite = whiteSamples.filter(s => s !== null)

  if (validBlack.length === 0 || validWhite.length === 0) return null

  const black = [
    Math.round(validBlack.reduce((s, c) => s + c[0], 0) / validBlack.length),
    Math.round(validBlack.reduce((s, c) => s + c[1], 0) / validBlack.length),
    Math.round(validBlack.reduce((s, c) => s + c[2], 0) / validBlack.length)
  ]

  const white = [
    Math.round(validWhite.reduce((s, c) => s + c[0], 0) / validWhite.length),
    Math.round(validWhite.reduce((s, c) => s + c[1], 0) / validWhite.length),
    Math.round(validWhite.reduce((s, c) => s + c[2], 0) / validWhite.length)
  ]

  return { white, black }
}
