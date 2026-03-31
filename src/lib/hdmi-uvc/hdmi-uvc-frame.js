// HDMI-UVC frame encoding/decoding with anchor-based layout

import {
  FRAME_MAGIC, HEADER_SIZE, ANCHOR_SIZE, MARGIN_SIZE, BLOCK_SIZE,
  ANCHOR_PATTERN, HDMI_MODE
} from './hdmi-uvc-constants.js'
import { crc32 } from './crc32.js'

// --- Byte encoding (direct mapping) ---

function encodeByte(val) {
  return val
}

function decodeByte(val) {
  return Math.max(0, Math.min(255, Math.round(val)))
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

// Calculate payload capacity: total data blocks minus 22 header blocks
export function getPayloadCapacity(width, height) {
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / BLOCK_SIZE)
  const blocksY = Math.floor(dr.h / BLOCK_SIZE)
  const totalBlocks = blocksX * blocksY
  return Math.max(0, totalBlocks - HEADER_SIZE) // subtract header blocks
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
  const MAGIC_BYTES = [0x42, 0x45, 0x41, 0x4D]
  const TOLERANCE = 8
  for (let i = 0; i < 4; i++) {
    if (Math.abs(data[i] - MAGIC_BYTES[i]) > TOLERANCE) return null
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const mode = view.getUint8(4)
  if (mode > 4) return null
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

  // Fill data region with 4×4 blocks
  // First HEADER_SIZE blocks = header bytes, rest = payload bytes
  const dr = getDataRegion(width, height)
  const blocksX = Math.floor(dr.w / BLOCK_SIZE)
  const blocksY = Math.floor(dr.h / BLOCK_SIZE)

  let blockIdx = 0
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      // Determine byte value for this block
      let val
      if (blockIdx < HEADER_SIZE) {
        val = encodeByte(headerBytes[blockIdx])
      } else {
        const payloadIdx = blockIdx - HEADER_SIZE
        val = payloadIdx < payload.length ? encodeByte(payload[payloadIdx]) : 0
      }

      // Fill 4×4 block
      const startX = dr.x + bx * BLOCK_SIZE
      const startY = dr.y + by * BLOCK_SIZE
      for (let dy = 0; dy < BLOCK_SIZE; dy++) {
        for (let dx = 0; dx < BLOCK_SIZE; dx++) {
          const i = ((startY + dy) * width + (startX + dx)) * 4
          imageData[i] = val
          imageData[i + 1] = val
          imageData[i + 2] = val
        }
      }
      blockIdx++
    }
  }

  return imageData
}

// --- Anchor detection (receiver) ---

// Sample a block's average value at (px, py) in the image
// Returns the average R value of the center 2×2 pixels of a 4×4 block
function sampleBlock(imageData, width, px, py) {
  // Center 2×2 of the 4×4 block starting at (px, py)
  const cx = px + 1
  const cy = py + 1
  let sum = 0
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      sum += imageData[((cy + dy) * width + (cx + dx)) * 4]
    }
  }
  return sum / 4
}

// Check if an 8×8 block grid at (originX, originY) matches the anchor pattern
// threshold: value above which a block is considered "white"
function verifyAnchorAt(imageData, width, height, originX, originY, threshold = 128) {
  if (originX < 0 || originY < 0 ||
      originX + ANCHOR_SIZE > width || originY + ANCHOR_SIZE > height) {
    return false
  }

  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const px = originX + bx * BLOCK_SIZE
      const py = originY + by * BLOCK_SIZE
      const val = sampleBlock(imageData, width, px, py)
      const isWhite = val > threshold
      const expected = ANCHOR_PATTERN[by][bx] === 1
      if (isWhite !== expected) return false
    }
  }
  return true
}

// Scan the frame for anchor patterns. Returns array of {x, y} positions found.
// Scans at block-center resolution (every BLOCK_SIZE pixels) for efficiency.
export function detectAnchors(imageData, width, height) {
  const anchors = []
  const step = 2 // Scan every 2px for sub-block alignment tolerance
  // Only scan edges where anchors could be (within ANCHOR_SIZE of each edge)
  // Plus some tolerance for offset
  const scanMargin = ANCHOR_SIZE + 64 // extra 64px tolerance for window offset

  for (let y = 0; y < Math.min(scanMargin, height - ANCHOR_SIZE); y += step) {
    for (let x = 0; x < Math.min(scanMargin, width - ANCHOR_SIZE); x += step) {
      if (verifyAnchorAt(imageData, width, height, x, y)) {
        anchors.push({ x, y, corner: 'TL' })
      }
    }
  }
  for (let y = 0; y < Math.min(scanMargin, height - ANCHOR_SIZE); y += step) {
    for (let x = Math.max(0, width - scanMargin); x < width - ANCHOR_SIZE + 1; x += step) {
      if (verifyAnchorAt(imageData, width, height, x, y)) {
        anchors.push({ x, y, corner: 'TR' })
      }
    }
  }
  for (let y = Math.max(0, height - scanMargin); y < height - ANCHOR_SIZE + 1; y += step) {
    for (let x = 0; x < Math.min(scanMargin, width - ANCHOR_SIZE); x += step) {
      if (verifyAnchorAt(imageData, width, height, x, y)) {
        anchors.push({ x, y, corner: 'BL' })
      }
    }
  }
  for (let y = Math.max(0, height - scanMargin); y < height - ANCHOR_SIZE + 1; y += step) {
    for (let x = Math.max(0, width - scanMargin); x < width - ANCHOR_SIZE + 1; x += step) {
      if (verifyAnchorAt(imageData, width, height, x, y)) {
        anchors.push({ x, y, corner: 'BR' })
      }
    }
  }

  return anchors
}

// Derive data region from detected anchor positions
export function dataRegionFromAnchors(anchors) {
  if (anchors.length < 2) return null

  // Find bounding box of all anchors
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const a of anchors) {
    if (a.x < minX) minX = a.x
    if (a.y < minY) minY = a.y
    if (a.x + ANCHOR_SIZE > maxX) maxX = a.x + ANCHOR_SIZE
    if (a.y + ANCHOR_SIZE > maxY) maxY = a.y + ANCHOR_SIZE
  }

  // Data region is inside the anchors (offset by MARGIN_SIZE from anchor origins)
  return {
    x: minX + MARGIN_SIZE,
    y: minY + MARGIN_SIZE,
    w: maxX - minX - 2 * MARGIN_SIZE,
    h: maxY - minY - 2 * MARGIN_SIZE
  }
}

// --- Data region decoding (receiver) ---

// Decode data blocks from a data region. Returns { header, payload, crcValid }
export function decodeDataRegion(imageData, width, region) {
  const blocksX = Math.floor(region.w / BLOCK_SIZE)
  const blocksY = Math.floor(region.h / BLOCK_SIZE)
  const totalBlocks = blocksX * blocksY

  if (totalBlocks < HEADER_SIZE) return null

  // Read all blocks (header + payload) as bytes
  const headerBytes = new Uint8Array(HEADER_SIZE)
  let blockIdx = 0

  // Read header
  for (let by = 0; by < blocksY && blockIdx < HEADER_SIZE; by++) {
    for (let bx = 0; bx < blocksX && blockIdx < HEADER_SIZE; bx++) {
      const px = region.x + bx * BLOCK_SIZE
      const py = region.y + by * BLOCK_SIZE
      headerBytes[blockIdx] = decodeByte(sampleBlock(imageData, width, px, py))
      blockIdx++
    }
  }

  const header = parseHeader(headerBytes)
  if (!header) return null

  // Read payload blocks
  const payload = new Uint8Array(header.payloadLength)
  let payloadIdx = 0
  blockIdx = 0

  for (let by = 0; by < blocksY && payloadIdx < header.payloadLength; by++) {
    for (let bx = 0; bx < blocksX && payloadIdx < header.payloadLength; bx++) {
      if (blockIdx >= HEADER_SIZE) {
        const px = region.x + bx * BLOCK_SIZE
        const py = region.y + by * BLOCK_SIZE
        payload[payloadIdx++] = decodeByte(sampleBlock(imageData, width, px, py))
      }
      blockIdx++
    }
  }

  const actualCrc = crc32(payload)
  return {
    header,
    payload,
    crcValid: actualCrc === header.payloadCrc
  }
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

  // Verify it
  const pass = verifyAnchorAt(imageData, width, height, 0, 0)
  console.log('Anchor roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testFrameRoundtrip() {
  const payload = new Uint8Array(500)
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
  const result = decodeDataRegion(outer, outerW, region)
  const pass = result !== null && result.crcValid && result.header.symbolId === 7

  console.log('Anchor offset test:', pass ? 'PASS' : 'FAIL')
  return pass
}
