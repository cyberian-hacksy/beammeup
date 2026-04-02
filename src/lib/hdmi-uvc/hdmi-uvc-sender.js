// HDMI-UVC Sender module - handles file encoding and full-screen display

import { createEncoder } from '../encoder.js'
import { METADATA_INTERVAL } from '../constants.js'
import {
  HDMI_UVC_MAX_FILE_SIZE,
  HDMI_MODE,
  HDMI_MODE_NAMES,
  FPS_PRESETS,
  DEFAULT_FPS_PRESET
} from './hdmi-uvc-constants.js'
import { buildFrame, getPayloadCapacity } from './hdmi-uvc-frame.js'

// Debug mode - always on while diagnosing HDMI-UVC issues
const DEBUG_MODE = true

function debugLog(text) {
  if (!DEBUG_MODE) return

  const el = document.getElementById('hdmi-uvc-sender-debug-log')
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

function resetCanvasStyles() {
  if (!elements?.canvas) return
  elements.canvas.style.display = 'none'
  elements.canvas.style.position = ''
  elements.canvas.style.top = ''
  elements.canvas.style.left = ''
  elements.canvas.style.width = ''
  elements.canvas.style.height = ''
  elements.canvas.style.zIndex = ''
  elements.canvas.style.imageRendering = ''
  elements.canvas.style.background = ''
}

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function getFps() {
  const index = parseInt(elements.fpsSlider.value)
  return FPS_PRESETS[index]
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

// Once the HDMI-UVC decode path is stable, repeating every symbol wastes most
// of the available bandwidth. Let fountain redundancy absorb frame loss.
const FRAMES_PER_SYMBOL = 1
const METADATA_BURST_FRAMES = 6
const MIN_BLOCK_SIZE = 512
const MAX_BLOCK_SIZE = 1024
const TARGET_SOURCE_BLOCKS = 128

function shouldSendMetadata(frameNumber) {
  return frameNumber <= METADATA_BURST_FRAMES || frameNumber % METADATA_INTERVAL === 0
}

function renderFrame() {
  if (!state.isSending || state.isPaused || !state.encoder) return

  const fps = getFps()
  const cw = elements.canvas.width
  const ch = elements.canvas.height

  try {
    const nextFrameNumber = state.frameCount + 1
    const sendMetadata = shouldSendMetadata(nextFrameNumber)
    const symbolId = sendMetadata ? 0 : state.symbolId
    const packet = state.encoder.generateSymbol(symbolId)

    const frameData = buildFrame(packet, HDMI_MODE.COMPAT_4, cw, ch, fps.fps, symbolId)

    const ctx = elements.canvas.getContext('2d')
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frameData), cw, ch), 0, 0)

    state.frameCount = nextFrameNumber
    elements.frameCount.textContent = state.frameCount

    const progress = Math.min(100, Math.round((state.symbolId / state.encoder.K_prime) * 100))
    elements.progressDisplay.textContent = progress + '%'
    debugCurrent(
      sendMetadata
        ? `#${state.frameCount} META ${progress}%`
        : `#${state.frameCount} sym=${state.symbolId}/${state.encoder.K_prime} ${progress}%`
    )

    // Advance data symbol only on non-metadata frames, repeating each symbol
    // across several frames to give the capture pipeline multiple chances.
    if (!sendMetadata && state.frameCount % FRAMES_PER_SYMBOL === 0) {
      state.symbolId++
      if (state.symbolId > state.encoder.K_prime) {
        state.symbolId = 1
        debugLog(`Looped back to symbol 1 after ${state.frameCount} frames`)
      }
    }

    state.timerId = setTimeout(renderFrame, fps.interval)

  } catch (err) {
    debugLog(`ERROR: ${err.message}`)
    showError('Frame render error: ' + err.message)
  }
}

async function startSending() {
  if (!state.fileData || !state.fileHash) return

  try {
    debugLog(`=== START SENDING ===`)

    // Go fullscreen to eliminate browser chrome from the HDMI output.
    // This ensures anchors are at the true corners with no toolbar artifacts.
    elements.canvas.style.display = 'block'
    elements.canvas.style.imageRendering = 'pixelated'
    elements.canvas.style.background = '#000'
    elements.canvas.style.width = '100%'
    elements.canvas.style.height = '100%'
    elements.placeholder.style.display = 'none'

    try {
      await elements.canvas.requestFullscreen()
      debugLog('Fullscreen: OK')
    } catch (e) {
      debugLog(`Fullscreen failed: ${e.message}, falling back to overlay`)
      elements.canvas.style.position = 'fixed'
      elements.canvas.style.top = '0'
      elements.canvas.style.left = '0'
      elements.canvas.style.width = '100vw'
      elements.canvas.style.height = '100vh'
      elements.canvas.style.zIndex = '999999'
    }

    // Wait a frame for fullscreen to settle, then measure actual dimensions
    await new Promise(r => setTimeout(r, 100))

    const canvasWidth = window.innerWidth
    const canvasHeight = window.innerHeight
    elements.canvas.width = canvasWidth
    elements.canvas.height = canvasHeight

    debugLog(`Canvas: ${canvasWidth}x${canvasHeight}, dpr: ${window.devicePixelRatio}`)

    // Size payloads from the actual frame capacity instead of pinning them to
    // 256 bytes. This keeps small files snappy and makes larger transfers practical
    // without exceeding what the current frame geometry can carry.
    const capacity = getPayloadCapacity(canvasWidth, canvasHeight)
    const frameBlockSize = Math.max(200, capacity - 16)
    const preferredBlockSize = Math.ceil(state.fileSize / TARGET_SOURCE_BLOCKS)
    const blockSize = Math.min(
      frameBlockSize,
      MAX_BLOCK_SIZE,
      Math.max(preferredBlockSize, MIN_BLOCK_SIZE)
    )

    debugLog(`Payload capacity: ${capacity} bytes/frame (max packet payload ${frameBlockSize})`)
    debugLog(`File: ${state.fileName} (${formatBytes(state.fileSize)}), blockSize: ${blockSize}`)

    state.encoder = createEncoder(
      state.fileData, state.fileName, 'application/octet-stream', state.fileHash, blockSize
    )

    debugLog(`Encoder: K=${state.encoder.K}, K'=${state.encoder.K_prime}`)

    state.isSending = true
    state.isPaused = false
    state.symbolId = 1
    state.frameCount = 0

    elements.fpsSlider.disabled = true
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

  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  resetCanvasStyles()
  elements.overlay.classList.add('hidden')
  elements.placeholder.style.display = 'flex'
  elements.placeholderIcon.textContent = '⏸'
  elements.placeholderText.textContent = 'Transfer paused - ' + state.frameCount + ' frames sent'

  elements.fpsSlider.disabled = false
  updateActionButton()
}

async function resumeSending() {
  state.isPaused = false

  elements.canvas.style.display = 'block'
  elements.canvas.style.imageRendering = 'pixelated'
  elements.canvas.style.background = '#000'
  elements.placeholder.style.display = 'none'

  try {
    await elements.canvas.requestFullscreen()
  } catch (e) {
    elements.canvas.style.position = 'fixed'
    elements.canvas.style.top = '0'
    elements.canvas.style.left = '0'
    elements.canvas.style.width = '100vw'
    elements.canvas.style.height = '100vh'
    elements.canvas.style.zIndex = '999999'
  }

  elements.fpsSlider.disabled = true
  updateActionButton()
  renderFrame()
}

function stopSending() {
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
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

  if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  elements.fpsSlider.disabled = false

  resetCanvasStyles()
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
    elements.estimate.textContent = ''

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

function handleFpsChange() {
  const preset = getFps()
  elements.fpsDisplay.textContent = preset.name
}

function handleKeydown(e) {
  if (e.key === 'Escape' && state.isSending) {
    stopSending()
  }
}

function handleFullscreenChange() {
  // If we were sending and fullscreen was exited (e.g. by pressing Escape), pause
  if (state.isSending && !state.isPaused && !document.fullscreenElement) {
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
    fpsSlider: document.getElementById('hdmi-uvc-fps-slider'),
    fpsDisplay: document.getElementById('hdmi-uvc-fps-display'),
    fileInfo: document.getElementById('hdmi-uvc-file-info'),
    estimate: document.getElementById('hdmi-uvc-estimate'),
    btnAction: document.getElementById('btn-hdmi-uvc-action'),
    btnStop: document.getElementById('btn-hdmi-uvc-stop')
  }

  elements.fpsSlider.value = DEFAULT_FPS_PRESET

  updateDropZoneState()
  updateActionButton()
  handleFpsChange()

  elements.fileInput.onchange = handleFileSelect
  elements.fpsSlider.oninput = handleFpsChange
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending

  elements.container.onclick = handleDropZoneClick
  elements.container.ondragover = handleDragOver
  elements.container.ondragleave = handleDragLeave
  elements.container.ondrop = handleDrop

  document.addEventListener('keydown', handleKeydown)
  document.addEventListener('fullscreenchange', handleFullscreenChange)


  // Debug panel copy button
  const copyBtn = document.getElementById('btn-hdmi-uvc-sender-copy-log')
  if (copyBtn) {
    copyBtn.onclick = async () => {
      const log = document.getElementById('hdmi-uvc-sender-debug-log')
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
  debugLog('HDMI-UVC Sender initialized')
}
