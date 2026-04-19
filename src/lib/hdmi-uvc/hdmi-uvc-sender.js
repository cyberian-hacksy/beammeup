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
  DEFAULT_FPS_PRESET,
  RENDER_SIZE_PRESETS,
  DEFAULT_RENDER_SIZE_PRESET
} from './hdmi-uvc-constants.js'
import { buildFrame, createFrameBuffer, getDataRegion, getPayloadCapacity } from './hdmi-uvc-frame.js'

// Debug mode - always on while diagnosing HDMI-UVC issues
const DEBUG_MODE = true
// Pass-2 slot-mix variant. Default is `p2` (4S/2P) per the clean-run feedback:
// the old 5S/1P schedule reached 97% with par=0, i.e. the source replay
// starved parity too long. Emit parity earlier to shorten the tail.
// Overrides: `?pass2=legacy` (5S/1P historical), `?pass2=mix` (2S/2P/2F
// aggressive). See docs/plans/2026-04-17-hdmi-tail-solver-and-rx-hardening.md
// Phase 3.
const PASS2_VARIANT = (typeof location !== 'undefined'
  ? new URLSearchParams(location.search).get('pass2') : null) || 'p2'
const CIMBAR_MAX_FILE_SIZE = 33 * 1024 * 1024
const HDMI_CIMBAR_MODE = 68
const HDMI_CIMBAR_VARIANT_NAME = 'B'
const HDMI_CIMBAR_TILE_COUNT = 1
const HDMI_CIMBAR_TILE_GAP = 0
const TX_PERF_LOG_INTERVAL_FRAMES = 60
const HDMI_CIMBAR_TILE_PADDING = {
  top: 20,
  right: 20,
  bottom: 10,
  left: 10
}
const HDMI_CIMBAR_CANONICAL_RENDER_SIZE = 1054
const HDMI_CIMBAR_VARIANTS = [HDMI_CIMBAR_MODE]
const CIMBAR_VARIANT_NAMES = {
  [HDMI_CIMBAR_MODE]: HDMI_CIMBAR_VARIANT_NAME
}

function getHdmiCimbarLayout(width, height) {
  const maxContentWidth = Math.max(1, width - HDMI_CIMBAR_TILE_PADDING.left - HDMI_CIMBAR_TILE_PADDING.right)
  const maxContentHeight = Math.max(1, height - HDMI_CIMBAR_TILE_PADDING.top - HDMI_CIMBAR_TILE_PADDING.bottom)
  const contentSize = Math.max(1, Math.min(maxContentWidth, maxContentHeight, HDMI_CIMBAR_CANONICAL_RENDER_SIZE))
  const renderWidth = HDMI_CIMBAR_CANONICAL_RENDER_SIZE
  const renderHeight = HDMI_CIMBAR_CANONICAL_RENDER_SIZE
  const tileOuterWidth = contentSize + HDMI_CIMBAR_TILE_PADDING.left + HDMI_CIMBAR_TILE_PADDING.right
  const tileOuterHeight = contentSize + HDMI_CIMBAR_TILE_PADDING.top + HDMI_CIMBAR_TILE_PADDING.bottom
  const tiles = [{
    index: 0,
    x: 0,
    y: 0,
    w: tileOuterWidth,
    h: tileOuterHeight,
    contentX: HDMI_CIMBAR_TILE_PADDING.left,
    contentY: HDMI_CIMBAR_TILE_PADDING.top,
    contentW: contentSize,
    contentH: contentSize,
    renderX: HDMI_CIMBAR_TILE_PADDING.left,
    renderY: HDMI_CIMBAR_TILE_PADDING.top,
    renderW: contentSize,
    renderH: contentSize
  }]

  return {
    mode: HDMI_CIMBAR_MODE,
    ratio: 1,
    gap: HDMI_CIMBAR_TILE_GAP,
    padding: { ...HDMI_CIMBAR_TILE_PADDING },
    tileCount: HDMI_CIMBAR_TILE_COUNT,
    contentWidth: contentSize,
    contentHeight: contentSize,
    renderWidth,
    renderHeight,
    tileOuterWidth,
    tileOuterHeight,
    composition: {
      x: 0,
      y: 0,
      w: tileOuterWidth,
      h: tileOuterHeight
    },
    display: {
      width: tileOuterWidth,
      height: tileOuterHeight
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

function createPerfWindow() {
  return {
    count: 0,
    sum: 0,
    min: Infinity,
    max: 0
  }
}

function resetPerfWindow(window) {
  window.count = 0
  window.sum = 0
  window.min = Infinity
  window.max = 0
}

function recordPerfSample(window, value) {
  if (!Number.isFinite(value)) return
  window.count++
  window.sum += value
  if (value < window.min) window.min = value
  if (value > window.max) window.max = value
}

function averagePerfWindow(window) {
  return window.count > 0 ? window.sum / window.count : 0
}

function createSenderPerfState() {
  return {
    batchMs: createPerfWindow(),
    buildMs: createPerfWindow(),
    blitMs: createPerfWindow(),
    totalMs: createPerfWindow(),
    intervalMs: createPerfWindow(),
    jitterMs: createPerfWindow(),
    framesSinceLog: 0,
    lastFrameStartMs: 0,
    overBudgetCount: 0
  }
}

function clearSenderPerfSamples(perf) {
  resetPerfWindow(perf.batchMs)
  resetPerfWindow(perf.buildMs)
  resetPerfWindow(perf.blitMs)
  resetPerfWindow(perf.totalMs)
  resetPerfWindow(perf.intervalMs)
  resetPerfWindow(perf.jitterMs)
  perf.framesSinceLog = 0
  perf.overBudgetCount = 0
}

function resetSenderPerfState() {
  state.txPerf = createSenderPerfState()
}

function resetHdmiFrameResources() {
  state.frameBuffer = null
  state.frameImageData = null
  state.frameBufferWidth = 0
  state.frameBufferHeight = 0
}

function ensureHdmiFrameResources(width, height) {
  if (
    state.frameBuffer &&
    state.frameImageData &&
    state.frameBufferWidth === width &&
    state.frameBufferHeight === height
  ) {
    return state.frameImageData
  }

  state.frameBuffer = createFrameBuffer(width, height)
  state.frameImageData = new ImageData(state.frameBuffer, width, height)
  state.frameBufferWidth = width
  state.frameBufferHeight = height
  return state.frameImageData
}

function logSenderSessionMetrics(phase, metrics, capacity) {
  const fps = getFps()
  debugLog(
    `${phase}: mode=${HDMI_MODE_NAMES[state.mode]} canvas=${metrics.width}x${metrics.height} ` +
    `target=${fps.fps}fps payload=${capacity} B/frame theoretical=${formatBytes(capacity * fps.fps)}/s ` +
    `source=${metrics.source} display=${metrics.displayWidth}x${metrics.displayHeight}@(${metrics.displayX},${metrics.displayY}) ` +
    `viewport=${metrics.viewportWidth}x${metrics.viewportHeight}`
  )
}

function noteSenderFramePerf(frameStartMs, batchMs, buildMs, blitMs, totalMs, fps, canvasWidth, canvasHeight) {
  const perf = state.txPerf
  if (!perf) return
  const targetIntervalMs = 1000 / fps.fps

  if (perf.lastFrameStartMs > 0) {
    const intervalMs = frameStartMs - perf.lastFrameStartMs
    recordPerfSample(perf.intervalMs, intervalMs)
    recordPerfSample(perf.jitterMs, Math.abs(intervalMs - targetIntervalMs))
  }
  perf.lastFrameStartMs = frameStartMs

  recordPerfSample(perf.batchMs, batchMs)
  recordPerfSample(perf.buildMs, buildMs)
  recordPerfSample(perf.blitMs, blitMs)
  recordPerfSample(perf.totalMs, totalMs)
  if (totalMs > targetIntervalMs) perf.overBudgetCount++
  perf.framesSinceLog++

  if (perf.framesSinceLog < TX_PERF_LOG_INTERVAL_FRAMES) return

  const avgIntervalMs = averagePerfWindow(perf.intervalMs)
  const deliveredFps = avgIntervalMs > 0 ? 1000 / avgIntervalMs : fps.fps
  debugLog(
    `TX perf: fps=${deliveredFps.toFixed(1)}/${fps.fps} ` +
    `interval=${avgIntervalMs.toFixed(2)}ms jitter=${averagePerfWindow(perf.jitterMs).toFixed(2)}ms ` +
    `batch=${averagePerfWindow(perf.batchMs).toFixed(2)}ms ` +
    `build=${averagePerfWindow(perf.buildMs).toFixed(2)}ms ` +
    `blit=${averagePerfWindow(perf.blitMs).toFixed(2)}ms ` +
    `total=${averagePerfWindow(perf.totalMs).toFixed(2)}ms ` +
    `overBudget=${perf.overBudgetCount}/${perf.totalMs.count} canvas=${canvasWidth}x${canvasHeight}`
  )

  clearSenderPerfSamples(perf)
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
  animationId: null,
  isSending: false,
  isPaused: false,
  isAwaitingStart: false,
  systematicIndex: 0,
  systematicStride: 1,
  intermediateSystematicStride: 1,
  paritySystematicIndex: 0,
  paritySystematicStride: 1,
  fountainSymbolId: 0,
  dataPacketCount: 0,
  frameCount: 0,
  mode: HDMI_MODE.COMPAT_4,
  renderSizePresetId: DEFAULT_RENDER_SIZE_PRESET,
  systematicPass: 1,
  tailStartFrame: 0,
  metadataIntervalFrames: METADATA_INTERVAL * 2,
  cimbarIdealRatio: 1,
  cimbarVariant: HDMI_CIMBAR_MODE,
  cimbarBoundsLogged: false,
  cimbarRenderCanvas: null,
  cimbarUseWrapper: false,
  cimbarLayout: null,
  nextFrameDueMs: 0,
  frameBuffer: null,
  frameImageData: null,
  frameBufferWidth: 0,
  frameBufferHeight: 0,
  txPerf: createSenderPerfState()
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
  if (elements?.placeholder) {
    elements.placeholder.style.position = ''
    elements.placeholder.style.zIndex = ''
    elements.placeholder.style.textAlign = ''
    elements.placeholder.style.padding = ''
  }
}

function setSignalLive(isLive) {
  if (!elements?.container) return
  elements.container.classList.toggle('signal-live', isLive)
  document.body?.classList.toggle('hdmi-uvc-signal-live', isLive)
}

function resetPreparedSessionState() {
  state.encoder = null
  state.packetSize = 0
  state.packetsPerFrame = 1
  state.isSending = false
  state.isPaused = false
  state.isAwaitingStart = false
  state.systematicIndex = 0
  state.systematicStride = 1
  state.intermediateSystematicStride = 1
  state.paritySystematicIndex = 0
  state.paritySystematicStride = 1
  state.fountainSymbolId = 0
  state.dataPacketCount = 0
  state.systematicPass = 1
  state.tailStartFrame = 0
  state.metadataIntervalFrames = METADATA_INTERVAL * 2
  state.frameCount = 0
  state.nextFrameDueMs = 0
  state.cimbarIdealRatio = 1
  state.cimbarBoundsLogged = false
  state.cimbarUseWrapper = false
  state.cimbarLayout = null
  state.animationId = null
  resetSenderPerfState()
}

async function restoreSenderReadyState() {
  resetRenderSchedule()
  resetHdmiFrameResources()
  resetPreparedSessionState()
  setSignalLive(false)
  resetCanvasStyles()
  await exitFullscreenSafely()
  elements.overlay.classList.add('hidden')
  elements.placeholder.style.display = 'flex'
  if (state.fileData) {
    elements.placeholderIcon.textContent = '✓'
    elements.placeholderText.textContent = 'File ready, click Start'
  } else {
    elements.placeholderIcon.textContent = '+'
    elements.placeholderText.textContent = 'Drop file here or tap to select'
  }
  elements.fpsSlider.disabled = false
  updateActionButton()
  updateModeSelector()
  updateRenderSizeSelector()
}

function applyFullscreenCanvasStyles() {
  elements.container.classList.add('fullscreen')
  elements.canvas.style.display = 'block'
  elements.canvas.style.position = 'absolute'
  elements.canvas.style.top = '0'
  elements.canvas.style.left = '0'
  elements.canvas.style.zIndex = '0'
  elements.canvas.style.imageRendering = 'pixelated'
  elements.canvas.style.background = '#000'
  elements.canvas.style.width = '100%'
  elements.canvas.style.height = '100%'
}

function clearSenderCanvasToBlack() {
  if (!elements?.canvas?.width || !elements?.canvas?.height) return
  const ctx = elements.canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, elements.canvas.width, elements.canvas.height)
}

function showArmedStartPrompt() {
  elements.overlay.classList.add('hidden')
  elements.placeholder.style.display = 'flex'
  elements.placeholder.style.position = 'relative'
  elements.placeholder.style.zIndex = '1'
  elements.placeholder.style.textAlign = 'center'
  elements.placeholder.style.padding = '1.5rem'
  elements.placeholderIcon.textContent = '>'
  elements.placeholderText.textContent = 'Fullscreen ready. Wait for the browser tip to disappear, then press Space or Enter to start.'
  debugCurrent('ARMED - press Space or Enter to start')
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

function getRenderSizePreset(id = state.renderSizePresetId) {
  return RENDER_SIZE_PRESETS.find((preset) => preset.id === id) ||
    RENDER_SIZE_PRESETS[0]
}

function fitRectWithin(boundsWidth, boundsHeight, contentWidth, contentHeight) {
  if (!boundsWidth || !boundsHeight || !contentWidth || !contentHeight) {
    return {
      width: Math.max(1, contentWidth || boundsWidth || 1),
      height: Math.max(1, contentHeight || boundsHeight || 1),
      x: 0,
      y: 0,
      scale: 1
    }
  }

  const scale = Math.min(boundsWidth / contentWidth, boundsHeight / contentHeight)
  const width = Math.max(1, Math.round(contentWidth * scale))
  const height = Math.max(1, Math.round(contentHeight * scale))

  return {
    width,
    height,
    x: Math.max(0, Math.floor((boundsWidth - width) / 2)),
    y: Math.max(0, Math.floor((boundsHeight - height) / 2)),
    scale
  }
}

function resolveHdmiCanvasMetrics(viewportMetrics = getCanvasViewportMetrics()) {
  const preset = getRenderSizePreset()
  const viewportWidth = Math.max(1, viewportMetrics.width)
  const viewportHeight = Math.max(1, viewportMetrics.height)

  if (preset.id === 'viewport') {
    return {
      ...viewportMetrics,
      viewportWidth,
      viewportHeight,
      width: viewportWidth,
      height: viewportHeight,
      source: viewportMetrics.source,
      renderPresetId: preset.id,
      renderPresetName: preset.name,
      displayWidth: viewportWidth,
      displayHeight: viewportHeight,
      displayX: 0,
      displayY: 0,
      displayScale: 1
    }
  }

  const internalWidth = preset.width
  const internalHeight = preset.height
  const fitted = fitRectWithin(viewportWidth, viewportHeight, internalWidth, internalHeight)

  return {
    ...viewportMetrics,
    viewportWidth,
    viewportHeight,
    width: internalWidth,
    height: internalHeight,
    source: `preset:${preset.id}`,
    renderPresetId: preset.id,
    renderPresetName: preset.name,
    displayWidth: fitted.width,
    displayHeight: fitted.height,
    displayX: fitted.x,
    displayY: fitted.y,
    displayScale: fitted.scale
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
  ensureCimbarRenderCanvas(layout.renderWidth, layout.renderHeight)

  debugLog(`Canvas: CIMBAR provisional ${layout.renderWidth}x${layout.renderHeight} before configure`)
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
    tile.renderX,
    tile.renderY,
    tile.renderW,
    tile.renderH
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

  const renderCanvas = ensureCimbarRenderCanvas(layout.renderWidth, layout.renderHeight)
  Module.canvas = renderCanvas
  if (typeof Module?.setCanvasSize === 'function') {
    Module.setCanvasSize(layout.renderWidth, layout.renderHeight)
  } else {
    renderCanvas.width = layout.renderWidth
    renderCanvas.height = layout.renderHeight
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
    `(content=${layout.contentWidth}x${layout.contentHeight}, render=${layout.renderWidth}x${layout.renderHeight}, ` +
    `tile=${layout.tileOuterWidth}x${layout.tileOuterHeight}, ` +
    `gap=${layout.gap}, composition=${layout.composition.w}x${layout.composition.h}@(${layout.composition.x},${layout.composition.y}), ` +
    `pad t=${layout.padding.top}, r=${layout.padding.right}, ` +
    `b=${layout.padding.bottom}, l=${layout.padding.left}, ` +
    `tiles=${layout.tileCount}, ratio=${ratio.toFixed(3)}, landscape=${landscapeViewport}, rotate=${rotateFlag}, scale=1.00)`
  )
  debugLog(
    `Canvas internal: ${elements.canvas.width}x${elements.canvas.height} ` +
    `(render=${state.cimbarRenderCanvas.width}x${state.cimbarRenderCanvas.height}, tiles=${layout.tileCount})`
  )
}

function measureAndApplyCanvasSize(viewportMetrics = getCanvasViewportMetrics()) {
  const metrics = resolveHdmiCanvasMetrics(viewportMetrics)

  elements.canvas.width = metrics.width
  elements.canvas.height = metrics.height
  elements.canvas.style.setProperty('width', `${metrics.displayWidth}px`, 'important')
  elements.canvas.style.setProperty('height', `${metrics.displayHeight}px`, 'important')
  elements.canvas.style.left = `${metrics.displayX}px`
  elements.canvas.style.top = `${metrics.displayY}px`

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
  debugLog(
    `Canvas: internal ${metrics.width}x${metrics.height} (${metrics.source}, preset=${metrics.renderPresetName}), ` +
    `display ${metrics.displayWidth}x${metrics.displayHeight}@(${metrics.displayX},${metrics.displayY}) ` +
    `within viewport ${metrics.viewportWidth}x${metrics.viewportHeight}, ` +
    `scale=${metrics.displayScale.toFixed(3)}, data region ${dataWidth}x${dataHeight} (${dataUtil}% of frame)`
  )
  if (metrics.renderPresetId !== 'viewport' && Math.abs(metrics.displayScale - 1) > 0.001) {
    debugLog(
      `Render scale warning: preset ${metrics.renderPresetName} is being resampled to ` +
      `${metrics.displayWidth}x${metrics.displayHeight} (scale=${metrics.displayScale.toFixed(3)}); ` +
      'expect lower payload robustness on the active display path'
    )
  }

  return { metrics, capacity }
}

function getRenderScaleIssue(metrics) {
  if (!metrics || metrics.renderPresetId === 'viewport') return null
  if (Math.abs(metrics.displayScale - 1) <= 0.001) return null

  return (
    `Render preset ${metrics.renderPresetName} requires 1:1 presentation, but the active display path ` +
    `would resample it to ${metrics.displayWidth}x${metrics.displayHeight} ` +
    `(scale=${metrics.displayScale.toFixed(3)}). Use Viewport mode or change browser/display scaling.`
  )
}

function cancelScheduledRender() {
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
  }
  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }
}

function resetRenderSchedule() {
  cancelScheduledRender()
  state.nextFrameDueMs = 0
}

function scheduleNextRender() {
  if (!state.isSending || state.isPaused) return

  const fps = getFps()
  const targetIntervalMs = 1000 / fps.fps
  if (!state.nextFrameDueMs) {
    state.nextFrameDueMs = performance.now() + targetIntervalMs
  }

  const armRender = () => {
    if (!state.isSending || state.isPaused) return

    const waitMs = state.nextFrameDueMs - performance.now()
    if (waitMs > 8) {
      state.timerId = setTimeout(() => {
        state.timerId = null
        armRender()
      }, Math.max(0, waitMs - 4))
      return
    }

    state.animationId = requestAnimationFrame((now) => {
      state.animationId = null
      if (!state.isSending || state.isPaused) return

      if (now + 0.25 < state.nextFrameDueMs) {
        armRender()
        return
      }

      state.nextFrameDueMs += targetIntervalMs
      if (state.nextFrameDueMs < now) {
        state.nextFrameDueMs = now + targetIntervalMs
      }
      renderFrame()
    })
  }

  armRender()
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
  } else if (state.isAwaitingStart) {
    btn.textContent = 'Press Space'
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

function updateEstimateSummary() {
  if (!elements?.estimate) return
  const preset = getRenderSizePreset()
  elements.estimate.textContent = `Render ${preset.name}`
}

function updateModeSelector() {
  const buttons = elements.modeButtons || []
  const disabled = state.isSending || state.isPaused || state.isAwaitingStart

  for (const button of buttons) {
    const mode = parseInt(button.dataset.mode, 10)
    button.classList.toggle('active', mode === state.mode)
    button.disabled = disabled
  }

  state.cimbarVariant = HDMI_CIMBAR_MODE
}

function updateRenderSizeSelector() {
  if (!elements?.renderSizeSelect) return
  elements.renderSizeSelect.value = getRenderSizePreset().id
  elements.renderSizeSelect.disabled = state.isSending || state.isPaused || state.isAwaitingStart || isCimbarMode()
  updateEstimateSummary()
}

// Once the HDMI-UVC decode path is stable, repeating every symbol wastes most
// of the available bandwidth. Let fountain redundancy absorb frame loss.
const FRAMES_PER_SYMBOL = 1
const METADATA_BURST_FRAMES = 4
const BOOTSTRAP_METADATA_INTERVAL_FRAMES = 12
const BOOTSTRAP_METADATA_WINDOW_FRAMES = 180
const MIN_METADATA_INTERVAL_FRAMES = 90
const MAX_METADATA_INTERVAL_FRAMES = 90
const MIN_BLOCK_SIZE = 512
const MAX_BLOCK_SIZE = 3072
const TARGET_SOURCE_BLOCKS = 128
const HYBRID_FOUNTAIN_PACKET_INTERVAL = 8
const RAW_RGB_PASS2_FOUNTAIN_PACKET_INTERVAL = 2
const RAW_RGB_PASS3_FOUNTAIN_PACKET_INTERVAL = 1
const COMPAT4_PASS2_FOUNTAIN_PACKET_INTERVAL = 8
const COMPAT4_PASS3_FOUNTAIN_PACKET_INTERVAL = 4
const COMPAT4_PASS4_FOUNTAIN_PACKET_INTERVAL = 2
const COMPAT4_PASS5_FOUNTAIN_PACKET_INTERVAL = 1
const COMPAT4_PASS6_FOUNTAIN_PACKET_INTERVAL = 1
const COMPAT4_PASS7_FOUNTAIN_PACKET_INTERVAL = 1
const TAIL_SYSTEMATIC_BURST_PERIOD_FRAMES = 6
const TAIL_SYSTEMATIC_BURST_FRAMES = 1

function computeMetadataIntervalFrames() {
  if (!state.encoder || !state.packetsPerFrame) return MIN_METADATA_INTERVAL_FRAMES
  const cycleFrames = Math.ceil(state.encoder.K_prime / state.packetsPerFrame)
  if (state.mode === HDMI_MODE.RAW_RGB) {
    const targetInterval = Math.ceil(cycleFrames / 3)
    return Math.max(45, Math.min(120, targetInterval))
  }
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
      // Four calibrated colors per 4x4 block. The current HDMI-UVC path is
      // packet-loss limited, so bias toward a lighter per-frame load rather
      // than maxing out nominal frame capacity. Keep shard size moderate, but
      // trim total slots and fill so more packets survive end-to-end.
      return {
        maxPacketsPerFrame: 10,
        targetFrameFill: 0.36,
        maxBlockSize: 896,
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
    case HDMI_MODE.LUMA_2:
      // Luma2 keeps the 4x4 grid but replaces fragile mid-tones/chroma with a
      // balanced black/white quadrant alphabet. Start just above the proven
      // binary 4x4 byte budget so live results isolate symbol robustness.
      return {
        maxPacketsPerFrame: 10,
        targetFrameFill: 0.32,
        maxBlockSize: 896,
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
    default:
      return { maxPacketsPerFrame: 4, targetFrameFill: 0.90, maxBlockSize: MAX_BLOCK_SIZE, maxUsedBytes: null }
  }
}

function usesMixedSlotReplay() {
  return (
    state.mode === HDMI_MODE.COMPAT_4 ||
    state.mode === HDMI_MODE.LUMA_2 ||
    state.mode === HDMI_MODE.CODEBOOK_3
  )
}

function shouldSendMetadata(frameNumber) {
  if (frameNumber <= METADATA_BURST_FRAMES) return true
  if (
    frameNumber <= BOOTSTRAP_METADATA_WINDOW_FRAMES &&
    (frameNumber % BOOTSTRAP_METADATA_INTERVAL_FRAMES) === 0
  ) {
    return true
  }
  return frameNumber % state.metadataIntervalFrames === 0
}

function getFountainPacketInterval() {
  if (state.mode === HDMI_MODE.RAW_RGB) {
    if (state.systematicPass >= 3) return RAW_RGB_PASS3_FOUNTAIN_PACKET_INTERVAL
    if (state.systematicPass >= 2) return RAW_RGB_PASS2_FOUNTAIN_PACKET_INTERVAL
    return HYBRID_FOUNTAIN_PACKET_INTERVAL
  }
  if (
    state.mode !== HDMI_MODE.COMPAT_4 &&
    state.mode !== HDMI_MODE.LUMA_2 &&
    state.mode !== HDMI_MODE.CODEBOOK_3
  ) {
    return HYBRID_FOUNTAIN_PACKET_INTERVAL
  }
  if (state.systematicPass >= 7) return COMPAT4_PASS7_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 6) return COMPAT4_PASS6_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 5) return COMPAT4_PASS5_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 4) return COMPAT4_PASS4_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 3) return COMPAT4_PASS3_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 2) return COMPAT4_PASS2_FOUNTAIN_PACKET_INTERVAL
  return HYBRID_FOUNTAIN_PACKET_INTERVAL
}

function getHybridScheduleDescription() {
  if (state.mode === HDMI_MODE.RAW_RGB) {
    return (
      'Hybrid schedule: source-only pass 1, then fountain every ' +
      `${RAW_RGB_PASS2_FOUNTAIN_PACKET_INTERVAL}/${RAW_RGB_PASS3_FOUNTAIN_PACKET_INTERVAL} ` +
      `data packets in later Color4 replay passes (default=${HYBRID_FOUNTAIN_PACKET_INTERVAL})`
    )
  }

  if (
    state.mode === HDMI_MODE.COMPAT_4 ||
    state.mode === HDMI_MODE.LUMA_2 ||
    state.mode === HDMI_MODE.CODEBOOK_3
  ) {
    const modeName =
      state.mode === HDMI_MODE.LUMA_2
        ? 'Luma2'
        : state.mode === HDMI_MODE.CODEBOOK_3
          ? 'Tile3'
          : '4x4'
    return (
      `Hybrid schedule: source-only pass 1, then mixed ${modeName} slot replay ` +
      `(5S/1P, 4S/1P/1F, 3S/1P/2F, 1S/2P/3F)`
    )
  }

  return `Hybrid schedule: source-only pass 1, then fountain every ${HYBRID_FOUNTAIN_PACKET_INTERVAL} data packets`
}

function describeFountainInterval(interval) {
  return interval > 0
    ? `fountain every ${interval} data packet(s)`
    : 'source-only'
}

function getSlotMixPatternForPass(passNumber) {
  if (!usesMixedSlotReplay()) return null
  if (passNumber <= 1) return ['source', 'source', 'source', 'source', 'source', 'source']
  if (passNumber === 2) {
    // Default `p2`: 4S/2P — emit parity earlier so the receiver can start
    // running parity recovery before the source replay completes.
    // `mix`: 2S/2P/2F — aggressive, useful when source arrival is already
    // saturated. `legacy`: historical 5S/1P, kept as an escape hatch.
    if (PASS2_VARIANT === 'legacy') {
      return ['source', 'source', 'source', 'source', 'source', 'parity']
    }
    if (PASS2_VARIANT === 'mix') {
      return ['source', 'source', 'parity', 'parity', 'fountain', 'fountain']
    }
    // `p2` and any unrecognized value fall through to the new default.
    return ['source', 'source', 'source', 'source', 'parity', 'parity']
  }
  if (passNumber === 3) return ['source', 'source', 'source', 'source', 'parity', 'fountain']
  if (passNumber === 4) return ['source', 'source', 'source', 'parity', 'fountain', 'fountain']
  return ['source', 'parity', 'parity', 'fountain', 'fountain', 'fountain']
}

function describeSlotMixPattern(pattern) {
  if (!pattern || pattern.length === 0) return 'systematic'
  const counts = { source: 0, parity: 0, fountain: 0 }
  for (const slot of pattern) {
    if (counts[slot] !== undefined) counts[slot]++
  }
  const parts = []
  if (counts.source) parts.push(`${counts.source}S`)
  if (counts.parity) parts.push(`${counts.parity}P`)
  if (counts.fountain) parts.push(`${counts.fountain}F`)
  return parts.join('/')
}

function getCurrentSystematicSpan() {
  if (!state.encoder) return 0
  if (usesMixedSlotReplay()) return state.encoder.K
  return state.systematicPass <= 1 ? state.encoder.K : state.encoder.K_prime
}

function getCurrentSystematicStride() {
  if (!state.encoder) return 1
  if (usesMixedSlotReplay()) return state.systematicStride
  return state.systematicPass <= 1
    ? state.systematicStride
    : state.intermediateSystematicStride
}

function getCurrentSystematicLabel() {
  if (usesMixedSlotReplay()) return 'mixed'
  return state.systematicPass <= 1 ? 'source' : 'intermediate'
}

function getSystematicPassIndexOffset(sourceSpan, passNumber = state.systematicPass) {
  if (sourceSpan <= 1) return 0
  if (passNumber === 1) return 0
  if (passNumber === 2) return Math.floor(sourceSpan / 2)
  if (passNumber === 3) return Math.floor(sourceSpan / 4)
  if (passNumber === 4) return Math.floor((sourceSpan * 3) / 4)
  if (passNumber === 5) return Math.floor(sourceSpan / 8)
  return Math.floor((sourceSpan * 5) / 8)
}

function getParitySystematicSpan() {
  if (!state.encoder) return 0
  return Math.max(0, state.encoder.K_prime - state.encoder.K)
}

function getSystematicSymbolIdForPass(index, span, stride, passNumber, base = 0) {
  if (span <= 0) return base + 1
  const passOffset = getSystematicPassIndexOffset(span, passNumber)
  return base + ((((index + passOffset) * stride) % span) + 1)
}

function advanceMixedReplayPass(frameNumber) {
  state.systematicPass++
  state.systematicIndex = 0
  const paritySpan = getParitySystematicSpan()
  const pattern = getSlotMixPatternForPass(state.systematicPass)
  debugLog(
    `Starting mixed replay pass ${state.systematicPass} at frame ${frameNumber + 1} ` +
    `(mix=${describeSlotMixPattern(pattern)}, ` +
    `source stride=${state.systematicStride}/${state.encoder.K}, ` +
    `offset=${getSystematicPassIndexOffset(state.encoder.K)}/${state.encoder.K}, ` +
    `parity stride=${state.paritySystematicStride}/${paritySpan || 1})`
  )
}

function nextSourceSystematicSymbolId(frameNumber) {
  const span = state.encoder.K
  const symbolId = getSystematicSymbolIdForPass(
    state.systematicIndex,
    span,
    state.systematicStride,
    state.systematicPass
  )
  state.systematicIndex++
  if (state.systematicIndex >= span) {
    advanceMixedReplayPass(frameNumber)
  }
  return symbolId
}

function nextParitySystematicSymbolId() {
  const paritySpan = getParitySystematicSpan()
  if (paritySpan <= 0) return state.encoder.K
  const symbolId = getSystematicSymbolIdForPass(
    state.paritySystematicIndex,
    paritySpan,
    state.paritySystematicStride,
    state.systematicPass,
    state.encoder.K
  )
  state.paritySystematicIndex = (state.paritySystematicIndex + 1) % paritySpan
  return symbolId
}

function nextDataSymbolId(frameNumber, strategy = 'auto') {
  if (usesMixedSlotReplay()) {
    let symbolId
    if (strategy === 'fountain') {
      symbolId = state.fountainSymbolId++
    } else if (strategy === 'parity') {
      symbolId = nextParitySystematicSymbolId()
    } else {
      symbolId = nextSourceSystematicSymbolId(frameNumber)
    }
    if (frameNumber % FRAMES_PER_SYMBOL === 0) {
      state.dataPacketCount++
    }
    return symbolId
  }

  const systematicSpan = getCurrentSystematicSpan()
  const systematicStride = getCurrentSystematicStride()
  const fountainPacketInterval = getFountainPacketInterval()
  const shouldSendFountain =
    strategy !== 'systematic' && (
      strategy === 'fountain' ||
      (
        fountainPacketInterval > 0 &&
        state.systematicPass > 1 &&
        state.fountainSymbolId > state.encoder.K_prime &&
        state.dataPacketCount > 0 &&
        state.dataPacketCount % fountainPacketInterval === 0
      )
    )

  let symbolId
  if (shouldSendFountain) {
    symbolId = state.fountainSymbolId++
  } else {
    const passOffset = getSystematicPassIndexOffset(systematicSpan)
    symbolId = (((state.systematicIndex + passOffset) * systematicStride) % systematicSpan) + 1
    if (frameNumber % FRAMES_PER_SYMBOL === 0) {
      state.systematicIndex++
      if (state.systematicIndex >= systematicSpan) {
        state.systematicPass++
        state.systematicIndex = 0
        if (
          state.tailStartFrame === 0 &&
          (
            state.mode === HDMI_MODE.COMPAT_4 ||
            state.mode === HDMI_MODE.LUMA_2 ||
            state.mode === HDMI_MODE.CODEBOOK_3
          ) &&
          state.systematicPass >= 5
        ) {
          state.tailStartFrame = frameNumber + 1
          debugLog(
            `Late-phase schedule: systematic burst frames start at frame ${state.tailStartFrame} ` +
            `(every ${TAIL_SYSTEMATIC_BURST_PERIOD_FRAMES} frame(s))`
          )
        }
        const nextSpan = getCurrentSystematicSpan()
        const nextStride = getCurrentSystematicStride()
        const nextLabel = getCurrentSystematicLabel()
        debugLog(
          `Starting ${nextLabel} replay pass ${state.systematicPass} at frame ${frameNumber + 1} ` +
          `(stride=${nextStride}/${nextSpan}, ` +
          `offset=${getSystematicPassIndexOffset(nextSpan)}/${nextSpan}, ` +
          `${describeFountainInterval(getFountainPacketInterval())})`
        )
      }
    }
  }

  if (frameNumber % FRAMES_PER_SYMBOL === 0) {
    state.dataPacketCount++
  }

  return symbolId
}

function isTailSystematicBurstFrame(frameNumber) {
  if (usesMixedSlotReplay()) return false
  if (
    state.mode !== HDMI_MODE.COMPAT_4 &&
    state.mode !== HDMI_MODE.LUMA_2 &&
    state.mode !== HDMI_MODE.CODEBOOK_3
  ) {
    return false
  }
  if (state.tailStartFrame <= 0 || frameNumber < state.tailStartFrame) return false

  const tailFrameIndex = frameNumber - state.tailStartFrame
  return (tailFrameIndex % TAIL_SYSTEMATIC_BURST_PERIOD_FRAMES) < TAIL_SYSTEMATIC_BURST_FRAMES
}

function buildFramePacketBatch(frameNumber) {
  const sendMetadata = shouldSendMetadata(frameNumber)
  const packets = []
  const symbolIds = []
  const slots = Math.max(1, state.packetsPerFrame)
  const tailSystematicBurst = isTailSystematicBurstFrame(frameNumber)
  const slotMixPattern = getSlotMixPatternForPass(state.systematicPass)

  if (sendMetadata) {
    packets.push(state.encoder.generateSymbol(0))
    symbolIds.push(0)
  }

  let dataSlotsBuilt = 0
  while (packets.length < slots) {
    let strategy = tailSystematicBurst ? 'systematic' : 'auto'
    if (slotMixPattern) {
      strategy = slotMixPattern[Math.min(dataSlotsBuilt, slotMixPattern.length - 1)] || 'source'
    }
    const symbolId = nextDataSymbolId(frameNumber, strategy)
    packets.push(state.encoder.generateSymbol(symbolId))
    symbolIds.push(symbolId)
    dataSlotsBuilt++
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

      scheduleNextRender()
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
    const frameStartMs = performance.now()
    const batch = buildFramePacketBatch(nextFrameNumber)
    const batchReadyMs = performance.now()

    const frameImageData = ensureHdmiFrameResources(cw, ch)
    buildFrame(batch.payload, state.mode, cw, ch, fps.fps, batch.outerSymbolId, state.frameBuffer)
    const buildDoneMs = performance.now()

    const ctx = elements.canvas.getContext('2d')
    ctx.putImageData(frameImageData, 0, 0)
    const blitDoneMs = performance.now()

    state.frameCount = nextFrameNumber
    elements.frameCount.textContent = state.frameCount

    const systematicSpan = Math.max(1, getCurrentSystematicSpan())
    const progress = Math.min(100, Math.round((state.systematicIndex / systematicSpan) * 100))
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

    noteSenderFramePerf(
      frameStartMs,
      batchReadyMs - frameStartMs,
      buildDoneMs - batchReadyMs,
      blitDoneMs - buildDoneMs,
      blitDoneMs - frameStartMs,
      fps,
      cw,
      ch
    )

    scheduleNextRender()

  } catch (err) {
    debugLog(`ERROR: ${err.message}`)
    showError('Frame render error: ' + err.message)
  }
}

function armPreparedStart() {
  state.isAwaitingStart = true
  state.isSending = false
  state.isPaused = false
  state.nextFrameDueMs = 0
  clearSenderCanvasToBlack()
  showArmedStartPrompt()
  setSignalLive(false)

  elements.fpsSlider.disabled = true
  updateActionButton()
  updateModeSelector()
  updateRenderSizeSelector()
  debugLog('Sender armed: wait for the fullscreen tip to clear, then press Space or Enter to begin transmission')
}

function beginPreparedStart() {
  if (!state.fileData) return
  if (isCimbarMode()) {
    const Module = getCimbarModule()
    if (!Module) return
  } else if (!state.encoder) {
    return
  }

  debugLog('=== START SENDING ===')
  state.isAwaitingStart = false
  state.isSending = true
  state.isPaused = false
  state.frameCount = 0
  state.nextFrameDueMs = performance.now() + (1000 / getFps().fps)
  resetSenderPerfState()
  elements.placeholder.style.display = 'none'
  setSignalLive(true)

  elements.fpsSlider.disabled = true
  updateActionButton()
  updateModeSelector()
  updateRenderSizeSelector()
  renderFrame()
}

async function cancelArmedStart(reason = 'Armed start cancelled') {
  if (!state.isAwaitingStart) return
  debugLog(reason)
  await restoreSenderReadyState()
}

async function startSending() {
  if (!state.fileData || !state.fileHash) return

  try {
    debugLog('=== ARMING FULLSCREEN START ===')
    const selectedFps = getFps()

    // Go fullscreen to eliminate browser chrome from the HDMI output.
    // This ensures anchors are at the true corners with no toolbar artifacts.
    applyFullscreenCanvasStyles()

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
    debugLog(`Sender FPS: ${selectedFps.name} (${selectedFps.interval}ms interval)`)

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

      state.cimbarBoundsLogged = false
      armPreparedStart()
      return
    }

    const { metrics, capacity } = measureAndApplyCanvasSize(stableMetrics)
    const renderScaleIssue = getRenderScaleIssue(metrics)
    if (renderScaleIssue) {
      throw new Error(renderScaleIssue)
    }
    logSenderSessionMetrics('Start session', metrics, capacity)
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
    debugLog(`Pass-2 variant: ${PASS2_VARIANT}`)
    debugLog(`Payload capacity: ${capacity} bytes/frame (max packet payload ${frameBlockSize})`)
    debugLog(
      `Batch profile: maxPackets=${maxPacketsPerFrame}, ` +
      `targetFill=${(targetFrameFill * 100).toFixed(0)}%, maxBlockSize=${maxBlockSize}, ` +
      `maxUsedBytes=${maxUsedBytes ?? 'none'}`
    )
    debugLog(`File: ${state.fileName} (${formatBytes(state.fileSize)}), blockSize: ${blockSize}`)

    state.encoder = createEncoder(
      state.fileData,
      state.fileName,
      'application/octet-stream',
      state.fileHash,
      blockSize
    )
    state.packetSize = blockSize + PACKET_HEADER_SIZE
    state.packetsPerFrame = bestPacketsPerFrame
    state.metadataIntervalFrames = computeMetadataIntervalFrames()
    const batchedBytes = bestUsedBytes
    const utilization = ((batchedBytes / capacity) * 100).toFixed(1)

    debugLog(`Encoder: K=${state.encoder.K}, K'=${state.encoder.K_prime}`)
    debugLog(
      `Metadata schedule: burst=${METADATA_BURST_FRAMES} frame(s), ` +
      `bootstrap=${BOOTSTRAP_METADATA_INTERVAL_FRAMES} frame(s) through frame ${BOOTSTRAP_METADATA_WINDOW_FRAMES}, ` +
      `interval=${state.metadataIntervalFrames} frame(s)`
    )
    debugLog(`Batching: ${state.packetsPerFrame} packet(s)/frame, packetSize=${state.packetSize}, used=${batchedBytes}/${capacity} bytes (${utilization}%)`)

    state.systematicIndex = 0
    state.systematicStride = chooseSystematicStride(state.encoder.K)
    state.intermediateSystematicStride = chooseSystematicStride(state.encoder.K_prime)
    state.paritySystematicIndex = 0
    state.paritySystematicStride = chooseSystematicStride(Math.max(1, state.encoder.K_prime - state.encoder.K))
    state.fountainSymbolId = state.encoder.K_prime + 1
    state.dataPacketCount = 0
    state.systematicPass = 1
    state.tailStartFrame = 0
    state.frameCount = 0
    resetSenderPerfState()
    if (usesMixedSlotReplay()) {
      debugLog(
        `Systematic order: source stride=${state.systematicStride}/${state.encoder.K}, ` +
        `parity stride=${state.paritySystematicStride}/${Math.max(1, state.encoder.K_prime - state.encoder.K)}`
      )
    } else {
      debugLog(
        `Systematic order: source stride=${state.systematicStride}/${state.encoder.K}, ` +
        `intermediate stride=${state.intermediateSystematicStride}/${state.encoder.K_prime}`
      )
    }
    debugLog(getHybridScheduleDescription())
    armPreparedStart()

  } catch (err) {
    console.error('HDMI-UVC start error:', err)
    await restoreSenderReadyState()
    showError('Failed to start: ' + err.message)
  }
}

async function pauseSending() {
  state.isPaused = true
  setSignalLive(false)
  cancelScheduledRender()

  resetCanvasStyles()
  await exitFullscreenSafely()
  elements.overlay.classList.add('hidden')
  elements.placeholder.style.display = 'flex'
  elements.placeholderIcon.textContent = '⏸'
  elements.placeholderText.textContent = 'Transfer paused - ' + state.frameCount + ' frames sent'

  elements.fpsSlider.disabled = false
  updateActionButton()
  updateModeSelector()
  updateRenderSizeSelector()
}

async function resumeSending() {
  try {
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
      const { metrics, capacity } = measureAndApplyCanvasSize(stableMetrics)
      const renderScaleIssue = getRenderScaleIssue(metrics)
      if (renderScaleIssue) {
        throw new Error(renderScaleIssue)
      }
      logSenderSessionMetrics('Resume session', metrics, capacity)
    }
    state.nextFrameDueMs = performance.now() + (1000 / getFps().fps)
    resetSenderPerfState()

    elements.fpsSlider.disabled = true
    updateActionButton()
    updateModeSelector()
    updateRenderSizeSelector()
    renderFrame()
  } catch (err) {
    console.error('HDMI-UVC resume error:', err)
    state.isPaused = true
    await restoreSenderReadyState()
    showError('Failed to resume: ' + err.message)
  }
}

async function stopSending() {
  resetRenderSchedule()
  resetHdmiFrameResources()
  resetPreparedSessionState()

  state.fileData = null
  state.fileName = null
  state.fileSize = 0
  state.fileHash = null
  setSignalLive(false)

  elements.fpsSlider.disabled = false

  resetCanvasStyles()
  await exitFullscreenSafely()
  elements.placeholder.style.display = 'flex'
  elements.overlay.classList.add('hidden')
  elements.placeholderIcon.textContent = '+'
  elements.placeholderText.textContent = 'Drop file here or tap to select'
  elements.fileInfo.textContent = 'No file'
  elements.fileInput.value = ''

  updateDropZoneState()
  updateActionButton()
  updateModeSelector()
  updateRenderSizeSelector()
}

function handleActionClick() {
  if (!state.fileData) return

  if (state.isAwaitingStart) return

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
    resetPreparedSessionState()
    state.isSending = false
    state.isPaused = false

    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ')'

    elements.placeholderIcon.textContent = '✓'
    elements.placeholderText.textContent = 'File ready, click Start'

    updateDropZoneState()
    updateActionButton()
    updateRenderSizeSelector()

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
  updateEstimateSummary()
}

function getRecommendedFpsPreset(mode = state.mode) {
  return mode === HDMI_MODE.CIMBAR ||
    mode === HDMI_MODE.COMPAT_4 ||
    mode === HDMI_MODE.RAW_RGB ||
    mode === HDMI_MODE.LUMA_2
    ? '1'
    : String(DEFAULT_FPS_PRESET)
}

function handleModeChange(e) {
  const button = e.currentTarget
  const newMode = parseInt(button.dataset.mode, 10)
  if (!Number.isFinite(newMode) || newMode === state.mode) return
  if (state.isSending || state.isPaused || state.isAwaitingStart) return

  state.mode = newMode
  const recommendedFpsPreset = getRecommendedFpsPreset(state.mode)
  if (elements.fpsSlider && elements.fpsSlider.value !== recommendedFpsPreset) {
    elements.fpsSlider.value = recommendedFpsPreset
    handleFpsChange()
  }
  updateModeSelector()
  updateRenderSizeSelector()
  debugLog(`HDMI mode selected: ${HDMI_MODE_NAMES[state.mode]}`)
}

function handleRenderSizeChange(e) {
  if (state.isAwaitingStart) return
  const preset = getRenderSizePreset(e.target.value)
  if (preset.id === state.renderSizePresetId) return

  state.renderSizePresetId = preset.id
  updateRenderSizeSelector()
  debugLog(`Render size selected: ${preset.name}`)
}

function handleKeydown(e) {
  if (state.isAwaitingStart) {
    if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      beginPreparedStart()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      void cancelArmedStart('Armed start cancelled before transmission')
      return
    }
  }

  if (e.key === 'Escape' && state.isSending) {
    stopSending()
  }
}

function handleFullscreenChange() {
  if (state.isAwaitingStart && !document.fullscreenElement) {
    void cancelArmedStart('Fullscreen exited before transmission started')
    return
  }
  // If we were sending and fullscreen was exited (e.g. by pressing Escape), pause
  if (state.isSending && !state.isPaused && !document.fullscreenElement) {
    pauseSending()
  }
}

async function exitFullscreenSafely() {
  if (!document.fullscreenElement) return
  try {
    await document.exitFullscreen()
  } catch {
    // Ignore fullscreen exit failures during cleanup.
  }
}

export async function resetHdmiUvcSender() {
  await stopSending()
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
    renderSizeSelect: document.getElementById('hdmi-uvc-render-size-select'),
    fpsSlider: document.getElementById('hdmi-uvc-fps-slider'),
    fpsDisplay: document.getElementById('hdmi-uvc-fps-display'),
    fileInfo: document.getElementById('hdmi-uvc-file-info'),
    estimate: document.getElementById('hdmi-uvc-estimate'),
    btnAction: document.getElementById('btn-hdmi-uvc-action'),
    btnStop: document.getElementById('btn-hdmi-uvc-stop')
  }
  elements.modeButtons = Array.from(elements.modeSelector?.querySelectorAll('.mode-btn') || [])

  elements.fpsSlider.value = getRecommendedFpsPreset(state.mode)
  if (elements.renderSizeSelect) {
    elements.renderSizeSelect.value = getRenderSizePreset().id
  }

  updateDropZoneState()
  updateActionButton()
  handleFpsChange()
  updateModeSelector()
  updateRenderSizeSelector()

  elements.fileInput.onchange = handleFileSelect
  elements.renderSizeSelect.oninput = handleRenderSizeChange
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
