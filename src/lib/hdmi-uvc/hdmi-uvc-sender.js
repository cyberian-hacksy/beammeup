// HDMI-UVC Sender module - handles file encoding and full-screen display

import { createEncoder } from '../encoder.js'
import { METADATA_INTERVAL } from '../constants.js'
import { PACKET_HEADER_SIZE } from '../packet.js'
import {
  HDMI_UVC_MAX_FILE_SIZE,
  HDMI_MODE,
  HDMI_MODE_NAMES,
  FPS_PRESETS,
  DEFAULT_FPS_PRESET
} from './hdmi-uvc-constants.js'
import { buildFrame, getDataRegion, getPayloadCapacity } from './hdmi-uvc-frame.js'

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
  packetSize: 0,
  packetsPerFrame: 1,
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
  elements.container?.classList.remove('fullscreen')
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

function waitForLayoutFrames(count = 2) {
  return new Promise((resolve) => {
    const step = () => {
      if (count <= 0) {
        resolve()
        return
      }
      count--
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
}

function getCanvasViewportMetrics() {
  const presentationEl = document.fullscreenElement || elements.container || elements.canvas
  const rect = presentationEl.getBoundingClientRect()
  const visual = window.visualViewport

  const rectWidth = Math.round(rect.width)
  const rectHeight = Math.round(rect.height)
  const visualWidth = visual ? Math.round(visual.width) : 0
  const visualHeight = visual ? Math.round(visual.height) : 0
  const innerWidth = Math.round(window.innerWidth)
  const innerHeight = Math.round(window.innerHeight)
  const screenWidth = Math.round(window.screen.width || 0)
  const screenHeight = Math.round(window.screen.height || 0)

  let width = rectWidth
  let height = rectHeight
  let source = document.fullscreenElement ? 'fullscreenRect' : 'containerRect'

  if (!width || !height) {
    width = visualWidth || innerWidth
    height = visualHeight || innerHeight
    source = visualWidth && visualHeight ? 'visualViewport' : 'window.inner'
  }

  return {
    width,
    height,
    source,
    rectWidth,
    rectHeight,
    visualWidth,
    visualHeight,
    innerWidth,
    innerHeight,
    screenWidth,
    screenHeight,
    devicePixelRatio: window.devicePixelRatio || 1
  }
}

function measureAndApplyCanvasSize() {
  const metrics = getCanvasViewportMetrics()

  elements.canvas.width = metrics.width
  elements.canvas.height = metrics.height

  const capacity = getPayloadCapacity(metrics.width, metrics.height, state.mode)
  const dataRegion = getDataRegion(metrics.width, metrics.height)
  const dataWidth = dataRegion.w
  const dataHeight = dataRegion.h
  const dataUtil = metrics.width > 0 && metrics.height > 0
    ? ((dataWidth * dataHeight) / (metrics.width * metrics.height) * 100).toFixed(1)
    : '0.0'

  debugLog(
    `Viewport: rect=${metrics.rectWidth}x${metrics.rectHeight}, ` +
    `visual=${metrics.visualWidth}x${metrics.visualHeight}, ` +
    `inner=${metrics.innerWidth}x${metrics.innerHeight}, ` +
    `screen=${metrics.screenWidth}x${metrics.screenHeight}, dpr=${metrics.devicePixelRatio}`
  )
  debugLog(`Canvas: ${metrics.width}x${metrics.height} (${metrics.source}), data region ${dataWidth}x${dataHeight} (${dataUtil}% of frame)`)

  return { metrics, capacity }
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

function updateModeSelector() {
  const buttons = elements.modeButtons || []
  const disabled = state.isSending || state.isPaused

  for (const button of buttons) {
    const mode = parseInt(button.dataset.mode, 10)
    button.classList.toggle('active', mode === state.mode)
    button.disabled = disabled
  }
}

// Once the HDMI-UVC decode path is stable, repeating every symbol wastes most
// of the available bandwidth. Let fountain redundancy absorb frame loss.
const FRAMES_PER_SYMBOL = 1
const METADATA_BURST_FRAMES = 6
const METADATA_INTERVAL_FRAMES = METADATA_INTERVAL * 2
const MIN_BLOCK_SIZE = 512
const MAX_BLOCK_SIZE = 1536
const TARGET_SOURCE_BLOCKS = 128

function getBatchingProfile(mode) {
  switch (mode) {
    case HDMI_MODE.RAW_RGB:
      // Three binary channels per 4x4 block. This is denser than 1-bit 4x4
      // without relying on unstable grayscale mid-tones, so allow a modestly
      // higher byte budget while keeping packet shards small enough to salvage.
      return {
        maxPacketsPerFrame: 12,
        targetFrameFill: 0.32,
        maxBlockSize: 832,
        maxUsedBytes: 10240
      }
    case HDMI_MODE.RAW_GRAY:
      // Gray2 is denser but materially less tolerant of capture noise than
      // binary 4x4. Keep total bytes/frame conservative and shard them across
      // many packets so packet-level salvage still has useful granularity.
      return {
        maxPacketsPerFrame: 12,
        targetFrameFill: 0.40,
        maxBlockSize: 768,
        maxUsedBytes: 8192
      }
    case HDMI_MODE.COMPAT_4:
      // 4x4 mode can carry more packets per frame, but very large per-packet
      // payloads make inner CRC success collapse on noisy captures. Stay between
      // the proven-good 6.2 KB/frame point and the failing 8.3 KB/frame point.
      return {
        maxPacketsPerFrame: 6,
        targetFrameFill: 0.70,
        maxBlockSize: 1280,
        maxUsedBytes: 7168
      }
    case HDMI_MODE.COMPAT_8:
      return { maxPacketsPerFrame: 4, targetFrameFill: 0.90, maxBlockSize: MAX_BLOCK_SIZE, maxUsedBytes: null }
    case HDMI_MODE.COMPAT_16:
      return { maxPacketsPerFrame: 2, targetFrameFill: 0.85, maxBlockSize: MAX_BLOCK_SIZE, maxUsedBytes: null }
    default:
      return { maxPacketsPerFrame: 4, targetFrameFill: 0.90, maxBlockSize: MAX_BLOCK_SIZE, maxUsedBytes: null }
  }
}

function shouldSendMetadata(frameNumber) {
  return frameNumber <= METADATA_BURST_FRAMES || frameNumber % METADATA_INTERVAL_FRAMES === 0
}

function buildFramePacketBatch(frameNumber) {
  const sendMetadata = shouldSendMetadata(frameNumber)
  const packets = []
  const symbolIds = []
  const slots = Math.max(1, state.packetsPerFrame)

  if (sendMetadata) {
    packets.push(state.encoder.generateSymbol(0))
    symbolIds.push(0)
  }

  while (packets.length < slots) {
    const symbolId = state.symbolId
    packets.push(state.encoder.generateSymbol(symbolId))
    symbolIds.push(symbolId)

    if (frameNumber % FRAMES_PER_SYMBOL === 0) {
      state.symbolId++
      if (state.symbolId > state.encoder.K_prime) {
        state.symbolId = 1
        debugLog(`Looped back to symbol 1 after ${frameNumber} frames`)
      }
    }
  }

  let totalLength = 0
  for (const packet of packets) totalLength += packet.length

  const payload = new Uint8Array(totalLength)
  let offset = 0
  for (const packet of packets) {
    payload.set(packet, offset)
    offset += packet.length
  }

  return {
    payload,
    symbolIds,
    outerSymbolId: symbolIds[0] ?? 0,
    sendMetadata
  }
}

function renderFrame() {
  if (!state.isSending || state.isPaused || !state.encoder) return

  const fps = getFps()
  const cw = elements.canvas.width
  const ch = elements.canvas.height

  try {
    const nextFrameNumber = state.frameCount + 1
    const batch = buildFramePacketBatch(nextFrameNumber)

    const frameData = buildFrame(batch.payload, state.mode, cw, ch, fps.fps, batch.outerSymbolId)

    const ctx = elements.canvas.getContext('2d')
    ctx.putImageData(new ImageData(new Uint8ClampedArray(frameData), cw, ch), 0, 0)

    state.frameCount = nextFrameNumber
    elements.frameCount.textContent = state.frameCount

    const progress = Math.min(100, Math.round((state.symbolId / state.encoder.K_prime) * 100))
    elements.progressDisplay.textContent = progress + '%'
    const dataSymbols = batch.symbolIds.filter(id => id !== 0)
    const firstData = dataSymbols[0]
    const lastData = dataSymbols[dataSymbols.length - 1]
    const symbolLabel = dataSymbols.length === 0
      ? 'META'
      : firstData === lastData
        ? `sym=${firstData}/${state.encoder.K_prime}`
        : `sym=${firstData}-${lastData}/${state.encoder.K_prime}`
    debugCurrent(
      batch.sendMetadata
        ? `#${state.frameCount} META + ${symbolLabel} ${progress}%`
        : `#${state.frameCount} ${symbolLabel} ${progress}%`
    )

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
    elements.container.classList.add('fullscreen')
    elements.canvas.style.display = 'block'
    elements.canvas.style.position = 'absolute'
    elements.canvas.style.top = '0'
    elements.canvas.style.left = '0'
    elements.canvas.style.imageRendering = 'pixelated'
    elements.canvas.style.background = '#000'
    elements.canvas.style.width = '100%'
    elements.canvas.style.height = '100%'
    elements.placeholder.style.display = 'none'

    try {
      await elements.container.requestFullscreen({ navigationUI: 'hide' })
      debugLog('Fullscreen: OK')
    } catch (e) {
      if (elements.container.requestFullscreen) {
        try {
          await elements.container.requestFullscreen()
          debugLog('Fullscreen: OK (default navigation UI)')
        } catch (fallbackErr) {
          debugLog(`Fullscreen failed: ${fallbackErr.message}, falling back to fixed overlay`)
        }
      } else {
        debugLog(`Fullscreen failed: ${e.message}, falling back to fixed overlay`)
      }
    }

    // Fullscreen layout can settle a frame or two after the promise resolves.
    // Measure the actual fullscreen element box instead of trusting window.inner*.
    await waitForLayoutFrames(3)

    const { metrics, capacity } = measureAndApplyCanvasSize()
    const canvasWidth = metrics.width
    const canvasHeight = metrics.height
    const {
      maxPacketsPerFrame,
      targetFrameFill,
      maxBlockSize: profileMaxBlockSize,
      maxUsedBytes
    } = getBatchingProfile(state.mode)

    // Size payloads from the actual frame capacity instead of pinning them to
    // 256 bytes. This keeps small files snappy and makes larger transfers practical
    // without exceeding what the current frame geometry can carry.
    const frameBlockSize = Math.max(200, capacity - PACKET_HEADER_SIZE)
    const preferredBlockSize = Math.ceil(state.fileSize / TARGET_SOURCE_BLOCKS)
    const maxBlockSize = Math.min(frameBlockSize, profileMaxBlockSize ?? MAX_BLOCK_SIZE, MAX_BLOCK_SIZE)
    const minBlockSize = Math.min(MIN_BLOCK_SIZE, maxBlockSize)
    let blockSize = Math.min(maxBlockSize, Math.max(preferredBlockSize, minBlockSize))
    let bestPacketsPerFrame = Math.min(
      maxPacketsPerFrame,
      Math.max(1, Math.floor(capacity / (blockSize + PACKET_HEADER_SIZE)))
    )
    let bestUsedBytes = bestPacketsPerFrame * (blockSize + PACKET_HEADER_SIZE)
    let bestPayloadPerFrame = bestPacketsPerFrame * blockSize

    if (bestUsedBytes / capacity > targetFrameFill || (maxUsedBytes && bestUsedBytes > maxUsedBytes)) {
      bestPacketsPerFrame = 1
      bestUsedBytes = blockSize + PACKET_HEADER_SIZE
      bestPayloadPerFrame = blockSize
    }

    for (let candidate = minBlockSize; candidate <= maxBlockSize; candidate += 4) {
      const packetsPerFrame = Math.min(
        maxPacketsPerFrame,
        Math.floor(capacity / (candidate + PACKET_HEADER_SIZE))
      )
      if (packetsPerFrame < 1) continue

      const usedBytes = packetsPerFrame * (candidate + PACKET_HEADER_SIZE)
      if (usedBytes / capacity > targetFrameFill) continue
      if (maxUsedBytes && usedBytes > maxUsedBytes) continue

      const payloadPerFrame = packetsPerFrame * candidate
      if (
        payloadPerFrame > bestPayloadPerFrame ||
        (payloadPerFrame === bestPayloadPerFrame && packetsPerFrame > bestPacketsPerFrame) ||
        (payloadPerFrame === bestPayloadPerFrame && packetsPerFrame === bestPacketsPerFrame && candidate > blockSize)
      ) {
        blockSize = candidate
        bestPacketsPerFrame = packetsPerFrame
        bestUsedBytes = usedBytes
        bestPayloadPerFrame = payloadPerFrame
      }
    }

    debugLog(`Mode: ${HDMI_MODE_NAMES[state.mode]}`)
    debugLog(`Payload capacity: ${capacity} bytes/frame (max packet payload ${frameBlockSize})`)
    debugLog(
      `Batch profile: maxPackets=${maxPacketsPerFrame}, ` +
      `targetFill=${(targetFrameFill * 100).toFixed(0)}%, maxBlockSize=${maxBlockSize}, ` +
      `maxUsedBytes=${maxUsedBytes ?? 'none'}`
    )
    debugLog(`File: ${state.fileName} (${formatBytes(state.fileSize)}), blockSize: ${blockSize}`)

    state.encoder = createEncoder(
      state.fileData, state.fileName, 'application/octet-stream', state.fileHash, blockSize
    )
    state.packetSize = blockSize + PACKET_HEADER_SIZE
    state.packetsPerFrame = bestPacketsPerFrame
    const batchedBytes = bestUsedBytes
    const utilization = ((batchedBytes / capacity) * 100).toFixed(1)

    debugLog(`Encoder: K=${state.encoder.K}, K'=${state.encoder.K_prime}`)
    debugLog(`Batching: ${state.packetsPerFrame} packet(s)/frame, packetSize=${state.packetSize}, used=${batchedBytes}/${capacity} bytes (${utilization}%)`)

    state.isSending = true
    state.isPaused = false
    state.symbolId = 1
    state.frameCount = 0

    elements.fpsSlider.disabled = true
    updateActionButton()
    updateModeSelector()
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
  updateModeSelector()
}

async function resumeSending() {
  state.isPaused = false

  elements.container.classList.add('fullscreen')
  elements.canvas.style.display = 'block'
  elements.canvas.style.position = 'absolute'
  elements.canvas.style.top = '0'
  elements.canvas.style.left = '0'
  elements.canvas.style.imageRendering = 'pixelated'
  elements.canvas.style.background = '#000'
  elements.canvas.style.width = '100%'
  elements.canvas.style.height = '100%'
  elements.placeholder.style.display = 'none'

  try {
    await elements.container.requestFullscreen({ navigationUI: 'hide' })
  } catch (e) {
    if (elements.container.requestFullscreen) {
      try {
        await elements.container.requestFullscreen()
      } catch (fallbackErr) {
        debugLog(`Resume fullscreen failed: ${fallbackErr.message}, falling back to fixed overlay`)
      }
    } else {
      debugLog(`Resume fullscreen failed: ${e.message}, falling back to fixed overlay`)
    }
  }

  await waitForLayoutFrames(3)
  measureAndApplyCanvasSize()

  elements.fpsSlider.disabled = true
  updateActionButton()
  updateModeSelector()
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
  state.packetSize = 0
  state.packetsPerFrame = 1
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
  updateModeSelector()
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

function handleModeChange(e) {
  const button = e.currentTarget
  const newMode = parseInt(button.dataset.mode, 10)
  if (!Number.isFinite(newMode) || newMode === state.mode) return
  if (state.isSending || state.isPaused) return

  state.mode = newMode
  updateModeSelector()
  debugLog(`HDMI mode selected: ${HDMI_MODE_NAMES[state.mode]}`)
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
    modeSelector: document.getElementById('hdmi-uvc-mode-selector'),
    fpsSlider: document.getElementById('hdmi-uvc-fps-slider'),
    fpsDisplay: document.getElementById('hdmi-uvc-fps-display'),
    fileInfo: document.getElementById('hdmi-uvc-file-info'),
    estimate: document.getElementById('hdmi-uvc-estimate'),
    btnAction: document.getElementById('btn-hdmi-uvc-action'),
    btnStop: document.getElementById('btn-hdmi-uvc-stop')
  }
  elements.modeButtons = Array.from(elements.modeSelector?.querySelectorAll('.mode-btn') || [])

  elements.fpsSlider.value = DEFAULT_FPS_PRESET

  updateDropZoneState()
  updateActionButton()
  handleFpsChange()
  updateModeSelector()

  elements.fileInput.onchange = handleFileSelect
  elements.fpsSlider.oninput = handleFpsChange
  elements.modeButtons.forEach(button => {
    button.onclick = handleModeChange
  })
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
