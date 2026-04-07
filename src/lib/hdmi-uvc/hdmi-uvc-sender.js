// HDMI-UVC Sender module - handles file encoding and full-screen display

import { createEncoder } from '../encoder.js'
import { METADATA_INTERVAL } from '../constants.js'
import { PACKET_HEADER_SIZE } from '../packet.js'
import { loadCimbarWasm, getModule as getCimbarModule } from '../cimbar/cimbar-loader.js'
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
const CIMBAR_MAX_FILE_SIZE = 33 * 1024 * 1024
const HDMI_CIMBAR_MODE = 68
const HDMI_CIMBAR_VARIANT_NAME = 'B'
const HDMI_CIMBAR_TILE_COUNT = 2
const HDMI_CIMBAR_TILE_GAP = 24
const HDMI_CIMBAR_TILE_PADDING = {
  top: 20,
  right: 20,
  bottom: 10,
  left: 10
}
const HDMI_CIMBAR_VARIANTS = [HDMI_CIMBAR_MODE]
const CIMBAR_VARIANT_NAMES = {
  [HDMI_CIMBAR_MODE]: HDMI_CIMBAR_VARIANT_NAME
}

function getHdmiCimbarLayout(width, height) {
  const maxContentWidth = Math.floor(
    (width - HDMI_CIMBAR_TILE_GAP - (HDMI_CIMBAR_TILE_PADDING.left + HDMI_CIMBAR_TILE_PADDING.right) * HDMI_CIMBAR_TILE_COUNT) /
      HDMI_CIMBAR_TILE_COUNT
  )
  const maxContentHeight = height - HDMI_CIMBAR_TILE_PADDING.top - HDMI_CIMBAR_TILE_PADDING.bottom
  const contentSize = Math.max(1, Math.min(maxContentWidth, maxContentHeight))
  const tileOuterWidth = contentSize + HDMI_CIMBAR_TILE_PADDING.left + HDMI_CIMBAR_TILE_PADDING.right
  const tileOuterHeight = contentSize + HDMI_CIMBAR_TILE_PADDING.top + HDMI_CIMBAR_TILE_PADDING.bottom
  const compositionWidth =
    tileOuterWidth * HDMI_CIMBAR_TILE_COUNT + HDMI_CIMBAR_TILE_GAP * (HDMI_CIMBAR_TILE_COUNT - 1)
  const compositionHeight = tileOuterHeight
  const originX = Math.max(0, Math.floor((width - compositionWidth) / 2))
  const originY = Math.max(0, Math.floor((height - compositionHeight) / 2))

  const tiles = Array.from({ length: HDMI_CIMBAR_TILE_COUNT }, (_, index) => {
    const x = originX + index * (tileOuterWidth + HDMI_CIMBAR_TILE_GAP)
    const y = originY
    return {
      index,
      x,
      y,
      w: tileOuterWidth,
      h: tileOuterHeight,
      contentX: x + HDMI_CIMBAR_TILE_PADDING.left,
      contentY: y + HDMI_CIMBAR_TILE_PADDING.top,
      contentW: contentSize,
      contentH: contentSize
    }
  })

  return {
    mode: HDMI_CIMBAR_MODE,
    ratio: 1,
    gap: HDMI_CIMBAR_TILE_GAP,
    padding: { ...HDMI_CIMBAR_TILE_PADDING },
    tileCount: HDMI_CIMBAR_TILE_COUNT,
    contentWidth: contentSize,
    contentHeight: contentSize,
    tileOuterWidth,
    tileOuterHeight,
    composition: {
      x: originX,
      y: originY,
      w: compositionWidth,
      h: compositionHeight
    },
    display: {
      width,
      height
    },
    tiles
  }
}

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
  systematicIndex: 0,
  systematicStride: 1,
  fountainSymbolId: 0,
  dataPacketCount: 0,
  frameCount: 0,
  mode: HDMI_MODE.COMPAT_4,
  systematicPass: 1,
  metadataIntervalFrames: METADATA_INTERVAL * 2,
  cimbarIdealRatio: 1,
  cimbarVariant: HDMI_CIMBAR_MODE,
  cimbarBoundsLogged: false,
  cimbarRenderCanvas: null,
  cimbarUseWrapper: false,
  cimbarLayout: null
}

let elements = null
let showError = (msg) => console.error(msg)

function resetCanvasStyles() {
  if (!elements?.canvas) return
  elements.container?.classList.remove('fullscreen')
  elements.container?.classList.remove('signal-live')
  if (elements.container) {
    elements.container.style.justifyContent = ''
    elements.container.style.alignItems = ''
  }
  document.body?.classList.remove('hdmi-uvc-signal-live')
  elements.canvas.style.display = 'none'
  elements.canvas.style.position = ''
  elements.canvas.style.top = ''
  elements.canvas.style.left = ''
  elements.canvas.style.removeProperty('width')
  elements.canvas.style.removeProperty('height')
  elements.canvas.style.zIndex = ''
  elements.canvas.style.imageRendering = ''
  elements.canvas.style.background = ''
  elements.canvas.style.transform = ''
  elements.canvas.style.padding = ''
  elements.canvas.style.boxSizing = ''
  elements.canvas.style.removeProperty('max-width')
  elements.canvas.style.removeProperty('max-height')
}

function setSignalLive(isLive) {
  if (!elements?.container) return
  elements.container.classList.toggle('signal-live', isLive)
  document.body?.classList.toggle('hdmi-uvc-signal-live', isLive)
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

function viewportMetricsEqual(a, b, tolerance = 1) {
  if (!a || !b) return false
  return (
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance &&
    Math.abs(a.rectWidth - b.rectWidth) <= tolerance &&
    Math.abs(a.rectHeight - b.rectHeight) <= tolerance
  )
}

async function waitForStableViewport(stableFrames = 3, maxFrames = 30) {
  let last = null
  let stableCount = 0

  for (let frame = 0; frame < maxFrames; frame++) {
    await waitForLayoutFrames(1)
    const current = getCanvasViewportMetrics()
    if (viewportMetricsEqual(current, last)) {
      stableCount++
      if (stableCount >= stableFrames) {
        return current
      }
    } else {
      stableCount = 0
    }
    last = current
  }

  return last || getCanvasViewportMetrics()
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

function isCimbarMode() {
  return state.mode === HDMI_MODE.CIMBAR
}

function normalizeHdmiCimbarVariant(value) {
  return HDMI_CIMBAR_VARIANTS.includes(value) ? value : HDMI_CIMBAR_MODE
}

function copyToWasmHeap(Module, data) {
  const ptr = Module._malloc(data.length)
  const wasmData = new Uint8Array(Module.HEAPU8.buffer, ptr, data.length)
  wasmData.set(data)
  return { ptr, view: wasmData }
}

function logCimbarContentBounds(canvas = elements?.canvas, label = 'CIMBAR content bounds') {
  if (!canvas) return

  const srcWidth = canvas.width
  const srcHeight = canvas.height
  if (!srcWidth || !srcHeight) return

  const probeCanvas = document.createElement('canvas')
  probeCanvas.width = srcWidth
  probeCanvas.height = srcHeight
  const probeCtx = probeCanvas.getContext('2d', { willReadFrequently: true })
  if (!probeCtx) return

  probeCtx.drawImage(canvas, 0, 0, srcWidth, srcHeight)
  const pixels = probeCtx.getImageData(0, 0, srcWidth, srcHeight).data

  let minX = srcWidth
  let minY = srcHeight
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < srcHeight; y++) {
    for (let x = 0; x < srcWidth; x++) {
      const idx = (y * srcWidth + x) * 4
      const r = pixels[idx]
      const g = pixels[idx + 1]
      const b = pixels[idx + 2]
      const a = pixels[idx + 3]
      if (a > 0 && (r > 12 || g > 12 || b > 12)) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }

  if (maxX >= minX && maxY >= minY) {
    debugLog(
      `${label}: (${minX},${minY})..(${maxX},${maxY}) ` +
      `size=${maxX - minX + 1}x${maxY - minY + 1} within ${srcWidth}x${srcHeight}`
    )
  } else {
    debugLog(`${label}: no non-black pixels within ${srcWidth}x${srcHeight}`)
  }
}

function ensureCimbarRenderCanvas(width, height) {
  if (!state.cimbarRenderCanvas) {
    state.cimbarRenderCanvas = document.createElement('canvas')
  }
  if (width && height) {
    state.cimbarRenderCanvas.width = width
    state.cimbarRenderCanvas.height = height
  }
  return state.cimbarRenderCanvas
}

function prepareCimbarCanvasForConfigure(metrics = getCanvasViewportMetrics()) {
  const layout = getHdmiCimbarLayout(metrics.width, metrics.height)

  elements.canvas.style.position = 'static'
  elements.canvas.style.top = ''
  elements.canvas.style.left = ''
  elements.canvas.style.transform = ''
  elements.canvas.style.setProperty('width', `${layout.display.width}px`, 'important')
  elements.canvas.style.setProperty('height', `${layout.display.height}px`, 'important')
  elements.canvas.style.setProperty('max-width', 'none', 'important')
  elements.canvas.style.setProperty('max-height', 'none', 'important')
  elements.canvas.style.padding = ''
  elements.canvas.style.boxSizing = ''
  if (elements.container) {
    elements.container.style.justifyContent = 'center'
    elements.container.style.alignItems = 'center'
  }
  state.cimbarLayout = layout
  ensureCimbarRenderCanvas(layout.contentWidth, layout.contentHeight)

  debugLog(`Canvas: CIMBAR provisional ${layout.contentWidth}x${layout.contentHeight} before configure`)
}

function clearCimbarDisplay() {
  const ctx = elements.canvas.getContext('2d')
  if (!ctx) return

  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, elements.canvas.width, elements.canvas.height)
}

function blitCimbarTileToDisplay(tile) {
  if (!state.cimbarUseWrapper || !state.cimbarRenderCanvas || !tile) return

  const ctx = elements.canvas.getContext('2d')
  if (!ctx) return

  ctx.drawImage(
    state.cimbarRenderCanvas,
    tile.contentX,
    tile.contentY
  )
}

function scaleCimbarCanvasToViewport(metrics = getCanvasViewportMetrics()) {
  const Module = getCimbarModule()
  const landscapeViewport = metrics.width >= metrics.height
  const layout = getHdmiCimbarLayout(metrics.width, metrics.height)
  const rotateFlag = landscapeViewport ? 1 : 0

  if (Module?._cimbare_rotate_window) {
    Module._cimbare_rotate_window(rotateFlag)
  }

  const ratio = Module?._cimbare_get_aspect_ratio?.() || state.cimbarIdealRatio || 1
  state.cimbarIdealRatio = ratio
  state.cimbarLayout = layout
  state.cimbarUseWrapper = true

  const renderCanvas = ensureCimbarRenderCanvas(layout.contentWidth, layout.contentHeight)
  Module.canvas = renderCanvas
  if (typeof Module?.setCanvasSize === 'function') {
    Module.setCanvasSize(layout.contentWidth, layout.contentHeight)
  } else {
    renderCanvas.width = layout.contentWidth
    renderCanvas.height = layout.contentHeight
  }
  elements.canvas.width = layout.display.width
  elements.canvas.height = layout.display.height

  elements.canvas.style.setProperty('width', `${layout.display.width}px`, 'important')
  elements.canvas.style.setProperty('height', `${layout.display.height}px`, 'important')
  elements.canvas.style.position = 'static'
  elements.canvas.style.top = ''
  elements.canvas.style.left = ''
  elements.canvas.style.transform = ''
  elements.canvas.style.padding = ''
  elements.canvas.style.boxSizing = ''
  elements.canvas.style.setProperty('max-width', 'none', 'important')
  elements.canvas.style.setProperty('max-height', 'none', 'important')
  if (elements.container) {
    elements.container.style.justifyContent = 'center'
    elements.container.style.alignItems = 'center'
  }
  clearCimbarDisplay()

  debugLog(`Viewport: rect=${metrics.rectWidth}x${metrics.rectHeight}, visual=${metrics.visualWidth}x${metrics.visualHeight}, inner=${metrics.innerWidth}x${metrics.innerHeight}, screen=${metrics.screenWidth}x${metrics.screenHeight}, dpr=${metrics.devicePixelRatio}`)
  debugLog(
    `Canvas: CIMBAR viewport ${layout.display.width}x${layout.display.height} ` +
    `(content=${layout.contentWidth}x${layout.contentHeight}, ` +
    `tile=${layout.tileOuterWidth}x${layout.tileOuterHeight}, ` +
    `gap=${layout.gap}, composition=${layout.composition.w}x${layout.composition.h}, ` +
    `pad t=${layout.padding.top}, r=${layout.padding.right}, ` +
    `b=${layout.padding.bottom}, l=${layout.padding.left}, ` +
    `tiles=${layout.tileCount}, ratio=${ratio.toFixed(3)}, landscape=${landscapeViewport}, rotate=${rotateFlag}, scale=1.00)`
  )
  debugLog(
    `Canvas internal: ${elements.canvas.width}x${elements.canvas.height} ` +
    `(render=${state.cimbarRenderCanvas.width}x${state.cimbarRenderCanvas.height}, tiles=${layout.tileCount})`
  )
}

function measureAndApplyCanvasSize(metrics = getCanvasViewportMetrics()) {

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

  state.cimbarVariant = HDMI_CIMBAR_MODE
}

// Once the HDMI-UVC decode path is stable, repeating every symbol wastes most
// of the available bandwidth. Let fountain redundancy absorb frame loss.
const FRAMES_PER_SYMBOL = 1
const METADATA_BURST_FRAMES = 4
const MIN_METADATA_INTERVAL_FRAMES = 90
const MAX_METADATA_INTERVAL_FRAMES = 180
const MIN_BLOCK_SIZE = 512
const MAX_BLOCK_SIZE = 3072
const TARGET_SOURCE_BLOCKS = 128
const HYBRID_FOUNTAIN_PACKET_INTERVAL = 8

function computeMetadataIntervalFrames() {
  if (!state.encoder || !state.packetsPerFrame) return MIN_METADATA_INTERVAL_FRAMES
  const cycleFrames = Math.ceil(state.encoder.K_prime / state.packetsPerFrame)
  const targetInterval = Math.ceil(cycleFrames / 2)
  return Math.max(
    MIN_METADATA_INTERVAL_FRAMES,
    Math.min(MAX_METADATA_INTERVAL_FRAMES, targetInterval)
  )
}

function gcd(a, b) {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return x || 1
}

function chooseSystematicStride(span) {
  if (span <= 2) return 1

  // Use a large coprime stride so any contiguous receive window sees symbols
  // spread across the whole systematic space instead of waiting for wrap.
  let stride = Math.max(2, Math.floor(span * 0.61803398875))
  if (stride >= span) stride = span - 1

  while (stride > 1 && gcd(stride, span) !== 1) {
    stride--
  }

  return Math.max(1, stride)
}

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
      // 4x4 mode is the most robust live path. Permuted systematic order helps
      // late-stage completion, but the best sustained throughput still comes
      // from the 6-7 packet large-shard family rather than 4-5 packets.
      return {
        minPacketsPerFrame: 6,
        maxPacketsPerFrame: 7,
        targetFrameFill: 0.99,
        maxBlockSize: MAX_BLOCK_SIZE,
        maxUsedBytes: null
      }
    case HDMI_MODE.CODEBOOK_3:
      // Binary quadrant glyphs keep the payload alphabet black/white while
      // increasing density over plain 4x4. Use many small shards and keep the
      // total bytes/frame only slightly above the proven 4x4 baseline so this
      // mode tests symbol robustness separately from batching pressure.
      return {
        maxPacketsPerFrame: 12,
        targetFrameFill: 0.25,
        maxBlockSize: 768,
        maxUsedBytes: 8400
      }
    case HDMI_MODE.GLYPH_5:
      // Larger 8x8 glyph tiles with nearest-match decoding. Start near the
      // proven 4x4 byte budget so the first live run isolates symbol quality
      // instead of immediately hitting the batching cliff.
      return {
        maxPacketsPerFrame: 10,
        targetFrameFill: 0.28,
        maxBlockSize: 768,
        maxUsedBytes: 8192
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
  return frameNumber <= METADATA_BURST_FRAMES ||
    frameNumber % state.metadataIntervalFrames === 0
}

function nextDataSymbolId(frameNumber) {
  const sourceSpan = state.encoder.K
  const shouldSendFountain =
    state.systematicPass > 1 &&
    state.fountainSymbolId > state.encoder.K_prime &&
    state.dataPacketCount > 0 &&
    state.dataPacketCount % HYBRID_FOUNTAIN_PACKET_INTERVAL === 0

  let symbolId
  if (shouldSendFountain) {
    symbolId = state.fountainSymbolId++
  } else {
    symbolId = ((state.systematicIndex * state.systematicStride) % sourceSpan) + 1
    if (frameNumber % FRAMES_PER_SYMBOL === 0) {
      state.systematicIndex++
      if (state.systematicIndex >= sourceSpan) {
        state.systematicPass++
        state.systematicIndex = 0
        debugLog(
          `Starting source replay pass ${state.systematicPass} at frame ${frameNumber + 1} ` +
          `(stride=${state.systematicStride}/${sourceSpan})`
        )
      }
    }
  }

  if (frameNumber % FRAMES_PER_SYMBOL === 0) {
    state.dataPacketCount++
  }

  return symbolId
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
    const symbolId = nextDataSymbolId(frameNumber)
    packets.push(state.encoder.generateSymbol(symbolId))
    symbolIds.push(symbolId)
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
  if (!state.isSending || state.isPaused) return

  if (isCimbarMode()) {
    const Module = getCimbarModule()
    if (!Module) return

    try {
      const layout = state.cimbarLayout || getHdmiCimbarLayout(elements.canvas.width, elements.canvas.height)
      clearCimbarDisplay()
      for (const tile of layout.tiles) {
        Module._cimbare_render()
        blitCimbarTileToDisplay(tile)
        Module._cimbare_next_frame(false)
      }

      state.frameCount++
      if (!state.cimbarBoundsLogged && state.frameCount >= 2) {
        if (state.cimbarUseWrapper && state.cimbarRenderCanvas) {
          logCimbarContentBounds(state.cimbarRenderCanvas, 'CIMBAR render bounds')
        }
        logCimbarContentBounds(elements.canvas, 'CIMBAR content bounds')
        state.cimbarBoundsLogged = true
      }
      elements.frameCount.textContent = state.frameCount
      elements.progressDisplay.textContent = 'CIMBAR'
      debugCurrent(`#${state.frameCount} CIMBAR x${layout.tileCount}`)

      const fps = getFps()
      state.timerId = setTimeout(renderFrame, fps.interval)
    } catch (err) {
      debugLog(`ERROR: ${err.message}`)
      showError('CIMBAR render error: ' + err.message)
    }
    return
  }

  if (!state.encoder) return

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

    const progress = Math.min(100, Math.round((state.systematicIndex / state.encoder.K_prime) * 100))
    elements.progressDisplay.textContent = progress + '%'
    const dataSymbols = batch.symbolIds.filter(id => id !== 0)
    const firstData = dataSymbols[0]
    const lastData = dataSymbols[dataSymbols.length - 1]
    const formatSymbolRef = (id) => {
      if (id <= state.encoder.K_prime) return `${id}/${state.encoder.K_prime}`
      return `F${id - state.encoder.K_prime}`
    }
    const symbolLabel = dataSymbols.length === 0
      ? 'META'
      : firstData === lastData
        ? `sym=${formatSymbolRef(firstData)}`
        : `sym=${formatSymbolRef(firstData)}-${formatSymbolRef(lastData)}`
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
    const stableMetrics = await waitForStableViewport()

    if (isCimbarMode()) {
      if (state.fileSize > CIMBAR_MAX_FILE_SIZE) {
        throw new Error(`File too large for CIMBAR mode (${formatBytes(CIMBAR_MAX_FILE_SIZE)} max)`)
      }

      state.cimbarVariant = normalizeHdmiCimbarVariant(state.cimbarVariant)

      prepareCimbarCanvasForConfigure(stableMetrics)

      await loadCimbarWasm()
      const Module = getCimbarModule()
      if (!Module) throw new Error('CIMBAR WASM not loaded')

      const cimbarLayout = state.cimbarLayout || getHdmiCimbarLayout(stableMetrics.width, stableMetrics.height)
      Module.canvas = ensureCimbarRenderCanvas(cimbarLayout.contentWidth, cimbarLayout.contentHeight)
      Module._cimbare_configure(state.cimbarVariant, -1)
      scaleCimbarCanvasToViewport(stableMetrics)

      const fnBytes = new TextEncoder().encode(state.fileName)
      const fnAlloc = copyToWasmHeap(Module, fnBytes)
      Module._cimbare_init_encode(fnAlloc.ptr, fnBytes.length, -1)
      Module._free(fnAlloc.ptr)

      const chunkSize = Module._cimbare_encode_bufsize()
      const fileBytes = new Uint8Array(state.fileData)
      for (let offset = 0; offset < fileBytes.length; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, fileBytes.length)
        const chunk = fileBytes.subarray(offset, end)
        const chunkAlloc = copyToWasmHeap(Module, chunk)
        Module._cimbare_encode(chunkAlloc.ptr, chunk.length)
        Module._free(chunkAlloc.ptr)
      }

      const emptyAlloc = copyToWasmHeap(Module, new Uint8Array(0))
      Module._cimbare_encode(emptyAlloc.ptr, 0)
      Module._free(emptyAlloc.ptr)

      debugLog(`Mode: ${HDMI_MODE_NAMES[state.mode]}`)
      debugLog(
        `CIMBAR sender configured: variant=${CIMBAR_VARIANT_NAMES[state.cimbarVariant] || state.cimbarVariant} ` +
        `(mode=${state.cimbarVariant}) aspect=${state.cimbarIdealRatio.toFixed(3)} tiles=${HDMI_CIMBAR_TILE_COUNT}`
      )
      debugLog(`File: ${state.fileName} (${formatBytes(state.fileSize)})`)

      state.isSending = true
      state.isPaused = false
      state.frameCount = 0
      state.cimbarBoundsLogged = false
      setSignalLive(true)

      elements.fpsSlider.disabled = true
      updateActionButton()
      updateModeSelector()
      renderFrame()
      return
    }

    const { metrics, capacity } = measureAndApplyCanvasSize(stableMetrics)
    const canvasWidth = metrics.width
    const canvasHeight = metrics.height
    const {
      minPacketsPerFrame,
      fixedPacketsPerFrame,
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
    let bestBlockSize = blockSize
    let bestPacketsPerFrame = 1
    let bestUsedBytes = blockSize + PACKET_HEADER_SIZE
    let bestPayloadPerFrame = blockSize
    let foundTargetFit = false

    for (let candidate = minBlockSize; candidate <= maxBlockSize; candidate += 4) {
      const maxPacketsThatFit = Math.min(
        maxPacketsPerFrame,
        Math.floor(capacity / (candidate + PACKET_HEADER_SIZE))
      )
      if (maxPacketsThatFit < 1) continue

      if (!fixedPacketsPerFrame && minPacketsPerFrame && maxPacketsThatFit < minPacketsPerFrame) {
        continue
      }

      const minPackets = fixedPacketsPerFrame
        ? Math.min(fixedPacketsPerFrame, maxPacketsThatFit)
        : (minPacketsPerFrame ?? 1)
      const maxPackets = fixedPacketsPerFrame
        ? Math.min(fixedPacketsPerFrame, maxPacketsThatFit)
        : maxPacketsThatFit

      for (let packetsPerFrame = minPackets; packetsPerFrame <= maxPackets; packetsPerFrame++) {
        const usedBytes = packetsPerFrame * (candidate + PACKET_HEADER_SIZE)
        if (maxUsedBytes && usedBytes > maxUsedBytes) continue

        const fitsTarget = usedBytes / capacity <= targetFrameFill
        if (foundTargetFit && !fitsTarget) continue

        const payloadPerFrame = packetsPerFrame * candidate
        const shouldSelect =
          (!foundTargetFit && fitsTarget) ||
          (fitsTarget === foundTargetFit && (
            payloadPerFrame > bestPayloadPerFrame ||
            (payloadPerFrame === bestPayloadPerFrame && packetsPerFrame < bestPacketsPerFrame) ||
            (payloadPerFrame === bestPayloadPerFrame && packetsPerFrame === bestPacketsPerFrame && candidate > bestBlockSize)
          ))

        if (shouldSelect) {
          bestBlockSize = candidate
          bestPacketsPerFrame = packetsPerFrame
          bestUsedBytes = usedBytes
          bestPayloadPerFrame = payloadPerFrame
          foundTargetFit = fitsTarget
        }
      }
    }

    blockSize = bestBlockSize

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
    state.metadataIntervalFrames = computeMetadataIntervalFrames()
    const batchedBytes = bestUsedBytes
    const utilization = ((batchedBytes / capacity) * 100).toFixed(1)

    debugLog(`Encoder: K=${state.encoder.K}, K'=${state.encoder.K_prime}`)
    debugLog(
      `Metadata schedule: burst=${METADATA_BURST_FRAMES} frame(s), ` +
      `interval=${state.metadataIntervalFrames} frame(s)`
    )
    debugLog(`Batching: ${state.packetsPerFrame} packet(s)/frame, packetSize=${state.packetSize}, used=${batchedBytes}/${capacity} bytes (${utilization}%)`)

    state.isSending = true
    state.isPaused = false
    state.systematicIndex = 0
    state.systematicStride = chooseSystematicStride(state.encoder.K)
    state.fountainSymbolId = state.encoder.K_prime + 1
    state.dataPacketCount = 0
    state.systematicPass = 1
    state.frameCount = 0
    debugLog(`Systematic order: source stride=${state.systematicStride}/${state.encoder.K}`)
    debugLog(`Hybrid schedule: source-only pass 1, then 1 fountain every ${HYBRID_FOUNTAIN_PACKET_INTERVAL} data packets`)
    setSignalLive(true)

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
  setSignalLive(false)
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
  setSignalLive(true)

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

  const stableMetrics = await waitForStableViewport()
  if (isCimbarMode()) {
    scaleCimbarCanvasToViewport(stableMetrics)
  } else {
    measureAndApplyCanvasSize(stableMetrics)
  }

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
  state.systematicIndex = 0
  state.systematicStride = 1
  state.fountainSymbolId = 0
  state.dataPacketCount = 0
  state.systematicPass = 1
  state.metadataIntervalFrames = METADATA_INTERVAL * 2
  state.frameCount = 0
  state.cimbarIdealRatio = 1
  state.cimbarBoundsLogged = false
  state.cimbarUseWrapper = false
  state.cimbarLayout = null
  setSignalLive(false)

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
  const recommendedFpsPreset = state.mode === HDMI_MODE.CIMBAR ? '1' : '0'
  if (elements.fpsSlider && elements.fpsSlider.value !== recommendedFpsPreset) {
    elements.fpsSlider.value = recommendedFpsPreset
    handleFpsChange()
  }
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
