// Receiver module - handles camera scanning and QR decoding
import jsQR from 'jsqr'
import { BLOCK_SIZE } from './constants.js'
import { createDecoder } from './decoder.js'

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
  startTime: null
}

// DOM elements (initialized on setup)
let elements = null

// Error display (will be connected to global error banner)
let showError = (msg) => console.error(msg)

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

// Enumerate available cameras
export async function enumerateCameras() {
  try {
    // Request permission first (needed to get labels)
    const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
    tempStream.getTracks().forEach(t => t.stop())

    const devices = await navigator.mediaDevices.enumerateDevices()
    let cameras = devices.filter(d => d.kind === 'videoinput')

    // Detect mobile (iOS/Android)
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent)

    // Clear dropdown using safe DOM method
    while (elements.cameraDropdown.firstChild) {
      elements.cameraDropdown.removeChild(elements.cameraDropdown.firstChild)
    }

    if (isMobile) {
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

      cameras.forEach(cam => {
        const option = document.createElement('option')
        option.value = cam.deviceId
        option.textContent = cam.label.toLowerCase().includes('front')
          ? 'Front Camera'
          : 'Back Camera'
        elements.cameraDropdown.appendChild(option)
      })
    } else {
      // On desktop: show all cameras
      cameras.forEach((cam, i) => {
        const option = document.createElement('option')
        option.value = cam.deviceId
        option.textContent = cam.label || ('Camera ' + (i + 1))
        elements.cameraDropdown.appendChild(option)
      })
    }

    if (cameras.length === 0) {
      showError('No camera found on this device.')
    }
  } catch (err) {
    console.error('Camera enumeration error:', err)
    if (err.name === 'NotAllowedError') {
      showError('Camera access denied. Please allow permissions.')
    }
  }
}

// Start scanning
async function startScanning() {
  const deviceId = elements.cameraDropdown.value
  if (!deviceId) {
    showError('Please select a camera.')
    return
  }

  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, facingMode: 'environment' }
    })

    elements.video.srcObject = state.stream
    await elements.video.play()

    // Create offscreen canvas for scanning
    state.canvas = document.createElement('canvas')
    state.ctx = state.canvas.getContext('2d', { willReadFrequently: true })

    // Reset decoder
    state.decoder = createDecoder()
    state.symbolTimes = []
    state.reconstructedBlob = null
    state.startTime = Date.now()
    state.isScanning = true

    elements.btnStartScan.disabled = true
    elements.btnStopScan.disabled = false
    elements.btnDownload.disabled = true
    elements.receiveStatus.textContent = 'Scanning...'

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
  elements.btnStartScan.disabled = false
  elements.btnStopScan.disabled = true
  elements.qrOverlay.style.display = 'none'

  if (!state.decoder || !state.decoder.isComplete()) {
    elements.receiveStatus.textContent = 'Stopped'
  }
}

// Scan a single frame
function scanFrame() {
  if (!state.isScanning) return

  const video = elements.video
  const canvas = state.canvas
  const ctx = state.ctx

  if (video.readyState === video.HAVE_ENOUGH_DATA) {
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0)

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    const result = jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'dontInvert' })

    if (result) {
      // Show QR detection overlay
      showQROverlay(result.location, video)

      // Decode Base64 and feed to decoder
      try {
        const binary = atob(result.data)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i)
        }

        const accepted = state.decoder.receive(bytes)
        if (accepted) {
          const now = Date.now()
          state.symbolTimes.push(now)
          // Keep only last 5 seconds of times
          state.symbolTimes = state.symbolTimes.filter(t => now - t < 5000)
        }

        updateReceiverStats()

        if (state.decoder.isComplete()) {
          onReceiveComplete()
          return
        }
      } catch (err) {
        console.log('QR decode error:', err.message)
      }
    } else {
      elements.qrOverlay.style.display = 'none'
    }
  }

  state.animationId = requestAnimationFrame(scanFrame)
}

// Show overlay around detected QR code
function showQROverlay(location, video) {
  const svg = elements.qrOverlay
  const polygon = elements.qrPolygon

  // Account for video position within container
  const videoRect = video.getBoundingClientRect()
  const containerRect = video.parentElement.getBoundingClientRect()
  const offsetX = videoRect.left - containerRect.left
  const offsetY = videoRect.top - containerRect.top

  // Calculate scale
  const scaleX = video.offsetWidth / video.videoWidth
  const scaleY = video.offsetHeight / video.videoHeight

  // Build polygon points from all 4 corners
  const points = [
    location.topLeftCorner,
    location.topRightCorner,
    location.bottomRightCorner,
    location.bottomLeftCorner
  ].map(p =>
    `${p.x * scaleX + offsetX},${p.y * scaleY + offsetY}`
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
  const progress = k > 0 ? (solved / k * 100) : 0

  elements.progressFill.style.width = progress + '%'
  elements.progressText.textContent = Math.round(progress) + '%'
  elements.statBlocks.textContent = solved + '/' + k
  elements.statSymbols.textContent = decoder.uniqueSymbols || 0

  if (decoder.metadata) {
    elements.fileNameDisplay.textContent =
      decoder.metadata.filename + ' (' + formatBytes(decoder.metadata.fileSize) + ')'
  }

  // Calculate elapsed time
  const now = Date.now()
  const elapsed = state.startTime ? now - state.startTime : 0
  elements.statTime.textContent = elapsed > 0 ? formatTime(elapsed) : '-'

  // Calculate rate in KB/s based on symbols received in last 5 seconds
  const times = state.symbolTimes
  if (times.length >= 2) {
    const windowDuration = (times[times.length - 1] - times[0]) / 1000
    const bytesInWindow = times.length * BLOCK_SIZE
    const rateKBps = windowDuration > 0 ? (bytesInWindow / windowDuration / 1024) : 0
    elements.statRate.textContent = rateKBps.toFixed(1) + ' KB/s'

    // Estimate remaining time based on current rate
    const remaining = k - solved
    const remainingBytes = remaining * BLOCK_SIZE
    const etaMs = rateKBps > 0 ? (remainingBytes / 1024 / rateKBps * 1000 * 1.3) : 0
    elements.statEta.textContent = etaMs > 0 ? ('~' + formatTime(etaMs)) : '-'
  }
}

// Handle receive completion
async function onReceiveComplete() {
  // Capture final timing before stopping
  const endTime = Date.now()
  const totalTime = state.startTime ? endTime - state.startTime : 0

  stopScanning()

  elements.receiveStatus.textContent = 'Verifying...'

  const verified = await state.decoder.verify()

  if (verified) {
    const data = state.decoder.reconstruct()
    const metadata = state.decoder.metadata

    state.reconstructedBlob = new Blob([data], { type: metadata.mimeType })

    // Calculate and display final stats
    const avgRateKBps = totalTime > 0 ? (metadata.fileSize / (totalTime / 1000) / 1024) : 0
    elements.statRate.textContent = avgRateKBps.toFixed(1) + ' KB/s'
    elements.statTime.textContent = formatTime(totalTime)
    elements.statEta.textContent = '-'

    elements.receiveStatus.textContent = 'Complete! Hash verified.'
    elements.btnDownload.disabled = false
    elements.progressFill.style.width = '100%'
    elements.progressText.textContent = '100%'
  } else {
    showError('File corrupted! Hash verification failed.')
    elements.receiveStatus.textContent = 'Verification failed!'
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

  if (elements) {
    elements.progressFill.style.width = '0%'
    elements.progressText.textContent = '0%'
    elements.fileNameDisplay.textContent = 'Waiting for file...'
    elements.statBlocks.textContent = '0/0'
    elements.statSymbols.textContent = '0'
    elements.statRate.textContent = '-'
    elements.statTime.textContent = '-'
    elements.statEta.textContent = '-'
    elements.receiveStatus.textContent = 'Ready'
    elements.btnDownload.disabled = true
  }
}

// Initialize receiver module
export function initReceiver(errorHandler) {
  showError = errorHandler

  elements = {
    cameraDropdown: document.getElementById('camera-dropdown'),
    video: document.getElementById('camera-video'),
    qrOverlay: document.getElementById('qr-overlay'),
    qrPolygon: document.getElementById('qr-polygon'),
    btnStartScan: document.getElementById('btn-start-scan'),
    btnStopScan: document.getElementById('btn-stop-scan'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    fileNameDisplay: document.getElementById('file-name-display'),
    statBlocks: document.getElementById('stat-blocks'),
    statSymbols: document.getElementById('stat-symbols'),
    statRate: document.getElementById('stat-rate'),
    statTime: document.getElementById('stat-time'),
    statEta: document.getElementById('stat-eta'),
    receiveStatus: document.getElementById('receive-status'),
    btnDownload: document.getElementById('btn-download')
  }

  // Bind event handlers
  elements.btnStartScan.onclick = startScanning
  elements.btnStopScan.onclick = stopScanning
  elements.btnDownload.onclick = downloadFile
}
