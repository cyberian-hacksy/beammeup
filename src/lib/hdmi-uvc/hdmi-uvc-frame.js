// HDMI-UVC frame encoding/decoding with anchor-based layout

import {
  FRAME_MAGIC, HEADER_SIZE, ANCHOR_SIZE, MARGIN_SIZE, BLOCK_SIZE,
  ANCHOR_PATTERN, HDMI_MODE, HDMI_MODE_NAMES, getModeBitsPerBlock, getModeDataBlockSize,
  getModeHeaderBlockSize, getModePayloadBlockSize
} from './hdmi-uvc-constants.js'
// crc32WithFallback prefers the WASM kernel (Phase 4) once loaded and
// transparently falls back to the JS implementation before instantiation.
// scanBrightRunsWithFallback offloads the anchor-detection inner loop the
// same way. Both expose a JS-compatible signature so callers need not know
// which backend ran.
import {
  crc32WithFallback as crc32,
  scanBrightRunsWithFallback,
  isHdmiUvcWasmActive,
  wasmClassifyCompat4Cells,
  wasmClassifyLuma2Cells
} from './hdmi-uvc-wasm.js'
import { getWasmClassifierEnabled } from './hdmi-uvc-diagnostics.js'

// Per-decode timing accumulator for the WASM payload-cell classifier.
// The receiver resets this before each decodeDataRegion call and reads it
// after so the frame perf log can attribute classifier cost separately
// from the rest of decode. Main thread and worker each see their own
// module copy — neither can read the other's. The receiver wires only
// the main-thread accumulator into its frame perf telemetry today.
let classifierMsAccumulator = 0
export function resetClassifierPerfAccumulator() { classifierMsAccumulator = 0 }
export function getClassifierPerfAccumulator() { return classifierMsAccumulator }
const classifierPerfNow = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now()

// --- Binary modulation (1 bit per block) ---
// Each byte is encoded as 8 blocks (MSB first): bit=1 → white (255), bit=0 → black (0).
// Receiver thresholds at 128. MJPEG corrupts values by ±20 but binary has 108+ margin.

const BITS_PER_BYTE = 8
const HEADER_BLOCKS = HEADER_SIZE * BITS_PER_BYTE // 22 bytes × 8 bits = 176 blocks
const GRAY2_LEVEL_FRACTIONS = [0.08, 0.36, 0.64, 0.92]
const GRAY2_THRESHOLD_FRACTIONS = [0.22, 0.50, 0.78]
const RGB3_PALETTE = [
  [255, 255, 255],
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255]
]
const RGB3_PILOT_SYMBOLS = [0, 1, 2, 3]
const RGB3_NORMALIZED_PALETTE = RGB3_PALETTE.map((color) => color.map((channel) => channel / 255))
const ENABLE_BINARY_PILOTS = false
const ENABLE_PAYLOAD_INTERLEAVING = false
const BINARY_PILOT_SPACING = 16
const BINARY_PILOT_OFFSET = 8
const payloadCellOrderCache = new Map()
const BINARY_3_MIN_HEADER_BAND_ROWS = 1
const BINARY_3_HEADER_PAD_BYTE = 0xAA
const BINARY_3_HEADER_BLOCK_SIZE = 4
const BINARY_3_PAYLOAD_BLOCK_SIZE = 3
const BINARY_3_REF_STRIP_WIDTH_4X4 = 1
const BINARY_3_REF_STRIP_PX = BINARY_3_REF_STRIP_WIDTH_4X4 * BINARY_3_HEADER_BLOCK_SIZE
export const CODEBOOK3_PATTERNS = [
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [1, 1, 0, 0],
  [0, 0, 1, 1],
  [1, 0, 1, 0],
  [0, 1, 0, 1],
  [1, 0, 0, 1],
  [0, 1, 1, 0]
]
export const LUMA2_PATTERNS = [
  [1, 1, 0, 0],
  [0, 0, 1, 1],
  [1, 0, 1, 0],
  [0, 1, 0, 1]
]
const GLYPH5_GRID_SIZE = 4
const GLYPH5_SYMBOL_COUNT = 32
export const GLYPH5_CODEBOOK = buildGlyph5Codebook()

function popcount16(mask) {
  let value = mask
  let count = 0
  while (value) {
    value &= value - 1
    count++
  }
  return count
}

function hammingDistance16(a, b) {
  return popcount16(a ^ b)
}

function buildGlyph5Pattern(mask) {
  const pattern = new Array(GLYPH5_GRID_SIZE * GLYPH5_GRID_SIZE)
  for (let i = 0; i < pattern.length; i++) {
    pattern[i] = (mask >> (pattern.length - 1 - i)) & 1
  }
  return pattern
}

function glyph5TransitionScore(mask) {
  let score = 0
  for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
    for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
      const idx = row * GLYPH5_GRID_SIZE + col
      const bit = (mask >> (15 - idx)) & 1
      if (col + 1 < GLYPH5_GRID_SIZE) {
        const right = (mask >> (15 - (idx + 1))) & 1
        if (bit !== right) score++
      }
      if (row + 1 < GLYPH5_GRID_SIZE) {
        const down = (mask >> (15 - (idx + GLYPH5_GRID_SIZE))) & 1
        if (bit !== down) score++
      }
    }
  }
  return score
}

function buildGlyph5Candidates() {
  const candidates = []
  for (let mask = 0; mask < 0x10000; mask++) {
    if (popcount16(mask) !== 8) continue

    let valid = true
    for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
      let rowCount = 0
      for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
        rowCount += (mask >> (15 - (row * GLYPH5_GRID_SIZE + col))) & 1
      }
      if (rowCount < 1 || rowCount > 3) {
        valid = false
        break
      }
    }
    if (!valid) continue

    for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
      let colCount = 0
      for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
        colCount += (mask >> (15 - (row * GLYPH5_GRID_SIZE + col))) & 1
      }
      if (colCount < 1 || colCount > 3) {
        valid = false
        break
      }
    }
    if (!valid) continue

    candidates.push({
      mask,
      pattern: buildGlyph5Pattern(mask),
      score: glyph5TransitionScore(mask)
    })
  }

  candidates.sort((a, b) => b.score - a.score || a.mask - b.mask)
  return candidates
}

function buildGlyph5Codebook() {
  const candidates = buildGlyph5Candidates()
  const selected = []
  const usedMasks = new Set()

  for (let minDistance = 8; minDistance >= 4 && selected.length < GLYPH5_SYMBOL_COUNT; minDistance--) {
    for (const candidate of candidates) {
      if (usedMasks.has(candidate.mask)) continue
      const ok = selected.every((entry) => hammingDistance16(entry.mask, candidate.mask) >= minDistance)
      if (!ok) continue
      selected.push(candidate)
      usedMasks.add(candidate.mask)
      if (selected.length >= GLYPH5_SYMBOL_COUNT) break
    }
  }

  if (selected.length < GLYPH5_SYMBOL_COUNT) {
    throw new Error(`Failed to build Glyph5 codebook (${selected.length}/${GLYPH5_SYMBOL_COUNT})`)
  }

  return selected.slice(0, GLYPH5_SYMBOL_COUNT).map((entry) => entry.pattern)
}

// Encode a byte into 8 binary block values (returned as array of 0/255)
function encodeBits(byte) {
  const bits = new Array(8)
  for (let i = 0; i < 8; i++) {
    bits[i] = (byte >> (7 - i)) & 1 ? 255 : 0
  }
  return bits
}

// Decode 8 sampled block values into a byte (threshold at 128)
function decodeBits(values) {
  let byte = 0
  for (let i = 0; i < 8; i++) {
    if (values[i] > 128) byte |= (1 << (7 - i))
  }
  return byte
}

function encodeGray2(symbol) {
  return Math.round(255 * GRAY2_LEVEL_FRACTIONS[symbol & 0x3])
}

function decodeGray2(sample, blackLevel = 0, whiteLevel = 255) {
  const minLevel = Math.max(0, Math.min(blackLevel, whiteLevel))
  const maxLevel = Math.min(255, Math.max(blackLevel, whiteLevel))
  const span = Math.max(64, maxLevel - minLevel)
  const t1 = minLevel + span * GRAY2_THRESHOLD_FRACTIONS[0]
  const t2 = minLevel + span * GRAY2_THRESHOLD_FRACTIONS[1]
  const t3 = minLevel + span * GRAY2_THRESHOLD_FRACTIONS[2]

  if (sample < t1) return 0
  if (sample < t2) return 1
  if (sample < t3) return 2
  return 3
}

function encodeRgb3(symbol) {
  return RGB3_PALETTE[symbol & 0x7]
}

function normalizeRgbSample(sample, blackLevels = [0, 0, 0], whiteLevels = [255, 255, 255]) {
  const normalized = [0, 0, 0]
  for (let channel = 0; channel < 3; channel++) {
    const minLevel = Math.max(0, Math.min(blackLevels[channel], whiteLevels[channel]))
    const maxLevel = Math.min(255, Math.max(blackLevels[channel], whiteLevels[channel]))
    const span = Math.max(64, maxLevel - minLevel)
    const value = (sample[channel] - minLevel) / span
    normalized[channel] = Math.max(0, Math.min(1, value))
  }
  return normalized
}

function decodeRgb3(sample, blackLevels = [0, 0, 0], whiteLevels = [255, 255, 255], palette = RGB3_NORMALIZED_PALETTE) {
  const normalized = normalizeRgbSample(sample, blackLevels, whiteLevels)

  let bestSymbol = 0
  let bestError = Infinity
  for (let symbol = 0; symbol < palette.length; symbol++) {
    const target = palette[symbol]
    let error = 0
    for (let channel = 0; channel < 3; channel++) {
      const delta = normalized[channel] - target[channel]
      error += delta * delta
    }
    if (error < bestError) {
      bestError = error
      bestSymbol = symbol
    }
  }

  return bestSymbol
}

function normalizeBinarySample(sample, blackLevel = 0, whiteLevel = 255) {
  const span = Math.max(48, Math.abs(whiteLevel - blackLevel))
  const polarity = whiteLevel >= blackLevel ? 1 : -1
  const normalized = (polarity * (sample - blackLevel)) / span
  return Math.max(0, Math.min(1, normalized))
}

function decodeQuadrantCodebook(samples, blackLevel = 0, whiteLevel = 255, patterns) {
  const normalized = samples.map((sample) => normalizeBinarySample(sample, blackLevel, whiteLevel))
  let bestSymbol = 0
  let bestError = Infinity

  for (let symbol = 0; symbol < patterns.length; symbol++) {
    const pattern = patterns[symbol]
    let error = 0
    for (let i = 0; i < 4; i++) {
      const delta = normalized[i] - pattern[i]
      error += delta * delta
    }
    if (error < bestError) {
      bestError = error
      bestSymbol = symbol
    }
  }

  return bestSymbol
}

export function decodeCodebook3(samples, blackLevel = 0, whiteLevel = 255) {
  return decodeQuadrantCodebook(samples, blackLevel, whiteLevel, CODEBOOK3_PATTERNS)
}

export function decodeLuma2(samples, blackLevel = 0, whiteLevel = 255) {
  const normalized = samples.map((sample) => normalizeBinarySample(sample, blackLevel, whiteLevel))
  const top = (normalized[0] + normalized[1]) * 0.5
  const bottom = (normalized[2] + normalized[3]) * 0.5
  const left = (normalized[0] + normalized[2]) * 0.5
  const right = (normalized[1] + normalized[3]) * 0.5

  const horizontalContrast = Math.abs(top - bottom)
  const verticalContrast = Math.abs(left - right)

  if (horizontalContrast >= verticalContrast) {
    return top >= bottom ? 0 : 1
  }

  return left >= right ? 2 : 3
}

export function decodeGlyph5(samples, blackLevel = 0, whiteLevel = 255) {
  const normalized = samples.map((sample) => normalizeBinarySample(sample, blackLevel, whiteLevel))
  let bestSymbol = 0
  let bestError = Infinity

  for (let symbol = 0; symbol < GLYPH5_CODEBOOK.length; symbol++) {
    const pattern = GLYPH5_CODEBOOK[symbol]
    let error = 0
    for (let i = 0; i < pattern.length; i++) {
      const delta = normalized[i] - pattern[i]
      error += delta * delta
    }
    if (error < bestError) {
      bestError = error
      bestSymbol = symbol
    }
  }

  return bestSymbol
}

function fillBlockSolid(imageData, width, startX, startY, size, r, g, b) {
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      const i = ((startY + dy) * width + (startX + dx)) * 4
      imageData[i] = r
      imageData[i + 1] = g
      imageData[i + 2] = b
    }
  }
}

function fillRectSolid(imageData, width, startX, startY, rectWidth, rectHeight, r, g, b) {
  for (let dy = 0; dy < rectHeight; dy++) {
    for (let dx = 0; dx < rectWidth; dx++) {
      const i = ((startY + dy) * width + (startX + dx)) * 4
      imageData[i] = r
      imageData[i + 1] = g
      imageData[i + 2] = b
    }
  }
}

function renderQuadrantCodebookBlock(imageData, width, startX, startY, size, pattern) {
  const xMid = Math.max(startX + 1, Math.min(startX + size - 1, startX + Math.round(size / 2)))
  const yMid = Math.max(startY + 1, Math.min(startY + size - 1, startY + Math.round(size / 2)))
  const quadrants = [
    [startX, startY, xMid, yMid],
    [xMid, startY, startX + size, yMid],
    [startX, yMid, xMid, startY + size],
    [xMid, yMid, startX + size, startY + size]
  ]

  for (let q = 0; q < quadrants.length; q++) {
    const [x0, y0, x1, y1] = quadrants[q]
    const val = pattern[q] ? 255 : 0
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const i = (py * width + px) * 4
        imageData[i] = val
        imageData[i + 1] = val
        imageData[i + 2] = val
      }
    }
  }
}

export function renderCodebook3Block(imageData, width, startX, startY, size, symbol) {
  renderQuadrantCodebookBlock(imageData, width, startX, startY, size, CODEBOOK3_PATTERNS[symbol & 0x7])
}

export function renderLuma2Block(imageData, width, startX, startY, size, symbol) {
  renderQuadrantCodebookBlock(imageData, width, startX, startY, size, LUMA2_PATTERNS[symbol & 0x3])
}

export function renderGlyph5Block(imageData, width, startX, startY, size, symbol) {
  const pattern = GLYPH5_CODEBOOK[symbol & 0x1F]
  for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
    const y0 = startY + Math.floor((row * size) / GLYPH5_GRID_SIZE)
    const y1 = startY + Math.floor(((row + 1) * size) / GLYPH5_GRID_SIZE)
    for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
      const x0 = startX + Math.floor((col * size) / GLYPH5_GRID_SIZE)
      const x1 = startX + Math.floor(((col + 1) * size) / GLYPH5_GRID_SIZE)
      const val = pattern[row * GLYPH5_GRID_SIZE + col] ? 255 : 0
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const i = (py * width + px) * 4
          imageData[i] = val
          imageData[i + 1] = val
          imageData[i + 2] = val
        }
      }
    }
  }
}

function extractBits(data, bitPos, count) {
  let value = 0
  for (let i = 0; i < count; i++) {
    const absoluteBit = bitPos + i
    const byteIdx = Math.floor(absoluteBit / BITS_PER_BYTE)
    const bitIdx = absoluteBit % BITS_PER_BYTE
    const bit = byteIdx < data.length ? ((data[byteIdx] >> (7 - bitIdx)) & 1) : 0
    value = (value << 1) | bit
  }
  return value
}

function appendSymbolBits(payload, state, symbol, bitsPerBlock) {
  state.bitBuffer = (state.bitBuffer << bitsPerBlock) | symbol
  state.bitCount += bitsPerBlock

  while (state.bitCount >= BITS_PER_BYTE && state.index < payload.length) {
    payload[state.index++] = (state.bitBuffer >> (state.bitCount - BITS_PER_BYTE)) & 0xFF
    state.bitCount -= BITS_PER_BYTE
    if (state.bitCount > 0) {
      state.bitBuffer &= (1 << state.bitCount) - 1
    } else {
      state.bitBuffer = 0
    }
  }
}

// --- Anchor rendering ---

// Draw an anchor pattern at (originX, originY) into RGBA imageData
export function renderAnchor(imageData, width, originX, originY) {
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const val = ANCHOR_PATTERN[by][bx] ? 255 : 0
      const startX = originX + bx * BLOCK_SIZE
      const startY = originY + by * BLOCK_SIZE
      for (let dy = 0; dy < BLOCK_SIZE; dy++) {
        for (let dx = 0; dx < BLOCK_SIZE; dx++) {
          const px = startX + dx
          const py = startY + dy
          if (px >= 0 && px < width) {
            const i = (py * width + px) * 4
            imageData[i] = val
            imageData[i + 1] = val
            imageData[i + 2] = val
            // Alpha already set to 255
          }
        }
      }
    }
  }
}

// --- Data region geometry ---

// Get the data region bounds for a frame of given dimensions
export function getDataRegion(width, height) {
  return {
    x: MARGIN_SIZE,
    y: MARGIN_SIZE,
    w: width - 2 * MARGIN_SIZE,
    h: height - 2 * MARGIN_SIZE
  }
}

function getBinary3HeaderBandRows(headerCellsX) {
  return Math.max(
    BINARY_3_MIN_HEADER_BAND_ROWS,
    Math.ceil((HEADER_SIZE * BITS_PER_BYTE) / Math.max(1, headerCellsX))
  )
}

// Calculate payload capacity in bytes (binary modulation: 8 data-blocks per byte)
export function getPayloadCapacity(width, height, mode = HDMI_MODE.COMPAT_4) {
  if (mode === HDMI_MODE.BINARY_3) {
    const dr = getDataRegion(width, height)
    const headerCellsX = Math.floor(dr.w / BINARY_3_HEADER_BLOCK_SIZE)
    const headerBandRows = getBinary3HeaderBandRows(headerCellsX)
    const payloadW = dr.w - 2 * BINARY_3_REF_STRIP_PX
    const payloadH = dr.h - headerBandRows * BINARY_3_HEADER_BLOCK_SIZE
    const payloadCellsX = Math.floor(payloadW / BINARY_3_PAYLOAD_BLOCK_SIZE)
    const payloadCellsY = Math.floor(payloadH / BINARY_3_PAYLOAD_BLOCK_SIZE)
    return Math.max(0, Math.floor((payloadCellsX * payloadCellsY) / BITS_PER_BYTE))
  }

  const dataBlockSize = getModePayloadBlockSize(mode)
  const bitsPerBlock = getModeBitsPerBlock(mode)
  if (!dataBlockSize || !bitsPerBlock) return 0
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / dataBlockSize)
  const blocksY = Math.floor(dr.h / dataBlockSize)
  const payloadBlocks = getUsablePayloadBlocks(mode, blocksX, blocksY)
  return Math.max(0, Math.floor((payloadBlocks * bitsPerBlock) / BITS_PER_BYTE))
}

// Native-geometry guidance string used by the sender's resample warning. Tested
// here because hdmi-uvc-frame.js is the module that test runners import.
export function buildNativeGeometryGuidance() {
  return [
    'Native 1080p required for dense modes. Checklist:',
    '  1. Sender display mode: 1920x1080 @ 60',
    '  2. Browser fullscreen: real 1920x1080',
    '  3. Canvas internal: 1920x1080',
    '  4. Canvas CSS size: 1920x1080',
    '  5. Browser zoom: 100%',
    '  6. OS display scaling: off / true 1080p output',
    '  7. No CSS transform on canvas',
    '  8. image-rendering: pixelated'
  ].join('\n')
}

export function isNative1080pGeometry(metrics) {
  if (!hasEffectiveOneToOnePresentation(metrics)) return false
  return !!metrics &&
    metrics.renderPresetId === '1080p' &&
    metrics.width === 1920 &&
    metrics.height === 1080 &&
    (metrics.displayX || 0) === 0 &&
    (metrics.displayY || 0) === 0 &&
    metrics.fullscreenActive === true
}

export function hasEffectiveOneToOnePresentation(metrics) {
  const dpr = metrics?.devicePixelRatio || 1
  const physicalWidth = Number.isFinite(metrics?.physicalDisplayWidth)
    ? metrics.physicalDisplayWidth
    : Math.round((metrics?.displayWidth || 0) * dpr)
  const physicalHeight = Number.isFinite(metrics?.physicalDisplayHeight)
    ? metrics.physicalDisplayHeight
    : Math.round((metrics?.displayHeight || 0) * dpr)
  const effectiveScale = Number.isFinite(metrics?.effectiveDisplayScale)
    ? metrics.effectiveDisplayScale
    : Math.min(
      metrics?.width ? physicalWidth / metrics.width : 0,
      metrics?.height ? physicalHeight / metrics.height : 0
    )

  return !!metrics &&
    Math.abs(physicalWidth - metrics.width) <= 2 &&
    Math.abs(physicalHeight - metrics.height) <= 2 &&
    Math.abs(effectiveScale - 1) <= 0.002
}

export function classifyStep(stepX, stepY) {
  const nearestX = Math.round(stepX)
  const nearestY = Math.round(stepY)
  const driftX = Math.abs(stepX - nearestX)
  const driftY = Math.abs(stepY - nearestY)
  const skew = Math.abs(stepX - stepY)

  if (skew > 0.10) return 'skewed'
  if (driftX > 0.05 || driftY > 0.05) return 'fractional'
  return 'integer'
}

function getBinaryPilotConfig(mode) {
  if (!ENABLE_BINARY_PILOTS || mode !== HDMI_MODE.COMPAT_4) return null
  return {
    spacing: BINARY_PILOT_SPACING,
    offsetX: BINARY_PILOT_OFFSET,
    offsetY: BINARY_PILOT_OFFSET
  }
}

function getPilotBit(config, bx, by) {
  const gx = Math.floor((bx - config.offsetX) / config.spacing)
  const gy = Math.floor((by - config.offsetY) / config.spacing)
  return (gx + gy) & 1
}

function isPilotBlock(mode, bx, by, blockIdx) {
  const config = getBinaryPilotConfig(mode)
  if (!config || blockIdx < HEADER_BLOCKS) return false
  if (bx < config.offsetX || by < config.offsetY) return false
  return ((bx - config.offsetX) % config.spacing === 0) &&
    ((by - config.offsetY) % config.spacing === 0)
}

function countPilotBlocks(mode, blocksX, blocksY) {
  const config = getBinaryPilotConfig(mode)
  if (!config) return 0

  let count = 0
  for (let by = config.offsetY; by < blocksY; by += config.spacing) {
    for (let bx = config.offsetX; bx < blocksX; bx += config.spacing) {
      const blockIdx = by * blocksX + bx
      if (blockIdx >= HEADER_BLOCKS) count++
    }
  }
  return count
}

function getReservedPayloadCells(mode) {
  return mode === HDMI_MODE.RAW_RGB ? RGB3_PILOT_SYMBOLS.length : 0
}

function getUsablePayloadBlocks(mode, blocksX, blocksY) {
  const totalBlocks = blocksX * blocksY
  const payloadBlocks = Math.max(0, totalBlocks - HEADER_BLOCKS)
  return Math.max(0, payloadBlocks - countPilotBlocks(mode, blocksX, blocksY) - getReservedPayloadCells(mode))
}

function gcd(a, b) {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x || 1
}

function choosePayloadInterleaveStride(count) {
  if (count < 2) return 1

  let stride = Math.max(1, Math.floor(count * 0.61803398875))
  while (stride > 1 && gcd(stride, count) !== 1) {
    stride--
  }
  return Math.max(1, stride)
}

function getPayloadCellOrder(mode, blocksX, blocksY) {
  const cacheKey = `${mode}:${blocksX}x${blocksY}:${ENABLE_PAYLOAD_INTERLEAVING ? 1 : 0}`
  const cached = payloadCellOrderCache.get(cacheKey)
  if (cached) return cached

  const cells = []
  let blockIdx = 0
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      if (blockIdx >= HEADER_BLOCKS && !isPilotBlock(mode, bx, by, blockIdx)) {
        cells.push({ bx, by })
      }
      blockIdx++
    }
  }

  if (!ENABLE_PAYLOAD_INTERLEAVING || mode !== HDMI_MODE.COMPAT_4 || cells.length < 2) {
    payloadCellOrderCache.set(cacheKey, cells)
    return cells
  }

  const stride = choosePayloadInterleaveStride(cells.length)
  const interleaved = new Array(cells.length)
  for (let logicalIdx = 0; logicalIdx < cells.length; logicalIdx++) {
    interleaved[logicalIdx] = cells[(logicalIdx * stride) % cells.length]
  }

  payloadCellOrderCache.set(cacheKey, interleaved)
  return interleaved
}

// --- Header serialization ---

export function buildHeader(mode, width, height, fps, symbolId, payloadLength, payloadCrc) {
  const header = new ArrayBuffer(HEADER_SIZE)
  const view = new DataView(header)
  view.setUint32(0, FRAME_MAGIC, false)
  view.setUint8(4, mode)
  view.setUint16(5, width, false)
  view.setUint16(7, height, false)
  view.setUint8(9, fps)
  view.setUint32(10, symbolId, false)
  view.setUint32(14, payloadLength, false)
  view.setUint32(18, payloadCrc, false)
  return new Uint8Array(header)
}

export function parseHeader(data) {
  if (data.length < HEADER_SIZE) return null
  const MAGIC_BYTES = [0xFF, 0x00, 0xFF, 0x00]
  const TOLERANCE = 0 // exact match — prevents 1-bit-shifted [0xFE,0x01] from passing as [0xFF,0x00]
  for (let i = 0; i < 4; i++) {
    if (Math.abs(data[i] - MAGIC_BYTES[i]) > TOLERANCE) return null
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const mode = view.getUint8(4)
  if (!getModeHeaderBlockSize(mode) || !getModePayloadBlockSize(mode)) return null
  const width = view.getUint16(5, false)
  const height = view.getUint16(7, false)
  if (width < 100 || width > 8000 || height < 100 || height > 8000) return null
  const payloadLength = view.getUint32(14, false)
  if (payloadLength === 0 || payloadLength > width * height * 3) return null
  return {
    magic: FRAME_MAGIC,
    mode,
    width,
    height,
    fps: view.getUint8(9),
    symbolId: view.getUint32(10, false),
    payloadLength,
    payloadCrc: view.getUint32(18, false)
  }
}

// --- Frame building (sender) ---

export function initializeFrameBuffer(imageData, width, height) {
  imageData.fill(0)
  for (let i = 3; i < imageData.length; i += 4) {
    imageData[i] = 255
  }

  renderAnchor(imageData, width, 0, 0)                                      // top-left
  renderAnchor(imageData, width, width - ANCHOR_SIZE, 0)                    // top-right
  renderAnchor(imageData, width, 0, height - ANCHOR_SIZE)                   // bottom-left
  renderAnchor(imageData, width, width - ANCHOR_SIZE, height - ANCHOR_SIZE) // bottom-right
}

export function createFrameBuffer(width, height) {
  const imageData = new Uint8ClampedArray(width * height * 4)
  initializeFrameBuffer(imageData, width, height)
  return imageData
}

function buildBinary3Frame(payload, width, height, fps, symbolId, targetBuffer = null) {
  const payloadCrc = crc32(payload)
  const headerBytes = buildHeader(HDMI_MODE.BINARY_3, width, height, fps, symbolId, payload.length, payloadCrc)

  const expectedLength = width * height * 4
  const imageData = targetBuffer && targetBuffer.length === expectedLength
    ? targetBuffer
    : createFrameBuffer(width, height)

  const dr = getDataRegion(width, height)
  fillRectSolid(imageData, width, dr.x, dr.y, dr.w, dr.h, 0, 0, 0)

  const headerCellsX = Math.floor(dr.w / BINARY_3_HEADER_BLOCK_SIZE)
  const headerBandRows = getBinary3HeaderBandRows(headerCellsX)
  const headerBandHeightPx = headerBandRows * BINARY_3_HEADER_BLOCK_SIZE
  const totalHeaderBits = headerCellsX * headerBandRows
  const totalHeaderBytes = Math.ceil(totalHeaderBits / BITS_PER_BYTE)
  const paddedHeader = new Uint8Array(totalHeaderBytes)
  paddedHeader.set(headerBytes, 0)
  for (let i = headerBytes.length; i < totalHeaderBytes; i++) {
    paddedHeader[i] = BINARY_3_HEADER_PAD_BYTE
  }

  let bitIdx = 0
  let byteIdx = 0
  for (let by = 0; by < headerBandRows; by++) {
    for (let bx = 0; bx < headerCellsX; bx++) {
      const bit = (paddedHeader[byteIdx] >> (7 - bitIdx)) & 1
      const val = bit ? 255 : 0
      fillBlockSolid(
        imageData,
        width,
        dr.x + bx * BINARY_3_HEADER_BLOCK_SIZE,
        dr.y + by * BINARY_3_HEADER_BLOCK_SIZE,
        BINARY_3_HEADER_BLOCK_SIZE,
        val,
        val,
        val
      )
      bitIdx++
      if (bitIdx >= BITS_PER_BYTE) {
        bitIdx = 0
        byteIdx++
      }
    }
  }

  const payloadBandHeight = Math.max(0, dr.h - headerBandHeightPx)
  const stripRows = Math.floor(payloadBandHeight / BINARY_3_HEADER_BLOCK_SIZE)
  const rightStripX = dr.x + dr.w - BINARY_3_REF_STRIP_PX
  for (let row = 0; row < stripRows; row++) {
    const leftVal = (row & 1) ? 255 : 0
    const rightVal = leftVal ? 0 : 255
    const y = dr.y + headerBandHeightPx + row * BINARY_3_HEADER_BLOCK_SIZE
    fillRectSolid(imageData, width, dr.x, y, BINARY_3_REF_STRIP_PX, BINARY_3_HEADER_BLOCK_SIZE, leftVal, leftVal, leftVal)
    fillRectSolid(imageData, width, rightStripX, y, BINARY_3_REF_STRIP_PX, BINARY_3_HEADER_BLOCK_SIZE, rightVal, rightVal, rightVal)
  }

  const payloadX = dr.x + BINARY_3_REF_STRIP_PX
  const payloadY = dr.y + headerBandHeightPx
  const payloadW = dr.w - 2 * BINARY_3_REF_STRIP_PX
  const payloadCellsX = Math.floor(payloadW / BINARY_3_PAYLOAD_BLOCK_SIZE)
  const payloadCellsY = Math.floor(payloadBandHeight / BINARY_3_PAYLOAD_BLOCK_SIZE)
  const payloadBitLength = payload.length * BITS_PER_BYTE
  let payloadBitPos = 0

  for (let cy = 0; cy < payloadCellsY; cy++) {
    for (let cx = 0; cx < payloadCellsX; cx++) {
      const symbol = payloadBitPos < payloadBitLength ? extractBits(payload, payloadBitPos, 1) : 0
      payloadBitPos++
      const val = symbol ? 255 : 0
      fillBlockSolid(
        imageData,
        width,
        payloadX + cx * BINARY_3_PAYLOAD_BLOCK_SIZE,
        payloadY + cy * BINARY_3_PAYLOAD_BLOCK_SIZE,
        BINARY_3_PAYLOAD_BLOCK_SIZE,
        val,
        val,
        val
      )
    }
  }

  return imageData
}

// Build a complete frame: static background/anchors plus header + payload blocks.
// When `targetBuffer` is provided, it must already contain the initialized static
// frame base (black background, alpha=255, anchors).
export function buildFrame(payload, mode, width, height, fps, symbolId, targetBuffer = null) {
  if (mode === HDMI_MODE.BINARY_3) {
    return buildBinary3Frame(payload, width, height, fps, symbolId, targetBuffer)
  }

  const headerBlockSize = getModeHeaderBlockSize(mode)
  const payloadBlockSize = getModePayloadBlockSize(mode)
  const dataBlockSize = payloadBlockSize
  const bitsPerBlock = getModeBitsPerBlock(mode)
  if (!headerBlockSize || !payloadBlockSize || !bitsPerBlock) {
    throw new Error(`Unsupported HDMI-UVC mode: ${mode}`)
  }
  const payloadCrc = crc32(payload)
  const headerBytes = buildHeader(mode, width, height, fps, symbolId, payload.length, payloadCrc)

  const expectedLength = width * height * 4
  const imageData = targetBuffer && targetBuffer.length === expectedLength
    ? targetBuffer
    : createFrameBuffer(width, height)

  // Fill data region with mode-sized blocks. The HDMI header remains binary for
  // robust lock; some modes carry more than 1 bit per payload block.
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / dataBlockSize)
  const blocksY = Math.floor(dr.h / dataBlockSize)
  const payloadCells = getPayloadCellOrder(mode, blocksX, blocksY)
  const reservedPayloadCells = getReservedPayloadCells(mode)
  let headerByteIdx = 0
  let headerBitIdx = 0
  let payloadBitPos = 0
  const payloadBitLength = payload.length * BITS_PER_BYTE

  let blockIdx = 0
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let r = 0
      let g = 0
      let b = 0
      if (blockIdx < HEADER_BLOCKS) {
        let val = 0
        if (headerByteIdx < headerBytes.length) {
          val = (headerBytes[headerByteIdx] >> (7 - headerBitIdx)) & 1 ? 255 : 0
        }
        r = val
        g = val
        b = val
        headerBitIdx++
        if (headerBitIdx >= 8) {
          headerBitIdx = 0
          headerByteIdx++
        }
      } else if (isPilotBlock(mode, bx, by, blockIdx)) {
        const val = getPilotBit(getBinaryPilotConfig(mode), bx, by) ? 255 : 0
        r = val
        g = val
        b = val
      }

      // Fill the mode-specific data block.
      const blockSize = blockIdx < HEADER_BLOCKS ? headerBlockSize : payloadBlockSize
      const startX = dr.x + bx * blockSize
      const startY = dr.y + by * blockSize
      fillBlockSolid(imageData, width, startX, startY, blockSize, r, g, b)
      blockIdx++
    }
  }

  if (mode === HDMI_MODE.RAW_RGB) {
    for (let cellIdx = 0; cellIdx < reservedPayloadCells && cellIdx < payloadCells.length; cellIdx++) {
      const { bx, by } = payloadCells[cellIdx]
      const [r, g, b] = encodeRgb3(RGB3_PILOT_SYMBOLS[cellIdx])
      const startX = dr.x + bx * dataBlockSize
      const startY = dr.y + by * dataBlockSize
      fillBlockSolid(imageData, width, startX, startY, dataBlockSize, r, g, b)
    }
  }

  for (let cellIdx = reservedPayloadCells; cellIdx < payloadCells.length && payloadBitPos < payloadBitLength; cellIdx++) {
    const { bx, by } = payloadCells[cellIdx]
    const symbol = extractBits(payload, payloadBitPos, bitsPerBlock)
    payloadBitPos += bitsPerBlock
    const startX = dr.x + bx * dataBlockSize
    const startY = dr.y + by * dataBlockSize

    let r = 0
    let g = 0
    let b = 0
    if (mode === HDMI_MODE.RAW_RGB) {
      [r, g, b] = encodeRgb3(symbol)
      fillBlockSolid(imageData, width, startX, startY, dataBlockSize, r, g, b)
      continue
    }
    if (mode === HDMI_MODE.GLYPH_5) {
      renderGlyph5Block(imageData, width, startX, startY, dataBlockSize, symbol)
      continue
    }
    if (mode === HDMI_MODE.CODEBOOK_3) {
      renderCodebook3Block(imageData, width, startX, startY, dataBlockSize, symbol)
      continue
    }
    if (mode === HDMI_MODE.LUMA_2) {
      renderLuma2Block(imageData, width, startX, startY, dataBlockSize, symbol)
      continue
    } else {
      const val = bitsPerBlock === 2 ? encodeGray2(symbol) : (symbol ? 255 : 0)
      r = val
      g = val
      b = val
    }

    fillBlockSolid(imageData, width, startX, startY, dataBlockSize, r, g, b)
  }

  return imageData
}

// --- Anchor detection (receiver) ---

// Sample a single pixel's R value at integer coordinates
function samplePixel(imageData, width, x, y) {
  return imageData[(y * width + x) * 4]
}

// Sample the center of a block at (px, py) with given block size.
// Averages a 2×2 area around the block center for noise tolerance.
export function sampleBlockAt(imageData, width, px, py, bs) {
  const cx = Math.round(px + bs / 2) - 1
  const cy = Math.round(py + bs / 2) - 1
  let sum = 0
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      sum += imageData[((cy + dy) * width + (cx + dx)) * 4]
    }
  }
  return sum / 4
}

function sampleBlockRgbAt(imageData, width, px, py, bs) {
  const cx = Math.round(px + bs / 2) - 1
  const cy = Math.round(py + bs / 2) - 1
  const sums = [0, 0, 0]
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const i = ((cy + dy) * width + (cx + dx)) * 4
      sums[0] += imageData[i]
      sums[1] += imageData[i + 1]
      sums[2] += imageData[i + 2]
    }
  }
  return [sums[0] / 4, sums[1] / 4, sums[2] / 4]
}

export function sampleCodebook3At(imageData, width, px, py, bs) {
  const xMid = px + bs / 2
  const yMid = py + bs / 2
  const quadrants = [
    [px, py, xMid, yMid],
    [xMid, py, px + bs, yMid],
    [px, yMid, xMid, py + bs],
    [xMid, yMid, px + bs, py + bs]
  ]

  return quadrants.map(([x0f, y0f, x1f, y1f]) => {
    const x0 = Math.max(0, Math.round(x0f))
    const y0 = Math.max(0, Math.round(y0f))
    const x1 = Math.min(width, Math.max(x0 + 1, Math.round(x1f)))
    const y1 = Math.min(imageData.length / (width * 4), Math.max(y0 + 1, Math.round(y1f)))
    let sum = 0
    let count = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        sum += imageData[(y * width + x) * 4]
        count++
      }
    }
    return count > 0 ? sum / count : 0
  })
}

export function sampleGlyph5At(imageData, width, px, py, bs) {
  const imgHeight = imageData.length / (width * 4)
  const samples = new Array(GLYPH5_GRID_SIZE * GLYPH5_GRID_SIZE)

  for (let row = 0; row < GLYPH5_GRID_SIZE; row++) {
    const y0 = Math.max(0, Math.round(py + (row * bs) / GLYPH5_GRID_SIZE))
    const y1 = Math.min(imgHeight, Math.max(y0 + 1, Math.round(py + ((row + 1) * bs) / GLYPH5_GRID_SIZE)))
    for (let col = 0; col < GLYPH5_GRID_SIZE; col++) {
      const x0 = Math.max(0, Math.round(px + (col * bs) / GLYPH5_GRID_SIZE))
      const x1 = Math.min(width, Math.max(x0 + 1, Math.round(px + ((col + 1) * bs) / GLYPH5_GRID_SIZE)))
      let sum = 0
      let count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += imageData[(y * width + x) * 4]
          count++
        }
      }
      samples[row * GLYPH5_GRID_SIZE + col] = count > 0 ? sum / count : 0
    }
  }

  return samples
}

function sampleBinaryPilotField(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, blocksY, mode) {
  const config = getBinaryPilotConfig(mode)
  if (!config) return null

  const imgHeight = imageData.length / (width * 4)
  const rows = []
  let blackSum = 0
  let whiteSum = 0
  let blackCount = 0
  let whiteCount = 0

  for (let by = config.offsetY; by < blocksY; by += config.spacing) {
    const row = []
    for (let bx = config.offsetX; bx < blocksX; bx += config.spacing) {
      const blockIdx = by * blocksX + bx
      if (blockIdx < HEADER_BLOCKS) {
        row.push(null)
        continue
      }

      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let sample = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        sample = sampleBlockAt(imageData, width, px, py, bs)
      }

      const bit = getPilotBit(config, bx, by)
      row.push({ bit, sample })
      if (bit) {
        whiteSum += sample
        whiteCount++
      } else {
        blackSum += sample
        blackCount++
      }
    }
    rows.push(row)
  }

  return {
    config,
    rows,
    cols: rows[0]?.length || 0,
    rowCount: rows.length,
    globalBlackLevel: blackCount > 0 ? blackSum / blackCount : 0,
    globalWhiteLevel: whiteCount > 0 ? whiteSum / whiteCount : 255
  }
}

function estimateBinaryPilotLevelsAt(field, bx, by, fallbackBlack = 0, fallbackWhite = 255) {
  if (!field || field.rowCount === 0 || field.cols === 0) {
    return { blackLevel: fallbackBlack, whiteLevel: fallbackWhite }
  }

  const { config, rows, cols, rowCount } = field
  const gx = (bx - config.offsetX) / config.spacing
  const gy = (by - config.offsetY) / config.spacing
  const centerX = Math.round(gx)
  const centerY = Math.round(gy)
  let blackSum = 0
  let whiteSum = 0
  let blackWeight = 0
  let whiteWeight = 0

  for (let py = Math.max(0, centerY - 1); py <= Math.min(rowCount - 1, centerY + 1); py++) {
    for (let px = Math.max(0, centerX - 1); px <= Math.min(cols - 1, centerX + 1); px++) {
      const sample = rows[py]?.[px]
      if (!sample) continue

      const weight = 1 / (1 + Math.abs(px - gx) + Math.abs(py - gy))
      if (sample.bit) {
        whiteSum += sample.sample * weight
        whiteWeight += weight
      } else {
        blackSum += sample.sample * weight
        blackWeight += weight
      }
    }
  }

  return {
    blackLevel: blackWeight > 0 ? blackSum / blackWeight : (field.globalBlackLevel ?? fallbackBlack),
    whiteLevel: whiteWeight > 0 ? whiteSum / whiteWeight : (field.globalWhiteLevel ?? fallbackWhite)
  }
}

function binaryConfidence(value, threshold) {
  return Math.min(128, Math.abs(value - threshold)) | 0
}

function buildPaddedBinary3Header(header, headerCellsX) {
  const headerBandRows = getBinary3HeaderBandRows(headerCellsX)
  const totalHeaderBits = headerCellsX * headerBandRows
  const totalHeaderBytes = Math.ceil(totalHeaderBits / BITS_PER_BYTE)
  const paddedHeader = new Uint8Array(totalHeaderBytes)
  const headerBytes = buildHeader(
    header.mode,
    header.width,
    header.height,
    header.fps,
    header.symbolId,
    header.payloadLength,
    header.payloadCrc
  )
  paddedHeader.set(headerBytes, 0)
  for (let i = headerBytes.length; i < totalHeaderBytes; i++) {
    paddedHeader[i] = BINARY_3_HEADER_PAD_BYTE
  }
  return { paddedHeader, headerBandRows }
}

function estimateBinary3LevelsFromHeader(imageData, width, rx, ry, stepX, stepY, bs, headerCellsX, header) {
  const { paddedHeader, headerBandRows } = buildPaddedBinary3Header(header, headerCellsX)
  const imgHeight = imageData.length / (width * 4)
  let blackSum = 0
  let blackCount = 0
  let whiteSum = 0
  let whiteCount = 0
  let bitIdx = 0
  let byteIdx = 0

  for (let by = 0; by < headerBandRows; by++) {
    for (let bx = 0; bx < headerCellsX; bx++) {
      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let val = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        val = sampleBlockAt(imageData, width, px, py, bs)
      }
      const expected = (paddedHeader[byteIdx] >> (7 - bitIdx)) & 1
      if (expected) {
        whiteSum += val
        whiteCount++
      } else {
        blackSum += val
        blackCount++
      }
      bitIdx++
      if (bitIdx >= BITS_PER_BYTE) {
        bitIdx = 0
        byteIdx++
      }
    }
  }

  return {
    blackLevel: blackCount > 0 ? blackSum / blackCount : 0,
    whiteLevel: whiteCount > 0 ? whiteSum / whiteCount : 255
  }
}

function fillMissingBinary3ReferenceRows(levels, fallback) {
  const { rowBlackLevels, rowWhiteLevels } = levels
  for (let i = 0; i < rowBlackLevels.length; i++) {
    if (!Number.isFinite(rowBlackLevels[i])) {
      const prev = i > 0 ? rowBlackLevels[i - 1] : NaN
      const next = i + 1 < rowBlackLevels.length ? rowBlackLevels[i + 1] : NaN
      rowBlackLevels[i] = Number.isFinite(prev) ? prev : (Number.isFinite(next) ? next : fallback.blackLevel)
    }
    if (!Number.isFinite(rowWhiteLevels[i])) {
      const prev = i > 0 ? rowWhiteLevels[i - 1] : NaN
      const next = i + 1 < rowWhiteLevels.length ? rowWhiteLevels[i + 1] : NaN
      rowWhiteLevels[i] = Number.isFinite(prev) ? prev : (Number.isFinite(next) ? next : fallback.whiteLevel)
    }
  }
}

function sampleBinary3ReferenceRows(imageData, width, region, rx, ry, stepX, stepY, bs, headerCellsX, header) {
  const headerBandRows = getBinary3HeaderBandRows(headerCellsX)
  const headerBandHeightCapture = headerBandRows * stepY
  const payloadStartY = ry + headerBandHeightCapture
  const payloadEndX = rx + region.w - stepX * BINARY_3_REF_STRIP_WIDTH_4X4
  const stripRows = Math.max(0, Math.floor((region.h - headerBandHeightCapture) / stepY))
  const rowBlackLevels = new Float32Array(stripRows)
  const rowWhiteLevels = new Float32Array(stripRows)
  rowBlackLevels.fill(NaN)
  rowWhiteLevels.fill(NaN)

  const imgHeight = imageData.length / (width * 4)
  for (let row = 0; row < stripRows; row++) {
    const y = payloadStartY + Math.round(row * stepY)
    let leftVal = NaN
    let rightVal = NaN
    if (y >= 0 && y < imgHeight) {
      if (rx >= 0 && rx < width) leftVal = sampleBlockAt(imageData, width, rx, y, bs)
      if (payloadEndX >= 0 && payloadEndX < width) rightVal = sampleBlockAt(imageData, width, payloadEndX, y, bs)
    }
    if (!Number.isFinite(leftVal) || !Number.isFinite(rightVal)) continue
    if (row & 1) {
      rowWhiteLevels[row] = leftVal
      rowBlackLevels[row] = rightVal
    } else {
      rowBlackLevels[row] = leftVal
      rowWhiteLevels[row] = rightVal
    }
  }

  const headerLevels = estimateBinary3LevelsFromHeader(
    imageData,
    width,
    rx,
    ry,
    stepX,
    stepY,
    bs,
    headerCellsX,
    header
  )
  fillMissingBinary3ReferenceRows({ rowBlackLevels, rowWhiteLevels }, headerLevels)

  return {
    rowBlackLevels,
    rowWhiteLevels,
    headerLevels,
    headerBandRows,
    headerBandHeightCapture,
    stripRows
  }
}

export function precomputeBinary3SampleOffsets(layout, region) {
  const headerStepX = layout.headerStepX || (layout.stepX * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE))
  const headerStepY = layout.headerStepY || (layout.stepY * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE))
  const headerBlocksX = layout.headerBlocksX || Math.floor(region.w / headerStepX)
  const headerBandRows = getBinary3HeaderBandRows(headerBlocksX)
  const stripWidthCapture = headerStepX * BINARY_3_REF_STRIP_WIDTH_4X4
  const payloadStartX = region.x + (layout.xOff || 0) + stripWidthCapture
  const payloadStartY = region.y + (layout.yOff || 0) + headerBandRows * headerStepY
  const payloadStepX = layout.stepX || (headerStepX * (BINARY_3_PAYLOAD_BLOCK_SIZE / BINARY_3_HEADER_BLOCK_SIZE))
  const payloadStepY = layout.stepY || (headerStepY * (BINARY_3_PAYLOAD_BLOCK_SIZE / BINARY_3_HEADER_BLOCK_SIZE))
  const payloadW = region.w - 2 * stripWidthCapture
  const payloadH = region.h - headerBandRows * headerStepY
  const cellsX = Math.max(0, Math.floor(payloadW / payloadStepX))
  const cellsY = Math.max(0, Math.floor(payloadH / payloadStepY))
  const offsets = new Int32Array(2 * cellsX * cellsY)
  let i = 0

  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      offsets[i++] = payloadStartX + Math.round(cx * payloadStepX)
      offsets[i++] = payloadStartY + Math.round(cy * payloadStepY)
    }
  }

  return { offsets, cellsX, cellsY }
}

function readBinary3Payload(
  imageData,
  width,
  region,
  rx,
  ry,
  headerStepX,
  headerStepY,
  headerBs,
  headerCellsX,
  header,
  options = {},
  precomputedOffsets = null
) {
  const payloadStepX = headerStepX * (BINARY_3_PAYLOAD_BLOCK_SIZE / BINARY_3_HEADER_BLOCK_SIZE)
  const payloadStepY = headerStepY * (BINARY_3_PAYLOAD_BLOCK_SIZE / BINARY_3_HEADER_BLOCK_SIZE)
  const payloadBs = headerBs * (BINARY_3_PAYLOAD_BLOCK_SIZE / BINARY_3_HEADER_BLOCK_SIZE)
  const stripWidthCapture = headerStepX * BINARY_3_REF_STRIP_WIDTH_4X4
  const payloadStartX = rx + stripWidthCapture

  const ref = sampleBinary3ReferenceRows(
    imageData,
    width,
    region,
    rx,
    ry,
    headerStepX,
    headerStepY,
    headerBs,
    headerCellsX,
    header
  )
  const payloadStartY = ry + ref.headerBandHeightCapture
  const payloadEndX = rx + region.w - stripWidthCapture
  const payloadCellsX = Math.max(0, Math.floor((payloadEndX - payloadStartX) / payloadStepX))
  const payloadCellsY = Math.max(0, Math.floor((region.h - ref.headerBandHeightCapture) / payloadStepY))
  const payload = new Uint8Array(header.payloadLength)
  const confidence = options.collectConfidence !== false ? new Uint8Array(header.payloadLength * BITS_PER_BYTE) : null
  const imgHeight = imageData.length / (width * 4)
  let bitBuffer = 0
  let bitCount = 0
  let byteIdx = 0
  let confidenceIdx = 0

  for (let cy = 0; cy < payloadCellsY && byteIdx < header.payloadLength; cy++) {
    const stripIdx = Math.min(
      Math.max(0, ref.stripRows - 1),
      Math.max(0, Math.round((cy * payloadStepY) / headerStepY))
    )
    const black = Number.isFinite(ref.rowBlackLevels[stripIdx]) ? ref.rowBlackLevels[stripIdx] : ref.headerLevels.blackLevel
    const white = Number.isFinite(ref.rowWhiteLevels[stripIdx]) ? ref.rowWhiteLevels[stripIdx] : ref.headerLevels.whiteLevel
    const threshold = (black + white) * 0.5

    for (let cx = 0; cx < payloadCellsX && byteIdx < header.payloadLength; cx++) {
      const offsetIdx = (cy * payloadCellsX + cx) * 2
      const px = precomputedOffsets && offsetIdx + 1 < precomputedOffsets.length
        ? precomputedOffsets[offsetIdx]
        : payloadStartX + Math.round(cx * payloadStepX)
      const py = precomputedOffsets && offsetIdx + 1 < precomputedOffsets.length
        ? precomputedOffsets[offsetIdx + 1]
        : payloadStartY + Math.round(cy * payloadStepY)

      let val = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        val = sampleBlockAt(imageData, width, px, py, payloadBs)
      }
      const symbol = val >= threshold ? 1 : 0
      if (confidence && confidenceIdx < confidence.length) {
        confidence[confidenceIdx++] = binaryConfidence(val, threshold)
      }
      bitBuffer = (bitBuffer << 1) | symbol
      bitCount++
      if (bitCount >= BITS_PER_BYTE) {
        payload[byteIdx++] = bitBuffer & 0xff
        bitBuffer = 0
        bitCount = 0
      }
    }
  }

  const actualCrc = crc32(payload)
  const levels = {
    blackLevel: ref.headerLevels.blackLevel,
    whiteLevel: ref.headerLevels.whiteLevel,
    rowBlackLevels: ref.rowBlackLevels,
    rowWhiteLevels: ref.rowWhiteLevels
  }
  const result = {
    header,
    payload,
    crcValid: actualCrc === header.payloadCrc,
    levels,
    _diag: {
      frameMode: HDMI_MODE.BINARY_3,
      blocksX: payloadCellsX,
      blocksY: payloadCellsY,
      headerBlocksX: headerCellsX,
      headerBlocksY: Math.floor(region.h / headerStepY),
      dataBs: payloadBs,
      headerBs,
      stepX: payloadStepX,
      stepY: payloadStepY,
      headerStepX,
      headerStepY,
      xOff: rx - region.x,
      yOff: ry - region.y,
      blackLevel: ref.headerLevels.blackLevel,
      whiteLevel: ref.headerLevels.whiteLevel,
      stripRows: ref.stripRows
    }
  }
  if (confidence) result.confidence = confidence
  return result
}

// Check if an 8×8 block grid at (originX, originY) matches the anchor pattern
// at the given block size. Returns true if all blocks match strict thresholds.
function verifyAnchorWithBlockSize(imageData, width, height, originX, originY, bs) {
  const aSize = Math.ceil(8 * bs)
  if (originX < 0 || originY < 0 ||
      originX + aSize > width || originY + aSize > height) {
    return false
  }

  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const px = originX + Math.round(bx * bs)
      const py = originY + Math.round(by * bs)
      const val = sampleBlockAt(imageData, width, px, py, bs)
      const expected = ANCHOR_PATTERN[by][bx] === 1
      if (expected) {
        if (val < 180) return false
      } else {
        if (val > 75) return false
      }
    }
  }
  return true
}

// Check that the area around a detected anchor is dark (canvas margin/HDMI border).
// Rejects false positives from browser chrome where surroundings are bright.
// Checks 3 points per direction at increasing distances for robustness.
function verifyAnchorContext(imageData, width, height, originX, originY, bs) {
  const aSize = Math.ceil(8 * bs)
  const mid = Math.round(aSize / 2)

  const isDarkAt = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return true
    return imageData[(y * width + x) * 4] < 50
  }

  // For each of 4 directions, check 3 points at distances proportional to the
  // detected anchor size so smaller anchors are not over-penalized.
  // Direction counts as "dark" if majority (2+) of points are dark.
  let darkDirs = 0
  const distances = Array.from(new Set([
    Math.max(4, Math.round(bs * 2)),
    Math.max(6, Math.round(bs * 3.5)),
    Math.max(8, Math.round(bs * 5))
  ]))

  // Above
  let dk = 0
  for (const d of distances) if (isDarkAt(originX + mid, originY - d)) dk++
  if (dk >= 2) darkDirs++

  // Below
  dk = 0
  for (const d of distances) if (isDarkAt(originX + mid, originY + aSize + d)) dk++
  if (dk >= 2) darkDirs++

  // Left
  dk = 0
  for (const d of distances) if (isDarkAt(originX - d, originY + mid)) dk++
  if (dk >= 2) darkDirs++

  // Right
  dk = 0
  for (const d of distances) if (isDarkAt(originX + aSize + d, originY + mid)) dk++
  if (dk >= 2) darkDirs++

  return darkDirs >= 3
}

// Try to verify an anchor at (originX, originY) across multiple block sizes.
// Returns the matching block size, or 0 if no match.
function verifyAnchorAt(imageData, width, height, originX, originY) {
  // Try block sizes starting from sender's native 3.0, spiraling outward.
  // This ensures exact match at 1:1 scale and finds scaled anchors efficiently.
  const blockSizes = [3.0, 2.75, 3.25, 2.5, 3.5, 2.25, 3.75, 2.0, 4.0, 4.25, 4.5, 4.75, 5.0]
  for (const bs of blockSizes) {
    if (verifyAnchorWithBlockSize(imageData, width, height, originX, originY, bs) &&
        verifyAnchorContext(imageData, width, height, originX, originY, bs)) {
      return bs
    }
  }
  return 0
}

// Find an anchor by scanning a corner for a bright rectangle, then verifying
// with a lightweight 2-point check (black ring + white center). The per-row
// bright-run scan delegates to scanBrightRunsWithFallback so the WASM kernel
// takes over once loaded. Scan order (yDir, row-by-row, left-to-right within
// a row) is preserved so the JS verifyBrightRun short-circuit still fires on
// the same first match as the pre-refactor loop.
function findCornerAnchor(imageData, width, height, xStart, xEnd, yStart, yEnd, yDir, corner) {
  const runs = scanBrightRunsWithFallback(
    imageData, width, height, xStart, xEnd, yStart, yEnd, yDir, 15, 50, 200
  )
  for (let i = 0; i < runs.length; i++) {
    const { runX, runY, runLen } = runs[i]
    const anchor = verifyBrightRun(imageData, width, height, runX, runY, runLen, yDir, corner)
    if (anchor) return anchor
  }
  return null
}

// Verify a bright run is an anchor edge and derive anchor position/block size
function verifyBrightRun(imageData, width, height, runX, runY, runLen, yDir, corner) {
  const bs = runLen / 8
  if (bs < 2 || bs > 6) return null

  // The bright run is an all-white row of the anchor.
  // If scanning from bottom (yDir=-1), this is the last row → origin is above.
  // If scanning from top (yDir=1), this is the first row → origin is here.
  const originX = runX
  const originY = yDir < 0 ? Math.round(runY - 7 * bs) : runY
  const aSize = Math.ceil(8 * bs)

  if (originY < 0 || originY + aSize > height) return null
  if (originX < 0 || originX + aSize > width) return null

  // Lightweight concentric-pattern check:
  // 1. Black ring at block (2,2) — should be dark
  const ringX = originX + Math.round(2.5 * bs)
  const ringY = originY + Math.round(2.5 * bs)
  if (ringX >= width || ringY >= height) return null
  if (imageData[(ringY * width + ringX) * 4] > 75) return null

  // 2. White center at block (3.5, 3.5) — should be bright
  const centerX = originX + Math.round(3.5 * bs)
  const centerY = originY + Math.round(3.5 * bs)
  if (centerX >= width || centerY >= height) return null
  if (imageData[(centerY * width + centerX) * 4] < 150) return null

  // 3. Black ring at block (5,5) — should be dark (opposite side)
  const ring2X = originX + Math.round(5.5 * bs)
  const ring2Y = originY + Math.round(5.5 * bs)
  if (ring2X >= width || ring2Y >= height) return null
  if (imageData[(ring2Y * width + ring2X) * 4] > 75) return null

  return { x: originX, y: originY, corner, blockSize: bs }
}

// Refine an anchor's block size by measuring the white→black transition at row 2.
// The anchor pattern row 2 is [W,W,B,B,B,B,W,W] — the transition at column 2
// gives a precise scale measurement that's more accurate than the bright-run width.
function refineAnchorScale(imageData, width, height, anchor) {
  const approxBs = anchor.blockSize
  // Sample at block row 2.5 (middle of the white-to-black transition row)
  const rowY = Math.round(anchor.y + 2.5 * approxBs)
  if (rowY >= height) return approxBs

  // Scan from anchor origin for the first dark pixel (transition from white border to black ring)
  // Scan right for the white→black transition. Require 3 consecutive dark
  // pixels to confirm (avoids single-pixel MJPEG noise).
  let transitionX = -1
  for (let x = anchor.x + Math.round(approxBs); x < anchor.x + Math.ceil(8 * approxBs) + 20 && x < width - 2; x++) {
    const v0 = imageData[(rowY * width + x) * 4]
    const v1 = imageData[(rowY * width + x + 1) * 4]
    const v2 = imageData[(rowY * width + x + 2) * 4]
    if (v0 < 100 && v1 < 100 && v2 < 100) {
      transitionX = x
      break
    }
  }

  if (transitionX < 0) return approxBs

  // The transition from white border to black ring occurs at 2 * BLOCK_SIZE sender pixels
  const captureDistance = transitionX - anchor.x
  const refinedBs = captureDistance / 2
  if (refinedBs >= 2.5 && refinedBs <= 6) return refinedBs
  return approxBs
}

// Detect chrome bottom edge: scan down center column for bright→dark transition.
// Only activates if the top of the frame is bright (actual browser chrome present).
function findChromeBottom(imageData, width, height) {
  const midX = Math.floor(width / 2)
  // If top of frame is dark, there's no chrome (e.g. unit test or direct canvas)
  if (imageData[(0 * width + midX) * 4] < 50) return 0
  for (let y = 0; y < Math.min(400, height - 1); y++) {
    const v = imageData[(y * width + midX) * 4]
    const vNext = imageData[((y + 1) * width + midX) * 4]
    if (v > 80 && vNext < 30) return y + 1
  }
  return 0
}

const ESTIMATED_ANCHOR_VERTICAL_RATIO = 1025 / 1648

// Scan the frame for anchor patterns. Returns array of {x, y, corner, blockSize}.
// Strategy: find bottom anchors first (reliable, away from browser chrome),
// then use their positions to guide top anchor search BELOW chromeBottom.
export function detectAnchors(imageData, width, height) {
  const anchors = []
  const margin = 300
  const chromeBottom = findChromeBottom(imageData, width, height)

  // Phase 1: Bottom anchors (scan upward from bottom — away from chrome)
  const bl = findCornerAnchor(imageData, width, height,
    0, Math.min(margin, width), height - 1, Math.max(0, height - margin), -1, 'BL')
  const br = findCornerAnchor(imageData, width, height,
    Math.max(0, width - margin), width, height - 1, Math.max(0, height - margin), -1, 'BR')

  if (bl) { bl.blockSize = refineAnchorScale(imageData, width, height, bl); anchors.push(bl) }
  if (br) { br.blockSize = refineAnchorScale(imageData, width, height, br); anchors.push(br) }

  // Phase 2: Top anchors — constrain search to a narrow band based on
  // expected canvas geometry (aspect ratio 0.45-0.75 of horizontal span).
  if (bl && br) {
    const hSpan = br.x - bl.x
    const expectedVSpan = Math.round(hSpan * ESTIMATED_ANCHOR_VERTICAL_RATIO)
    // Expected vertical span: between 45% and 75% of horizontal span
    const minVSpan = Math.round(hSpan * 0.40)
    const maxVSpan = Math.round(hSpan * 0.80)
    const topSearchLo = Math.max(chromeBottom, bl.y - maxVSpan - 50)
    const topSearchHi = Math.max(chromeBottom, bl.y - minVSpan + 50)

    const tl = findCornerAnchor(imageData, width, height,
      Math.max(0, bl.x - 20), Math.min(width, bl.x + 50), topSearchLo, topSearchHi, 1, 'TL')
    const tr = findCornerAnchor(imageData, width, height,
      Math.max(0, br.x - 20), Math.min(width, br.x + 50), topSearchLo, topSearchHi, 1, 'TR')

    // Only accept detected top anchors if they match each other and the
    // expected sender geometry. Fullscreen UI can create a plausible-looking
    // horizontal edge much lower than the true top anchors.
    const detectedTopYDelta = tl && tr ? Math.abs(tl.y - tr.y) : Infinity
    const leftDetectedVSpan = tl ? bl.y - tl.y : 0
    const rightDetectedVSpan = tr ? br.y - tr.y : 0
    const avgDetectedVSpan = (leftDetectedVSpan + rightDetectedVSpan) * 0.5
    const vSpanTolerance = Math.max(40, Math.round(hSpan * 0.08))
    const expectedVSpanTolerance = Math.max(60, Math.round(hSpan * 0.10))
    const detectedTopAnchorsLookValid =
      tl &&
      tr &&
      detectedTopYDelta <= 15 &&
      leftDetectedVSpan > 0 &&
      rightDetectedVSpan > 0 &&
      Math.abs(leftDetectedVSpan - rightDetectedVSpan) <= vSpanTolerance &&
      Math.abs(avgDetectedVSpan - expectedVSpan) <= expectedVSpanTolerance

    if (detectedTopAnchorsLookValid) {
      tl.blockSize = refineAnchorScale(imageData, width, height, tl)
      tr.blockSize = refineAnchorScale(imageData, width, height, tr)
      anchors.push(tl)
      anchors.push(tr)
    } else {
      // Fullscreen HDMI captures often preserve the bottom anchors cleanly while
      // the top anchors are obscured by transient browser/fullscreen UI. Fall
      // back to the known sender frame geometry using the trusted bottom pair.
      const avgBottomBs = ((bl.blockSize || BLOCK_SIZE) + (br.blockSize || BLOCK_SIZE)) * 0.5
      const estimatedTopY = Math.max(0, Math.round(Math.min(bl.y, br.y) - expectedVSpan))
      if (estimatedTopY < Math.min(bl.y, br.y)) {
        anchors.push({
          x: bl.x,
          y: estimatedTopY,
          corner: 'TL',
          blockSize: avgBottomBs,
          estimated: true
        })
        anchors.push({
          x: br.x,
          y: estimatedTopY,
          corner: 'TR',
          blockSize: avgBottomBs,
          estimated: true
        })
      }
    }
  }

  return anchors
}

// Derive data region from detected anchor positions.
// Requires at least one top and one bottom anchor with consistent block sizes.
export function dataRegionFromAnchors(anchors) {
  if (anchors.length < 2) return null

  const bl = anchors.find(a => a.corner === 'BL')
  const br = anchors.find(a => a.corner === 'BR')
  const tl = anchors.find(a => a.corner === 'TL')
  const tr = anchors.find(a => a.corner === 'TR')

  // On the HDMI-UVC fullscreen path, partial anchor sets are much more likely
  // to be browser/UI false positives than valid frames. Require all four
  // corners so a single fake top edge cannot create a plausible data region.
  if (!bl || !br || !tl || !tr) return null

  // Check block size consistency: all anchors within 20% of median
  const sizes = anchors.map(a => a.blockSize).sort((a, b) => a - b)
  const median = sizes[Math.floor(sizes.length / 2)]
  if (sizes.some(s => Math.abs(s - median) / median > 0.20)) return null

  const avgBs = anchors.reduce((s, a) => s + a.blockSize, 0) / anchors.length
  const actualAnchorSize = Math.ceil(8 * avgBs)

  // The captured HDMI feed should be axis-aligned: top anchors should sit
  // nearly above the bottom anchors, and the left/right vertical spans should
  // agree closely. UI chrome often creates fake top anchors that fail this.
  const maxHorizontalDrift = Math.max(12, Math.round(actualAnchorSize * 0.5))
  if (Math.abs(tl.x - bl.x) > maxHorizontalDrift) return null
  if (Math.abs(tr.x - br.x) > maxHorizontalDrift) return null

  const leftVSpan = bl.y - tl.y
  const rightVSpan = br.y - tr.y
  if (leftVSpan <= 0 || rightVSpan <= 0) return null
  const verticalSpanDelta = Math.abs(leftVSpan - rightVSpan)
  if (verticalSpanDelta > Math.max(18, Math.round(avgBs * 8))) return null

  const topSpan = tr.x - tl.x
  const bottomSpan = br.x - bl.x
  if (topSpan <= 0 || bottomSpan <= 0) return null
  const horizontalSpanDelta = Math.abs(topSpan - bottomSpan)
  if (horizontalSpanDelta > Math.max(18, Math.round(avgBs * 8))) return null

  // Compute bounds from available anchors
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const a of anchors) {
    if (a.x < minX) minX = a.x
    if (a.y < minY) minY = a.y
    if (a.x + actualAnchorSize > maxX) maxX = a.x + actualAnchorSize
    if (a.y + actualAnchorSize > maxY) maxY = a.y + actualAnchorSize
  }

  const w = maxX - minX - 2 * actualAnchorSize
  const h = maxY - minY - 2 * actualAnchorSize
  if (w < 100 || h < 100) return null

  return {
    x: minX + actualAnchorSize,
    y: minY + actualAnchorSize,
    w, h,
    frameW: maxX - minX,
    frameH: maxY - minY,
    anchorSize: actualAnchorSize,
    blockSize: avgBs,
    stepX: avgBs,
    stepY: avgBs
  }
}

// --- Data region decoding (receiver) ---

// Read payload using binary modulation (8 blocks per byte, threshold at 128).
function readPayloadAt(
  imageData,
  width,
  region,
  rx,
  ry,
  stepX,
  stepY,
  bs,
  blocksX,
  header,
  expectedBlocksY = null,
  headerLayout = null,
  options = {},
  precomputedOffsets = null
) {
  if (header.mode === HDMI_MODE.BINARY_3) {
    const headerSamplingLayout = headerLayout || {
      rx,
      ry,
      stepX: stepX * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE),
      stepY: stepY * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE),
      bs: bs * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE),
      blocksX: Math.floor(region.w / (stepX * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE)))
    }
    return readBinary3Payload(
      imageData,
      width,
      region,
      headerSamplingLayout.rx,
      headerSamplingLayout.ry,
      headerSamplingLayout.stepX,
      headerSamplingLayout.stepY,
      headerSamplingLayout.bs,
      headerSamplingLayout.blocksX,
      header,
      options,
      precomputedOffsets
    )
  }

  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)
  const bitsPerBlock = getModeBitsPerBlock(header.mode) || 1
  const payloadCells = getPayloadCellOrder(header.mode, blocksX, blocksY)
  const reservedPayloadCells = getReservedPayloadCells(header.mode)
  const headerSamplingLayout = headerLayout || {
    rx,
    ry,
    stepX,
    stepY,
    bs,
    blocksX,
    blocksY
  }
  const levels = header.mode === HDMI_MODE.RAW_RGB
    ? estimateRgbPayloadLevelsFromHeader(
      imageData,
      width,
      region,
      headerSamplingLayout.rx,
      headerSamplingLayout.ry,
      headerSamplingLayout.stepX,
      headerSamplingLayout.stepY,
      headerSamplingLayout.bs,
      headerSamplingLayout.blocksX,
      header,
      headerSamplingLayout.blocksY
    )
    : estimatePayloadLevelsFromHeader(
      imageData,
      width,
      region,
      headerSamplingLayout.rx,
      headerSamplingLayout.ry,
      headerSamplingLayout.stepX,
      headerSamplingLayout.stepY,
      headerSamplingLayout.bs,
      headerSamplingLayout.blocksX,
      header,
      headerSamplingLayout.blocksY
    )
  const pilotField = bitsPerBlock === 1
    ? sampleBinaryPilotField(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, blocksY, header.mode)
    : null
  const payload = new Uint8Array(header.payloadLength)
  const confidence = options.collectConfidence && bitsPerBlock === 1
    ? new Uint8Array(header.payloadLength * BITS_PER_BYTE)
    : null
  let confidenceIdx = 0
  const decodeState = { index: 0, bitBuffer: 0, bitCount: 0 }
  const height = imageData.length / (width * 4)

  // Phase 4 Task 4.3: batch classify COMPAT_4 (binary) and LUMA_2 cells in
  // WASM when the module is loaded. The per-cell JS branches stay as the
  // fallback for other modes (RAW_RGB, GLYPH_5, CODEBOOK_3, RAW_GRAY) and
  // whenever the WASM kernel throws. `preComputedSymbols` is a Uint8Array of
  // length (payloadCells.length - reservedPayloadCells); index 0 corresponds
  // to cellIdx = reservedPayloadCells.
  const isCompat4Binary = bitsPerBlock === 1 &&
    header.mode !== HDMI_MODE.RAW_RGB &&
    header.mode !== HDMI_MODE.GLYPH_5 &&
    header.mode !== HDMI_MODE.CODEBOOK_3 &&
    header.mode !== HDMI_MODE.LUMA_2
  const isLuma2 = header.mode === HDMI_MODE.LUMA_2
  let preComputedSymbols = null
  if (!confidence && (isCompat4Binary || isLuma2) && isHdmiUvcWasmActive()) {
    preComputedSymbols = batchClassifyPayloadCells({
      imageData, width, height,
      payloadCells, reservedPayloadCells,
      rx, ry, stepX, stepY, bs,
      mode: isCompat4Binary ? 'compat4' : 'luma2',
      levels, pilotField
    })
  }

  for (let cellIdx = reservedPayloadCells; cellIdx < payloadCells.length && decodeState.index < header.payloadLength; cellIdx++) {
    const { bx, by } = payloadCells[cellIdx]
    const px = rx + Math.round(bx * stepX)
    const py = ry + Math.round(by * stepY)
    let symbol = 0
    if (preComputedSymbols) {
      // WASM already handled sampling + classification. The per-cell bounds
      // check is baked into sample2x2R / sampleQuadrants which return 0 for
      // out-of-bounds centers — matching the JS default-symbol-0 behavior.
      symbol = preComputedSymbols[cellIdx - reservedPayloadCells]
    } else if (px >= 0 && px < width && py >= 0 && py < height) {
      if (header.mode === HDMI_MODE.RAW_RGB) {
        const rgb = sampleBlockRgbAt(imageData, width, px, py, bs)
        symbol = decodeRgb3(rgb, levels?.blackLevels, levels?.whiteLevels, levels?.rgbPalette)
      } else if (header.mode === HDMI_MODE.LUMA_2) {
        const samples = sampleCodebook3At(imageData, width, px, py, bs)
        symbol = decodeLuma2(samples, levels?.blackLevel, levels?.whiteLevel)
      } else if (header.mode === HDMI_MODE.GLYPH_5) {
        const samples = sampleGlyph5At(imageData, width, px, py, bs)
        symbol = decodeGlyph5(samples, levels?.blackLevel, levels?.whiteLevel)
      } else if (header.mode === HDMI_MODE.CODEBOOK_3) {
        const samples = sampleCodebook3At(imageData, width, px, py, bs)
        symbol = decodeCodebook3(samples, levels?.blackLevel, levels?.whiteLevel)
      } else if (bitsPerBlock === 2) {
        const val = sampleBlockAt(imageData, width, px, py, bs)
        symbol = decodeGray2(val, levels?.blackLevel, levels?.whiteLevel)
      } else {
        const val = sampleBlockAt(imageData, width, px, py, bs)
        const localLevels = pilotField
          ? estimateBinaryPilotLevelsAt(pilotField, bx, by, levels?.blackLevel, levels?.whiteLevel)
          : levels
        const threshold = ((localLevels?.blackLevel ?? 0) + (localLevels?.whiteLevel ?? 255)) * 0.5
        symbol = val >= threshold ? 1 : 0
        if (confidence && confidenceIdx < confidence.length) {
          confidence[confidenceIdx++] = binaryConfidence(val, threshold)
        }
      }
    }
    appendSymbolBits(payload, decodeState, symbol, bitsPerBlock)
  }

  const actualCrc = crc32(payload)
  const result = { header, payload, crcValid: actualCrc === header.payloadCrc, levels }
  if (confidence) result.confidence = confidence
  return result
}

// Pre-compute per-cell symbols for COMPAT_4 (binary) or LUMA_2 (4-level) by
// batching into the WASM classifier. Returns a Uint8Array or null on failure
// (or when the diagnostic toggle is off). Index 0 corresponds to
// payloadCells[reservedPayloadCells]; out-of-bounds cells are handled by the
// WASM sampler returning 0 (matches JS default). Total wall time is added
// to classifierMsAccumulator so the receiver can surface it in perf logs.
function batchClassifyPayloadCells({
  imageData, width, height, payloadCells, reservedPayloadCells,
  rx, ry, stepX, stepY, bs, mode, levels, pilotField
}) {
  if (!getWasmClassifierEnabled()) return null
  const n = payloadCells.length - reservedPayloadCells
  if (n <= 0) return null
  const start = classifierPerfNow()
  try {
    const cells = new Array(n)
    if (mode === 'compat4') {
      for (let i = 0; i < n; i++) {
        const cell = payloadCells[reservedPayloadCells + i]
        const px = rx + Math.round(cell.bx * stepX)
        const py = ry + Math.round(cell.by * stepY)
        const localLevels = pilotField
          ? estimateBinaryPilotLevelsAt(pilotField, cell.bx, cell.by, levels?.blackLevel, levels?.whiteLevel)
          : levels
        const threshold = ((localLevels?.blackLevel ?? 0) + (localLevels?.whiteLevel ?? 255)) * 0.5
        cells[i] = [px, py, bs, threshold]
      }
      try {
        return wasmClassifyCompat4Cells(imageData, width, height, cells)
      } catch (_) {
        return null
      }
    }
    // mode === 'luma2'
    const black = levels?.blackLevel ?? 0
    const white = levels?.whiteLevel ?? 255
    for (let i = 0; i < n; i++) {
      const cell = payloadCells[reservedPayloadCells + i]
      const px = rx + Math.round(cell.bx * stepX)
      const py = ry + Math.round(cell.by * stepY)
      cells[i] = [px, py, bs, black, white]
    }
    try {
      return wasmClassifyLuma2Cells(imageData, width, height, cells)
    } catch (_) {
      return null
    }
  } finally {
    classifierMsAccumulator += classifierPerfNow() - start
  }
}

// Read a fixed payload length from a known-good grid layout without relying on a
// newly decoded HDMI header. Used after session lock, where inner packet CRCs can
// validate individual packets even if the outer frame header is damaged.
export function readPayloadWithLayout(imageData, width, region, layout, payloadLength, precomputedOffsets = null, options = {}) {
  if (!layout || !payloadLength || payloadLength <= 0) return null

  const blocksX = layout.blocksX
  const blocksY = layout.blocksY ?? Math.floor(region.h / layout.stepY)
  const frameMode = layout.frameMode ?? HDMI_MODE.COMPAT_4
  if (!blocksX || !blocksY) return null

  const rx = region.x + (layout.xOff || 0)
  const ry = region.y + (layout.yOff || 0)
  const bitsPerBlock = layout.bitsPerBlock || 1

  if (frameMode === HDMI_MODE.BINARY_3) {
    const headerStepX = layout.headerStepX || (layout.stepX * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE))
    const headerStepY = layout.headerStepY || (layout.stepY * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE))
    const headerBs = layout.headerBs || (layout.dataBs * (BINARY_3_HEADER_BLOCK_SIZE / BINARY_3_PAYLOAD_BLOCK_SIZE))
    const headerBlocksX = layout.headerBlocksX || Math.floor(region.w / headerStepX)
    const header = {
      mode: HDMI_MODE.BINARY_3,
      width: layout.frameWidth ?? 0,
      height: layout.frameHeight ?? 0,
      fps: layout.fps ?? 0,
      symbolId: 0,
      payloadLength,
      payloadCrc: 0
    }
    const result = readBinary3Payload(
      imageData,
      width,
      region,
      rx,
      ry,
      headerStepX,
      headerStepY,
      headerBs,
      headerBlocksX,
      header,
      options,
      precomputedOffsets
    )
    return result?.payload?.length === payloadLength ? result.payload : null
  }

  const payloadCells = getPayloadCellOrder(frameMode, blocksX, blocksY)
  const reservedPayloadCells = getReservedPayloadCells(frameMode)
  const pilotField = bitsPerBlock === 1
    ? sampleBinaryPilotField(
      imageData,
      width,
      region,
      rx,
      ry,
      layout.stepX,
      layout.stepY,
      layout.dataBs,
      blocksX,
      blocksY,
      frameMode
    )
    : null
  const rgbPalette = frameMode === HDMI_MODE.RAW_RGB
    ? (() => {
      const palette = []
      const pilotCount = Math.min(RGB3_PILOT_SYMBOLS.length, payloadCells.length)
      for (let i = 0; i < pilotCount; i++) {
        const { bx, by } = payloadCells[i]
        const px = rx + Math.round(bx * layout.stepX)
        const py = ry + Math.round(by * layout.stepY)
        let rgb = RGB3_PALETTE[i]
        if (px >= 0 && px < width && py >= 0 && py < imageData.length / (width * 4)) {
          rgb = sampleBlockRgbAt(imageData, width, px, py, layout.dataBs)
        }
        palette.push(normalizeRgbSample(rgb, layout.blackLevels, layout.whiteLevels))
      }
      while (palette.length < RGB3_PILOT_SYMBOLS.length) {
        palette.push(RGB3_NORMALIZED_PALETTE[palette.length])
      }
      return palette
    })()
    : null
  const payload = new Uint8Array(payloadLength)
  const decodeState = { index: 0, bitBuffer: 0, bitCount: 0 }
  const height = imageData.length / (width * 4)

  for (let cellIdx = reservedPayloadCells; cellIdx < payloadCells.length && decodeState.index < payloadLength; cellIdx++) {
    const { bx, by } = payloadCells[cellIdx]
    const px = rx + Math.round(bx * layout.stepX)
    const py = ry + Math.round(by * layout.stepY)
    let symbol = 0
    if (px >= 0 && px < width && py >= 0 && py < height) {
      if (frameMode === HDMI_MODE.RAW_RGB) {
        const rgb = sampleBlockRgbAt(imageData, width, px, py, layout.dataBs)
        symbol = decodeRgb3(rgb, layout.blackLevels, layout.whiteLevels, rgbPalette)
      } else if (frameMode === HDMI_MODE.LUMA_2) {
        const samples = sampleCodebook3At(imageData, width, px, py, layout.dataBs)
        symbol = decodeLuma2(samples, layout.blackLevel, layout.whiteLevel)
      } else if (frameMode === HDMI_MODE.GLYPH_5) {
        const samples = sampleGlyph5At(imageData, width, px, py, layout.dataBs)
        symbol = decodeGlyph5(samples, layout.blackLevel, layout.whiteLevel)
      } else if (frameMode === HDMI_MODE.CODEBOOK_3) {
        const samples = sampleCodebook3At(imageData, width, px, py, layout.dataBs)
        symbol = decodeCodebook3(samples, layout.blackLevel, layout.whiteLevel)
      } else if (bitsPerBlock === 2) {
        const val = sampleBlockAt(imageData, width, px, py, layout.dataBs)
        symbol = decodeGray2(val, layout.blackLevel, layout.whiteLevel)
      } else {
        const val = sampleBlockAt(imageData, width, px, py, layout.dataBs)
        const localLevels = pilotField
          ? estimateBinaryPilotLevelsAt(pilotField, bx, by, layout.blackLevel, layout.whiteLevel)
          : layout
        const threshold = ((localLevels?.blackLevel ?? 0) + (localLevels?.whiteLevel ?? 255)) * 0.5
        symbol = val >= threshold ? 1 : 0
      }
    }
    appendSymbolBits(payload, decodeState, symbol, bitsPerBlock)
  }

  return decodeState.index === payloadLength ? payload : null
}

// Score a candidate header: higher = better. CRC-valid candidates always win.
function scoreCandidate(result) {
  if (result.crcValid) return 10000
  let score = 0
  // Strongly prefer the original small-packet diagnostic shape (256 blockSize + packet header)
  if (result.header.payloadLength === 272) score += 1000
  else if (result.header.payloadLength > 0 && result.header.payloadLength <= 16384) score += 10
  return score
}

function getHeaderSpanMetrics(header, region) {
  const measuredFrameW = region.frameW || null
  const measuredFrameH = region.frameH || null
  return {
    measuredFrameW,
    measuredFrameH,
    decodedFrameW: header.width,
    decodedFrameH: header.height,
    decodedToMeasuredX: measuredFrameW ? header.width / measuredFrameW : null,
    decodedToMeasuredY: measuredFrameH ? header.height / measuredFrameH : null,
    measuredToDecodedX: measuredFrameW ? measuredFrameW / header.width : null,
    measuredToDecodedY: measuredFrameH ? measuredFrameH / header.height : null,
    geometryClass: classifyHeaderGeometry(header, region)
  }
}

function summarizeDecisionCandidate(result, region) {
  if (!result) return null
  const diag = result._diag || {}
  const metrics = getHeaderSpanMetrics(result.header, region)
  return {
    hypothesis: diag.hypothesis || 'base',
    refined: !!diag.refined,
    crcValid: !!result.crcValid,
    score: diag.score ?? scoreCandidate(result),
    mode: result.header.mode,
    width: result.header.width,
    height: result.header.height,
    fps: result.header.fps,
    symbolId: result.header.symbolId,
    payloadLength: result.header.payloadLength,
    xOff: diag.xOff,
    yOff: diag.yOff,
    dataBs: diag.dataBs,
    stepX: diag.stepX,
    stepY: diag.stepY,
    blocksX: diag.blocksX,
    blocksY: diag.blocksY,
    ...metrics
  }
}

function attachDecisionTrace(result, decision, region) {
  if (!result) return
  if (!result._diag) result._diag = {}
  result._diag.score ??= scoreCandidate(result)
  Object.assign(result._diag, getHeaderSpanMetrics(result.header, region))
  result._diag.decision = decision
}

// Read header bytes using binary modulation at given alignment.
// Returns parsed header or null. Reads HEADER_BLOCKS blocks, decodes 8 per byte.
function probeHeaderBinary(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, expectedBlocksY = null) {
  const headerBytes = new Uint8Array(HEADER_SIZE)
  let byteIdx = 0, bitIdx = 0, currentByte = 0
  const imgHeight = imageData.length / (width * 4)
  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)

  for (let by = 0; by < blocksY && byteIdx < HEADER_SIZE; by++) {
    for (let bx = 0; bx < blocksX && byteIdx < HEADER_SIZE; bx++) {
      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let val = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        val = sampleBlockAt(imageData, width, px, py, bs)
      }
      if (val > 128) currentByte |= (1 << (7 - bitIdx))
      bitIdx++
      if (bitIdx >= 8) {
        headerBytes[byteIdx++] = currentByte
        currentByte = 0
        bitIdx = 0
      }
    }
  }

  return parseHeader(headerBytes)
}

function estimatePayloadLevelsFromHeader(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, header, expectedBlocksY = null) {
  const headerBytes = buildHeader(
    header.mode,
    header.width,
    header.height,
    header.fps,
    header.symbolId,
    header.payloadLength,
    header.payloadCrc
  )
  let byteIdx = 0
  let bitIdx = 0
  const imgHeight = imageData.length / (width * 4)
  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)
  let blackSum = 0
  let whiteSum = 0
  let blackCount = 0
  let whiteCount = 0

  for (let by = 0; by < blocksY && byteIdx < HEADER_SIZE; by++) {
    for (let bx = 0; bx < blocksX && byteIdx < HEADER_SIZE; bx++) {
      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let val = 0
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        val = sampleBlockAt(imageData, width, px, py, bs)
      }

      const expectedBit = (headerBytes[byteIdx] >> (7 - bitIdx)) & 1
      if (expectedBit) {
        whiteSum += val
        whiteCount++
      } else {
        blackSum += val
        blackCount++
      }

      bitIdx++
      if (bitIdx >= 8) {
        bitIdx = 0
        byteIdx++
      }
    }
  }

  return {
    blackLevel: blackCount > 0 ? blackSum / blackCount : 0,
    whiteLevel: whiteCount > 0 ? whiteSum / whiteCount : 255
  }
}

function estimateRgbPayloadLevelsFromHeader(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, header, expectedBlocksY = null) {
  const headerBytes = buildHeader(
    header.mode,
    header.width,
    header.height,
    header.fps,
    header.symbolId,
    header.payloadLength,
    header.payloadCrc
  )
  let byteIdx = 0
  let bitIdx = 0
  const imgHeight = imageData.length / (width * 4)
  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)
  const blackSums = [0, 0, 0]
  const whiteSums = [0, 0, 0]
  let blackCount = 0
  let whiteCount = 0

  for (let by = 0; by < blocksY && byteIdx < HEADER_SIZE; by++) {
    for (let bx = 0; bx < blocksX && byteIdx < HEADER_SIZE; bx++) {
      const px = rx + Math.round(bx * stepX)
      const py = ry + Math.round(by * stepY)
      let rgb = [0, 0, 0]
      if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
        rgb = sampleBlockRgbAt(imageData, width, px, py, bs)
      }

      const expectedBit = (headerBytes[byteIdx] >> (7 - bitIdx)) & 1
      if (expectedBit) {
        whiteSums[0] += rgb[0]
        whiteSums[1] += rgb[1]
        whiteSums[2] += rgb[2]
        whiteCount++
      } else {
        blackSums[0] += rgb[0]
        blackSums[1] += rgb[1]
        blackSums[2] += rgb[2]
        blackCount++
      }

      bitIdx++
      if (bitIdx >= 8) {
        bitIdx = 0
        byteIdx++
      }
    }
  }

  const blackLevels = blackCount > 0 ? blackSums.map((sum) => sum / blackCount) : [0, 0, 0]
  const whiteLevels = whiteCount > 0 ? whiteSums.map((sum) => sum / whiteCount) : [255, 255, 255]
  const payloadCells = getPayloadCellOrder(header.mode, blocksX, blocksY)
  const rgbPalette = []
  const pilotCount = Math.min(RGB3_PILOT_SYMBOLS.length, payloadCells.length)

  for (let i = 0; i < pilotCount; i++) {
    const { bx, by } = payloadCells[i]
    const px = rx + Math.round(bx * stepX)
    const py = ry + Math.round(by * stepY)
    let rgb = RGB3_PALETTE[i]
    if (px >= 0 && px < width && py >= 0 && py < imgHeight) {
      rgb = sampleBlockRgbAt(imageData, width, px, py, bs)
    }
    rgbPalette.push(normalizeRgbSample(rgb, blackLevels, whiteLevels))
  }

  while (rgbPalette.length < RGB3_PILOT_SYMBOLS.length) {
    rgbPalette.push(RGB3_NORMALIZED_PALETTE[rgbPalette.length])
  }

  return {
    blackLevels,
    whiteLevels,
    rgbPalette
  }
}

// Once a plausible header is found, derive a more precise capture scale from the
// measured frame span. This reduces horizontal drift across later header fields.
function refineCandidateFromHeader(imageData, width, region, header, rx, ry, hypothesis = 'base', options = {}) {
  if (!region.frameW || !region.frameH) return null
  if (header.width < 100 || header.height < 100) return null
  const headerBlockSize = getModeHeaderBlockSize(header.mode)
  const payloadBlockSize = getModePayloadBlockSize(header.mode)
  const bitsPerBlock = getModeBitsPerBlock(header.mode)
  if (!headerBlockSize || !payloadBlockSize || !bitsPerBlock) return null

  const headerBlocksX = Math.floor((header.width - 2 * MARGIN_SIZE) / headerBlockSize)
  const headerBlocksY = Math.floor((header.height - 2 * MARGIN_SIZE) / headerBlockSize)
  if (headerBlocksX * headerBlocksY < HEADER_BLOCKS) return null

  const payloadBlocksX = Math.floor((header.width - 2 * MARGIN_SIZE) / payloadBlockSize)
  const payloadBlocksY = Math.floor((header.height - 2 * MARGIN_SIZE) / payloadBlockSize)
  if (payloadBlocksX * payloadBlocksY < HEADER_BLOCKS + BITS_PER_BYTE) return null

  const headerStepX = (region.frameW / header.width) * headerBlockSize
  const headerStepY = (region.frameH / header.height) * headerBlockSize
  const headerBs = Math.min(headerStepX, headerStepY)
  const payloadScale = payloadBlockSize / headerBlockSize
  const payloadStepX = headerStepX * payloadScale
  const payloadStepY = headerStepY * payloadScale
  const payloadBs = headerBs * payloadScale
  const minStep = headerBlockSize === 4 ? 3 : headerBlockSize === 8 ? 6 : 12
  const maxStep = headerBlockSize === 4 ? 6 : headerBlockSize === 8 ? 10 : 20
  if (headerStepX < minStep || headerStepX > maxStep || headerStepY < minStep || headerStepY > maxStep) return null

  const yOffsets = [0, -1, 1, -2, 2]
  let bestResult = null
  let bestScore = -1

  for (let xAdjust = -2; xAdjust <= 2; xAdjust++) {
    for (const yAdjust of yOffsets) {
      const refinedRx = rx + xAdjust
      const refinedRy = ry + yAdjust

      const refinedHeader = probeHeaderBinary(
        imageData,
        width,
        region,
        refinedRx,
        refinedRy,
        headerStepX,
        headerStepY,
        headerBs,
        headerBlocksX,
        headerBlocksY
      )
      if (!refinedHeader) continue

      const payloadBlocks = getUsablePayloadBlocks(refinedHeader.mode, payloadBlocksX, payloadBlocksY)
      const payloadCapacity = refinedHeader.mode === HDMI_MODE.BINARY_3
        ? getPayloadCapacity(refinedHeader.width, refinedHeader.height, HDMI_MODE.BINARY_3)
        : Math.floor((payloadBlocks * bitsPerBlock) / BITS_PER_BYTE)
      if (payloadCapacity < refinedHeader.payloadLength) continue

      const result = readPayloadAt(
        imageData,
        width,
        region,
        refinedRx,
        refinedRy,
        payloadStepX,
        payloadStepY,
        payloadBs,
        payloadBlocksX,
        refinedHeader,
        payloadBlocksY,
        {
          rx: refinedRx,
          ry: refinedRy,
          stepX: headerStepX,
          stepY: headerStepY,
          bs: headerBs,
          blocksX: headerBlocksX,
          blocksY: headerBlocksY
        },
        options
      )
      const innerDiag = result._diag
      result._diag = {
        dataBs: payloadBs,
        headerBs,
        dataBlockSize: payloadBlockSize,
        headerBlockSize,
        payloadBlockSize,
        bitsPerBlock,
        stepX: payloadStepX,
        stepY: payloadStepY,
        headerStepX,
        headerStepY,
        blocksX: payloadBlocksX,
        blocksY: payloadBlocksY,
        headerBlocksX,
        headerBlocksY,
        frameMode: refinedHeader.mode,
        xOff: refinedRx - region.x,
        yOff: refinedRy - region.y,
        refined: true,
        hypothesis,
        payloadCapacity,
        scaleX: region.frameW / refinedHeader.width,
        scaleY: region.frameH / refinedHeader.height,
        blackLevel: result.levels?.blackLevel,
        whiteLevel: result.levels?.whiteLevel,
        blackLevels: result.levels?.blackLevels,
        whiteLevels: result.levels?.whiteLevels,
        score: scoreCandidate(result),
        ...getHeaderSpanMetrics(refinedHeader, region)
      }
      if (refinedHeader.mode === HDMI_MODE.BINARY_3 && innerDiag) {
        result._diag = {
          ...result._diag,
          blocksX: innerDiag.blocksX,
          blocksY: innerDiag.blocksY,
          headerBlocksX: innerDiag.headerBlocksX,
          headerBlocksY: innerDiag.headerBlocksY,
          blackLevel: innerDiag.blackLevel,
          whiteLevel: innerDiag.whiteLevel,
          stripRows: innerDiag.stripRows
        }
      }

      if (result.crcValid) return result

      const score = scoreCandidate(result)
      if (score > bestScore) {
        bestScore = score
        bestResult = result
      }
    }
  }

  return bestResult
}

function classifyHeaderGeometry(header, region) {
  const tooSmall =
    header.width < region.frameW * 0.75 ||
    header.height < region.frameH * 0.75
  const tooLarge =
    header.width > region.frameW * 1.5 ||
    header.height > region.frameH * 1.5

  if (tooSmall && !tooLarge) return 'small'
  if (tooLarge && !tooSmall) return 'large'
  return 'normal'
}

function getHeaderRefinementHypotheses(header, region) {
  const hypotheses = []
  const geometry = classifyHeaderGeometry(header, region)

  if (
    header.width * 2 <= 8000 &&
    header.height * 2 <= 8000 &&
    (header.width < region.frameW * 0.75 || header.height < region.frameH * 0.75)
  ) {
    hypotheses.push({
      name: 'double',
      header: {
        ...header,
        width: header.width * 2,
        height: header.height * 2,
        fps: Math.min(header.fps * 2, 255),
        symbolId: header.symbolId * 2,
        payloadLength: header.payloadLength * 2
      }
    })
  }

  if (
    header.width >= 200 &&
    header.height >= 200 &&
    (header.width > region.frameW * 1.5 || header.height > region.frameH * 1.5)
  ) {
    hypotheses.push({
      name: 'half',
      header: {
        ...header,
        width: Math.floor(header.width / 2),
        height: Math.floor(header.height / 2),
        fps: Math.max(1, Math.floor(header.fps / 2)),
        symbolId: Math.floor(header.symbolId / 2),
        payloadLength: Math.floor(header.payloadLength / 2)
      }
    })
  }

  if (geometry === 'large') {
    hypotheses.sort((a, b) => (a.name === 'half' ? -1 : 0) - (b.name === 'half' ? -1 : 0))
  } else if (geometry === 'small') {
    hypotheses.sort((a, b) => (a.name === 'double' ? -1 : 0) - (b.name === 'double' ? -1 : 0))
  }

  hypotheses.push({ header, name: 'base' })
  return hypotheses
}

function tryPreferredExperimentalLayoutDecode(imageData, width, region, layout, options = {}) {
  if (!layout) return null

  const frameMode = layout.frameMode
  const headerBlockSize = getModeHeaderBlockSize(frameMode)
  const payloadBlockSize = getModePayloadBlockSize(frameMode)
  const bitsPerBlock = getModeBitsPerBlock(frameMode)
  const blocksX = layout.blocksX
  const blocksY = layout.blocksY ?? Math.floor(region.h / layout.stepY)
  const headerBlocksX = layout.headerBlocksX ?? blocksX
  const headerStepX = layout.headerStepX ?? layout.stepX
  const headerStepY = layout.headerStepY ?? layout.stepY
  const headerBs = layout.headerBs ?? layout.dataBs
  const headerBlocksY = layout.headerBlocksY ?? Math.floor(region.h / headerStepY)
  const precomputedOffsets = layout.precomputedOffsets || null
  if (!headerBlockSize || !payloadBlockSize || !bitsPerBlock || !blocksX || !blocksY || !headerBlocksX || !headerBlocksY) return null

  const xAdjustments = [0, -1, 1, -2, 2]
  const yAdjustments = [0, -1, 1, -2, 2]
  let bestResult = null
  let bestScore = -1

  for (const xAdjust of xAdjustments) {
    for (const yAdjust of yAdjustments) {
      const rx = region.x + (layout.xOff || 0) + xAdjust
      const ry = region.y + (layout.yOff || 0) + yAdjust
      const header = probeHeaderBinary(
        imageData,
        width,
        region,
        rx,
        ry,
        headerStepX,
        headerStepY,
        headerBs,
        headerBlocksX,
        headerBlocksY
      )
      if (!header) continue
      if (header.mode !== frameMode) continue

      const payloadBitsPerBlock = getModeBitsPerBlock(header.mode) || bitsPerBlock
      const payloadBlocks = getUsablePayloadBlocks(header.mode, blocksX, blocksY)
      const payloadCapacity = Math.floor((payloadBlocks * payloadBitsPerBlock) / BITS_PER_BYTE)
      if (payloadCapacity < header.payloadLength) continue

      const result = readPayloadAt(
        imageData, width, region, rx, ry,
        layout.stepX, layout.stepY, layout.dataBs, blocksX, header, blocksY,
        {
          rx,
          ry,
          stepX: headerStepX,
          stepY: headerStepY,
          bs: headerBs,
          blocksX: headerBlocksX,
          blocksY: headerBlocksY
        },
        options,
        precomputedOffsets
      )
      const innerDiag = result._diag
      result._diag = {
        ...layout,
        modeProbe: frameMode,
        probeDataBlockSize: headerBlockSize,
        dataBlockSize: payloadBlockSize,
        headerBlockSize,
        payloadBlockSize,
        headerBs,
        bitsPerBlock: payloadBitsPerBlock,
        payloadCapacity,
        xOff: (layout.xOff || 0) + xAdjust,
        yOff: (layout.yOff || 0) + yAdjust,
        preferred: true,
        refined: false,
        hypothesis: 'preferred',
        score: scoreCandidate(result),
        ...getHeaderSpanMetrics(header, region)
      }
      if (header.mode === HDMI_MODE.BINARY_3 && innerDiag) {
        result._diag = {
          ...result._diag,
          blocksX: innerDiag.blocksX,
          blocksY: innerDiag.blocksY,
          headerBlocksX: innerDiag.headerBlocksX,
          headerBlocksY: innerDiag.headerBlocksY,
          blackLevel: innerDiag.blackLevel,
          whiteLevel: innerDiag.whiteLevel,
          stripRows: innerDiag.stripRows
        }
      }
      attachDecisionTrace(result, {
        winner: {
          hypothesis: 'preferred',
          refined: false,
          score: result._diag.score,
          crcValid: !!result.crcValid
        },
        reason: 'preferred_layout',
        candidates: [summarizeDecisionCandidate(result, region)]
      }, region)

      if (result.crcValid) return result

      const score = scoreCandidate(result)
      if (score > bestScore) {
        bestScore = score
        bestResult = result
      }
    }
  }

  return bestResult
}

// Decode data blocks from a data region using binary modulation.
// Search the declared compat data modes so the payload grid size can differ from
// the 4×4 anchor grid without prior header knowledge.
export function decodeDataRegion(imageData, width, region, options = {}) {
  const baseBs = region.blockSize || BLOCK_SIZE
  const yOffsets = [0, -1, 1, -2, 2, -3, 3, -4, 4]
  const bsAdjustments = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.5, -0.5]
  const candidateHeaderBlockSizes = [4, 8]

  let bestResult = null
  let bestScore = -1

  const preferredResult = tryPreferredExperimentalLayoutDecode(imageData, width, region, region.preferredLayout, options)
  if (preferredResult) return preferredResult

  for (const headerBlockSize of candidateHeaderBlockSizes) {
    const headerScale = headerBlockSize / BLOCK_SIZE
    const baseStepX = (region.stepX || baseBs) * headerScale
    const baseStepY = (region.stepY || baseBs) * headerScale
    const baseHeaderBs = baseBs * headerScale
    const baseDataStep = Math.max(1, Math.round(baseStepX))
    const offsets = []
    for (let coarse = -2; coarse <= 2; coarse++) {
      for (let fine = -2; fine <= 2; fine++) {
        offsets.push(coarse * baseDataStep + fine)
      }
    }

    for (const bsAdj of bsAdjustments) {
      const anchorBs = baseBs + bsAdj
      if (anchorBs < 2 || anchorBs > 6) continue

      const scale = anchorBs / baseBs
      const stepX = baseStepX * scale
      const stepY = baseStepY * scale
      const headerBs = baseHeaderBs * scale

      const headerBlocksX = Math.floor(region.w / stepX)
      const headerBlocksY = Math.floor(region.h / stepY)
      if (headerBlocksX * headerBlocksY < HEADER_BLOCKS) continue

      for (const xOff of offsets) {
        for (const yOff of yOffsets) {
          const rx = region.x + xOff
          const ry = region.y + yOff

          const header = probeHeaderBinary(imageData, width, region, rx, ry, stepX, stepY, headerBs, headerBlocksX)
          if (!header) continue

          const resolvedHeaderBlockSize = getModeHeaderBlockSize(header.mode)
          const payloadBlockSize = getModePayloadBlockSize(header.mode)
          const payloadBitsPerBlock = getModeBitsPerBlock(header.mode)
          if (!resolvedHeaderBlockSize || !payloadBlockSize || !payloadBitsPerBlock) continue
          if (resolvedHeaderBlockSize !== headerBlockSize) continue

          const payloadScale = payloadBlockSize / resolvedHeaderBlockSize
          const payloadStepX = stepX * payloadScale
          const payloadStepY = stepY * payloadScale
          const payloadBs = headerBs * payloadScale
          const payloadBlocksX = Math.floor(region.w / payloadStepX)
          const payloadBlocksY = Math.floor(region.h / payloadStepY)
          if (payloadBlocksX * payloadBlocksY < HEADER_BLOCKS + BITS_PER_BYTE) continue

          const payloadBlocks = getUsablePayloadBlocks(header.mode, payloadBlocksX, payloadBlocksY)
          const payloadCapacity = header.mode === HDMI_MODE.BINARY_3
            ? getPayloadCapacity(header.width, header.height, HDMI_MODE.BINARY_3)
            : Math.floor((payloadBlocks * payloadBitsPerBlock) / BITS_PER_BYTE)
          if (payloadCapacity < header.payloadLength) continue

          const headerLayout = {
            rx,
            ry,
            stepX,
            stepY,
            bs: headerBs,
            blocksX: headerBlocksX,
            blocksY: headerBlocksY
          }
          const baseResult = readPayloadAt(
            imageData,
            width,
            region,
            rx,
            ry,
            payloadStepX,
            payloadStepY,
            payloadBs,
            payloadBlocksX,
            header,
            payloadBlocksY,
            headerLayout,
            options
          )
          const innerDiag = baseResult._diag
          baseResult._diag = {
            modeProbe: header.mode,
            probeDataBlockSize: headerBlockSize,
            dataBlockSize: payloadBlockSize,
            headerBlockSize,
            payloadBlockSize,
            bitsPerBlock: payloadBitsPerBlock,
            dataBs: payloadBs,
            headerBs,
            stepX: payloadStepX,
            stepY: payloadStepY,
            headerStepX: stepX,
            headerStepY: stepY,
            blocksX: payloadBlocksX,
            blocksY: payloadBlocksY,
            headerBlocksX,
            headerBlocksY,
            frameMode: header.mode,
            xOff,
            yOff,
            bsAdj,
            payloadCapacity,
            blackLevel: baseResult.levels?.blackLevel,
            whiteLevel: baseResult.levels?.whiteLevel,
            blackLevels: baseResult.levels?.blackLevels,
            whiteLevels: baseResult.levels?.whiteLevels,
            hypothesis: 'base',
            refined: false,
            score: scoreCandidate(baseResult),
            ...getHeaderSpanMetrics(header, region)
          }
          if (header.mode === HDMI_MODE.BINARY_3 && innerDiag) {
            baseResult._diag = {
              ...baseResult._diag,
              blocksX: innerDiag.blocksX,
              blocksY: innerDiag.blocksY,
              headerBlocksX: innerDiag.headerBlocksX,
              headerBlocksY: innerDiag.headerBlocksY,
              blackLevel: innerDiag.blackLevel,
              whiteLevel: innerDiag.whiteLevel,
              stripRows: innerDiag.stripRows
            }
          }
          let result = baseResult

          const refinements = getHeaderRefinementHypotheses(header, region)
            .map(({ header: hypothesisHeader, name }) =>
              refineCandidateFromHeader(imageData, width, region, hypothesisHeader, rx, ry, name, options)
            )
            .filter(Boolean)

          let decisionReason = refinements.length > 0 ? 'base_kept' : 'base_only'

          if (refinements.length > 0) {
            let bestRefined = refinements[0]
            let bestRefinedScore = scoreCandidate(bestRefined)
            for (let i = 1; i < refinements.length; i++) {
              const candidate = refinements[i]
              const candidateScore = scoreCandidate(candidate)
              if (candidate.crcValid || candidateScore > bestRefinedScore) {
                bestRefined = candidate
                bestRefinedScore = candidateScore
              }
            }

            const baseScore = scoreCandidate(result)
            const geometry = classifyHeaderGeometry(header, region)
            const refinedHypothesis = bestRefined._diag?.hypothesis
            const shouldPreferRefined =
              bestRefined.crcValid ||
              bestRefinedScore > baseScore ||
              (
                geometry !== 'normal' &&
                refinedHypothesis &&
                refinedHypothesis !== 'base' &&
                bestRefinedScore >= baseScore
              )

            if (shouldPreferRefined) {
              if (bestRefined.crcValid) {
                decisionReason = 'refined_crc'
              } else if (bestRefinedScore > baseScore) {
                decisionReason = 'refined_score'
              } else {
                decisionReason = 'geometry_override'
              }
              result = bestRefined
            }
          }

          const decision = {
            winner: {
              hypothesis: result._diag?.hypothesis || 'base',
              refined: !!result._diag?.refined,
              score: result._diag?.score ?? scoreCandidate(result),
              crcValid: !!result.crcValid
            },
            reason: decisionReason,
            candidates: [
              summarizeDecisionCandidate(baseResult, region),
              ...refinements.map((candidate) => summarizeDecisionCandidate(candidate, region))
            ].filter(Boolean)
          }
          attachDecisionTrace(result, decision, region)

          const score = scoreCandidate(result)

          if (!region._logged) {
            region._logged = true
            console.log(`[HDMI-RX] Header: probeBs=${headerBlockSize} mode=${header.mode} dataBs=${payloadBs.toFixed(2)} step=${payloadStepX.toFixed(2)}/${payloadStepY.toFixed(2)} step-class=${classifyStep(payloadStepX, payloadStepY)} grid=${payloadBlocksX}x${payloadBlocksY} len=${header.payloadLength} cap=${payloadCapacity} off=(${xOff},${yOff}) crc=${result.crcValid}`)
          }

          if (result.crcValid) return result

          if (score > bestScore) {
            bestScore = score
            bestResult = result
          }
        }
      }
    }
  }

  return bestResult
}

// --- Tests ---

export function testHeaderRoundtrip() {
  const header = buildHeader(HDMI_MODE.COMPAT_4, 1920, 1080, 30, 42, 1000000, 0xDEADBEEF)
  const parsed = parseHeader(header)
  const pass = parsed !== null &&
    parsed.magic === FRAME_MAGIC &&
    parsed.mode === HDMI_MODE.COMPAT_4 &&
    parsed.width === 1920 && parsed.height === 1080 &&
    parsed.fps === 30 && parsed.symbolId === 42 &&
    parsed.payloadLength === 1000000 && parsed.payloadCrc === 0xDEADBEEF
  console.log('Header roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testAnchorRoundtrip() {
  const width = 640, height = 480
  const imageData = new Uint8ClampedArray(width * height * 4)
  for (let i = 3; i < imageData.length; i += 4) imageData[i] = 255

  // Render one anchor at (0, 0)
  renderAnchor(imageData, width, 0, 0)

  // Verify it (verifyAnchorAt returns block size > 0 on match)
  const bs = verifyAnchorAt(imageData, width, height, 0, 0)
  const pass = bs > 0
  console.log('Anchor roundtrip test:', pass ? `PASS (bs=${bs})` : 'FAIL')
  return pass
}

export function testFrameRoundtrip() {
  const payload = new Uint8Array(400)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256

  const width = 640, height = 407
  const frame = buildFrame(payload, HDMI_MODE.COMPAT_4, width, height, 30, 42)

  // Detect anchors
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Frame roundtrip test: FAIL (found', anchors.length, 'anchors)')
    return false
  }

  // Derive data region and decode
  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Frame roundtrip test: FAIL (no data region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.symbolId === 42 &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testModeCapacityOrdering() {
  const width = 640
  const height = 480
  const cap4 = getPayloadCapacity(width, height, HDMI_MODE.COMPAT_4)
  const luma2Cap = getPayloadCapacity(width, height, HDMI_MODE.LUMA_2)
  const removedCap16 = getPayloadCapacity(width, height, 4)
  const pass = cap4 > 0 && luma2Cap > cap4 && removedCap16 === 0
  console.log(
    'Mode capacity ordering test:',
    pass ? `PASS (${cap4}; Luma2=${luma2Cap}; legacy 16x16 disabled)` : 'FAIL'
  )
  return pass
}

export function testHeaderAndPayloadBlockSizesMatchForExistingModes() {
  const modes = [
    HDMI_MODE.COMPAT_4,
    HDMI_MODE.RAW_GRAY,
    HDMI_MODE.RAW_RGB,
    HDMI_MODE.LUMA_2,
    HDMI_MODE.CODEBOOK_3,
    HDMI_MODE.GLYPH_5
  ]
  const fail = modes.find((mode) =>
    getModeHeaderBlockSize(mode) !== getModeDataBlockSize(mode) ||
    getModePayloadBlockSize(mode) !== getModeDataBlockSize(mode)
  )
  const pass = !fail
  console.log('Header/payload block size accessors test:', pass ? 'PASS' : `FAIL on mode ${fail}`)
  return pass
}

export function testBinary3ConstantsRegistered() {
  const pass = HDMI_MODE.BINARY_3 === 8 &&
    HDMI_MODE_NAMES[HDMI_MODE.BINARY_3] === '3x3' &&
    getModeHeaderBlockSize(HDMI_MODE.BINARY_3) === 4 &&
    getModePayloadBlockSize(HDMI_MODE.BINARY_3) === 3 &&
    getModeBitsPerBlock(HDMI_MODE.BINARY_3) === 1
  console.log('BINARY_3 constants test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBinary3FrameRoundtrip() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_3)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 23) & 0xff

    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      console.log('BINARY_3 roundtrip test: FAIL (anchors)')
      return false
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      console.log('BINARY_3 roundtrip test: FAIL (region)')
      return false
    }
    const result = decodeDataRegion(frame, width, region)
    const pass = result && result.crcValid &&
      result.header.mode === HDMI_MODE.BINARY_3 &&
      result.payload.length === payload.length &&
      result.payload.every((v, i) => v === payload[i])
    console.log('BINARY_3 roundtrip test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_3 roundtrip test: FAIL', err?.message || err)
    return false
  }
}

export function testDecodeDataRegionPropagatesBinary3Levels() {
  try {
    const width = 1920
    const height = 1080
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_3)
    const payload = new Uint8Array(Math.min(cap, 4096))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 47) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 11)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(frame, width, region) : null
    const pass = result?.crcValid &&
      typeof result._diag?.blackLevel === 'number' &&
      typeof result._diag?.whiteLevel === 'number'
    console.log('decodeDataRegion BINARY_3 levels propagation test:', pass ? 'PASS' : `FAIL diag=${JSON.stringify(result?._diag)}`)
    return pass
  } catch (err) {
    console.log('decodeDataRegion BINARY_3 levels propagation test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary3LockedLayoutMatchesBlindSweep() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_3)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 7)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const blind = region ? decodeDataRegion(frame, width, region) : null
    if (!blind?.crcValid) {
      console.log('Binary3 locked-layout test: FAIL (blind decode)')
      return false
    }

    const diag = blind._diag
    const lockedLayout = {
      blocksX: diag.blocksX,
      blocksY: diag.blocksY,
      frameMode: HDMI_MODE.BINARY_3,
      bitsPerBlock: 1,
      stepX: diag.stepX,
      stepY: diag.stepY,
      dataBs: diag.dataBs,
      xOff: diag.xOff,
      yOff: diag.yOff,
      blackLevel: diag.blackLevel,
      whiteLevel: diag.whiteLevel
    }
    const fast = readPayloadWithLayout(frame, width, region, lockedLayout, payload.length)
    const pass = fast && fast.length === payload.length && fast.every((v, i) => v === payload[i])
    console.log('Binary3 locked-layout test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('Binary3 locked-layout test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary3PrecomputedOffsetsMatchUncached() {
  try {
    const width = 640
    const height = 407
    const cap = getPayloadCapacity(width, height, HDMI_MODE.BINARY_3)
    const payload = new Uint8Array(Math.min(cap, 1500))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 41) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 7)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const initial = region ? decodeDataRegion(frame, width, region) : null
    if (!initial?.crcValid) {
      console.log('Binary3 precomputed offsets match test: FAIL (initial decode)')
      return false
    }
    const diag = initial._diag
    const layout = {
      blocksX: diag.blocksX,
      blocksY: diag.blocksY,
      frameMode: HDMI_MODE.BINARY_3,
      bitsPerBlock: 1,
      stepX: diag.stepX,
      stepY: diag.stepY,
      dataBs: diag.dataBs,
      xOff: diag.xOff,
      yOff: diag.yOff,
      blackLevel: diag.blackLevel,
      whiteLevel: diag.whiteLevel
    }
    const uncached = readPayloadWithLayout(frame, width, region, layout, payload.length, null)
    const { offsets } = precomputeBinary3SampleOffsets(layout, region)
    const cached = readPayloadWithLayout(frame, width, region, layout, payload.length, offsets)
    const pass = uncached && cached &&
      uncached.length === cached.length &&
      cached.every((v, i) => v === uncached[i]) &&
      cached.every((v, i) => v === payload[i])
    console.log('Binary3 precomputed offsets match test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('Binary3 precomputed offsets match test: FAIL', err?.message || err)
    return false
  }
}

export function testDecodeDataRegionConfidence() {
  try {
    const payload = new Uint8Array(50)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 19) & 0xff
    const width = 640
    const height = 407
    const frame = buildFrame(payload, HDMI_MODE.BINARY_3, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(frame, width, region, { collectConfidence: true }) : null
    const pass = result?.crcValid &&
      result.confidence instanceof Uint8Array &&
      result.confidence.length === payload.length * 8 &&
      result.confidence.every((c) => c >= 0 && c <= 128)
    console.log('decode confidence test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('decode confidence test: FAIL', err?.message || err)
    return false
  }
}

export function testDecodeDataRegionConfidenceCompat4() {
  try {
    const payload = new Uint8Array(50)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 11) & 0xff
    const width = 640
    const height = 407
    const frame = buildFrame(payload, HDMI_MODE.COMPAT_4, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    const region = dataRegionFromAnchors(anchors)
    const result = region ? decodeDataRegion(frame, width, region, { collectConfidence: true }) : null
    const pass = result?.crcValid &&
      result.confidence instanceof Uint8Array &&
      result.confidence.length === payload.length * 8
    console.log('decode confidence test (COMPAT_4):', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('decode confidence test (COMPAT_4): FAIL', err?.message || err)
    return false
  }
}

function frameRefactorChecksum(mode, payloadLength, multiplier) {
  const payload = new Uint8Array(payloadLength)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * multiplier) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, mode, width, height, 30, 42)
  const view = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
  return crc32(view)
}

function testPinnedFrameBytes(label, mode, payloadLength, multiplier, expected) {
  const checksum = frameRefactorChecksum(mode, payloadLength, multiplier)
  const pass = checksum === expected
  console.log(`${label} frame refactor byte-equality test: ${pass ? 'PASS' : 'FAIL'} (crc=${checksum.toString(16)}, expected=${expected.toString(16)})`)
  return pass
}

export function testFrameRefactorPreservesCompat4Bytes() {
  return testPinnedFrameBytes('Compat4', HDMI_MODE.COMPAT_4, 400, 73, 0x29e01f8b)
}

export function testFrameRefactorPreservesRawGrayBytes() {
  return testPinnedFrameBytes('RawGray', HDMI_MODE.RAW_GRAY, 401, 37, 0x5899e33b)
}

export function testFrameRefactorPreservesRawRgbBytes() {
  return testPinnedFrameBytes('RawRgb', HDMI_MODE.RAW_RGB, 401, 53, 0xdd629520)
}

export function testFrameRefactorPreservesLuma2Bytes() {
  return testPinnedFrameBytes('Luma2', HDMI_MODE.LUMA_2, 401, 31, 0xe338dccd)
}

export function testFrameRefactorPreservesCodebook3Bytes() {
  return testPinnedFrameBytes('Tile3', HDMI_MODE.CODEBOOK_3, 401, 29, 0xd862dd50)
}

export function testFrameRefactorPreservesGlyph5Bytes() {
  return testPinnedFrameBytes('Glyph5', HDMI_MODE.GLYPH_5, 402, 41, 0x1fc74de1)
}

export function testDecodeDataRegionRoundtripsAllModes() {
  const modes = [
    HDMI_MODE.COMPAT_4,
    HDMI_MODE.RAW_GRAY,
    HDMI_MODE.RAW_RGB,
    HDMI_MODE.LUMA_2,
    HDMI_MODE.CODEBOOK_3,
    HDMI_MODE.GLYPH_5
  ]
  const width = 640
  const height = 407
  const failures = []

  for (const mode of modes) {
    const payload = new Uint8Array(getPayloadCapacity(width, height, mode))
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + mode) & 0xFF

    const frame = buildFrame(payload, mode, width, height, 30, 42)
    const anchors = detectAnchors(frame, width, height)
    if (anchors.length < 2) {
      failures.push(`${mode}: anchors`)
      continue
    }
    const region = dataRegionFromAnchors(anchors)
    if (!region) {
      failures.push(`${mode}: region`)
      continue
    }
    const result = decodeDataRegion(frame, width, region)
    if (!result || !result.crcValid) {
      failures.push(`${mode}: crc`)
      continue
    }
    if (result.payload.length !== payload.length) {
      failures.push(`${mode}: len`)
      continue
    }
    if (!result.payload.every((v, i) => v === payload[i])) {
      failures.push(`${mode}: bytes`)
      continue
    }
  }

  const pass = failures.length === 0
  console.log('decodeDataRegion all-modes roundtrip test:', pass ? 'PASS' : `FAIL ${failures.join(', ')}`)
  return pass
}

export function testNativeGeometryGuidance() {
  const text = buildNativeGeometryGuidance().toLowerCase()
  const required = [
    '1920x1080',
    '@ 60',
    'browser fullscreen',
    'canvas internal',
    'canvas css',
    'browser zoom',
    'display scaling',
    'css transform',
    'pixelated'
  ]
  const missing = required.filter((token) => !text.includes(token.toLowerCase()))
  const pass = missing.length === 0
  console.log('Native geometry guidance test:', pass ? 'PASS' : `FAIL (missing: ${missing.join(', ')})`)
  return pass
}

export function testNative1080pGeometryCheck() {
  const ok = {
    renderPresetId: '1080p',
    width: 1920,
    height: 1080,
    displayWidth: 1920,
    displayHeight: 1080,
    displayScale: 1,
    displayX: 0,
    displayY: 0,
    fullscreenActive: true
  }
  const viewport = { ...ok, renderPresetId: 'viewport' }
  const scaled = { ...ok, displayWidth: 1728, displayHeight: 972, displayScale: 0.9 }
  const hidpiExternal = {
    ...ok,
    displayWidth: 1652,
    displayHeight: 929,
    displayScale: 0.86,
    devicePixelRatio: 1080 / 929,
    physicalDisplayWidth: 1920,
    physicalDisplayHeight: 1080,
    effectiveDisplayScale: 1
  }
  const notFullscreen = { ...ok, fullscreenActive: false }
  const pass = isNative1080pGeometry(ok) &&
    isNative1080pGeometry(hidpiExternal) &&
    !isNative1080pGeometry(viewport) &&
    !isNative1080pGeometry(scaled) &&
    !isNative1080pGeometry(notFullscreen)
  console.log('Native 1080p geometry check test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testEffectiveOneToOnePresentationCheck() {
  const cssScaledButPhysicalNative = {
    width: 1920,
    height: 1080,
    displayWidth: 1652,
    displayHeight: 929,
    displayScale: 0.86,
    devicePixelRatio: 1080 / 929,
    physicalDisplayWidth: 1920,
    physicalDisplayHeight: 1080,
    effectiveDisplayScale: 1
  }
  const physicallyScaled = {
    ...cssScaledButPhysicalNative,
    physicalDisplayWidth: 1652,
    physicalDisplayHeight: 929,
    effectiveDisplayScale: 0.86
  }
  const pass = hasEffectiveOneToOnePresentation(cssScaledButPhysicalNative) &&
    !hasEffectiveOneToOnePresentation(physicallyScaled)
  console.log('Effective one-to-one presentation check test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testClassifyStep() {
  const cases = [
    { sx: 3.00, sy: 3.00, expected: 'integer' },
    { sx: 3.02, sy: 3.01, expected: 'integer' },
    { sx: 3.20, sy: 3.20, expected: 'fractional' },
    { sx: 3.00, sy: 3.20, expected: 'skewed' },
    { sx: 4.00, sy: 4.00, expected: 'integer' }
  ]
  const fail = cases.find(({ sx, sy, expected }) => classifyStep(sx, sy) !== expected)
  const pass = !fail
  console.log('classifyStep test:', pass ? 'PASS' : `FAIL on ${JSON.stringify(fail)}`)
  return pass
}

export function testGray2FrameRoundtrip() {
  const payload = new Uint8Array(400)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 37) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.RAW_GRAY, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Gray2 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Gray2 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.RAW_GRAY &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Gray2 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testRgb3FrameRoundtrip() {
  const payload = new Uint8Array(401)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 53) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.RAW_RGB, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('RGB3 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('RGB3 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.RAW_RGB &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('RGB3 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testLuma2FrameRoundtrip() {
  const payload = new Uint8Array(401)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.LUMA_2, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Luma2 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Luma2 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.LUMA_2 &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Luma2 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testLuma2Classifier() {
  const cases = [
    { samples: [230, 220, 20, 30], expected: 0 },
    { samples: [20, 30, 220, 230], expected: 1 },
    { samples: [225, 25, 235, 35], expected: 2 },
    { samples: [30, 230, 40, 220], expected: 3 }
  ]

  const pass = cases.every(({ samples, expected }) => decodeLuma2(samples, 0, 255) === expected)
  console.log('Luma2 classifier test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testCodebook3FrameRoundtrip() {
  const payload = new Uint8Array(401)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 29) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.CODEBOOK_3, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Tile3 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Tile3 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.CODEBOOK_3 &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Tile3 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testGlyph5FrameRoundtrip() {
  const payload = new Uint8Array(402)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 41) & 0xFF

  const width = 640
  const height = 480
  const frame = buildFrame(payload, HDMI_MODE.GLYPH_5, width, height, 30, 42)
  const anchors = detectAnchors(frame, width, height)
  if (anchors.length < 2) {
    console.log('Glyph5 frame roundtrip test: FAIL (anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Glyph5 frame roundtrip test: FAIL (no region)')
    return false
  }

  const result = decodeDataRegion(frame, width, region)
  const pass = result !== null &&
    result.crcValid &&
    result.header.mode === HDMI_MODE.GLYPH_5 &&
    result.payload.length === payload.length &&
    result.payload.every((v, i) => v === payload[i])

  console.log('Glyph5 frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testAnchorDetectionWithOffset() {
  // Build a frame at 400×300, embed it at offset (22, 20) in a 460×350 canvas
  // Simulates HDMI capture with small black borders (realistic scenario)
  const innerW = 400, innerH = 300
  const outerW = 460, outerH = 350
  const offsetX = 22, offsetY = 20

  const payload = new Uint8Array(100)
  for (let i = 0; i < payload.length; i++) payload[i] = i

  // Build inner frame
  const innerFrame = buildFrame(payload, HDMI_MODE.COMPAT_4, innerW, innerH, 30, 7)

  // Create outer canvas (black)
  const outer = new Uint8ClampedArray(outerW * outerH * 4)
  for (let i = 3; i < outer.length; i += 4) outer[i] = 255

  // Copy inner frame to offset position
  for (let y = 0; y < innerH; y++) {
    for (let x = 0; x < innerW; x++) {
      const srcIdx = (y * innerW + x) * 4
      const dstIdx = ((y + offsetY) * outerW + (x + offsetX)) * 4
      outer[dstIdx] = innerFrame[srcIdx]
      outer[dstIdx + 1] = innerFrame[srcIdx + 1]
      outer[dstIdx + 2] = innerFrame[srcIdx + 2]
    }
  }

  // Detect anchors in outer canvas
  const anchors = detectAnchors(outer, outerW, outerH)
  if (anchors.length < 2) {
    console.log('Anchor offset test: FAIL (found', anchors.length, 'anchors)')
    return false
  }

  const region = dataRegionFromAnchors(anchors)
  if (!region) {
    console.log('Anchor offset test: FAIL (no data region)')
    return false
  }
  const result = decodeDataRegion(outer, outerW, region)
  const pass = result !== null && result.crcValid && result.header.symbolId === 7

  console.log('Anchor offset test:', pass ? 'PASS' : 'FAIL')
  return pass
}
