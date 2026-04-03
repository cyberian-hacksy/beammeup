// HDMI-UVC frame encoding/decoding with anchor-based layout

import {
  FRAME_MAGIC, HEADER_SIZE, ANCHOR_SIZE, MARGIN_SIZE, BLOCK_SIZE,
  ANCHOR_PATTERN, HDMI_MODE, getModeBitsPerBlock, getModeDataBlockSize
} from './hdmi-uvc-constants.js'
import { crc32 } from './crc32.js'

// --- Binary modulation (1 bit per block) ---
// Each byte is encoded as 8 blocks (MSB first): bit=1 → white (255), bit=0 → black (0).
// Receiver thresholds at 128. MJPEG corrupts values by ±20 but binary has 108+ margin.

const BITS_PER_BYTE = 8
const HEADER_BLOCKS = HEADER_SIZE * BITS_PER_BYTE // 22 bytes × 8 bits = 176 blocks
const GRAY2_LEVEL_FRACTIONS = [0.08, 0.36, 0.64, 0.92]
const GRAY2_THRESHOLD_FRACTIONS = [0.22, 0.50, 0.78]
const ENABLE_BINARY_PILOTS = false
const ENABLE_PAYLOAD_INTERLEAVING = false
const BINARY_PILOT_SPACING = 16
const BINARY_PILOT_OFFSET = 8
const payloadCellOrderCache = new Map()
const CODEBOOK3_PATTERNS = [
  [0, 0, 0, 0],
  [1, 1, 1, 1],
  [1, 1, 0, 0],
  [0, 0, 1, 1],
  [1, 0, 1, 0],
  [0, 1, 0, 1],
  [1, 0, 0, 1],
  [0, 1, 1, 0]
]
const GLYPH5_GRID_SIZE = 4
const GLYPH5_SYMBOL_COUNT = 32
const GLYPH5_CODEBOOK = buildGlyph5Codebook()

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
  return [
    (symbol & 0x4) ? 255 : 0,
    (symbol & 0x2) ? 255 : 0,
    (symbol & 0x1) ? 255 : 0
  ]
}

function decodeRgb3(sample, blackLevels = [0, 0, 0], whiteLevels = [255, 255, 255]) {
  let symbol = 0
  for (let channel = 0; channel < 3; channel++) {
    const minLevel = Math.max(0, Math.min(blackLevels[channel], whiteLevels[channel]))
    const maxLevel = Math.min(255, Math.max(blackLevels[channel], whiteLevels[channel]))
    const span = Math.max(64, maxLevel - minLevel)
    const threshold = minLevel + span * 0.5
    if (sample[channel] >= threshold) {
      symbol |= (1 << (2 - channel))
    }
  }
  return symbol
}

function normalizeBinarySample(sample, blackLevel = 0, whiteLevel = 255) {
  const span = Math.max(48, Math.abs(whiteLevel - blackLevel))
  const polarity = whiteLevel >= blackLevel ? 1 : -1
  const normalized = (polarity * (sample - blackLevel)) / span
  return Math.max(0, Math.min(1, normalized))
}

function decodeCodebook3(samples, blackLevel = 0, whiteLevel = 255) {
  const normalized = samples.map((sample) => normalizeBinarySample(sample, blackLevel, whiteLevel))
  let bestSymbol = 0
  let bestError = Infinity

  for (let symbol = 0; symbol < CODEBOOK3_PATTERNS.length; symbol++) {
    const pattern = CODEBOOK3_PATTERNS[symbol]
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

function decodeGlyph5(samples, blackLevel = 0, whiteLevel = 255) {
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

function renderCodebook3Block(imageData, width, startX, startY, size, symbol) {
  const pattern = CODEBOOK3_PATTERNS[symbol & 0x7]
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

function renderGlyph5Block(imageData, width, startX, startY, size, symbol) {
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

// Draw a 32×32 anchor pattern at (originX, originY) into RGBA imageData
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

// Calculate payload capacity in bytes (binary modulation: 8 data-blocks per byte)
export function getPayloadCapacity(width, height, mode = HDMI_MODE.COMPAT_4) {
  const dataBlockSize = getModeDataBlockSize(mode)
  const bitsPerBlock = getModeBitsPerBlock(mode)
  if (!dataBlockSize || !bitsPerBlock) return 0
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / dataBlockSize)
  const blocksY = Math.floor(dr.h / dataBlockSize)
  const payloadBlocks = getUsablePayloadBlocks(mode, blocksX, blocksY)
  return Math.max(0, Math.floor((payloadBlocks * bitsPerBlock) / BITS_PER_BYTE))
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

function getUsablePayloadBlocks(mode, blocksX, blocksY) {
  const totalBlocks = blocksX * blocksY
  const payloadBlocks = Math.max(0, totalBlocks - HEADER_BLOCKS)
  return Math.max(0, payloadBlocks - countPilotBlocks(mode, blocksX, blocksY))
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
  if (!getModeDataBlockSize(mode)) return null
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

// Build a complete frame: black background + 4 anchors + data blocks (header + payload)
export function buildFrame(payload, mode, width, height, fps, symbolId) {
  const dataBlockSize = getModeDataBlockSize(mode)
  const bitsPerBlock = getModeBitsPerBlock(mode)
  if (!dataBlockSize || !bitsPerBlock) {
    throw new Error(`Unsupported HDMI-UVC mode: ${mode}`)
  }
  const payloadCrc = crc32(payload)
  const headerBytes = buildHeader(mode, width, height, fps, symbolId, payload.length, payloadCrc)

  // Create RGBA image (black background, alpha=255)
  const imageData = new Uint8ClampedArray(width * height * 4)
  for (let i = 3; i < imageData.length; i += 4) {
    imageData[i] = 255 // Set all alpha to 255, RGB stays 0 (black)
  }

  // Draw 4 corner anchors
  renderAnchor(imageData, width, 0, 0)                                    // top-left
  renderAnchor(imageData, width, width - ANCHOR_SIZE, 0)                  // top-right
  renderAnchor(imageData, width, 0, height - ANCHOR_SIZE)                 // bottom-left
  renderAnchor(imageData, width, width - ANCHOR_SIZE, height - ANCHOR_SIZE) // bottom-right

  // Fill data region with mode-sized blocks. The HDMI header remains binary for
  // robust lock; some modes carry more than 1 bit per payload block.
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / dataBlockSize)
  const blocksY = Math.floor(dr.h / dataBlockSize)
  const payloadCells = getPayloadCellOrder(mode, blocksX, blocksY)
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
      const startX = dr.x + bx * dataBlockSize
      const startY = dr.y + by * dataBlockSize
      fillBlockSolid(imageData, width, startX, startY, dataBlockSize, r, g, b)
      blockIdx++
    }
  }

  for (let cellIdx = 0; cellIdx < payloadCells.length && payloadBitPos < payloadBitLength; cellIdx++) {
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
function sampleBlockAt(imageData, width, px, py, bs) {
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

function sampleCodebook3At(imageData, width, px, py, bs) {
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

function sampleGlyph5At(imageData, width, px, py, bs) {
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

  // For each of 4 directions, check 3 points at 8/14/20px from anchor edge.
  // Direction counts as "dark" if majority (2+) of points are dark.
  let darkDirs = 0
  const distances = [8, 14, 20]

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
  // Try block sizes starting from sender's native 4.0, spiraling outward.
  // This ensures exact match at 1:1 scale and finds scaled anchors efficiently.
  const blockSizes = [4.0, 3.75, 4.25, 3.5, 4.5, 3.25, 4.75, 3.0, 5.0, 2.75, 5.25, 2.5, 5.5]
  for (const bs of blockSizes) {
    if (verifyAnchorWithBlockSize(imageData, width, height, originX, originY, bs) &&
        verifyAnchorContext(imageData, width, height, originX, originY, bs)) {
      return bs
    }
  }
  return 0
}

// Find an anchor by scanning a corner for a bright rectangle, then verifying
// with a lightweight 2-point check (black ring + white center).
function findCornerAnchor(imageData, width, height, xStart, xEnd, yStart, yEnd, yDir, corner) {
  // Scan row by row in yDir direction for a horizontal bright run (15-50px)
  for (let y = yStart; y !== yEnd; y += yDir) {
    if (y < 0 || y >= height) continue
    let runStart = -1, runLen = 0
    for (let x = xStart; x < xEnd; x++) {
      if (imageData[(y * width + x) * 4] > 200) {
        if (runStart < 0) runStart = x
        runLen++
      } else {
        if (runLen >= 15 && runLen <= 50) {
          const anchor = verifyBrightRun(imageData, width, height, runStart, y, runLen, yDir, corner)
          if (anchor) return anchor
        }
        runStart = -1
        runLen = 0
      }
    }
    if (runLen >= 15 && runLen <= 50) {
      const anchor = verifyBrightRun(imageData, width, height, runStart, y, runLen, yDir, corner)
      if (anchor) return anchor
    }
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
    // Expected vertical span: between 45% and 75% of horizontal span
    const minVSpan = Math.round(hSpan * 0.40)
    const maxVSpan = Math.round(hSpan * 0.80)
    const topSearchLo = Math.max(chromeBottom, bl.y - maxVSpan - 50)
    const topSearchHi = Math.max(chromeBottom, bl.y - minVSpan + 50)

    const tl = findCornerAnchor(imageData, width, height,
      Math.max(0, bl.x - 20), Math.min(width, bl.x + 50), topSearchLo, topSearchHi, 1, 'TL')
    const tr = findCornerAnchor(imageData, width, height,
      Math.max(0, br.x - 20), Math.min(width, br.x + 50), topSearchLo, topSearchHi, 1, 'TR')

    // Only accept top anchors if BOTH are found at matching y (±15px)
    if (tl && tr && Math.abs(tl.y - tr.y) <= 15) {
      tl.blockSize = refineAnchorScale(imageData, width, height, tl)
      tr.blockSize = refineAnchorScale(imageData, width, height, tr)
      anchors.push(tl)
      anchors.push(tr)
    }
    // If top anchors aren't found or don't match, we'll estimate from bottom pair
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

  // Need at least one top anchor and one bottom anchor
  const hasTop = tl || tr
  const hasBottom = bl || br
  if (!hasTop || !hasBottom) return null

  // Check block size consistency: all anchors within 20% of median
  const sizes = anchors.map(a => a.blockSize).sort((a, b) => a - b)
  const median = sizes[Math.floor(sizes.length / 2)]
  if (sizes.some(s => Math.abs(s - median) / median > 0.20)) return null

  const avgBs = anchors.reduce((s, a) => s + a.blockSize, 0) / anchors.length
  const actualAnchorSize = Math.ceil(8 * avgBs)

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
function readPayloadAt(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, header, expectedBlocksY = null) {
  const blocksY = expectedBlocksY ?? Math.floor(region.h / stepY)
  const bitsPerBlock = getModeBitsPerBlock(header.mode) || 1
  const payloadCells = getPayloadCellOrder(header.mode, blocksX, blocksY)
  const levels = header.mode === HDMI_MODE.RAW_RGB
    ? estimateRgbPayloadLevelsFromHeader(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, header, blocksY)
    : estimatePayloadLevelsFromHeader(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, header, blocksY)
  const pilotField = bitsPerBlock === 1
    ? sampleBinaryPilotField(imageData, width, region, rx, ry, stepX, stepY, bs, blocksX, blocksY, header.mode)
    : null
  const payload = new Uint8Array(header.payloadLength)
  const decodeState = { index: 0, bitBuffer: 0, bitCount: 0 }
  const height = imageData.length / (width * 4)

  for (let cellIdx = 0; cellIdx < payloadCells.length && decodeState.index < header.payloadLength; cellIdx++) {
    const { bx, by } = payloadCells[cellIdx]
    const px = rx + Math.round(bx * stepX)
    const py = ry + Math.round(by * stepY)
    let symbol = 0
    if (px >= 0 && px < width && py >= 0 && py < height) {
      if (header.mode === HDMI_MODE.RAW_RGB) {
        const rgb = sampleBlockRgbAt(imageData, width, px, py, bs)
        symbol = decodeRgb3(rgb, levels?.blackLevels, levels?.whiteLevels)
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
      }
    }
    appendSymbolBits(payload, decodeState, symbol, bitsPerBlock)
  }

  const actualCrc = crc32(payload)
  return { header, payload, crcValid: actualCrc === header.payloadCrc, levels }
}

// Read a fixed payload length from a known-good grid layout without relying on a
// newly decoded HDMI header. Used after session lock, where inner packet CRCs can
// validate individual packets even if the outer frame header is damaged.
export function readPayloadWithLayout(imageData, width, region, layout, payloadLength) {
  if (!layout || !payloadLength || payloadLength <= 0) return null

  const blocksX = layout.blocksX
  const blocksY = layout.blocksY ?? Math.floor(region.h / layout.stepY)
  const frameMode = layout.frameMode ?? HDMI_MODE.COMPAT_4
  if (!blocksX || !blocksY) return null

  const rx = region.x + (layout.xOff || 0)
  const ry = region.y + (layout.yOff || 0)
  const bitsPerBlock = layout.bitsPerBlock || 1
  const payloadCells = getPayloadCellOrder(frameMode, blocksX, blocksY)
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
  const payload = new Uint8Array(payloadLength)
  const decodeState = { index: 0, bitBuffer: 0, bitCount: 0 }
  const height = imageData.length / (width * 4)

  for (let cellIdx = 0; cellIdx < payloadCells.length && decodeState.index < payloadLength; cellIdx++) {
    const { bx, by } = payloadCells[cellIdx]
    const px = rx + Math.round(bx * layout.stepX)
    const py = ry + Math.round(by * layout.stepY)
    let symbol = 0
    if (px >= 0 && px < width && py >= 0 && py < height) {
      if (frameMode === HDMI_MODE.RAW_RGB) {
        const rgb = sampleBlockRgbAt(imageData, width, px, py, layout.dataBs)
        symbol = decodeRgb3(rgb, layout.blackLevels, layout.whiteLevels)
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

  return {
    blackLevels: blackCount > 0 ? blackSums.map((sum) => sum / blackCount) : [0, 0, 0],
    whiteLevels: whiteCount > 0 ? whiteSums.map((sum) => sum / whiteCount) : [255, 255, 255]
  }
}

// Once a plausible header is found, derive a more precise capture scale from the
// measured frame span. This reduces horizontal drift across later header fields.
function refineCandidateFromHeader(imageData, width, region, header, rx, ry, hypothesis = 'base') {
  if (!region.frameW || !region.frameH) return null
  if (header.width < 100 || header.height < 100) return null
  const dataBlockSize = getModeDataBlockSize(header.mode)
  const bitsPerBlock = getModeBitsPerBlock(header.mode)
  if (!dataBlockSize || !bitsPerBlock) return null

  const blocksX = Math.floor((header.width - 2 * MARGIN_SIZE) / dataBlockSize)
  const blocksY = Math.floor((header.height - 2 * MARGIN_SIZE) / dataBlockSize)
  if (blocksX * blocksY < HEADER_BLOCKS + BITS_PER_BYTE) return null

  const stepX = (region.frameW / header.width) * dataBlockSize
  const stepY = (region.frameH / header.height) * dataBlockSize
  const dataBs = Math.min(stepX, stepY)
  const minStep = dataBlockSize === 4 ? 3 : dataBlockSize === 8 ? 6 : 12
  const maxStep = dataBlockSize === 4 ? 6 : dataBlockSize === 8 ? 10 : 20
  if (stepX < minStep || stepX > maxStep || stepY < minStep || stepY > maxStep) return null

  const yOffsets = [0, -1, 1, -2, 2]
  let bestResult = null
  let bestScore = -1

  for (let xAdjust = -2; xAdjust <= 2; xAdjust++) {
    for (const yAdjust of yOffsets) {
      const refinedRx = rx + xAdjust
      const refinedRy = ry + yAdjust

      const refinedHeader = probeHeaderBinary(
        imageData, width, region, refinedRx, refinedRy, stepX, stepY, dataBs, blocksX, blocksY
      )
      if (!refinedHeader) continue

      const payloadBlocks = getUsablePayloadBlocks(refinedHeader.mode, blocksX, blocksY)
      const payloadCapacity = Math.floor((payloadBlocks * bitsPerBlock) / BITS_PER_BYTE)
      if (payloadCapacity < refinedHeader.payloadLength) continue

      const result = readPayloadAt(
        imageData, width, region, refinedRx, refinedRy, stepX, stepY, dataBs, blocksX, refinedHeader, blocksY
      )
      result._diag = {
        dataBs,
        dataBlockSize,
        bitsPerBlock,
        stepX,
        stepY,
        blocksX,
        blocksY,
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

function tryPreferredExperimentalLayoutDecode(imageData, width, region, layout) {
  if (!layout || (layout.frameMode ?? HDMI_MODE.COMPAT_4) < HDMI_MODE.CODEBOOK_3) return null

  const frameMode = layout.frameMode
  const dataBlockSize = getModeDataBlockSize(frameMode)
  const bitsPerBlock = getModeBitsPerBlock(frameMode)
  const blocksX = layout.blocksX
  const blocksY = layout.blocksY ?? Math.floor(region.h / layout.stepY)
  if (!dataBlockSize || !bitsPerBlock || !blocksX || !blocksY) return null

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
        layout.stepX,
        layout.stepY,
        layout.dataBs,
        blocksX,
        blocksY
      )
      if (!header) continue
      if (header.mode !== frameMode) continue

      const payloadBitsPerBlock = getModeBitsPerBlock(header.mode) || bitsPerBlock
      const payloadBlocks = getUsablePayloadBlocks(header.mode, blocksX, blocksY)
      const payloadCapacity = Math.floor((payloadBlocks * payloadBitsPerBlock) / BITS_PER_BYTE)
      if (payloadCapacity < header.payloadLength) continue

      const result = readPayloadAt(
        imageData, width, region, rx, ry,
        layout.stepX, layout.stepY, layout.dataBs, blocksX, header, blocksY
      )
      result._diag = {
        ...layout,
        modeProbe: frameMode,
        probeDataBlockSize: dataBlockSize,
        dataBlockSize,
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
export function decodeDataRegion(imageData, width, region) {
  const baseBs = region.blockSize || BLOCK_SIZE
  const yOffsets = [0, -1, 1, -2, 2, -3, 3, -4, 4]
  const bsAdjustments = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.5, -0.5]
  const candidateBlockSizes = [4, 8, 16]

  let bestResult = null
  let bestScore = -1

  const preferredResult = tryPreferredExperimentalLayoutDecode(imageData, width, region, region.preferredLayout)
  if (preferredResult) return preferredResult

  for (const dataBlockSize of candidateBlockSizes) {
    const dataScale = dataBlockSize / BLOCK_SIZE
    const baseStepX = (region.stepX || baseBs) * dataScale
    const baseStepY = (region.stepY || baseBs) * dataScale
    const baseDataBs = baseBs * dataScale
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
      const dataBs = baseDataBs * scale

      const blocksX = Math.floor(region.w / stepX)
      const totalBlocksY = Math.floor(region.h / stepY)
      if (blocksX * totalBlocksY < HEADER_BLOCKS + BITS_PER_BYTE) continue

      for (const xOff of offsets) {
        for (const yOff of yOffsets) {
          const rx = region.x + xOff
          const ry = region.y + yOff

          const header = probeHeaderBinary(imageData, width, region, rx, ry, stepX, stepY, dataBs, blocksX)
          if (!header) continue

          const payloadBitsPerBlock = getModeBitsPerBlock(header.mode) || bitsPerBlock
          const blocksY = Math.floor(region.h / stepY)
          const payloadBlocks = getUsablePayloadBlocks(header.mode, blocksX, blocksY)
          const payloadCapacity = Math.floor((payloadBlocks * payloadBitsPerBlock) / BITS_PER_BYTE)
          if (payloadCapacity < header.payloadLength) continue

          const baseResult = readPayloadAt(imageData, width, region, rx, ry, stepX, stepY, dataBs, blocksX, header)
          baseResult._diag = {
            modeProbe: header.mode,
            probeDataBlockSize: dataBlockSize,
            dataBlockSize,
            bitsPerBlock: payloadBitsPerBlock,
            dataBs,
            stepX,
            stepY,
            blocksX,
            blocksY,
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
          let result = baseResult

          const refinements = getHeaderRefinementHypotheses(header, region)
            .map(({ header: hypothesisHeader, name }) =>
              refineCandidateFromHeader(imageData, width, region, hypothesisHeader, rx, ry, name)
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
            console.log(`[HDMI-RX] Header: probeBs=${dataBlockSize} mode=${header.mode} dataBs=${dataBs.toFixed(2)} step=${stepX.toFixed(2)}/${stepY.toFixed(2)} grid=${blocksX}x${blocksY} len=${header.payloadLength} cap=${payloadCapacity} off=(${xOff},${yOff}) crc=${result.crcValid}`)
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

  const width = 640, height = 480
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
  const cap8 = getPayloadCapacity(width, height, HDMI_MODE.COMPAT_8)
  const cap16 = getPayloadCapacity(width, height, HDMI_MODE.COMPAT_16)
  const pass = cap4 > cap8 && cap8 > cap16
  console.log('Mode capacity ordering test:', pass ? `PASS (${cap4} > ${cap8} > ${cap16})` : 'FAIL')
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
