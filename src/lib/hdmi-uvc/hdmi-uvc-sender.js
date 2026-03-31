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

    // Draw to canvas (dimensions set once in startSending, not here)
    const ctx = elements.canvas.getContext('2d')
    const imageData = new ImageData(
      new Uint8ClampedArray(frameData),
      res.width,
      res.height
    )
    ctx.putImageData(imageData, 0, 0)

    if (state.frameCount === 0) {
      // For compat modes, header bytes are block-encoded (blockSize pixels wide)
      const bs = BLOCK_SIZES[state.mode] || 1
      const m = [0, 1, 2, 3].map(i => frameData[(i * bs + Math.floor(bs / 2)) * 4])
      debugLog(`Frame: ${res.width}x${res.height}, headerBlockSize=${bs}, magic=${m.join(',')} (expect 66,69,65,77)`)
    }

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

    // Set canvas bitmap dimensions ONCE (not every frame - that clears the canvas)
    elements.canvas.width = res.width
    elements.canvas.height = res.height

    // Cover the viewport with the canvas using position:fixed.
    // We intentionally avoid requestFullscreen() because on macOS it creates
    // a new Space that HDMI mirror doesn't follow — the dongle would still
    // show the old Space with the app UI instead of the data frames.
    elements.canvas.style.display = 'block'
    elements.canvas.style.position = 'fixed'
    elements.canvas.style.top = '0'
    elements.canvas.style.left = '0'
    elements.canvas.style.width = '100vw'
    elements.canvas.style.height = '100vh'
    elements.canvas.style.zIndex = '999999'
    elements.canvas.style.imageRendering = 'pixelated'
    elements.canvas.style.background = '#000'
    elements.placeholder.style.display = 'none'

    // Maximize the browser window to eliminate horizontal/vertical offset
    window.moveTo(0, 0)
    window.resizeTo(screen.availWidth, screen.availHeight)

    debugLog(`Canvas bitmap: ${res.width}x${res.height}`)
    debugLog(`Screen: ${screen.width}x${screen.height}, avail: ${screen.availWidth}x${screen.availHeight}, dpr: ${window.devicePixelRatio}`)
    debugLog(`Window: outer=${window.outerWidth}x${window.outerHeight} at (${window.screenX},${window.screenY})`)
    debugLog(`Display mode: CSS fixed overlay (no fullscreen API — avoids macOS Spaces issue)`)

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

  // Hide canvas, show paused placeholder
  resetCanvasStyles()
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

  // Restore canvas overlay
  elements.canvas.style.display = 'block'
  elements.canvas.style.position = 'fixed'
  elements.canvas.style.top = '0'
  elements.canvas.style.left = '0'
  elements.canvas.style.width = '100vw'
  elements.canvas.style.height = '100vh'
  elements.canvas.style.zIndex = '999999'
  elements.canvas.style.imageRendering = 'pixelated'
  elements.canvas.style.background = '#000'
  elements.placeholder.style.display = 'none'

  // Disable controls during send
  elements.resolutionSlider.disabled = true
  elements.fpsSlider.disabled = true
  elements.modeButtons.forEach(btn => btn.disabled = true)

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

  // Re-enable controls
  elements.resolutionSlider.disabled = false
  elements.fpsSlider.disabled = false
  elements.modeButtons.forEach(btn => btn.disabled = false)

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

let cachedScreens = null

async function populateDisplayDropdown() {
  const dropdown = elements.displayDropdown

  // Clear existing options except first
  while (dropdown.options.length > 1) {
    dropdown.remove(1)
  }

  try {
    if ('getScreenDetails' in window) {
      const screenDetails = await window.getScreenDetails()
      cachedScreens = screenDetails.screens
      const currentScreen = screenDetails.currentScreen

      cachedScreens.forEach((s, i) => {
        const option = document.createElement('option')
        option.value = i.toString()
        const isCurrent = s === currentScreen ? ' (current)' : ''
        const isInternal = s.isInternal ? ' [built-in]' : ' [external]'
        const label = s.label || `Screen ${i + 1}`
        option.textContent = `${label}: ${s.width}x${s.height}${isCurrent}${isInternal}`
        dropdown.appendChild(option)

        // Auto-select first external (non-current) display — likely the HDMI dongle
        if (!s.isInternal && s !== currentScreen && dropdown.value === 'current') {
          dropdown.value = i.toString()
          debugLog(`Auto-selected external display: ${label} (${s.width}x${s.height})`)
        }
      })

      debugLog(`Found ${cachedScreens.length} display(s)`)
    }
  } catch (err) {
    debugLog(`Display detection failed: ${err.message}`)
  }
}

async function enterFullscreenOnSelectedDisplay() {
  // Re-detect displays now (we're in a user gesture context, so getScreenDetails will work)
  if (!cachedScreens) {
    debugLog(`Detecting displays (user gesture context)...`)
    await populateDisplayDropdown()
  }

  const selectedValue = elements.displayDropdown.value

  try {
    if (selectedValue !== 'current' && cachedScreens) {
      const screenIndex = parseInt(selectedValue)
      const targetScreen = cachedScreens[screenIndex]

      if (targetScreen) {
        debugLog(`Going fullscreen on: ${targetScreen.label || 'Screen ' + (screenIndex + 1)} (${targetScreen.width}x${targetScreen.height}, internal=${targetScreen.isInternal})`)

        // Move window to target screen first
        window.moveTo(targetScreen.left + 100, targetScreen.top + 100)
        await new Promise(r => setTimeout(r, 200))

        await elements.canvas.requestFullscreen({ screen: targetScreen })
        debugLog(`Fullscreen on target display succeeded`)
        return
      }
    }
  } catch (err) {
    debugLog(`Fullscreen on selected display failed: ${err.message}`)
  }

  // Fallback: try each non-current screen
  if (cachedScreens && cachedScreens.length > 1) {
    debugLog(`Trying each display as fallback...`)
    for (const s of cachedScreens) {
      try {
        if (!s.isInternal || cachedScreens.length === 2) {
          debugLog(`Trying: ${s.label || 'unknown'} (${s.width}x${s.height})`)
          window.moveTo(s.left + 100, s.top + 100)
          await new Promise(r => setTimeout(r, 200))
          await elements.canvas.requestFullscreen({ screen: s })
          debugLog(`Fullscreen succeeded on: ${s.label}`)
          return
        }
      } catch (e) {
        debugLog(`Failed: ${e.message}`)
      }
    }
  }

  // Last resort: fullscreen on current screen
  debugLog('Fallback: fullscreen on current screen (canvas)')
  if (elements.canvas.requestFullscreen) {
    await elements.canvas.requestFullscreen().catch(() => {})
  }
}

function handleKeydown(e) {
  // Escape pauses/hides the canvas overlay
  if (e.key === 'Escape' && state.isSending && !state.isPaused) {
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
    displayDropdown: document.getElementById('hdmi-uvc-display-dropdown'),
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

  // Populate display dropdown (may fail without user gesture - will retry on click and on Start)
  populateDisplayDropdown()
  elements.displayDropdown.onfocus = () => populateDisplayDropdown()

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
