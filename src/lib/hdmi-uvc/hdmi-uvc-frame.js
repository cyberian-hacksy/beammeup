// HDMI-UVC frame encoding/decoding utilities

import { FRAME_MAGIC, HEADER_SIZE, HDMI_MODE, BLOCK_SIZES } from './hdmi-uvc-constants.js'
import { crc32 } from './crc32.js'

// Safe value range to avoid HDMI color crushing
// Some HDMI pipelines aggressively crush values below ~100
// Using restricted mid-range to ensure values survive
const SAFE_MIN = 100
const SAFE_MAX = 200
const SAFE_RANGE = SAFE_MAX - SAFE_MIN // 100

// Encode byte (0-255) to safe HDMI range (16-240)
function encodeByte(val) {
  return Math.round(SAFE_MIN + (val / 255) * SAFE_RANGE)
}

// Decode safe HDMI range (16-240) back to byte (0-255)
function decodeByte(val) {
  // Clamp to safe range first
  const clamped = Math.max(SAFE_MIN, Math.min(SAFE_MAX, val))
  return Math.round(((clamped - SAFE_MIN) / SAFE_RANGE) * 255)
}

// Build frame header (22 bytes)
export function buildHeader(mode, width, height, fps, symbolId, payloadLength, payloadCrc) {
  const header = new ArrayBuffer(HEADER_SIZE)
  const view = new DataView(header)

  view.setUint32(0, FRAME_MAGIC, false)      // Magic
  view.setUint8(4, mode)                      // Mode
  view.setUint16(5, width, false)             // Width
  view.setUint16(7, height, false)            // Height
  view.setUint8(9, fps)                       // FPS
  view.setUint32(10, symbolId, false)         // Symbol ID
  view.setUint32(14, payloadLength, false)    // Payload length
  view.setUint32(18, payloadCrc, false)       // Payload CRC32

  return new Uint8Array(header)
}

// Parse frame header from bytes
export function parseHeader(data) {
  if (data.length < HEADER_SIZE) return null

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const magic = view.getUint32(0, false)

  if (magic !== FRAME_MAGIC) return null

  return {
    magic,
    mode: view.getUint8(4),
    width: view.getUint16(5, false),
    height: view.getUint16(7, false),
    fps: view.getUint8(9),
    symbolId: view.getUint32(10, false),
    payloadLength: view.getUint32(14, false),
    payloadCrc: view.getUint32(18, false)
  }
}

// Calculate payload capacity for given resolution and mode
export function getPayloadCapacity(width, height, mode) {
  const headerRows = 2
  const dataRows = height - headerRows
  const dataPixels = width * dataRows

  switch (mode) {
    case HDMI_MODE.RAW_RGB:
      return dataPixels * 3
    case HDMI_MODE.RAW_GRAY:
      return dataPixels
    case HDMI_MODE.COMPAT_4:
    case HDMI_MODE.COMPAT_8:
    case HDMI_MODE.COMPAT_16:
      const blockSize = BLOCK_SIZES[mode]
      const blocksX = Math.floor(width / blockSize)
      const blocksY = Math.floor(dataRows / blockSize)
      return blocksX * blocksY
    default:
      return 0
  }
}

// Encode payload to grayscale pixels (1 byte per pixel)
export function encodePayloadGray(payload, width, height) {
  const headerRows = 2
  const dataRows = height - headerRows
  const dataPixels = width * dataRows

  // Create RGBA image data (4 bytes per pixel for canvas)
  const imageData = new Uint8ClampedArray(width * height * 4)

  // Fill header rows with recognizable pattern (alternating dark/light in safe range)
  for (let y = 0; y < headerRows; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const val = ((x + y) % 2) === 0 ? SAFE_MIN : SAFE_MAX
      imageData[i] = val     // R
      imageData[i + 1] = val // G
      imageData[i + 2] = val // B
      imageData[i + 3] = 255 // A
    }
  }

  // Encode data rows (map to safe range)
  for (let p = 0; p < Math.min(payload.length, dataPixels); p++) {
    const x = p % width
    const y = headerRows + Math.floor(p / width)
    const i = (y * width + x) * 4
    const val = encodeByte(payload[p])
    imageData[i] = val     // R
    imageData[i + 1] = val // G
    imageData[i + 2] = val // B
    imageData[i + 3] = 255 // A
  }

  // Fill remaining pixels with safe minimum (encoded 0)
  for (let p = payload.length; p < dataPixels; p++) {
    const x = p % width
    const y = headerRows + Math.floor(p / width)
    const i = (y * width + x) * 4
    imageData[i] = SAFE_MIN
    imageData[i + 1] = SAFE_MIN
    imageData[i + 2] = SAFE_MIN
    imageData[i + 3] = 255
  }

  return imageData
}

// Decode grayscale pixels to payload
export function decodePayloadGray(imageData, width, height, expectedLength) {
  const headerRows = 2
  const payload = new Uint8Array(expectedLength)

  for (let p = 0; p < expectedLength; p++) {
    const x = p % width
    const y = headerRows + Math.floor(p / width)
    const i = (y * width + x) * 4
    // Use red channel (all RGB should be same in grayscale), decode from safe range
    payload[p] = decodeByte(imageData[i])
  }

  return payload
}

// Encode payload to RGB pixels (3 bytes per pixel)
export function encodePayloadRGB(payload, width, height) {
  const headerRows = 2
  const dataRows = height - headerRows
  const dataPixels = width * dataRows
  const capacity = dataPixels * 3

  const imageData = new Uint8ClampedArray(width * height * 4)

  // Fill header rows with pattern (alternating in safe range)
  for (let y = 0; y < headerRows; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const val = ((x + y) % 2) === 0 ? SAFE_MIN : SAFE_MAX
      imageData[i] = val
      imageData[i + 1] = val
      imageData[i + 2] = val
      imageData[i + 3] = 255
    }
  }

  // Encode data rows (3 payload bytes per pixel in R, G, B, mapped to safe range)
  let payloadIdx = 0
  for (let y = headerRows; y < height && payloadIdx < payload.length; y++) {
    for (let x = 0; x < width && payloadIdx < payload.length; x++) {
      const i = (y * width + x) * 4
      imageData[i] = payloadIdx < payload.length ? encodeByte(payload[payloadIdx++]) : SAFE_MIN     // R
      imageData[i + 1] = payloadIdx < payload.length ? encodeByte(payload[payloadIdx++]) : SAFE_MIN // G
      imageData[i + 2] = payloadIdx < payload.length ? encodeByte(payload[payloadIdx++]) : SAFE_MIN // B
      imageData[i + 3] = 255
    }
  }

  return imageData
}

// Decode RGB pixels to payload
export function decodePayloadRGB(imageData, width, height, expectedLength) {
  const headerRows = 2
  const payload = new Uint8Array(expectedLength)

  let payloadIdx = 0
  for (let y = headerRows; y < height && payloadIdx < expectedLength; y++) {
    for (let x = 0; x < width && payloadIdx < expectedLength; x++) {
      const i = (y * width + x) * 4
      if (payloadIdx < expectedLength) payload[payloadIdx++] = decodeByte(imageData[i])     // R
      if (payloadIdx < expectedLength) payload[payloadIdx++] = decodeByte(imageData[i + 1]) // G
      if (payloadIdx < expectedLength) payload[payloadIdx++] = decodeByte(imageData[i + 2]) // B
    }
  }

  return payload
}

// Test header roundtrip
export function testHeaderRoundtrip() {
  const header = buildHeader(
    HDMI_MODE.RAW_GRAY,
    1920, 1080,
    30,
    42,
    1000000,
    0xDEADBEEF
  )

  const parsed = parseHeader(header)
  const pass = parsed !== null &&
    parsed.magic === FRAME_MAGIC &&
    parsed.mode === HDMI_MODE.RAW_GRAY &&
    parsed.width === 1920 &&
    parsed.height === 1080 &&
    parsed.fps === 30 &&
    parsed.symbolId === 42 &&
    parsed.payloadLength === 1000000 &&
    parsed.payloadCrc === 0xDEADBEEF

  console.log('Header roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

// Test raw grayscale encoding roundtrip
export function testPayloadGrayRoundtrip() {
  const payload = new Uint8Array(1000)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256

  const width = 100
  const height = 20

  const encoded = encodePayloadGray(payload, width, height)
  const decoded = decodePayloadGray(encoded, width, height, payload.length)

  let pass = true
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== decoded[i]) {
      pass = false
      break
    }
  }

  console.log('Payload Gray roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

// Test raw RGB encoding roundtrip
export function testPayloadRGBRoundtrip() {
  const payload = new Uint8Array(3000)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256

  const width = 100
  const height = 20

  const encoded = encodePayloadRGB(payload, width, height)
  const decoded = decodePayloadRGB(encoded, width, height, payload.length)

  let pass = true
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== decoded[i]) {
      pass = false
      break
    }
  }

  console.log('Payload RGB roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

// Encode payload using super-pixels (NxN block per byte)
export function encodePayloadCompat(payload, width, height, blockSize) {
  const headerRows = 2
  const dataRows = height - headerRows
  const blocksX = Math.floor(width / blockSize)
  const blocksY = Math.floor(dataRows / blockSize)

  const imageData = new Uint8ClampedArray(width * height * 4)

  // Fill entire image with black first
  for (let i = 0; i < imageData.length; i += 4) {
    imageData[i] = 0
    imageData[i + 1] = 0
    imageData[i + 2] = 0
    imageData[i + 3] = 255
  }

  // Fill header rows with pattern (alternating in safe range)
  for (let y = 0; y < headerRows; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const val = ((x + y) % 2) === 0 ? SAFE_MIN : SAFE_MAX
      imageData[i] = val
      imageData[i + 1] = val
      imageData[i + 2] = val
    }
  }

  // Encode data as super-pixels (map to safe range)
  let payloadIdx = 0
  for (let by = 0; by < blocksY && payloadIdx < payload.length; by++) {
    for (let bx = 0; bx < blocksX && payloadIdx < payload.length; bx++) {
      const val = encodeByte(payload[payloadIdx++])

      // Fill entire block with this value
      const startY = headerRows + by * blockSize
      const startX = bx * blockSize

      for (let dy = 0; dy < blockSize; dy++) {
        for (let dx = 0; dx < blockSize; dx++) {
          const y = startY + dy
          const x = startX + dx
          const i = (y * width + x) * 4
          imageData[i] = val
          imageData[i + 1] = val
          imageData[i + 2] = val
        }
      }
    }
  }

  return imageData
}

// Decode super-pixels to payload using majority voting
export function decodePayloadCompat(imageData, width, height, blockSize, expectedLength) {
  const headerRows = 2
  const dataRows = height - headerRows
  const blocksX = Math.floor(width / blockSize)
  const blocksY = Math.floor(dataRows / blockSize)

  const payload = new Uint8Array(expectedLength)

  let payloadIdx = 0
  for (let by = 0; by < blocksY && payloadIdx < expectedLength; by++) {
    for (let bx = 0; bx < blocksX && payloadIdx < expectedLength; bx++) {
      // Sample center pixels for majority voting (more reliable)
      const startY = headerRows + by * blockSize
      const startX = bx * blockSize
      const centerOffset = Math.floor(blockSize / 4)
      const sampleSize = Math.floor(blockSize / 2)

      let sum = 0
      let count = 0

      for (let dy = centerOffset; dy < centerOffset + sampleSize; dy++) {
        for (let dx = centerOffset; dx < centerOffset + sampleSize; dx++) {
          const y = startY + dy
          const x = startX + dx
          const i = (y * width + x) * 4
          sum += imageData[i] // Use red channel
          count++
        }
      }

      payload[payloadIdx++] = decodeByte(Math.round(sum / count))
    }
  }

  return payload
}

// Test compatible mode encoding roundtrip
export function testPayloadCompatRoundtrip() {
  const payload = new Uint8Array(100)
  for (let i = 0; i < payload.length; i++) payload[i] = i * 2

  const width = 128
  const height = 72
  const blockSize = 8

  const encoded = encodePayloadCompat(payload, width, height, blockSize)
  const decoded = decodePayloadCompat(encoded, width, height, blockSize, payload.length)

  let pass = true
  for (let i = 0; i < payload.length; i++) {
    if (payload[i] !== decoded[i]) {
      pass = false
      console.log('Mismatch at', i, ':', payload[i], '!=', decoded[i])
      break
    }
  }

  console.log('Payload Compat roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}

// Build complete frame with header embedded in pixels
export function buildFrame(payload, mode, width, height, fps, symbolId) {
  const payloadCrc = crc32(payload)
  const header = buildHeader(mode, width, height, fps, symbolId, payload.length, payloadCrc)

  let imageData
  switch (mode) {
    case HDMI_MODE.RAW_RGB:
      imageData = encodePayloadRGB(payload, width, height)
      break
    case HDMI_MODE.RAW_GRAY:
      imageData = encodePayloadGray(payload, width, height)
      break
    case HDMI_MODE.COMPAT_4:
      imageData = encodePayloadCompat(payload, width, height, 4)
      break
    case HDMI_MODE.COMPAT_8:
      imageData = encodePayloadCompat(payload, width, height, 8)
      break
    case HDMI_MODE.COMPAT_16:
      imageData = encodePayloadCompat(payload, width, height, 16)
      break
    default:
      throw new Error('Unknown mode: ' + mode)
  }

  // Embed header in first row (encoded to safe range)
  for (let i = 0; i < HEADER_SIZE; i++) {
    const pixelIdx = i * 4
    const encoded = encodeByte(header[i])
    imageData[pixelIdx] = encoded     // R
    imageData[pixelIdx + 1] = encoded // G
    imageData[pixelIdx + 2] = encoded // B
  }

  return imageData
}

// Parse frame: extract header and payload
export function parseFrame(imageData, width, height) {
  // Extract header from first row (decode from safe range)
  const headerBytes = new Uint8Array(HEADER_SIZE)
  for (let i = 0; i < HEADER_SIZE; i++) {
    headerBytes[i] = decodeByte(imageData[i * 4]) // Red channel, decoded
  }

  const header = parseHeader(headerBytes)
  if (!header) return null

  // Decode payload based on mode
  let payload
  switch (header.mode) {
    case HDMI_MODE.RAW_RGB:
      payload = decodePayloadRGB(imageData, width, height, header.payloadLength)
      break
    case HDMI_MODE.RAW_GRAY:
      payload = decodePayloadGray(imageData, width, height, header.payloadLength)
      break
    case HDMI_MODE.COMPAT_4:
      payload = decodePayloadCompat(imageData, width, height, 4, header.payloadLength)
      break
    case HDMI_MODE.COMPAT_8:
      payload = decodePayloadCompat(imageData, width, height, 8, header.payloadLength)
      break
    case HDMI_MODE.COMPAT_16:
      payload = decodePayloadCompat(imageData, width, height, 16, header.payloadLength)
      break
    default:
      return null
  }

  // Verify CRC
  const actualCrc = crc32(payload)
  if (actualCrc !== header.payloadCrc) {
    console.warn('CRC mismatch:', header.payloadCrc, '!=', actualCrc)
    return { header, payload, crcValid: false }
  }

  return { header, payload, crcValid: true }
}

// Test complete frame roundtrip
export function testFrameRoundtrip() {
  const payload = new Uint8Array(500)
  for (let i = 0; i < payload.length; i++) payload[i] = i % 256

  const width = 640
  const height = 480

  const frame = buildFrame(payload, HDMI_MODE.RAW_GRAY, width, height, 30, 42)
  const parsed = parseFrame(frame, width, height)

  const pass = parsed !== null &&
    parsed.crcValid &&
    parsed.header.symbolId === 42 &&
    parsed.payload.length === payload.length

  console.log('Frame roundtrip test:', pass ? 'PASS' : 'FAIL')
  return pass
}
