// Receiver module - handles camera scanning and QR decoding
import jsQR from 'jsqr'
import { createDecoder } from './decoder.js'
import { QR_MODE, MODE_MARGIN_RATIOS, PATCH_SIZE_RATIO, PATCH_GAP_RATIO } from './constants.js'
import { calibrateFromFinders, normalizeRgb } from './calibration.js'
import { ColorQRDecoder } from './color-decoder.js'

// Receiver state
const state = {
  decoder: null,
  stream: null,
  animationId: null,
  canvas: null,
  ctx: null,
  isScanning: false,
  symbolTimes: [],
  reconstructedBlob: null,
  startTime: null,
  cameras: [],
  currentCameraId: null,
  isMobile: false,
  hasNotifiedFirstScan: false,
  // Color mode state
  detectedMode: null,      // Auto-detected from first packet
  manualMode: null,        // User override (null = auto)
  effectiveMode: QR_MODE.BW, // What we're actually using
  channelBuffers: null,    // Reusable pixel buffers for color decode
  lastBufferSize: 0,
  // Debug counters
  frameCount: 0,
  detectCount: 0,
  // Calibration smoothing
  smoothWhite: null,       // Smoothed white reference [r,g,b]
  smoothBlack: null,       // Smoothed black reference [r,g,b]
  // New libcimbar-based color decoder
  colorDecoder: null
}

// Audio feedback helper
function playBeep(frequency = 800, duration = 150) {
  try {
    const ctx = new AudioContext()
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()
    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.frequency.value = frequency
    gain.gain.value = 0.3
    oscillator.start()
    oscillator.stop(ctx.currentTime + duration / 1000)
  } catch (err) {
    // AudioContext may fail silently
  }
}

// DOM elements (initialized on setup)
let elements = null

// Error display (will be connected to global error banner)
let showError = (msg) => console.error(msg)

// Debug helpers
let lastLoggedState = ''
let lastLoggedSymIds = ''
let lastLoggedDecodePattern = ''
let lastLoggedSymCount = 0
let logEntryCount = 0
let lastLoggedThresholds = { r: 0, g: 0, b: 0 }

function debugStatus(text) {
  const el = document.getElementById('debug-current')
  if (el) el.textContent = text
}

function debugLog(text, forceLog = false) {
  // Always log threshold changes and forced entries
  if (!forceLog && !text.startsWith('>>>')) {
    // Extract key info for smart deduplication
    // Format: "CMY F! 010 R64/55 G62/55 B37/55 [260] +0 #83 89%"
    const symIdMatch = text.match(/\[([^\]]+)\]/)
    const patternMatch = text.match(/[01]{3}/)
    const symCountMatch = text.match(/#(\d+)/)
    const acceptedMatch = text.match(/\+(\d+)/)

    const symIds = symIdMatch ? symIdMatch[1] : ''
    const pattern = patternMatch ? patternMatch[0] : ''
    const symCount = symCountMatch ? parseInt(symCountMatch[1]) : 0
    const accepted = acceptedMatch ? parseInt(acceptedMatch[1]) : 0

    // Skip if same symbol IDs, same pattern, same count, and nothing accepted
    if (symIds === lastLoggedSymIds &&
        pattern === lastLoggedDecodePattern &&
        symCount === lastLoggedSymCount &&
        accepted === 0) {
      return
    }

    lastLoggedSymIds = symIds
    lastLoggedDecodePattern = pattern
    lastLoggedSymCount = symCount
  }

  const el = document.getElementById('debug-log')
  if (el) {
    logEntryCount++
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    el.textContent += timestamp + ' ' + text + '\n'
    // Keep only last 200 lines
    const lines = el.textContent.split('\n')
    if (lines.length > 200) {
      el.textContent = lines.slice(-200).join('\n')
    }
    el.scrollTop = el.scrollHeight
  }
}

// Utility: format bytes to human readable
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// Utility: format milliseconds to human readable time
function formatTime(ms) {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return totalSeconds + 's'

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return minutes + 'm ' + seconds + 's'

  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return hours + 'h ' + mins + 'm ' + seconds + 's'
}

// ============ Color Mode Helpers ============

// Fixed 8-color RGB palette for Palette mode (matches sender)
const PALETTE_RGB = [
  [255, 255, 255], // 0: White
  [255, 255, 0],   // 1: Yellow
  [255, 0, 255],   // 2: Magenta
  [255, 0, 0],     // 3: Red
  [0, 255, 255],   // 4: Cyan
  [0, 255, 0],     // 5: Green
  [0, 0, 255],     // 6: Blue
  [0, 0, 0]        // 7: Black
]

// Patch configuration for sampling HCC2D calibration patches
const PALETTE_PATCH_CONFIG = [
  { corner: 'TL', offset: 0, paletteIndex: 0 },
  { corner: 'TL', offset: 1, paletteIndex: 3 },
  { corner: 'TR', offset: 0, paletteIndex: 5 },
  { corner: 'TR', offset: 1, paletteIndex: 4 },
  { corner: 'BL', offset: 0, paletteIndex: 6 },
  { corner: 'BL', offset: 1, paletteIndex: 2 },
  { corner: 'BR', offset: 0, paletteIndex: 1 },
  { corner: 'BR', offset: 1, paletteIndex: 7 },
]

// Adaptive thresholds for PCCC channel classification
// These auto-adjust based on observed normalized values
const adaptiveThresholds = {
  r: 0.62,  // Initial Cyan threshold (higher due to red bias)
  g: 0.52,  // Initial Magenta threshold
  b: 0.52,  // Initial Yellow threshold

  // Running stats for adaptation (exponential moving average)
  // Initial values closer to observed reality for faster convergence
  rRunningMin: 0.45, rRunningMax: 0.75,
  gRunningMin: 0.40, gRunningMax: 0.65,
  bRunningMin: 0.40, bRunningMax: 0.65,
  frameCount: 0,

  // Update thresholds based on observed min/max
  update(rMin, rMax, gMin, gMax, bMin, bMax) {
    // Use faster adaptation for first 20 frames, then slower for stability
    const alpha = this.frameCount < 20 ? 0.4 : 0.15

    // Update running min/max with smoothing
    this.rRunningMin = alpha * rMin + (1 - alpha) * this.rRunningMin
    this.rRunningMax = alpha * rMax + (1 - alpha) * this.rRunningMax
    this.gRunningMin = alpha * gMin + (1 - alpha) * this.gRunningMin
    this.gRunningMax = alpha * gMax + (1 - alpha) * this.gRunningMax
    this.bRunningMin = alpha * bMin + (1 - alpha) * this.bRunningMin
    this.bRunningMax = alpha * bMax + (1 - alpha) * this.bRunningMax

    // Calculate new thresholds as midpoint between min and max
    // with a slight bias toward higher values (since we see high bias)
    const bias = 0.55  // 0.5 = exact middle, higher = bias toward max
    this.r = this.rRunningMin + (this.rRunningMax - this.rRunningMin) * bias
    this.g = this.gRunningMin + (this.gRunningMax - this.gRunningMin) * bias
    this.b = this.bRunningMin + (this.bRunningMax - this.bRunningMin) * bias

    // Clamp to reasonable range
    this.r = Math.max(0.4, Math.min(0.85, this.r))
    this.g = Math.max(0.4, Math.min(0.75, this.g))
    this.b = Math.max(0.4, Math.min(0.75, this.b))

    this.frameCount++

    // Log threshold changes: only when significant (3+ points) or every 50 frames
    const tR = Math.round(this.r * 100)
    const tG = Math.round(this.g * 100)
    const tB = Math.round(this.b * 100)
    const significantChange = Math.abs(tR - lastLoggedThresholds.r) >= 3 ||
                              Math.abs(tG - lastLoggedThresholds.g) >= 3 ||
                              Math.abs(tB - lastLoggedThresholds.b) >= 3
    const periodicLog = this.frameCount % 50 === 0

    if (significantChange || periodicLog) {
      lastLoggedThresholds = { r: tR, g: tG, b: tB }
      // Log range info too for context
      const rngR = Math.round(this.rRunningMin * 100) + '-' + Math.round(this.rRunningMax * 100)
      const rngG = Math.round(this.gRunningMin * 100) + '-' + Math.round(this.gRunningMax * 100)
      const rngB = Math.round(this.bRunningMin * 100) + '-' + Math.round(this.bRunningMax * 100)
      debugLog('>>> THRESH #' + this.frameCount + ' tR' + tR + ' tG' + tG + ' tB' + tB + ' | R:' + rngR + ' G:' + rngG + ' B:' + rngB)
    }
  },

  reset() {
    // Initial thresholds based on typical camera bias
    this.r = 0.62
    this.g = 0.52
    this.b = 0.52
    // Initial running min/max closer to observed reality
    this.rRunningMin = 0.45; this.rRunningMax = 0.75
    this.gRunningMin = 0.40; this.gRunningMax = 0.65
    this.bRunningMin = 0.40; this.bRunningMax = 0.65
    this.frameCount = 0
    lastLoggedThresholds = { r: 0, g: 0, b: 0 }
  }
}

// Debug: track normalized value distribution per frame
// Filter out clipped/extreme values to get reliable stats
const normStats = {
  rSum: 0, gSum: 0, bSum: 0,
  rMin: 1, gMin: 1, bMin: 1,
  rMax: 0, gMax: 0, bMax: 0,
  count: 0,
  // Track "valid" min/max (excluding outliers near 0 or 1)
  rValidMin: 1, gValidMin: 1, bValidMin: 1,
  rValidMax: 0, gValidMax: 0, bValidMax: 0,
  validCount: 0,
  reset() {
    this.rSum = this.gSum = this.bSum = 0
    this.rMin = this.gMin = this.bMin = 1
    this.rMax = this.gMax = this.bMax = 0
    this.count = 0
    this.rValidMin = this.gValidMin = this.bValidMin = 1
    this.rValidMax = this.gValidMax = this.bValidMax = 0
    this.validCount = 0
  },
  add(r, g, b) {
    this.rSum += r; this.gSum += g; this.bSum += b
    this.rMin = Math.min(this.rMin, r); this.gMin = Math.min(this.gMin, g); this.bMin = Math.min(this.bMin, b)
    this.rMax = Math.max(this.rMax, r); this.gMax = Math.max(this.gMax, g); this.bMax = Math.max(this.bMax, b)
    this.count++
    // Only track "valid" range for values not clipped (between 0.1 and 0.9)
    // This filters out pixels that hit calibration limits
    if (r > 0.1 && r < 0.9 && g > 0.1 && g < 0.9 && b > 0.1 && b < 0.9) {
      this.rValidMin = Math.min(this.rValidMin, r)
      this.gValidMin = Math.min(this.gValidMin, g)
      this.bValidMin = Math.min(this.bValidMin, b)
      this.rValidMax = Math.max(this.rValidMax, r)
      this.gValidMax = Math.max(this.gValidMax, g)
      this.bValidMax = Math.max(this.bValidMax, b)
      this.validCount++
    }
  },
  getStats() {
    if (this.count === 0) return null
    return {
      rAvg: this.rSum / this.count,
      gAvg: this.gSum / this.count,
      bAvg: this.bSum / this.count,
      rRange: [this.rMin, this.rMax],
      gRange: [this.gMin, this.gMax],
      bRange: [this.bMin, this.bMax]
    }
  },
  // Update adaptive thresholds after each frame using valid (non-clipped) stats
  updateAdaptive() {
    if (this.validCount > 10) {
      // Use valid min/max (filtered) for threshold adaptation
      adaptiveThresholds.update(
        this.rValidMin, this.rValidMax,
        this.gValidMin, this.gValidMax,
        this.bValidMin, this.bValidMax
      )
    }
  }
}

// Check if position is finder or timing pattern
function isFinderOrTiming(row, col, size) {
  if (row < 8 && col < 8) return true
  if (row < 8 && col >= size - 8) return true
  if (row >= size - 8 && col < 8) return true
  if (row === 6 || col === 6) return true
  if (size > 25) {
    const alignPos = size - 7
    if (row >= alignPos - 2 && row <= alignPos + 2 &&
        col >= alignPos - 2 && col <= alignPos + 2) return true
  }
  return false
}

// Convert image to grayscale for QR detection
function toGrayscale(imageData) {
  const gray = new Uint8ClampedArray(imageData.width * imageData.height * 4)
  const pixels = imageData.data

  for (let i = 0; i < pixels.length; i += 4) {
    const g = Math.round(pixels[i] * 0.299 + pixels[i + 1] * 0.587 + pixels[i + 2] * 0.114)
    gray[i] = g
    gray[i + 1] = g
    gray[i + 2] = g
    gray[i + 3] = 255
  }

  return gray
}

// Sample color from center of a region (5x5 average)
function sampleColor(pixels, width, centerX, centerY) {
  let rSum = 0, gSum = 0, bSum = 0, count = 0
  const sampleRadius = 2

  for (let dy = -sampleRadius; dy <= sampleRadius; dy++) {
    for (let dx = -sampleRadius; dx <= sampleRadius; dx++) {
      const x = Math.round(centerX + dx)
      const y = Math.round(centerY + dy)
      if (x >= 0 && x < width && y >= 0) {
        const idx = (y * width + x) * 4
        rSum += pixels[idx]
        gSum += pixels[idx + 1]
        bSum += pixels[idx + 2]
        count++
      }
    }
  }

  if (count === 0) return null
  return [Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count)]
}

// Get patch position in image based on QR bounds (matches sender's ratio-based approach)
// Calculates margin, patch size, and gap from the detected QR size using the same ratios as sender
function getPatchPositionInImage(corner, offset, qrBounds) {
  const { qrLeft, qrTop, qrWidth, qrHeight } = qrBounds

  // Use ratio-based sizing (matches sender)
  // qrWidth corresponds to the QR code size, margin is calculated from that
  const margin = qrWidth * MODE_MARGIN_RATIOS[QR_MODE.PALETTE]
  const patchSize = margin * PATCH_SIZE_RATIO
  const gap = margin * PATCH_GAP_RATIO

  let x, y
  switch (corner) {
    case 'TL':
      x = qrLeft - margin + gap + offset * (patchSize + gap) + patchSize / 2
      y = qrTop - margin + gap + patchSize / 2
      break
    case 'TR':
      x = qrLeft + qrWidth + margin - gap - patchSize / 2 - offset * (patchSize + gap)
      y = qrTop - margin + gap + patchSize / 2
      break
    case 'BL':
      x = qrLeft - margin + gap + offset * (patchSize + gap) + patchSize / 2
      y = qrTop + qrHeight + margin - gap - patchSize / 2
      break
    case 'BR':
      x = qrLeft + qrWidth + margin - gap - patchSize / 2 - offset * (patchSize + gap)
      y = qrTop + qrHeight + margin - gap - patchSize / 2
      break
  }

  return { x, y }
}

// Sample calibration patches for Palette mode
function samplePatchCalibration(pixels, imageSize, qrBounds) {
  const palette = new Array(8).fill(null)
  let successCount = 0
  let debugPositions = []

  for (const patch of PALETTE_PATCH_CONFIG) {
    const pos = getPatchPositionInImage(patch.corner, patch.offset, qrBounds)

    if (pos.x >= 0 && pos.x < imageSize && pos.y >= 0 && pos.y < imageSize) {
      const color = sampleColor(pixels, imageSize, pos.x, pos.y)
      if (color) {
        palette[patch.paletteIndex] = color
        successCount++
        debugPositions.push(patch.corner + patch.offset + ':' + Math.round(pos.x) + ',' + Math.round(pos.y))
      }
    }
  }

  // Log patch positions periodically for debugging
  if (paletteStats.frameCount % 100 === 0 && debugPositions.length > 0) {
    const { qrLeft, qrTop, qrWidth, qrHeight } = qrBounds
    debugLog('>>> PATCHPOS QR:' + Math.round(qrLeft) + ',' + Math.round(qrTop) + ' ' + Math.round(qrWidth) + 'x' + Math.round(qrHeight) + ' | ' + debugPositions.join(' '))
  }

  // Require at least 6 patches for patch-based calibration
  if (successCount >= 6) {
    for (let i = 0; i < 8; i++) {
      if (!palette[i]) {
        palette[i] = PALETTE_RGB[i]
      }
    }

    // Validate palette: check that colors are sufficiently distinct
    // White (0) should be bright, Black (7) should be dark
    let white = palette[0]
    let black = palette[7]
    const red = palette[3]
    let whiteBrightness = white[0] + white[1] + white[2]
    let blackBrightness = black[0] + black[1] + black[2]

    // If black is brighter than white, swap them (lighting/exposure issue)
    if (blackBrightness > whiteBrightness) {
      const temp = white; white = black; black = temp
      const tempB = whiteBrightness; whiteBrightness = blackBrightness; blackBrightness = tempB
      palette[0] = white
      palette[7] = black
    }

    // Log sampled colors periodically for debugging
    if (paletteStats.frameCount % 50 === 0) {
      debugLog('>>> SAMPLED W:' + white.join(',') + '=' + whiteBrightness +
               ' K:' + black.join(',') + '=' + blackBrightness +
               ' R:' + red.join(','), true)
    }

    // Camera compresses dynamic range - white isn't 765, black isn't 0
    // Relaxed thresholds: white > 350, black < 450, difference > 100
    if (whiteBrightness < 350 || blackBrightness > 450 || whiteBrightness - blackBrightness < 100) {
      // Palette looks invalid - colors not distinct enough
      if (paletteStats.frameCount % 50 === 0) {
        debugLog('>>> PATCH FAIL: brightness W' + whiteBrightness + ' K' + blackBrightness + ' diff' + (whiteBrightness - blackBrightness), true)
      }
      return null
    }

    // Check that at least some colors have distinct hues
    // Red (3) should have high R, low G - relaxed from +50 to +30
    if (red[0] < red[1] + 30) {
      // Red doesn't look red
      if (paletteStats.frameCount % 50 === 0) {
        debugLog('>>> PATCH FAIL: red R' + red[0] + ' G' + red[1], true)
      }
      return null
    }

    return palette
  }

  // Not enough patches sampled
  if (paletteStats.frameCount % 100 === 0) {
    debugLog('>>> PATCH FAIL: only ' + successCount + '/8 patches', true)
  }
  return null
}

// Classify CMY color for PCCC mode
function classifyCMY(r, g, b, white, black, collectStats = false) {
  const [normR, normG, normB] = normalizeRgb(r, g, b, white, black, true)

  // Collect stats for debugging (only sample every Nth pixel)
  if (collectStats) {
    normStats.add(normR, normG, normB)
  }

  // Use adaptive thresholds that auto-adjust based on observed values
  return [
    normR < adaptiveThresholds.r ? 1 : 0,
    normG < adaptiveThresholds.g ? 1 : 0,
    normB < adaptiveThresholds.b ? 1 : 0
  ]
}

// Debug: track palette classification stats
const paletteStats = {
  counts: new Array(8).fill(0),
  lastPalette: null,
  frameCount: 0,
  reset() {
    this.counts = new Array(8).fill(0)
    this.lastPalette = null
    this.frameCount = 0
  },
  add(index) {
    this.counts[index]++
  },
  logPalette(palette) {
    if (this.frameCount % 100 === 0 && palette) {
      // Log sampled palette colors periodically
      const colors = palette.map((c, i) => i + ':' + c.join(',')).join(' | ')
      debugLog('>>> PALETTE ' + colors)
      // Log White/Black used for normalization
      const w = palette[0], k = palette[7]
      debugLog('>>> CALIB W:' + w.join(',') + ' K:' + k.join(','))
      // Log adaptive thresholds
      const t = rgbAdaptiveThresholds
      debugLog('>>> RGB-THRESH R:' + Math.round(t.r * 100) + ' G:' + Math.round(t.g * 100) + ' B:' + Math.round(t.b * 100) +
               ' | R:' + Math.round(t.rMin * 100) + '-' + Math.round(t.rMax * 100) +
               ' G:' + Math.round(t.gMin * 100) + '-' + Math.round(t.gMax * 100) +
               ' B:' + Math.round(t.bMin * 100) + '-' + Math.round(t.bMax * 100))
    }
    this.lastPalette = palette
    this.frameCount++
  },
  getDistribution() {
    const total = this.counts.reduce((a, b) => a + b, 0)
    if (total === 0) return null
    return this.counts.map(c => Math.round(100 * c / total))
  }
}

// Adaptive thresholds for RGB/Palette mode (similar to CMY)
const rgbAdaptiveThresholds = {
  r: 0.50, g: 0.50, b: 0.50,
  rMin: 0.3, rMax: 0.7,
  gMin: 0.3, gMax: 0.7,
  bMin: 0.3, bMax: 0.7,
  frameCount: 0,

  update(rMin, rMax, gMin, gMax, bMin, bMax) {
    const alpha = this.frameCount < 20 ? 0.4 : 0.15
    this.rMin = alpha * rMin + (1 - alpha) * this.rMin
    this.rMax = alpha * rMax + (1 - alpha) * this.rMax
    this.gMin = alpha * gMin + (1 - alpha) * this.gMin
    this.gMax = alpha * gMax + (1 - alpha) * this.gMax
    this.bMin = alpha * bMin + (1 - alpha) * this.bMin
    this.bMax = alpha * bMax + (1 - alpha) * this.bMax

    // Threshold at midpoint with slight bias
    const bias = 0.50
    this.r = this.rMin + (this.rMax - this.rMin) * bias
    this.g = this.gMin + (this.gMax - this.gMin) * bias
    this.b = this.bMin + (this.bMax - this.bMin) * bias

    // Clamp to reasonable range
    this.r = Math.max(0.3, Math.min(0.7, this.r))
    this.g = Math.max(0.3, Math.min(0.7, this.g))
    this.b = Math.max(0.3, Math.min(0.7, this.b))

    this.frameCount++
  },

  reset() {
    this.r = this.g = this.b = 0.50
    this.rMin = this.gMin = this.bMin = 0.3
    this.rMax = this.gMax = this.bMax = 0.7
    this.frameCount = 0
  }
}

// Track normalized RGB stats for adaptive thresholding
const rgbNormStats = {
  rMin: 1, rMax: 0, gMin: 1, gMax: 0, bMin: 1, bMax: 0, count: 0,
  reset() {
    this.rMin = this.gMin = this.bMin = 1
    this.rMax = this.gMax = this.bMax = 0
    this.count = 0
  },
  add(r, g, b) {
    // Only track valid range (not clipped)
    if (r > 0.1 && r < 0.9) { this.rMin = Math.min(this.rMin, r); this.rMax = Math.max(this.rMax, r) }
    if (g > 0.1 && g < 0.9) { this.gMin = Math.min(this.gMin, g); this.gMax = Math.max(this.gMax, g) }
    if (b > 0.1 && b < 0.9) { this.bMin = Math.min(this.bMin, b); this.bMax = Math.max(this.bMax, b) }
    this.count++
  },
  updateAdaptive() {
    if (this.count > 10) {
      rgbAdaptiveThresholds.update(this.rMin, this.rMax, this.gMin, this.gMax, this.bMin, this.bMax)
    }
  }
}

// Classify RGB palette color for Palette mode
// Uses White/Black from sampled palette for normalization + adaptive thresholds
function classifyPalette(r, g, b, sampledPalette, calibration, collectStats = false) {
  // Use White (index 0) and Black (index 7) from sampled palette for normalization
  const white = sampledPalette ? sampledPalette[0] : calibration.white
  const black = sampledPalette ? sampledPalette[7] : calibration.black

  // Normalize each channel to 0-1 range (0 = black, 1 = white)
  const [normR, normG, normB] = normalizeRgb(r, g, b, white, black, true)

  // Collect stats for adaptive thresholding
  if (collectStats) {
    rgbNormStats.add(normR, normG, normB)
  }

  // Use adaptive thresholds: below = dark (bit 1), above = light (bit 0)
  const rBit = normR < rgbAdaptiveThresholds.r ? 1 : 0
  const gBit = normG < rgbAdaptiveThresholds.g ? 1 : 0
  const bBit = normB < rgbAdaptiveThresholds.b ? 1 : 0

  // Track stats for debugging
  if (collectStats) {
    const index = rBit * 4 + gBit * 2 + bBit
    paletteStats.add(index)
  }

  return [rBit, gBit, bBit]
}

// Extract color channels from image and decode
function extractColorChannels(imageData, qrBounds, mode, calibration, sampledPalette) {
  const { qrLeft, qrTop, qrWidth, qrHeight } = qrBounds
  const size = imageData.width
  const pixels = imageData.data

  // Reset stats for this frame
  if (mode === QR_MODE.PCCC) {
    normStats.reset()
  } else if (mode === QR_MODE.PALETTE) {
    rgbNormStats.reset()
    // Log palette periodically for debugging
    paletteStats.logPalette(sampledPalette)
  }

  // Allocate or reuse channel buffers
  const bufferSize = size * size * 4
  if (bufferSize !== state.lastBufferSize) {
    state.channelBuffers = {
      ch0: new Uint8ClampedArray(bufferSize),
      ch1: new Uint8ClampedArray(bufferSize),
      ch2: new Uint8ClampedArray(bufferSize)
    }
    state.lastBufferSize = bufferSize
  }

  const { ch0, ch1, ch2 } = state.channelBuffers
  let sampleCounter = 0

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = (py * size + px) * 4
      const r = pixels[idx]
      const g = pixels[idx + 1]
      const b = pixels[idx + 2]

      let bits
      if (px >= qrLeft && px < qrLeft + qrWidth && py >= qrTop && py < qrTop + qrHeight) {
        if (mode === QR_MODE.PCCC) {
          // Collect stats every 50th pixel to avoid performance hit
          const collectStats = (++sampleCounter % 50 === 0)
          bits = classifyCMY(r, g, b, calibration.white, calibration.black, collectStats)
        } else {
          // For PALETTE mode: use sampled palette if available, else use calibration for normalization
          const collectStats = (++sampleCounter % 50 === 0)
          bits = classifyPalette(r, g, b, sampledPalette, calibration, collectStats)
        }
      } else {
        bits = [0, 0, 0] // Outside QR = white
      }

      // Create grayscale channel images (bit 1 = dark, bit 0 = light)
      const g0 = bits[0] ? 0 : 255
      const g1 = bits[1] ? 0 : 255
      const g2 = bits[2] ? 0 : 255

      ch0[idx] = ch0[idx + 1] = ch0[idx + 2] = g0; ch0[idx + 3] = 255
      ch1[idx] = ch1[idx + 1] = ch1[idx + 2] = g1; ch1[idx + 3] = 255
      ch2[idx] = ch2[idx + 1] = ch2[idx + 2] = g2; ch2[idx + 3] = 255
    }
  }

  return { ch0, ch1, ch2, size }
}

// Update mode status display
function updateModeStatus() {
  if (!elements.modeStatus) return

  const effective = state.manualMode !== null ? state.manualMode : (state.detectedMode !== null ? state.detectedMode : QR_MODE.BW)
  state.effectiveMode = effective

  const modeNames = ['BW', 'CMY', 'RGB']

  if (state.manualMode !== null) {
    elements.modeStatus.textContent = 'Manual: ' + modeNames[effective]
    elements.modeStatus.className = 'mode-status manual'
  } else if (state.detectedMode !== null) {
    elements.modeStatus.textContent = 'Detected: ' + modeNames[effective]
    elements.modeStatus.className = 'mode-status detected'
  } else {
    elements.modeStatus.textContent = 'Auto-detecting...'
    elements.modeStatus.className = 'mode-status'
  }

  // Update button states
  if (elements.receiverModeButtons) {
    elements.receiverModeButtons.forEach(btn => {
      btn.classList.toggle('active', parseInt(btn.dataset.mode) === effective)
    })
  }
}

// Show the appropriate status section
function showStatus(which) {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.add('hidden')

  if (which === 'scanning') {
    elements.statusScanning.classList.remove('hidden')
  } else if (which === 'receiving') {
    elements.statusReceiving.classList.remove('hidden')
  } else if (which === 'complete') {
    elements.statusComplete.classList.remove('hidden')
  }
}

// Enumerate available cameras
async function enumerateCameras() {
  try {
    // Request permission first (needed to get labels)
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
    tempStream.getTracks().forEach(t => t.stop())

    const devices = await navigator.mediaDevices.enumerateDevices()
    let cameras = devices.filter(d => d.kind === 'videoinput')

    // Detect mobile (iOS/Android)
    state.isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

    if (state.isMobile) {
      // On mobile: filter to front/back only
      const front = cameras.find(c =>
        c.label.toLowerCase().includes('front') ||
        c.label.toLowerCase().includes('facetime')
      )
      const back = cameras.find(c =>
        c.label.toLowerCase().includes('back') &&
        !c.label.toLowerCase().includes('ultra') &&
        !c.label.toLowerCase().includes('wide') &&
        !c.label.toLowerCase().includes('tele') &&
        !c.label.toLowerCase().includes('macro')
      ) || cameras.find(c => c.label.toLowerCase().includes('back'))

      cameras = [back, front].filter(Boolean)

      // Mobile: show toggle button, hide dropdown
      elements.cameraPicker.classList.add('hidden')
      elements.btnCameraSwitch.classList.remove('hidden')
    } else {
      // Desktop: show dropdown directly, hide toggle button
      elements.btnCameraSwitch.classList.add('hidden')
      elements.cameraPicker.classList.remove('hidden')

      while (elements.cameraDropdown.firstChild) {
        elements.cameraDropdown.removeChild(elements.cameraDropdown.firstChild)
      }

      cameras.forEach((cam, i) => {
        const option = document.createElement('option')
        option.value = cam.deviceId
        option.textContent = cam.label || ('Camera ' + (i + 1))
        elements.cameraDropdown.appendChild(option)
      })
    }

    state.cameras = cameras

    if (cameras.length === 0) {
      showError('No camera found on this device.')
      return null
    }

    // Hide controls entirely if only one camera
    if (cameras.length <= 1) {
      elements.btnCameraSwitch.classList.add('hidden')
      elements.cameraPicker.classList.add('hidden')
    }

    // Return default camera ID (first one, which is back camera on mobile)
    return cameras[0].deviceId
  } catch (err) {
    console.error('Camera enumeration error:', err)
    if (err.name === 'NotAllowedError') {
      showError('Camera access denied. Please allow permissions.')
    }
    return null
  }
}

// Start scanning with specified camera
async function startScanning(deviceId) {
  if (!deviceId) {
    showError('No camera available.')
    return
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, facingMode: 'environment' }
    })

    state.currentCameraId = deviceId
    elements.cameraDropdown.value = deviceId

    elements.video.srcObject = state.stream
    await elements.video.play()

    // Create offscreen canvas for scanning
    state.canvas = document.createElement('canvas')
    state.ctx = state.canvas.getContext('2d', { willReadFrequently: true })

    // Reset decoder and calibration
    state.decoder = createDecoder()
    state.symbolTimes = []
    state.reconstructedBlob = null
    state.startTime = Date.now()
    state.isScanning = true
    state.frameCount = 0
    state.detectCount = 0
    state.smoothWhite = null
    state.smoothBlack = null
    adaptiveThresholds.reset()
    rgbAdaptiveThresholds.reset()
    paletteStats.reset()

    showStatus('scanning')
    elements.statSymbols.textContent = '0 codes'

    // Start scan loop
    scanFrame()
  } catch (err) {
    console.error('Camera start error:', err)
    showError('Failed to start camera. ' + err.message)
  }
}

// Stop scanning
function stopScanning() {
  state.isScanning = false

  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
  }

  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
  }

  elements.video.srcObject = null
  elements.qrOverlay.style.display = 'none'
}

// Switch camera
async function switchCamera(deviceId) {
  if (deviceId === state.currentCameraId) return

  // Stop current stream
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
  }

  // Start with new camera (preserve decoder state)
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, facingMode: 'environment' }
    })

    state.currentCameraId = deviceId
    elements.video.srcObject = state.stream
    await elements.video.play()
  } catch (err) {
    console.error('Camera switch error:', err)
    showError('Failed to switch camera. ' + err.message)
  }
}

// Toggle between front and back camera (mobile only)
async function toggleMobileCamera(e) {
  e.stopPropagation()
  if (state.cameras.length < 2) return

  const currentIndex = state.cameras.findIndex(c => c.deviceId === state.currentCameraId)
  const nextIndex = (currentIndex + 1) % state.cameras.length
  const nextCamera = state.cameras[nextIndex]

  await switchCamera(nextCamera.deviceId)
}

// Process a decoded packet
function processPacket(bytes) {
  let accepted = state.decoder.receive(bytes)

  // Handle new session (sender changed settings)
  if (accepted === 'new_session') {
    console.log('New session detected, resetting receiver')
    state.decoder.reset()
    state.symbolTimes = []
    state.startTime = Date.now()
    state.hasNotifiedFirstScan = false
    state.detectedMode = null
    state.frameCount = 0
    state.detectCount = 0
    state.smoothWhite = null
    state.smoothBlack = null
    adaptiveThresholds.reset()
    rgbAdaptiveThresholds.reset()
    paletteStats.reset()
    updateModeStatus()
    showStatus('scanning')
    elements.progressFill.style.width = '0%'
    elements.statSymbols.textContent = '0 codes'
    accepted = state.decoder.receive(bytes)
  }

  if (accepted) {
    if (!state.hasNotifiedFirstScan) {
      state.hasNotifiedFirstScan = true
      playBeep()
    }

    const now = Date.now()
    state.symbolTimes.push(now)
    state.symbolTimes = state.symbolTimes.filter(t => now - t < 5000)
  }

  return accepted
}

// Scan a single frame
function scanFrame() {
  if (!state.isScanning) return

  const video = elements.video
  const canvas = state.canvas
  const ctx = state.ctx

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    // Crop to square (like experiments) - critical for color mode processing
    const vw = video.videoWidth
    const vh = video.videoHeight
    const size = Math.min(vw, vh)

    canvas.width = size
    canvas.height = size

    // Center crop
    const offsetX = (vw - size) / 2
    const offsetY = (vh - size) / 2
    ctx.drawImage(video, offsetX, offsetY, size, size, 0, 0, size, size)

    const imageData = ctx.getImageData(0, 0, size, size)

    // Determine effective mode
    const effectiveMode = state.manualMode !== null ? state.manualMode : (state.detectedMode !== null ? state.detectedMode : QR_MODE.BW)

    // Convert to grayscale for QR detection (try both inversions for better detection)
    const grayData = toGrayscale(imageData)
    const grayResult = jsQR(grayData, size, size)

    if (effectiveMode === QR_MODE.BW) {
      // BW mode: use grayscale QR decode directly
      if (grayResult) {
        showQROverlay(grayResult.location, video, offsetX, offsetY, size)
        debugStatus('BW detected')

        try {
          const binary = atob(grayResult.data)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i)
          }

          // Check mode from packet header for auto-detection
          if (state.detectedMode === null && bytes.length >= 16) {
            const flags = bytes[15]
            const packetMode = (flags >> 1) & 0x03
            if (packetMode !== QR_MODE.BW) {
              state.detectedMode = packetMode
              updateModeStatus()
              // Process this packet (likely metadata) before switching modes
              processPacket(bytes)
              updateReceiverStats()
              state.animationId = requestAnimationFrame(scanFrame)
              return
            }
          }

          processPacket(bytes)
          updateReceiverStats()

          if (state.decoder.isComplete()) {
            onReceiveComplete()
            return
          }
        } catch (err) {
          debugStatus('BW decode error')
        }
      } else {
        elements.qrOverlay.style.display = 'none'
        debugStatus('BW no QR')
      }
    } else {
      // Color mode: use new libcimbar-based decoder
      // Applies: relative colors, color correction, drift tracking, priority decoding

      state.frameCount++

      if (!grayResult) {
        // No QR detected - skip frame, show detection rate
        elements.qrOverlay.style.display = 'none'
        const rate = state.frameCount > 0 ? Math.round(100 * state.detectCount / state.frameCount) : 0
        debugStatus('no QR ' + rate + '%')
        state.animationId = requestAnimationFrame(scanFrame)
        return
      }

      state.detectCount++
      const rate = Math.round(100 * state.detectCount / state.frameCount)

      // Grayscale detection succeeded - use detected position
      const loc = grayResult.location
      showQROverlay(loc, video, offsetX, offsetY, size)

      const modeName = effectiveMode === QR_MODE.PCCC ? 'CMY' : 'RGB'

      try {
        // Initialize color decoder if needed
        if (!state.colorDecoder) {
          state.colorDecoder = new ColorQRDecoder()
        }

        // Decode using new libcimbar-based pipeline
        const decoded = state.colorDecoder.decode(imageData, loc)

        // Debug: log color decoder stats to on-screen panel
        if (state.frameCount % 10 === 1) {
          const stats = decoded.stats
          const dist = stats.colorDistribution || []
          const modSize = state.colorDecoder.detectedModuleSize?.toFixed(1) || '?'
          const corrInfo = state.colorDecoder.corrector?.getDebugInfo() || '?'
          const classType = state.colorDecoder.classifierType || '?'
          debugLog(`>>> COLOR v${state.colorDecoder.grid?.version || '?'} mod:${modSize}px ${classType} ${corrInfo}`)
          debugLog(`>>> DIST W:${dist[0]||0} C:${dist[1]||0} M:${dist[2]||0} Y:${dist[3]||0} B:${dist[4]||0} G:${dist[5]||0} R:${dist[6]||0} K:${dist[7]||0}`)

          // Sample a few module results to see actual RGB values
          const sampleResults = []
          for (const [key, result] of decoded.results) {
            if (sampleResults.length >= 3 && result.colorName !== 'white' && result.colorName !== 'black') {
              // Collect up to 3 chromatic samples
              if (result.sampledRGB && sampleResults.length < 6) {
                sampleResults.push(result)
              }
            } else if (sampleResults.length < 3 && result.sampledRGB) {
              sampleResults.push(result)
            }
            if (sampleResults.length >= 6) break
          }
          if (sampleResults.length > 0) {
            const samples = sampleResults.slice(0, 3).map(r => {
              const s = r.sampledRGB || [0,0,0]
              const c = r.correctedRGB || [0,0,0]
              return `${s[0]},${s[1]},${s[2]}->${c[0]?.toFixed(0)},${c[1]?.toFixed(0)},${c[2]?.toFixed(0)}=${r.colorName?.substring(0,1)||'?'}`
            })
            debugLog(`>>> RGB ${samples.join(' | ')}`)
          }

          // Check pixel mapping stats
          const decoder = state.colorDecoder.decoder
          if (decoder?.lastBuildStats) {
            const s = decoder.lastBuildStats
            const pct = (100 * s.mappedPixels / (decoded.channels.size * decoded.channels.size)).toFixed(0)
            debugLog(`>>> MAP mapped:${s.mappedPixels} (${pct}%) fixed:${s.fixedPixels} data:${s.dataPixels}`)
          }
        }

        // Decode each channel with jsQR
        const channelResults = [
          jsQR(decoded.channels.ch0, decoded.channels.size, decoded.channels.size),
          jsQR(decoded.channels.ch1, decoded.channels.size, decoded.channels.size),
          jsQR(decoded.channels.ch2, decoded.channels.size, decoded.channels.size)
        ]

        // Track which channels decoded successfully
        const channelBits = channelResults.map(r => r ? 1 : 0)
        let acceptedCount = 0

        // Process any successful channel decodes
        const symIds = []
        for (let i = 0; i < channelResults.length; i++) {
          const chResult = channelResults[i]
          if (chResult) {
            try {
              const binary = atob(chResult.data)
              const bytes = new Uint8Array(binary.length)
              for (let j = 0; j < binary.length; j++) {
                bytes[j] = binary.charCodeAt(j)
              }

              // Extract symbol ID from header (bytes 9-12, big-endian)
              if (bytes.length >= 13) {
                const symId = (bytes[9] << 24) | (bytes[10] << 16) | (bytes[11] << 8) | bytes[12]
                symIds.push(symId >>> 0)
              }

              // Auto-detect mode from first packet
              if (state.detectedMode === null && bytes.length >= 16) {
                const flags = bytes[15]
                const packetMode = (flags >> 1) & 0x03
                state.detectedMode = packetMode
                updateModeStatus()
              }

              const accepted = processPacket(bytes)
              if (accepted) acceptedCount++
            } catch (err) {
              // Individual channel decode error, continue with others
            }
          }
        }

        // Show status with new decoder stats
        const symCount = state.decoder.uniqueSymbols || 0
        const symIdStr = symIds.length > 0 ? symIds.join('/') : '-'
        const conf = Math.round(decoded.stats.avgConfidence * 100)
        const drift = decoded.stats.avgDrift.toFixed(1)

        const statusText = `${modeName} ${channelBits.join('')} conf:${conf}% drift:${drift} [${symIdStr}] +${acceptedCount} #${symCount} ${rate}%`
        debugStatus(statusText)
        debugLog(statusText)

        if (acceptedCount > 0) {
          updateReceiverStats()

          if (state.decoder.isComplete()) {
            onReceiveComplete()
            return
          }
        }
      } catch (err) {
        console.log('Color decode error:', err.message)
        debugStatus(`${modeName} error: ${err.message}`)
      }
    }
  }

  state.animationId = requestAnimationFrame(scanFrame)
}

// Show overlay around detected QR code
function showQROverlay(location, video, cropOffsetX, cropOffsetY, cropSize) {
  const svg = elements.qrOverlay
  const polygon = elements.qrPolygon

  // Account for video position within container
  const videoRect = video.getBoundingClientRect()
  const containerRect = video.parentElement.getBoundingClientRect()
  const containerOffsetX = videoRect.left - containerRect.left
  const containerOffsetY = videoRect.top - containerRect.top

  // Calculate scale from cropped canvas to video display
  // Video display scale
  const videoDisplayWidth = video.offsetWidth
  const videoDisplayHeight = video.offsetHeight

  // The cropped area in the video
  const cropDisplayWidth = videoDisplayWidth * (cropSize / video.videoWidth)
  const cropDisplayHeight = videoDisplayHeight * (cropSize / video.videoHeight)

  // Scale from cropped canvas coordinates to display coordinates
  const scaleX = cropDisplayWidth / cropSize
  const scaleY = cropDisplayHeight / cropSize

  // Offset for crop area in display coordinates
  const cropDisplayOffsetX = videoDisplayWidth * (cropOffsetX / video.videoWidth)
  const cropDisplayOffsetY = videoDisplayHeight * (cropOffsetY / video.videoHeight)

  // Build polygon points from all 4 corners
  const points = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner
  ].map(p =>
    `${p.x * scaleX + cropDisplayOffsetX + containerOffsetX},${p.y * scaleY + cropDisplayOffsetY + containerOffsetY}`
  ).join(' ')

  polygon.setAttribute('points', points)
  svg.style.display = 'block'
}

// Update receiver statistics display
function updateReceiverStats() {
  const decoder = state.decoder
  if (!decoder) return

  const k = decoder.k || 0
  const solved = decoder.solved || 0
  const uniqueSymbols = decoder.uniqueSymbols || 0

  // If we have metadata, switch to receiving view
  if (decoder.metadata && k > 0) {
    showStatus('receiving')

    const progress = (solved / k * 100)
    elements.progressFill.style.width = progress + '%'
    elements.statBlocks.textContent = solved + '/' + k
    elements.fileNameDisplay.textContent =
      decoder.metadata.filename + ' (' + formatBytes(decoder.metadata.fileSize) + ')'

    // Calculate rate based on actual file size and progress
    const times = state.symbolTimes
    const fileSize = decoder.metadata.fileSize
    if (times.length >= 2 && fileSize > 0) {
      const windowDuration = (times[times.length - 1] - times[0]) / 1000
      const bytesPerBlock = fileSize / k
      const bytesInWindow = times.length * bytesPerBlock
      const rateKBps = windowDuration > 0 ? (bytesInWindow / windowDuration / 1024) : 0
      elements.statRate.textContent = rateKBps.toFixed(1) + ' KB/s'

      // Estimate remaining time
      const remaining = k - solved
      const remainingBytes = remaining * bytesPerBlock
      const etaMs = rateKBps > 0 ? (remainingBytes / 1024 / rateKBps * 1000 * 1.3) : 0
      elements.statEta.textContent = etaMs > 0 ? ('~' + formatTime(etaMs)) : ''
    }
  } else {
    // Still in scanning phase
    elements.statSymbols.textContent = uniqueSymbols + ' codes'
  }
}

// Handle receive completion
async function onReceiveComplete() {
  // Capture final timing before stopping
  const endTime = Date.now()
  const totalTime = state.startTime ? endTime - state.startTime : 0

  stopScanning()

  const verified = await state.decoder.verify()

  if (verified) {
    // Notify user of successful completion
    playBeep()

    const data = state.decoder.reconstruct()
    const metadata = state.decoder.metadata

    state.reconstructedBlob = new Blob([data], { type: metadata.mimeType })

    // Calculate average transfer rate
    const totalSeconds = totalTime / 1000
    const avgRateKBps = totalSeconds > 0 ? (metadata.fileSize / 1024 / totalSeconds) : 0

    showStatus('complete')
    elements.completeFileName.textContent =
      metadata.filename + ' (' + formatBytes(metadata.fileSize) + ') in ' + formatTime(totalTime)
    elements.completeRate.textContent = avgRateKBps.toFixed(1) + ' KB/s avg'
  } else {
    showError('Hash verification failed. Tap Reset to try again.')
    // Reset decoder so user can retry
    state.decoder = null
    state.reconstructedBlob = null
    state.startTime = null
    showStatus('scanning')
    elements.statSymbols.textContent = '0 codes'
  }
}

// Download the received file
function downloadFile() {
  if (!state.reconstructedBlob || !state.decoder || !state.decoder.metadata) return

  const url = URL.createObjectURL(state.reconstructedBlob)
  const a = document.createElement('a')
  a.href = url
  a.download = state.decoder.metadata.filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)

  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Reset receiver state
export function resetReceiver() {
  stopScanning()
  state.decoder = null
  state.reconstructedBlob = null
  state.startTime = null
  state.hasNotifiedFirstScan = false
  // Reset mode state
  state.detectedMode = null
  state.manualMode = null
  state.effectiveMode = QR_MODE.BW
  // Reset debug counters
  state.frameCount = 0
  state.detectCount = 0
  // Reset adaptive thresholds and palette stats
  adaptiveThresholds.reset()
  rgbAdaptiveThresholds.reset()
  paletteStats.reset()
  // Reset color decoder
  if (state.colorDecoder) {
    state.colorDecoder.reset()
  }

  if (elements) {
    showStatus('scanning')
    elements.progressFill.style.width = '0%'
    elements.fileNameDisplay.textContent = '-'
    elements.statBlocks.textContent = '0/0'
    elements.statSymbols.textContent = '0 codes'
    elements.statRate.textContent = '-'
    elements.statEta.textContent = ''
    updateModeStatus()
  }
}

// Auto-start receiver (called when entering receiver screen)
export async function autoStartReceiver() {
  const defaultCameraId = await enumerateCameras()
  if (defaultCameraId) {
    await startScanning(defaultCameraId)
  }
}

// Initialize receiver module
export function initReceiver(errorHandler) {
  showError = errorHandler

  elements = {
    cameraDropdown: document.getElementById('camera-dropdown'),
    cameraPicker: document.getElementById('camera-picker'),
    btnCameraSwitch: document.getElementById('btn-camera-switch'),
    video: document.getElementById('camera-video'),
    qrOverlay: document.getElementById('qr-overlay'),
    qrPolygon: document.getElementById('qr-polygon'),
    statusScanning: document.getElementById('status-scanning'),
    statusReceiving: document.getElementById('status-receiving'),
    statusComplete: document.getElementById('status-complete'),
    progressFill: document.getElementById('progress-fill'),
    fileNameDisplay: document.getElementById('file-name-display'),
    completeFileName: document.getElementById('complete-file-name'),
    statBlocks: document.getElementById('stat-blocks'),
    statSymbols: document.getElementById('stat-symbols'),
    statRate: document.getElementById('stat-rate'),
    statEta: document.getElementById('stat-eta'),
    btnDownload: document.getElementById('btn-download'),
    btnReceiveAnother: document.getElementById('btn-receive-another'),
    btnResetReceiver: document.getElementById('btn-reset-receiver'),
    completeRate: document.getElementById('complete-rate'),
    // Mode override elements
    modeStatus: document.getElementById('mode-status'),
    receiverModeButtons: document.querySelectorAll('#receiver-mode-selector .mode-btn'),
    // Debug elements
    btnCopyLog: document.getElementById('btn-copy-log'),
    debugLog: document.getElementById('debug-log')
  }

  // Bind event handlers
  elements.btnCameraSwitch.onclick = toggleMobileCamera
  elements.cameraDropdown.onchange = (e) => switchCamera(e.target.value)
  elements.btnDownload.onclick = downloadFile
  elements.btnReceiveAnother.onclick = restartReceiver
  elements.btnResetReceiver.onclick = restartReceiver
  elements.btnCopyLog.onclick = async () => {
    try {
      await navigator.clipboard.writeText(elements.debugLog.textContent)
      elements.btnCopyLog.textContent = 'Copied!'
      setTimeout(() => { elements.btnCopyLog.textContent = 'Copy' }, 1500)
    } catch (err) {
      // Fallback for iOS
      const text = elements.debugLog.textContent
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      elements.btnCopyLog.textContent = 'Copied!'
      setTimeout(() => { elements.btnCopyLog.textContent = 'Copy' }, 1500)
    }
  }

  // Mode override handlers
  elements.receiverModeButtons.forEach(btn => {
    btn.onclick = () => {
      const mode = parseInt(btn.dataset.mode)
      // Toggle: clicking active mode clears override (back to auto)
      if (state.manualMode === mode) {
        state.manualMode = null
      } else {
        state.manualMode = mode
      }
      updateModeStatus()
    }
  })
}

// Restart receiver for another file
async function restartReceiver() {
  resetReceiver()
  await autoStartReceiver()
}
