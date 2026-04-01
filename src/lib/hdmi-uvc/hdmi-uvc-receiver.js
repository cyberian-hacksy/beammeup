// HDMI-UVC Receiver module - captures from UVC device and decodes frames

import { createDecoder } from '../decoder.js'
import { parsePacket } from '../packet.js'
import { DEVICE_STORAGE_KEY, HDMI_MODE_NAMES } from './hdmi-uvc-constants.js'
import { detectAnchors, dataRegionFromAnchors, decodeDataRegion } from './hdmi-uvc-frame.js'

// Debug mode - always on while diagnosing HDMI-UVC issues
const DEBUG_MODE = true

function debugLog(text) {
  if (!DEBUG_MODE) return

  const el = document.getElementById('hdmi-uvc-receiver-debug-log')
  if (el) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    el.textContent += timestamp + ' ' + text + '\n'
    // Keep only last 500 lines
    const lines = el.textContent.split('\n')
    if (lines.length > 500) {
      el.textContent = lines.slice(-500).join('\n')
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
  completedFile: null,
  anchorBounds: null  // Cached data region from detected anchors
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
  const isDiagFrame = state.frameCount <= 5 || state.frameCount % 30 === 0

  // Diagnostic: find content bounds and probe anchor regions while scanning
  if (!state.anchorBounds && isDiagFrame) {
    const p = imageData.data

    // Find content bounds: first non-black pixel from each edge
    let contentLeft = -1, contentTop = -1, contentRight = -1, contentBottom = -1
    const midY = Math.floor(height / 2)
    for (let x = 0; x < width; x++) {
      if (p[(midY * width + x) * 4] > 10) { contentLeft = x; break }
    }
    for (let x = width - 1; x >= 0; x--) {
      if (p[(midY * width + x) * 4] > 10) { contentRight = x; break }
    }
    const midX = Math.floor(width / 2)
    for (let y = 0; y < height; y++) {
      if (p[(y * width + midX) * 4] > 10) { contentTop = y; break }
    }
    for (let y = height - 1; y >= 0; y--) {
      if (p[(y * width + midX) * 4] > 10) { contentBottom = y; break }
    }
    debugLog(`Content bounds: L=${contentLeft} T=${contentTop} R=${contentRight} B=${contentBottom} (${contentRight-contentLeft}x${contentBottom-contentTop})`)

    // Probe at content origin: first 60 R values along the content top-left
    if (contentLeft >= 0 && contentTop >= 0) {
      // Row at content top: should show anchor white border if transmitting
      const r1 = []
      for (let x = contentLeft; x < Math.min(contentLeft + 60, width); x++) {
        r1.push(p[(contentTop * width + x) * 4])
      }
      debugLog(`Content row${contentTop} R[${contentLeft}..+60]: ${r1.join(',')}`)

      // Column at content left edge going down: shows vertical structure
      const c1 = []
      for (let y = contentTop; y < Math.min(contentTop + 60, height); y++) {
        c1.push(p[(y * width + contentLeft) * 4])
      }
      debugLog(`Content col${contentLeft} R[${contentTop}..+60]: ${c1.join(',')}`)

      // Probe center of frame (should show data blocks if transmitting)
      const cx = Math.floor((contentLeft + contentRight) / 2)
      const cy = Math.floor((contentTop + contentBottom) / 2)
      const center = []
      for (let x = cx - 10; x < cx + 10; x++) {
        center.push(p[(cy * width + x) * 4])
      }
      debugLog(`Center row${cy} R[${cx-10}..${cx+10}]: ${center.join(',')}`)
    }
  }

  // === ANCHOR DETECTION ===
  let region = state.anchorBounds

  if (!region) {
    const anchors = detectAnchors(imageData.data, width, height)
    if (anchors.length >= 2) {
      region = dataRegionFromAnchors(anchors)
      state.anchorBounds = region
      debugLog(`*** ANCHORS LOCKED: ${anchors.length} found, region (${region.x},${region.y}) ${region.w}x${region.h} ***`)
    } else if (isDiagFrame) {
      debugLog(`Frame ${state.frameCount}: ${anchors.length} anchors found (need ≥2)`)
      debugCurrent(`#${state.frameCount} scanning...`)
    }
  }

  if (!region) {
    scheduleNextFrame()
    return
  }

  // === DECODE DATA REGION ===
  const result = decodeDataRegion(imageData.data, width, region)

  if (result && result.crcValid) {
    state.validFrames++
    elements.statFrames.textContent = state.validFrames + ' valid frames'

    if (!state.detectedMode) {
      state.detectedMode = result.header.mode
      state.detectedResolution = { width: result.header.width, height: result.header.height }
      elements.signalStatus.textContent = `Detected: ${result.header.width}x${result.header.height}`
      debugLog(`=== SIGNAL DETECTED ===`)
      debugLog(`Mode: ${HDMI_MODE_NAMES[result.header.mode]}, ${result.header.width}x${result.header.height}`)
    }

    const packet = result.payload
    const parsed = parsePacket(packet)

    if (parsed) {
      if (!state.decoder) {
        state.decoder = createDecoder()
        state.startTime = Date.now()
        showReceivingStatus()
        debugLog(`Decoder created`)
      }

      state.decoder.receive(packet)

      if (state.validFrames % 10 === 0) {
        debugLog(`Progress: ${Math.round(state.decoder.progress * 100)}%, sym=${parsed.symbolId}`)
      }

      debugCurrent(`#${state.validFrames} sym=${parsed.symbolId} ${Math.round((state.decoder.progress || 0) * 100)}%`)
      updateProgress()

      if (state.decoder.isComplete()) {
        debugLog(`=== TRANSFER COMPLETE ===`)
        handleComplete()
        return
      }
    }
  } else if (result && !result.crcValid) {
    if (isDiagFrame) debugLog(`Frame ${state.frameCount}: CRC fail`)
    debugCurrent(`#${state.frameCount} CRC fail`)
    // Anchor position may have drifted — clear cache to re-detect
    state.anchorBounds = null
  } else {
    if (isDiagFrame) debugLog(`Frame ${state.frameCount}: decode failed`)
    debugCurrent(`#${state.frameCount} no data`)
    state.anchorBounds = null
  }

  // Update debug canvas
  if (isDiagFrame) {
    const debugCanvas = document.getElementById('hdmi-uvc-receiver-debug-canvas')
    if (debugCanvas) {
      debugCanvas.width = Math.min(width, 640)
      debugCanvas.height = Math.min(height, 360)
      debugCanvas.getContext('2d').drawImage(state.canvas, 0, 0, debugCanvas.width, debugCanvas.height)
    }
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
  state.anchorBounds = null

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

  // Debug panel buttons
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
  const clearBtn = document.getElementById('btn-hdmi-uvc-receiver-clear-log')
  if (clearBtn) {
    clearBtn.onclick = () => {
      const log = document.getElementById('hdmi-uvc-receiver-debug-log')
      if (log) log.textContent = ''
      debugLog('=== LOG CLEARED ===')
      debugLog(`Frame count at clear: ${state.frameCount}`)
    }
  }
  debugLog('HDMI-UVC Receiver initialized')
}
