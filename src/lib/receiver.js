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
  startTime: null,
  cameras: [],
  currentCameraId: null,
  isMobile: false,
  hasNotifiedFirstScan: false
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

    // Reset decoder
    state.decoder = createDecoder()
    state.symbolTimes = []
    state.reconstructedBlob = null
    state.startTime = Date.now()
    state.isScanning = true

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
          // Notify on first successful scan
          if (!state.hasNotifiedFirstScan) {
            state.hasNotifiedFirstScan = true
            playBeep()
          }

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
  const uniqueSymbols = decoder.uniqueSymbols || 0

  // If we have metadata, switch to receiving view
  if (decoder.metadata && k > 0) {
    showStatus('receiving')

    const progress = (solved / k * 100)
    elements.progressFill.style.width = progress + '%'
    elements.statBlocks.textContent = solved + '/' + k
    elements.fileNameDisplay.textContent =
      decoder.metadata.filename + ' (' + formatBytes(decoder.metadata.fileSize) + ')'

    // Calculate rate
    const times = state.symbolTimes
    if (times.length >= 2) {
      const windowDuration = (times[times.length - 1] - times[0]) / 1000
      const bytesInWindow = times.length * BLOCK_SIZE
      const rateKBps = windowDuration > 0 ? (bytesInWindow / windowDuration / 1024) : 0
      elements.statRate.textContent = rateKBps.toFixed(1) + ' KB/s'

      // Estimate remaining time
      const remaining = k - solved
      const remainingBytes = remaining * BLOCK_SIZE
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
    showError('File corrupted! Hash verification failed.')
    showStatus('scanning')
    elements.statSymbols.textContent = 'Verification failed'
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

  if (elements) {
    showStatus('scanning')
    elements.progressFill.style.width = '0%'
    elements.fileNameDisplay.textContent = '-'
    elements.statBlocks.textContent = '0/0'
    elements.statSymbols.textContent = '0 codes'
    elements.statRate.textContent = '-'
    elements.statEta.textContent = ''
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
    completeRate: document.getElementById('complete-rate')
  }

  // Bind event handlers
  elements.btnCameraSwitch.onclick = toggleMobileCamera
  elements.cameraDropdown.onchange = (e) => switchCamera(e.target.value)
  elements.btnDownload.onclick = downloadFile
  elements.btnReceiveAnother.onclick = restartReceiver
}

// Restart receiver for another file
async function restartReceiver() {
  resetReceiver()
  await autoStartReceiver()
}
