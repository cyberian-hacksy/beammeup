// HDMI-UVC Sender module - handles file encoding and full-screen display

import { createEncoder } from '../encoder.js'
import { parsePacket } from '../packet.js'
import {
  HDMI_UVC_MAX_FILE_SIZE,
  HDMI_MODE,
  HDMI_MODE_NAMES,
  RESOLUTION_PRESETS,
  FPS_PRESETS,
  DEFAULT_RESOLUTION_PRESET,
  DEFAULT_FPS_PRESET,
  BLOCK_SIZES
} from './hdmi-uvc-constants.js'
import { buildFrame, getPayloadCapacity } from './hdmi-uvc-frame.js'

// Debug mode - enabled via ?test URL parameter
const DEBUG_MODE = typeof location !== 'undefined' && location.search.includes('test')

function debugLog(text) {
  if (!DEBUG_MODE) return

  const el = document.getElementById('hdmi-uvc-sender-debug-log')
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
  console.log('[HDMI-TX]', text)
}

function debugCurrent(text) {
  if (!DEBUG_MODE) return
  const el = document.getElementById('hdmi-uvc-sender-debug-current')
  if (el) el.textContent = text
}

const state = {
  encoder: null,
  fileData: null,
  fileName: null,
  fileSize: 0,
  fileHash: null,
  timerId: null,
  isSending: false,
  isPaused: false,
  symbolId: 1,
  frameCount: 0,
  mode: HDMI_MODE.COMPAT_4
}

let elements = null
let showError = (msg) => console.error(msg)

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function getResolution() {
  const index = parseInt(elements.resolutionSlider.value)
  return RESOLUTION_PRESETS[index]
}

function getFps() {
  const index = parseInt(elements.fpsSlider.value)
  return FPS_PRESETS[index]
}

function estimateTime() {
  if (!state.fileSize) return ''

  const res = getResolution()
  const fps = getFps()
  const capacity = getPayloadCapacity(res.width, res.height, state.mode)

  if (capacity === 0) return ''

  const effectiveCapacity = capacity * 0.9
  const totalFrames = Math.ceil(state.fileSize / effectiveCapacity)
  const seconds = totalFrames / fps.fps

  if (seconds < 1) return '<1s'
  if (seconds < 60) return '~' + Math.ceil(seconds) + 's'
  if (seconds < 3600) return '~' + (seconds / 60).toFixed(1) + 'm'
  return '~' + (seconds / 3600).toFixed(1) + 'h'
}

function estimateThroughput() {
  const res = getResolution()
  const fps = getFps()
  const capacity = getPayloadCapacity(res.width, res.height, state.mode)
  const bytesPerSecond = capacity * fps.fps
  return formatBytes(bytesPerSecond) + '/s'
}

function updateDropZoneState() {
  const container = elements.container
  if (!state.fileData) {
    container.classList.add('empty')
    container.classList.remove('has-file')
  } else {
    container.classList.remove('empty')
    container.classList.add('has-file')
  }
}

function updateActionButton() {
  const btn = elements.btnAction
  if (!state.fileData) {
    btn.textContent = 'Start'
    btn.disabled = true
  } else if (state.isSending && !state.isPaused) {
    btn.textContent = 'Pause'
    btn.disabled = false
  } else if (state.isPaused) {
    btn.textContent = 'Resume'
    btn.disabled = false
  } else {
    btn.textContent = 'Start'
    btn.disabled = false
  }
  elements.btnStop.disabled = !state.fileData
}

function updateModeButtons() {
  elements.modeButtons.forEach(btn => {
    const mode = parseInt(btn.dataset.mode)
    btn.classList.toggle('active', mode === state.mode)
  })
}

function renderFrame() {
  if (!state.isSending || state.isPaused || !state.encoder) return

  const res = getResolution()
  const fps = getFps()

  try {
    // Generate fountain symbol
    const packet = state.encoder.generateSymbol(state.symbolId)

    if (state.frameCount === 0) {
      debugLog(`First packet: ${packet.length} bytes, symbolId=${state.symbolId}`)
    }

    // Build frame with packet payload
    const frameData = buildFrame(
      packet,
      state.mode,
      res.width,
      res.height,
      fps.fps,
      state.symbolId
    )

    if (state.frameCount === 0) {
      debugLog(`Frame built: ${frameData.length} bytes (${res.width}x${res.height}x4 RGBA)`)
    }

    // Draw to canvas
    const canvas = elements.canvas
    const ctx = canvas.getContext('2d')
    canvas.width = res.width
    canvas.height = res.height

    const imageData = new ImageData(
      new Uint8ClampedArray(frameData),
      res.width,
      res.height
    )
    ctx.putImageData(imageData, 0, 0)

    // Update overlay
    state.frameCount++
    elements.frameCount.textContent = state.frameCount

    const progress = Math.min(100, Math.round((state.symbolId / state.encoder.K_prime) * 100))
    elements.progressDisplay.textContent = progress + '%'

    // Debug current status
    debugCurrent(`#${state.frameCount} sym=${state.symbolId}/${state.encoder.K_prime} ${progress}%`)

    // Advance symbol ID, loop back after K_prime
    state.symbolId++
    if (state.symbolId > state.encoder.K_prime) {
      state.symbolId = 1
      debugLog(`Looped back to symbol 1 after ${state.frameCount} frames`)
    }

    // Schedule next frame
    state.timerId = setTimeout(renderFrame, fps.interval)

  } catch (err) {
    debugLog(`ERROR in renderFrame: ${err.message}`)
    console.error('renderFrame error:', err)
    showError('Frame render error: ' + err.message)
  }
}

async function startSending() {
  if (!state.fileData || !state.fileHash) return

  try {
    const res = getResolution()
    const capacity = getPayloadCapacity(res.width, res.height, state.mode)
    const modeName = HDMI_MODE_NAMES[state.mode] || state.mode

    debugLog(`=== START SENDING ===`)
    debugLog(`Mode: ${modeName}, Resolution: ${res.width}x${res.height}`)
    debugLog(`Frame capacity: ${capacity} bytes`)

    // Calculate block size to maximize frame utilization:
    // - Use full frame capacity (minus 16-byte packet header) for large files
    // - For small files, use smaller blocks to ensure K >= 5 for fountain efficiency
    const frameBlockSize = capacity - 16  // Maximum payload that fits in one frame
    const minBlocks = 5
    const blockSizeForMinBlocks = Math.floor(state.fileSize / minBlocks)
    const blockSize = Math.min(frameBlockSize, Math.max(blockSizeForMinBlocks, 200))

    debugLog(`Block size: ${blockSize} bytes (frame capacity: ${capacity})`)
    debugLog(`File: ${state.fileName}, size: ${state.fileSize} bytes`)

    // Create encoder with file data
    state.encoder = createEncoder(
      state.fileData,
      state.fileName,
      'application/octet-stream',
      state.fileHash,
      blockSize
    )

    debugLog(`Encoder created: K=${state.encoder.K}, K'=${state.encoder.K_prime}, M=${state.encoder.M}`)

    // Show canvas, hide placeholder
    elements.canvas.style.display = 'block'
    elements.placeholder.style.display = 'none'
    elements.overlay.classList.remove('hidden')

    // Enter fullscreen for maximum data area
    if (elements.container.requestFullscreen) {
      elements.container.requestFullscreen().catch(() => {})
    }

    state.isSending = true
    state.isPaused = false
    state.symbolId = 1
    state.frameCount = 0

    // Disable controls during send
    elements.resolutionSlider.disabled = true
    elements.fpsSlider.disabled = true
    elements.modeButtons.forEach(btn => btn.disabled = true)

    updateActionButton()
    renderFrame()

  } catch (err) {
    console.error('HDMI-UVC start error:', err)
    showError('Failed to start: ' + err.message)
  }
}

function pauseSending() {
  state.isPaused = true
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
  }

  // Exit fullscreen
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {})
  }

  // Hide canvas, show paused placeholder
  elements.canvas.style.display = 'none'
  elements.overlay.classList.add('hidden')
  elements.placeholder.style.display = 'flex'
  elements.placeholderIcon.textContent = '⏸'
  elements.placeholderText.textContent = 'Transfer paused - ' + state.frameCount + ' frames sent'

  // Re-enable controls while paused
  elements.resolutionSlider.disabled = false
  elements.fpsSlider.disabled = false
  elements.modeButtons.forEach(btn => btn.disabled = false)

  updateActionButton()
}

function resumeSending() {
  state.isPaused = false

  // Show canvas, hide placeholder
  elements.canvas.style.display = 'block'
  elements.overlay.classList.remove('hidden')
  elements.placeholder.style.display = 'none'

  // Disable controls during send
  elements.resolutionSlider.disabled = true
  elements.fpsSlider.disabled = true
  elements.modeButtons.forEach(btn => btn.disabled = true)

  // Re-enter fullscreen
  if (elements.container.requestFullscreen) {
    elements.container.requestFullscreen().catch(() => {})
  }

  updateActionButton()
  renderFrame()
}

function stopSending() {
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
  }

  // Exit fullscreen
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {})
  }

  state.encoder = null
  state.fileData = null
  state.fileName = null
  state.fileSize = 0
  state.fileHash = null
  state.isSending = false
  state.isPaused = false
  state.symbolId = 1
  state.frameCount = 0

  // Re-enable controls
  elements.resolutionSlider.disabled = false
  elements.fpsSlider.disabled = false
  elements.modeButtons.forEach(btn => btn.disabled = false)

  elements.canvas.style.display = 'none'
  elements.placeholder.style.display = 'flex'
  elements.overlay.classList.add('hidden')
  elements.placeholderIcon.textContent = '+'
  elements.placeholderText.textContent = 'Drop file here or tap to select'
  elements.fileInfo.textContent = 'No file'
  elements.estimate.textContent = ''
  elements.fileInput.value = ''

  updateDropZoneState()
  updateActionButton()
}

function handleActionClick() {
  if (!state.fileData) return

  if (state.isSending && !state.isPaused) {
    pauseSending()
  } else if (state.isPaused) {
    resumeSending()
  } else {
    startSending()
  }
}

async function processFile(file) {
  if (!file) return

  if (file.size > HDMI_UVC_MAX_FILE_SIZE) {
    showError('File too large. HDMI-UVC limit: 1GB.')
    return
  }

  try {
    const buffer = await file.arrayBuffer()
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))

    state.fileData = buffer
    state.fileName = file.name
    state.fileSize = file.size
    state.fileHash = hash
    state.isSending = false
    state.isPaused = false

    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ')'
    elements.estimate.textContent = estimateTime() + ' @ ' + estimateThroughput()

    elements.placeholderIcon.textContent = '✓'
    elements.placeholderText.textContent = 'File ready, click Start'

    updateDropZoneState()
    updateActionButton()

  } catch (err) {
    console.error('File read error:', err)
    showError('Failed to read file: ' + err.message)
  }
}

function handleFileSelect(e) {
  processFile(e.target.files[0])
}

function handleDropZoneClick() {
  if (!state.fileData) {
    elements.fileInput.click()
  }
}

function handleDragOver(e) {
  e.preventDefault()
  e.stopPropagation()
  if (!state.fileData) {
    elements.container.classList.add('dragover')
  }
}

function handleDragLeave(e) {
  e.preventDefault()
  e.stopPropagation()
  elements.container.classList.remove('dragover')
}

async function handleDrop(e) {
  e.preventDefault()
  e.stopPropagation()
  elements.container.classList.remove('dragover')

  if (state.fileData) return

  const files = e.dataTransfer.files
  if (files.length > 0) {
    await processFile(files[0])
  }
}

function handleModeClick(e) {
  const mode = parseInt(e.target.dataset.mode)
  if (isNaN(mode)) return

  state.mode = mode
  updateModeButtons()

  if (state.fileSize) {
    elements.estimate.textContent = estimateTime() + ' @ ' + estimateThroughput()
  }
}

function handleResolutionChange() {
  const preset = getResolution()
  elements.resolutionDisplay.textContent = preset.name + ' (' + preset.width + 'x' + preset.height + ')'

  if (state.fileSize) {
    elements.estimate.textContent = estimateTime() + ' @ ' + estimateThroughput()
  }
}

function handleFpsChange() {
  const preset = getFps()
  elements.fpsDisplay.textContent = preset.name

  if (state.fileSize) {
    elements.estimate.textContent = estimateTime() + ' @ ' + estimateThroughput()
  }
}

function handleKeydown(e) {
  // Browser handles Escape to exit fullscreen, fullscreenchange event will pause
  // This handles Escape when NOT in fullscreen (e.g., if fullscreen request failed)
  if (e.key === 'Escape' && state.isSending && !state.isPaused && !document.fullscreenElement) {
    pauseSending()
  }
}

function handleFullscreenChange() {
  // When user exits fullscreen (via Escape or browser UI), pause sending
  if (!document.fullscreenElement && state.isSending && !state.isPaused) {
    pauseSending()
  }
}

export function resetHdmiUvcSender() {
  stopSending()
}

export function initHdmiUvcSender(errorHandler) {
  showError = errorHandler

  elements = {
    fileInput: document.getElementById('hdmi-uvc-file-input'),
    container: document.getElementById('hdmi-uvc-container'),
    placeholder: document.getElementById('hdmi-uvc-placeholder'),
    placeholderIcon: document.getElementById('hdmi-uvc-placeholder-icon'),
    placeholderText: document.getElementById('hdmi-uvc-placeholder-text'),
    canvas: document.getElementById('hdmi-uvc-canvas'),
    overlay: document.getElementById('hdmi-uvc-overlay'),
    frameCount: document.getElementById('hdmi-uvc-frame-count'),
    progressDisplay: document.getElementById('hdmi-uvc-progress'),
    modeSelector: document.getElementById('hdmi-uvc-mode-selector'),
    modeButtons: document.querySelectorAll('#hdmi-uvc-mode-selector .mode-btn'),
    resolutionSlider: document.getElementById('hdmi-uvc-resolution-slider'),
    resolutionDisplay: document.getElementById('hdmi-uvc-resolution-display'),
    fpsSlider: document.getElementById('hdmi-uvc-fps-slider'),
    fpsDisplay: document.getElementById('hdmi-uvc-fps-display'),
    fileInfo: document.getElementById('hdmi-uvc-file-info'),
    estimate: document.getElementById('hdmi-uvc-estimate'),
    btnAction: document.getElementById('btn-hdmi-uvc-action'),
    btnStop: document.getElementById('btn-hdmi-uvc-stop')
  }

  elements.resolutionSlider.value = DEFAULT_RESOLUTION_PRESET
  elements.fpsSlider.value = DEFAULT_FPS_PRESET

  updateDropZoneState()
  updateActionButton()
  updateModeButtons()
  handleResolutionChange()
  handleFpsChange()

  elements.fileInput.onchange = handleFileSelect
  elements.resolutionSlider.oninput = handleResolutionChange
  elements.fpsSlider.oninput = handleFpsChange
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending

  elements.container.onclick = handleDropZoneClick
  elements.container.ondragover = handleDragOver
  elements.container.ondragleave = handleDragLeave
  elements.container.ondrop = handleDrop

  elements.modeButtons.forEach(btn => {
    btn.onclick = handleModeClick
  })

  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', handleFullscreenChange)

  // Debug panel setup
  if (DEBUG_MODE) {
    const debugPanel = document.getElementById('hdmi-uvc-sender-debug')
    if (debugPanel) debugPanel.style.display = 'block'

    const copyBtn = document.getElementById('btn-hdmi-uvc-sender-copy-log')
    if (copyBtn) {
      copyBtn.onclick = async () => {
        const log = document.getElementById('hdmi-uvc-sender-debug-log')
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
    debugLog('HDMI-UVC Sender initialized (debug mode)')
  }
}
