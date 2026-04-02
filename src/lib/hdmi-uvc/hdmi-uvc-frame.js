// HDMI-UVC frame encoding/decoding with anchor-based layout

import {
  FRAME_MAGIC, HEADER_SIZE, ANCHOR_SIZE, MARGIN_SIZE, BLOCK_SIZE,
  ANCHOR_PATTERN, HDMI_MODE, getModeDataBlockSize
} from './hdmi-uvc-constants.js'
import { crc32 } from './crc32.js'

// --- Binary modulation (1 bit per block) ---
// Each byte is encoded as 8 blocks (MSB first): bit=1 → white (255), bit=0 → black (0).
// Receiver thresholds at 128. MJPEG corrupts values by ±20 but binary has 108+ margin.

const BITS_PER_BYTE = 8
const HEADER_BLOCKS = HEADER_SIZE * BITS_PER_BYTE // 22 bytes × 8 bits = 176 blocks

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
  if (!dataBlockSize) return 0
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / dataBlockSize)
  const blocksY = Math.floor(dr.h / dataBlockSize)
  const totalBlocks = blocksX * blocksY
  return Math.max(0, Math.floor((totalBlocks - HEADER_BLOCKS) / BITS_PER_BYTE))
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
  if (!dataBlockSize) {
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

  // Fill data region with binary-encoded mode-sized blocks.
  // Each byte is encoded as 8 blocks (MSB first, 0/255).
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / dataBlockSize)
  const blocksY = Math.floor(dr.h / dataBlockSize)

  // Combine header + payload into a single byte stream
  const allBytes = new Uint8Array(headerBytes.length + payload.length)
  allBytes.set(headerBytes)
  allBytes.set(payload, headerBytes.length)

  let byteIdx = 0
  let bitIdx = 0

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let val = 0
      if (byteIdx < allBytes.length) {
        val = (allBytes[byteIdx] >> (7 - bitIdx)) & 1 ? 255 : 0
      }

      // Fill the mode-specific data block.
      const startX = dr.x + bx * dataBlockSize
      const startY = dr.y + by * dataBlockSize
      for (let dy = 0; dy < dataBlockSize; dy++) {
        for (let dx = 0; dx < dataBlockSize; dx++) {
          const i = ((startY + dy) * width + (startX + dx)) * 4
          imageData[i] = val
          imageData[i + 1] = val
          imageData[i + 2] = val
        }
      }

      bitIdx++
      if (bitIdx >= 8) {
        bitIdx = 0
        byteIdx++
      }
    }
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
  const payload = new Uint8Array(header.payloadLength)
  let payloadIdx = 0
  let blockIdx = 0
  let currentByte = 0
  let bitIdx = 0
  const height = imageData.length / (width * 4)

  for (let by = 0; by < blocksY && payloadIdx < header.payloadLength; by++) {
    for (let bx = 0; bx < blocksX && payloadIdx < header.payloadLength; bx++) {
      if (blockIdx >= HEADER_BLOCKS) {
        const px = rx + Math.round(bx * stepX)
        const py = ry + Math.round(by * stepY)
        let val = 0
        if (px >= 0 && px < width && py >= 0 && py < height) {
          val = sampleBlockAt(imageData, width, px, py, bs)
        }
        if (val > 128) currentByte |= (1 << (7 - bitIdx))
        bitIdx++
        if (bitIdx >= 8) {
          payload[payloadIdx++] = currentByte
          currentByte = 0
          bitIdx = 0
        }
      }
      blockIdx++
    }
  }

  const actualCrc = crc32(payload)
  return { header, payload, crcValid: actualCrc === header.payloadCrc }
}

// Read a fixed payload length from a known-good grid layout without relying on a
// newly decoded HDMI header. Used after session lock, where inner packet CRCs can
// validate individual packets even if the outer frame header is damaged.
export function readPayloadWithLayout(imageData, width, region, layout, payloadLength) {
  if (!layout || !payloadLength || payloadLength <= 0) return null

  const blocksX = layout.blocksX
  const blocksY = layout.blocksY ?? Math.floor(region.h / layout.stepY)
  if (!blocksX || !blocksY) return null

  const rx = region.x + (layout.xOff || 0)
  const ry = region.y + (layout.yOff || 0)
  const payload = new Uint8Array(payloadLength)
  let payloadIdx = 0
  let blockIdx = 0
  let currentByte = 0
  let bitIdx = 0
  const height = imageData.length / (width * 4)

  for (let by = 0; by < blocksY && payloadIdx < payloadLength; by++) {
    for (let bx = 0; bx < blocksX && payloadIdx < payloadLength; bx++) {
      if (blockIdx >= HEADER_BLOCKS) {
        const px = rx + Math.round(bx * layout.stepX)
        const py = ry + Math.round(by * layout.stepY)
        let val = 0
        if (px >= 0 && px < width && py >= 0 && py < height) {
          val = sampleBlockAt(imageData, width, px, py, layout.dataBs)
        }
        if (val > 128) currentByte |= (1 << (7 - bitIdx))
        bitIdx++
        if (bitIdx >= 8) {
          payload[payloadIdx++] = currentByte
          currentByte = 0
          bitIdx = 0
        }
      }
      blockIdx++
    }
  }

  return payloadIdx === payloadLength ? payload : null
}

// Score a candidate header: higher = better. CRC-valid candidates always win.
function scoreCandidate(result) {
  if (result.crcValid) return 10000
  let score = 0
  // Strongly prefer the original small-packet diagnostic shape (256 blockSize + packet header)
  if (result.header.payloadLength === 272) score += 1000
  else if (result.header.payloadLength > 0 && result.header.payloadLength <= 4096) score += 10
  return score
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

// Once a plausible header is found, derive a more precise capture scale from the
// measured frame span. This reduces horizontal drift across later header fields.
function refineCandidateFromHeader(imageData, width, region, header, rx, ry, hypothesis = 'base') {
  if (!region.frameW || !region.frameH) return null
  if (header.width < 100 || header.height < 100) return null
  const dataBlockSize = getModeDataBlockSize(header.mode)
  if (!dataBlockSize) return null

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

      const payloadBlocks = blocksX * blocksY - HEADER_BLOCKS
      const payloadCapacity = Math.floor(payloadBlocks / BITS_PER_BYTE)
      if (payloadCapacity < refinedHeader.payloadLength) continue

      const result = readPayloadAt(
        imageData, width, region, refinedRx, refinedRy, stepX, stepY, dataBs, blocksX, refinedHeader, blocksY
      )
      result._diag = {
        dataBs,
        dataBlockSize,
        stepX,
        stepY,
        blocksX,
        blocksY,
        xOff: refinedRx - region.x,
        yOff: refinedRy - region.y,
        refined: true,
        hypothesis,
        payloadCapacity,
        scaleX: region.frameW / refinedHeader.width,
        scaleY: region.frameH / refinedHeader.height
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

function getHeaderRefinementHypotheses(header, region) {
  const hypotheses = [{ header, name: 'base' }]

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

  return hypotheses
}

// Decode data blocks from a data region using binary modulation.
// Search the declared compat data modes so the payload grid size can differ from
// the 4×4 anchor grid without prior header knowledge.
export function decodeDataRegion(imageData, width, region) {
  const baseBs = region.blockSize || BLOCK_SIZE
  const yOffsets = [0, -1, 1, -2, 2]
  const bsAdjustments = [0, 0.1, -0.1, 0.2, -0.2, 0.3, -0.3, 0.5, -0.5]
  const candidateModes = [HDMI_MODE.COMPAT_4, HDMI_MODE.COMPAT_8, HDMI_MODE.COMPAT_16]

  let bestResult = null
  let bestScore = -1

  for (const mode of candidateModes) {
    const dataBlockSize = getModeDataBlockSize(mode)
    if (!dataBlockSize) continue

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

          const blocksY = Math.floor(region.h / stepY)
          const payloadBlocks = blocksX * blocksY - HEADER_BLOCKS
          const payloadCapacity = Math.floor(payloadBlocks / BITS_PER_BYTE)
          if (payloadCapacity < header.payloadLength) continue

          let result = readPayloadAt(imageData, width, region, rx, ry, stepX, stepY, dataBs, blocksX, header)
          result._diag = {
            modeProbe: mode,
            dataBlockSize,
            dataBs,
            stepX,
            stepY,
            blocksX,
            blocksY,
            xOff,
            yOff,
            bsAdj,
            payloadCapacity
          }

          const refinements = getHeaderRefinementHypotheses(header, region)
            .map(({ header: hypothesisHeader, name }) =>
              refineCandidateFromHeader(imageData, width, region, hypothesisHeader, rx, ry, name)
            )
            .filter(Boolean)

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
            if (bestRefined.crcValid || bestRefinedScore > baseScore) {
              result = bestRefined
            }
          }

          const score = scoreCandidate(result)

          if (!region._logged) {
            region._logged = true
            console.log(`[HDMI-RX] Header: mode=${mode} dataBs=${dataBs.toFixed(2)} step=${stepX.toFixed(2)}/${stepY.toFixed(2)} grid=${blocksX}x${blocksY} len=${header.payloadLength} cap=${payloadCapacity} off=(${xOff},${yOff}) crc=${result.crcValid}`)
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
