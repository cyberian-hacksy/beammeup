// Receiver module - handles camera scanning and QR decoding
import jsQR from 'jsqr'
import { createDecoder } from './decoder.js'
import { QR_MODE, MODE_MARGINS, PATCH_SIZE, PATCH_GAP } from './constants.js'
import { calibrateFromFinders, normalizeRgb } from './calibration.js'

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
  smoothBlack: null        // Smoothed black reference [r,g,b]
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
let logEntryCount = 0

function debugStatus(text) {
  const el = document.getElementById('debug-current')
  if (el) el.textContent = text
}

function debugLog(text) {
  // Only log if state changed significantly
  if (text === lastLoggedState) return
  lastLoggedState = text

  const el = document.getElementById('debug-log')
  if (el) {
    logEntryCount++
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    el.textContent += timestamp + ' ' + text + '\n'
    // Keep only last 50 lines
    const lines = el.textContent.split('\n')
    if (lines.length > 50) {
      el.textContent = lines.slice(-50).join('\n')
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

// Threshold for PCCC channel classification
const CMY_THRESHOLD = 0.5

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

// Get patch position in image based on QR bounds (matches experiment approach)
// Uses fixed pixel values from sender, scaled relative to observed QR size
function getPatchPositionInImage(corner, offset, qrBounds) {
  const { qrLeft, qrTop, qrWidth, qrHeight } = qrBounds

  // Reference QR size for scaling (sender typically renders QR at ~320px when canvasSize=440)
  const REFERENCE_QR_SIZE = 320

  // Scale sender's fixed pixel values to image coordinates
  const estimatedMargin = qrWidth * (MODE_MARGINS[QR_MODE.PALETTE] / REFERENCE_QR_SIZE)
  const patchSizeImg = qrWidth * (PATCH_SIZE / REFERENCE_QR_SIZE)
  const gapImg = qrWidth * (PATCH_GAP / REFERENCE_QR_SIZE)

  let x, y
  switch (corner) {
    case 'TL':
      x = qrLeft - estimatedMargin + gapImg + offset * (patchSizeImg + gapImg) + patchSizeImg / 2
      y = qrTop - estimatedMargin + gapImg + patchSizeImg / 2
      break
    case 'TR':
      x = qrLeft + qrWidth + estimatedMargin - gapImg - patchSizeImg / 2 - offset * (patchSizeImg + gapImg)
      y = qrTop - estimatedMargin + gapImg + patchSizeImg / 2
      break
    case 'BL':
      x = qrLeft - estimatedMargin + gapImg + offset * (patchSizeImg + gapImg) + patchSizeImg / 2
      y = qrTop + qrHeight + estimatedMargin - gapImg - patchSizeImg / 2
      break
    case 'BR':
      x = qrLeft + qrWidth + estimatedMargin - gapImg - patchSizeImg / 2 - offset * (patchSizeImg + gapImg)
      y = qrTop + qrHeight + estimatedMargin - gapImg - patchSizeImg / 2
      break
  }

  return { x, y }
}

// Sample calibration patches for Palette mode
function samplePatchCalibration(pixels, imageSize, qrBounds) {
  const palette = new Array(8).fill(null)
  let successCount = 0

  for (const patch of PALETTE_PATCH_CONFIG) {
    const pos = getPatchPositionInImage(patch.corner, patch.offset, qrBounds)

    if (pos.x >= 0 && pos.x < imageSize && pos.y >= 0 && pos.y < imageSize) {
      const color = sampleColor(pixels, imageSize, pos.x, pos.y)
      if (color) {
        palette[patch.paletteIndex] = color
        successCount++
      }
    }
  }

  // Require at least 6 patches for patch-based calibration
  if (successCount >= 6) {
    for (let i = 0; i < 8; i++) {
      if (!palette[i]) {
        palette[i] = PALETTE_RGB[i]
      }
    }
    return palette
  }

  return null
}

// Classify CMY color for PCCC mode
function classifyCMY(r, g, b, white, black) {
  const [normR, normG, normB] = normalizeRgb(r, g, b, white, black, true)
  return [
    normR < CMY_THRESHOLD ? 1 : 0,
    normG < CMY_THRESHOLD ? 1 : 0,
    normB < CMY_THRESHOLD ? 1 : 0
  ]
}

// Classify RGB palette color for Palette mode
// sampledPalette = actual sampled colors [0-255] from camera
// If null, use calibration to normalize then compare to ideal palette
function classifyPalette(r, g, b, sampledPalette, calibration) {
  let minDist = Infinity
  let minIndex = 0

  if (sampledPalette) {
    // HCC2D mode: compare directly against sampled palette colors
    for (let i = 0; i < sampledPalette.length; i++) {
      const [pr, pg, pb] = sampledPalette[i]
      const dist = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
      if (dist < minDist) {
        minDist = dist
        minIndex = i
      }
    }
  } else {
    // Fallback: normalize against white/black, compare to ideal palette
    const [normR, normG, normB] = normalizeRgb(r, g, b, calibration.white, calibration.black, true)
    // Ideal palette in [0-1] space
    const idealPalette = [
      [1, 1, 1],   // 0: White
      [1, 1, 0],   // 1: Yellow
      [1, 0, 1],   // 2: Magenta
      [1, 0, 0],   // 3: Red
      [0, 1, 1],   // 4: Cyan
      [0, 1, 0],   // 5: Green
      [0, 0, 1],   // 6: Blue
      [0, 0, 0]    // 7: Black
    ]
    for (let i = 0; i < idealPalette.length; i++) {
      const [pr, pg, pb] = idealPalette[i]
      const dist = (normR - pr) ** 2 + (normG - pg) ** 2 + (normB - pb) ** 2
      if (dist < minDist) {
        minDist = dist
        minIndex = i
      }
    }
  }

  // Extract RGB bits from palette index
  return [
    (minIndex >> 2) & 1,
    (minIndex >> 1) & 1,
    minIndex & 1
  ]
}

// Extract color channels from image and decode
function extractColorChannels(imageData, qrBounds, mode, calibration, sampledPalette) {
  const { qrLeft, qrTop, qrWidth, qrHeight } = qrBounds
  const size = imageData.width
  const pixels = imageData.data

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

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const idx = (py * size + px) * 4
      const r = pixels[idx]
      const g = pixels[idx + 1]
      const b = pixels[idx + 2]

      let bits
      if (px >= qrLeft && px < qrLeft + qrWidth && py >= qrTop && py < qrTop + qrHeight) {
        if (mode === QR_MODE.PCCC) {
          bits = classifyCMY(r, g, b, calibration.white, calibration.black)
        } else {
          // For PALETTE mode: use sampled palette if available, else use calibration for normalization
          bits = classifyPalette(r, g, b, sampledPalette, calibration)
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
      // Color mode: require grayscale QR detection like experiments
      // Finder patterns are preserved as B/W, so jsQR can locate even color frames
      // If detection fails, skip this frame and wait for next

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

      const qrLeft = Math.min(loc.topLeftCorner.x, loc.bottomLeftCorner.x)
      const qrRight = Math.max(loc.topRightCorner.x, loc.bottomRightCorner.x)
      const qrTop = Math.min(loc.topLeftCorner.y, loc.topRightCorner.y)
      const qrBottom = Math.max(loc.bottomLeftCorner.y, loc.bottomRightCorner.y)
      const qrBounds = {
        qrLeft,
        qrTop,
        qrWidth: qrRight - qrLeft,
        qrHeight: qrBottom - qrTop
      }

      // Get calibration from detected position
      let calibration = calibrateFromFinders(loc, imageData)
      let sampledPalette = null

      if (effectiveMode === QR_MODE.PALETTE) {
        sampledPalette = samplePatchCalibration(imageData.data, size, qrBounds)
        if (sampledPalette) {
          calibration = { white: sampledPalette[0], black: sampledPalette[7] }
        }
      }

      // Fallback calibration if needed
      if (!calibration) {
        calibration = { white: [255, 255, 255], black: [0, 0, 0] }
      }

      // Sanity check: white must be brighter than black
      // If inverted (common with finder pattern sampling issues), swap them
      let wSum = calibration.white[0] + calibration.white[1] + calibration.white[2]
      let bSum = calibration.black[0] + calibration.black[1] + calibration.black[2]
      let swapped = false
      if (wSum < bSum) {
        // Swap white and black
        const temp = calibration.white
        calibration.white = calibration.black
        calibration.black = temp
        const tempSum = wSum
        wSum = bSum
        bSum = tempSum
        swapped = true
      }

      // Apply temporal smoothing to calibration (exponential moving average)
      // This stabilizes the calibration across frames
      const alpha = 0.3  // Smoothing factor: 0.3 = 30% new, 70% old
      if (state.smoothWhite === null) {
        // First frame - initialize
        state.smoothWhite = [...calibration.white]
        state.smoothBlack = [...calibration.black]
      } else {
        // Blend with previous values
        for (let i = 0; i < 3; i++) {
          state.smoothWhite[i] = Math.round(alpha * calibration.white[i] + (1 - alpha) * state.smoothWhite[i])
          state.smoothBlack[i] = Math.round(alpha * calibration.black[i] + (1 - alpha) * state.smoothBlack[i])
        }
      }
      // Use smoothed calibration
      calibration.white = state.smoothWhite
      calibration.black = state.smoothBlack
      wSum = calibration.white[0] + calibration.white[1] + calibration.white[2]
      bSum = calibration.black[0] + calibration.black[1] + calibration.black[2]

      // Show calibration info
      const modeName = effectiveMode === QR_MODE.PCCC ? 'CMY' : 'RGB'
      const calibType = (sampledPalette ? 'P' : 'F') + (swapped ? '!' : '')  // ! = was swapped

      try {
        // Extract color channels using bounds and calibration
        const channels = extractColorChannels(imageData, qrBounds, effectiveMode, calibration, sampledPalette)

        // Decode each channel
        const channelResults = [
          jsQR(channels.ch0, channels.size, channels.size),
          jsQR(channels.ch1, channels.size, channels.size),
          jsQR(channels.ch2, channels.size, channels.size)
        ]

        // Debug: show on-screen (visible on mobile)
        // Format: MODE CALIB_TYPE ch0ch1ch2 WHITE BLACK RATE
        const decoded = channelResults.map(r => r ? 1 : 0)
        let acceptedCount = 0

        // Process any successful channel decodes
        const symIds = []  // Track symbol IDs from each channel
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
                symIds.push(symId >>> 0)  // Convert to unsigned
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

        // Show status with symbol IDs decoded
        const symCount = state.decoder.uniqueSymbols || 0
        const symIdStr = symIds.length > 0 ? symIds.join('/') : '-'
        const statusText = modeName + ' ' + calibType + ' ' + decoded.join('') + ' [' + symIdStr + '] +' + acceptedCount + ' #' + symCount + ' ' + rate + '%'
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
    debugLine: document.getElementById('debug-line')
  }

  // Bind event handlers
  elements.btnCameraSwitch.onclick = toggleMobileCamera
  elements.cameraDropdown.onchange = (e) => switchCamera(e.target.value)
  elements.btnDownload.onclick = downloadFile
  elements.btnReceiveAnother.onclick = restartReceiver
  elements.btnResetReceiver.onclick = restartReceiver

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
