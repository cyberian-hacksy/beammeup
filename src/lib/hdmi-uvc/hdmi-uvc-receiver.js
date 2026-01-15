// HDMI-UVC Receiver module - captures from UVC device and decodes frames

import { createDecoder } from '../decoder.js'
import { parsePacket } from '../packet.js'
import { DEVICE_STORAGE_KEY, HDMI_MODE_NAMES } from './hdmi-uvc-constants.js'
import { parseFrame } from './hdmi-uvc-frame.js'

// Debug mode - enabled via ?test URL parameter
const DEBUG_MODE = typeof location !== 'undefined' && location.search.includes('test')

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
  isScanning: false,
  frameCount: 0,
  validFrames: 0,
  startTime: null,
  detectedMode: null,
  detectedResolution: null,
  completedFile: null
}

let elements = null
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

    state.canvas = document.createElement('canvas')
    state.ctx = state.canvas.getContext('2d', { willReadFrequently: true })

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

function processFrame() {
  if (!state.isScanning || !state.stream) return

  const video = elements.video
  if (video.videoWidth === 0) {
    state.animationId = requestAnimationFrame(processFrame)
    return
  }

  const width = video.videoWidth
  const height = video.videoHeight
  state.canvas.width = width
  state.canvas.height = height
  state.ctx.drawImage(video, 0, 0)

  const imageData = state.ctx.getImageData(0, 0, width, height)
  state.frameCount++

  // Log frame info periodically
  if (state.frameCount === 1) {
    debugLog(`Video: ${width}x${height}, first frame captured`)
  }

  // Log first 32 bytes every 30 frames to see what we're actually capturing
  if (state.frameCount % 30 === 1) {
    const firstBytes = Array.from(imageData.data.slice(0, 32)).map(b => b.toString(16).padStart(2, '0')).join(' ')
    debugLog(`Frame ${state.frameCount} bytes: ${firstBytes}`)
  }

  const result = parseFrame(imageData.data, width, height)

  if (result) {
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

        // Debug progress every 10 valid frames
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
        debugLog(`Frame ${state.frameCount}: CRC OK but packet parse failed`)
      }
    } else {
      // CRC failed - log occasionally
      if (state.frameCount % 30 === 0) {
        debugLog(`Frame ${state.frameCount}: CRC mismatch (expected ${result.header.payloadCrc?.toString(16)})`)
      }
      debugCurrent(`#${state.frameCount} CRC fail`)
    }
  } else {
    // No valid header found - log occasionally
    if (state.frameCount % 60 === 0) {
      debugLog(`Frame ${state.frameCount}: No BEAM header found`)
    }
    debugCurrent(`#${state.frameCount} no signal`)
  }

  state.animationId = requestAnimationFrame(processFrame)
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

  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }

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

function resetReceiver() {
  state.isScanning = false

  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }

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
  processFrame()
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

  // Debug panel setup
  if (DEBUG_MODE) {
    const debugPanel = document.getElementById('hdmi-uvc-receiver-debug')
    if (debugPanel) debugPanel.style.display = 'block'

    const copyBtn = document.getElementById('btn-hdmi-uvc-receiver-copy-log')
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const log = document.getElementById('hdmi-uvc-receiver-debug-log')
        if (log) {
          try {
            await navigator.clipboard.writeText(log.textContent)
            copyBtn.textContent = 'Copied!'
            setTimeout(() => copyBtn.textContent = 'Copy', 1000)
          } catch (e) {
            console.error('Copy failed:', e)
          }
        }
      }
    }
    debugLog('HDMI-UVC Receiver initialized (debug mode)')
  }
}
