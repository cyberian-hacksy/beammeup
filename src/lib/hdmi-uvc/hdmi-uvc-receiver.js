// HDMI-UVC Receiver module - captures from UVC device and decodes frames

import { createDecoder } from '../decoder.js'
import { parsePacket } from '../packet.js'
import { DEVICE_STORAGE_KEY, HDMI_MODE_NAMES } from './hdmi-uvc-constants.js'
import { parseFrame } from './hdmi-uvc-frame.js'

// Debug mode - always on while diagnosing HDMI-UVC issues
const DEBUG_MODE = true

function debugLog(text) {
  if (!DEBUG_MODE) return

  const el = document.getElementById('hdmi-uvc-receiver-debug-log')
  if (el) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    el.textContent += timestamp + ' ' + text + '\n'
    // Keep only last 100 lines
    const lines = el.textContent.split('\n')
    if (lines.length > 100) {
      el.textContent = lines.slice(-100).join('\n')
    }
    el.scrollTop = el.scrollHeight
  }
  console.log('[HDMI-RX]', text)
}

function debugCurrent(text) {
  if (!DEBUG_MODE) return
  const el = document.getElementById('hdmi-uvc-receiver-debug-current')
  if (el) el.textContent = text
}

const state = {
  decoder: null,
  stream: null,
  canvas: null,
  ctx: null,
  animationId: null,
  callbackId: null,
  isScanning: false,
  frameCount: 0,
  validFrames: 0,
  startTime: null,
  detectedMode: null,
  detectedResolution: null,
  completedFile: null
}

// Check if requestVideoFrameCallback is available (better sync than requestAnimationFrame)
const hasVideoFrameCallback = typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype

// Check if VideoFrame API is available (direct frame access)
const hasVideoFrame = typeof VideoFrame !== 'undefined'

// Check if ImageCapture API is available (better for UVC devices)
const hasImageCapture = typeof ImageCapture !== 'undefined'

let elements = null
let imageCapture = null
let showError = (msg) => console.error(msg)

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function saveDevicePreference(deviceId) {
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, deviceId)
  } catch (e) {
    // Ignore storage errors
  }
}

function loadDevicePreference() {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY)
  } catch (e) {
    return null
  }
}

async function enumerateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const videoDevices = devices.filter(d => d.kind === 'videoinput')

  const dropdown = elements.deviceDropdown
  while (dropdown.firstChild) {
    dropdown.removeChild(dropdown.firstChild)
  }

  const savedDevice = loadDevicePreference()

  videoDevices.forEach((device, i) => {
    const option = document.createElement('option')
    option.value = device.deviceId
    option.textContent = device.label || `Camera ${i + 1}`

    if (device.label && /capture|hdmi|uvc|cam link/i.test(device.label)) {
      option.textContent += ' (Capture)'
    }

    if (device.deviceId === savedDevice) {
      option.selected = true
    }

    dropdown.appendChild(option)
  })

  return videoDevices
}

async function startCapture(deviceId) {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
  }

  try {
    debugLog(`Starting capture, deviceId: ${deviceId || '(default)'}`)

    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    }

    state.stream = await navigator.mediaDevices.getUserMedia(constraints)
    elements.video.srcObject = state.stream

    await new Promise(resolve => {
      elements.video.onloadedmetadata = resolve
    })

    // Log actual video track settings
    const track = state.stream.getVideoTracks()[0]
    if (track) {
      const settings = track.getSettings()
      debugLog(`Track: ${track.label}`)
      debugLog(`Actual: ${settings.width}x${settings.height} @ ${settings.frameRate || '?'}fps`)
    }

    // Log frame callback method
    debugLog(`Frame capture method: ${hasVideoFrameCallback ? 'requestVideoFrameCallback' : 'requestAnimationFrame'}`)

    // Set up ImageCapture if available
    if (hasImageCapture && track) {
      try {
        imageCapture = new ImageCapture(track)
        debugLog('ImageCapture API: initialized')
      } catch (e) {
        debugLog(`ImageCapture API: failed to initialize (${e.message})`)
        imageCapture = null
      }
    } else {
      debugLog('ImageCapture API: not available')
    }

    state.canvas = document.createElement('canvas')
    state.ctx = state.canvas.getContext('2d', {
      willReadFrequently: true,
      alpha: false,  // Might help with consistent color handling
      colorSpace: 'srgb'
    })

    saveDevicePreference(deviceId)

    elements.signalStatus.textContent = 'Connected - scanning...'
    elements.signalStatus.classList.add('connected')

    return true

  } catch (err) {
    console.error('Camera error:', err)
    debugLog(`ERROR: ${err.message}`)
    showError('Failed to access capture device: ' + err.message)
    return false
  }
}

function scheduleNextFrame() {
  if (!state.isScanning || !state.stream) return

  const video = elements.video

  if (hasVideoFrameCallback) {
    // Use requestVideoFrameCallback for accurate frame timing
    state.callbackId = video.requestVideoFrameCallback(processFrame)
  } else {
    // Fallback to requestAnimationFrame
    state.animationId = requestAnimationFrame(processFrame)
  }
}

async function processFrame(now, metadata) {
  if (!state.isScanning || !state.stream) return

  const video = elements.video
  if (video.videoWidth === 0) {
    scheduleNextFrame()
    return
  }

  const width = video.videoWidth
  const height = video.videoHeight
  state.canvas.width = width
  state.canvas.height = height

  let imageData
  let captureMethod = 'video'

  // Try ImageCapture API first (works best with UVC devices)
  if (imageCapture) {
    try {
      const bitmap = await imageCapture.grabFrame()
      state.ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      imageData = state.ctx.getImageData(0, 0, width, height)
      captureMethod = 'ImageCapture'
    } catch (e) {
      // Fall through to other methods
    }
  }

  // Try VideoFrame API for direct frame access
  if (!imageData && hasVideoFrame && metadata) {
    try {
      const frame = new VideoFrame(video, { timestamp: metadata.mediaTime * 1000000 || 0 })
      state.ctx.drawImage(frame, 0, 0)
      frame.close()
      imageData = state.ctx.getImageData(0, 0, width, height)
      captureMethod = 'VideoFrame'
    } catch (e) {
      // Fall through to default method
    }
  }

  // Default: draw video directly to canvas
  if (!imageData) {
    state.ctx.drawImage(video, 0, 0)
    imageData = state.ctx.getImageData(0, 0, width, height)
  }

  state.frameCount++

  // === DIAGNOSTIC LOGGING ===
  const isDiagFrame = state.frameCount <= 5 || state.frameCount % 30 === 0

  if (state.frameCount === 1) {
    debugLog(`=== RECEIVER DIAGNOSTICS ===`)
    debugLog(`Video: ${width}x${height}`)
    debugLog(`readyState=${video.readyState}, paused=${video.paused}, currentTime=${video.currentTime.toFixed(2)}`)
    debugLog(`APIs: VideoFrame=${hasVideoFrame}, ImageCapture=${hasImageCapture}, VideoFrameCallback=${hasVideoFrameCallback}`)
    debugLog(`Capture method: ${captureMethod}`)
    if (metadata) {
      debugLog(`Metadata: presentedFrames=${metadata.presentedFrames}, mediaTime=${metadata.mediaTime?.toFixed(3)}`)
    }
    // Log video track capabilities
    const track = state.stream?.getVideoTracks()[0]
    if (track) {
      const settings = track.getSettings()
      debugLog(`Track settings: ${JSON.stringify(settings)}`)
    }
  }

  if (isDiagFrame) {
    debugLog(`--- Frame ${state.frameCount} (method=${captureMethod}) ---`)

    // Show header area: first 22 pixels of row 0 as decimal R values
    const hdrPixels = []
    for (let i = 0; i < Math.min(22, width); i++) {
      hdrPixels.push(imageData.data[i * 4])  // Red channel only
    }
    debugLog(`Row0 R[0..21]: ${hdrPixels.join(',')}`)

    // Show what BEAM magic would need: pixels 0-3 should be 66,69,65,77
    const p = imageData.data
    debugLog(`Px0: R=${p[0]} G=${p[1]} B=${p[2]} A=${p[3]} (need R=66 for 'B')`)
    debugLog(`Px1: R=${p[4]} G=${p[5]} B=${p[6]} A=${p[7]} (need R=69 for 'E')`)
    debugLog(`Px2: R=${p[8]} G=${p[9]} B=${p[10]} A=${p[11]} (need R=65 for 'A')`)
    debugLog(`Px3: R=${p[12]} G=${p[13]} B=${p[14]} A=${p[15]} (need R=77 for 'M')`)

    // Show pixel value ranges across first row to understand color space
    let minR = 255, maxR = 0, sumR = 0
    const sampleWidth = Math.min(width, 200)
    for (let x = 0; x < sampleWidth; x++) {
      const r = imageData.data[x * 4]
      if (r < minR) minR = r
      if (r > maxR) maxR = r
      sumR += r
    }
    debugLog(`Row0 stats (${sampleWidth}px): min=${minR} max=${maxR} avg=${(sumR/sampleWidth).toFixed(1)}`)

    // Show first few pixels of data row 2 (where payload starts)
    const row2off = 2 * width * 4
    const row2vals = []
    for (let i = 0; i < Math.min(8, width); i++) {
      row2vals.push(`${imageData.data[row2off + i*4]}`)
    }
    debugLog(`Row2 R[0..7]: ${row2vals.join(',')}`)

    // Update debug canvas
    const debugCanvas = document.getElementById('hdmi-uvc-receiver-debug-canvas')
    if (debugCanvas) {
      debugCanvas.width = Math.min(width, 640)
      debugCanvas.height = Math.min(height, 360)
      const debugCtx = debugCanvas.getContext('2d')
      debugCtx.drawImage(state.canvas, 0, 0, debugCanvas.width, debugCanvas.height)
    }
  }

  // === FRAME PARSING ===
  let result = parseFrame(imageData.data, width, height)
  let headerRow = 0

  // If not found, scan first 100 rows for BEAM header
  if (!result && isDiagFrame) {
    let closestRow = -1
    let closestMagic = ''
    for (let row = 1; row < Math.min(100, height); row++) {
      const rowOffset = row * width * 4
      const testData = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset + rowOffset)
      const testResult = parseFrame(testData, width, height - row)
      if (testResult) {
        debugLog(`*** BEAM HEADER FOUND AT ROW ${row}! ***`)
        result = testResult
        headerRow = row
        break
      }
      // Track closest match for diagnostics
      if (closestRow === -1) {
        const r0 = imageData.data[rowOffset]
        const r1 = imageData.data[rowOffset + 4]
        // Check if first two pixels are close to 'B'(66) and 'E'(69)
        if (Math.abs(r0 - 66) < 10 && Math.abs(r1 - 69) < 10) {
          closestRow = row
          closestMagic = `R=${r0},${imageData.data[rowOffset+4]},${imageData.data[rowOffset+8]},${imageData.data[rowOffset+12]}`
        }
      }
    }
    if (!result && closestRow >= 0) {
      debugLog(`Near-miss: row ${closestRow} had ${closestMagic} (need 66,69,65,77)`)
    }
  }

  // === RESULT HANDLING ===
  if (result) {
    if (isDiagFrame) {
      debugLog(`Header found at row ${headerRow}: mode=${result.header.mode} ${result.header.width}x${result.header.height} sym=${result.header.symbolId} crc=${result.crcValid ? 'OK' : 'FAIL'}`)
    }

    if (result.crcValid) {
      state.validFrames++
      elements.statFrames.textContent = state.validFrames + ' valid frames'

      const modeName = HDMI_MODE_NAMES[result.header.mode] || result.header.mode

      if (!state.detectedMode) {
        state.detectedMode = result.header.mode
        state.detectedResolution = { width: result.header.width, height: result.header.height }
        elements.signalStatus.textContent = `Detected: ${result.header.width}x${result.header.height}`
        debugLog(`=== SIGNAL DETECTED ===`)
        debugLog(`Mode: ${modeName}, Resolution: ${result.header.width}x${result.header.height}`)
        debugLog(`FPS: ${result.header.fps}, Payload: ${result.header.payloadLength} bytes`)
      }

      const packet = result.payload
      const parsed = parsePacket(packet)

      if (parsed) {
        if (!state.decoder) {
          state.decoder = createDecoder()
          state.startTime = Date.now()
          showReceivingStatus()
          debugLog(`Decoder created, receiving...`)
        }

        state.decoder.receive(packet)

        if (state.validFrames % 10 === 0) {
          const progress = state.decoder.progress
          debugLog(`Progress: ${Math.round(progress * 100)}%, sym=${parsed.symbolId}, blocks=${state.decoder.solvedCount || 0}`)
        }

        debugCurrent(`#${state.validFrames} sym=${parsed.symbolId} ${Math.round((state.decoder.progress || 0) * 100)}%`)

        updateProgress()

        if (state.decoder.isComplete()) {
          debugLog(`=== TRANSFER COMPLETE ===`)
          handleComplete()
          return
        }
      } else {
        debugLog(`Frame ${state.frameCount}: CRC OK but packet parse failed (payloadLen=${result.header.payloadLength})`)
      }
    } else {
      if (isDiagFrame) {
        // Log CRC details to understand corruption pattern
        const { crc32: computeCrc } = await import('./crc32.js')
        const actualCrc = computeCrc(result.payload)
        debugLog(`CRC FAIL: header says ${result.header.payloadCrc?.toString(16)}, computed ${actualCrc.toString(16)}, payloadLen=${result.payload.length}`)
        // Show first 16 bytes of payload
        const payloadHead = Array.from(result.payload.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' ')
        debugLog(`Payload[0..15]: ${payloadHead}`)
      }
      debugCurrent(`#${state.frameCount} CRC fail`)
    }
  } else {
    if (isDiagFrame) {
      debugLog(`No BEAM header (row 0 pixels: ${imageData.data[0]},${imageData.data[4]},${imageData.data[8]},${imageData.data[12]} need 66,69,65,77)`)
    }
    debugCurrent(`#${state.frameCount} no signal`)
  }

  scheduleNextFrame()
}

function showReceivingStatus() {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.remove('hidden')
  elements.statusComplete.classList.add('hidden')
}

function showCompleteStatus() {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.remove('hidden')
}

function updateProgress() {
  if (!state.decoder || !state.decoder.metadata) return

  const meta = state.decoder.metadata
  const progress = state.decoder.progress

  elements.fileName.textContent = meta.filename
  elements.statProgress.textContent = Math.round(progress * 100) + '%'
  elements.progressFill.style.width = (progress * 100) + '%'

  const elapsed = (Date.now() - state.startTime) / 1000
  if (elapsed > 0) {
    const bytesReceived = progress * meta.fileSize
    const rate = bytesReceived / elapsed
    elements.statRate.textContent = formatBytes(rate) + '/s'
  }
}

async function handleComplete() {
  state.isScanning = false

  cancelNextFrame()

  const decoder = state.decoder
  const meta = decoder.metadata

  const fileData = decoder.reconstruct()

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', fileData))
  const hashMatch = hash.every((b, i) => b === meta.hash[i])

  if (!hashMatch) {
    showError('File hash mismatch - transfer may be corrupted')
  }

  const elapsed = (Date.now() - state.startTime) / 1000
  const rate = fileData.byteLength / elapsed

  state.completedFile = {
    data: fileData,
    name: meta.filename,
    type: meta.mimeType || 'application/octet-stream'
  }

  elements.completeName.textContent = meta.filename + ' (' + formatBytes(fileData.byteLength) + ')'
  elements.completeRate.textContent = formatBytes(rate) + '/s'

  showCompleteStatus()
}

function downloadFile() {
  if (!state.completedFile) return

  const blob = new Blob([state.completedFile.data], { type: state.completedFile.type })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = state.completedFile.name
  a.click()

  URL.revokeObjectURL(url)
}

function cancelNextFrame() {
  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }
  if (state.callbackId && hasVideoFrameCallback && elements.video) {
    elements.video.cancelVideoFrameCallback(state.callbackId)
    state.callbackId = null
  }
}

function resetReceiver() {
  state.isScanning = false

  cancelNextFrame()

  state.decoder = null
  state.frameCount = 0
  state.validFrames = 0
  state.startTime = null
  state.detectedMode = null
  state.detectedResolution = null
  state.completedFile = null

  elements.statFrames.textContent = '0 frames'
  elements.statusScanning.classList.remove('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.add('hidden')
  elements.progressFill.style.width = '0'

  if (state.stream) {
    elements.signalStatus.textContent = 'Connected - scanning...'
  }
}

function startScanning() {
  state.isScanning = true
  scheduleNextFrame()
}

async function handleDeviceChange() {
  const deviceId = elements.deviceDropdown.value
  resetReceiver()

  if (await startCapture(deviceId)) {
    startScanning()
  }
}

function handleReceiveAnother() {
  resetReceiver()
  startScanning()
}

export async function autoStartHdmiUvcReceiver() {
  await enumerateDevices()

  const savedDevice = loadDevicePreference()
  const deviceId = savedDevice || elements.deviceDropdown.value

  if (await startCapture(deviceId)) {
    startScanning()
  }
}

export function resetHdmiUvcReceiver() {
  resetReceiver()

  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
    state.stream = null
  }

  imageCapture = null

  elements.signalStatus.textContent = 'Waiting for signal...'
  elements.signalStatus.classList.remove('connected')
}

export function initHdmiUvcReceiver(errorHandler) {
  showError = errorHandler

  elements = {
    video: document.getElementById('hdmi-uvc-video'),
    signalStatus: document.getElementById('hdmi-uvc-signal-status'),
    deviceDropdown: document.getElementById('hdmi-uvc-device-dropdown'),
    statusScanning: document.getElementById('hdmi-uvc-status-scanning'),
    statusReceiving: document.getElementById('hdmi-uvc-status-receiving'),
    statusComplete: document.getElementById('hdmi-uvc-status-complete'),
    statFrames: document.getElementById('hdmi-uvc-stat-frames'),
    fileName: document.getElementById('hdmi-uvc-file-name'),
    statProgress: document.getElementById('hdmi-uvc-stat-progress'),
    statRate: document.getElementById('hdmi-uvc-stat-rate'),
    progressFill: document.getElementById('hdmi-uvc-progress-fill'),
    completeName: document.getElementById('hdmi-uvc-complete-name'),
    completeRate: document.getElementById('hdmi-uvc-complete-rate'),
    btnReset: document.getElementById('btn-hdmi-uvc-reset'),
    btnDownload: document.getElementById('btn-hdmi-uvc-download'),
    btnAnother: document.getElementById('btn-hdmi-uvc-another')
  }

  elements.deviceDropdown.onchange = handleDeviceChange
  elements.btnReset.onclick = () => {
    resetReceiver()
    startScanning()
  }
  elements.btnDownload.onclick = downloadFile
  elements.btnAnother.onclick = handleReceiveAnother

  // Debug panel copy button
  const copyBtn = document.getElementById('btn-hdmi-uvc-receiver-copy-log')
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const log = document.getElementById('hdmi-uvc-receiver-debug-log')
      if (log) {
        try {
          await navigator.clipboard.writeText(log.textContent)
          copyBtn.textContent = 'Copied!'
          setTimeout(() => copyBtn.textContent = 'Copy Log', 1500)
        } catch (e) {
          console.error('Copy failed:', e)
        }
      }
    }
  }
  debugLog('HDMI-UVC Receiver initialized')
}
