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
import {
  buildFrame,
  buildNativeGeometryGuidance,
  createFrameBuffer,
  getDataRegion,
  getPayloadCapacity,
  hasEffectiveOneToOnePresentation,
  isNative1080pGeometry
} from './hdmi-uvc-frame.js'
import { buildCard, CARD_KIND } from './hdmi-uvc-lab.js'
import { loadHdmiUvcWasm } from './hdmi-uvc-wasm.js'
import { getPass2Variant, renderDiagnosticsPanel } from './hdmi-uvc-diagnostics.js'

// Kick off WASM instantiation when the sender module loads so buildFrame's
// payload CRC uses the WASM kernel from the first transmitted frame. Errors
// fall through to the JS crc32 fallback in frame.js.
loadHdmiUvcWasm().catch(() => {})

// Debug mode - always on while diagnosing HDMI-UVC issues
const DEBUG_MODE = true
// Pass-2 slot-mix variant lives in the diagnostics module: default `p2` (4S/2P)
// per the clean-run feedback, with `legacy` (5S/1P historical) and `mix`
// (2S/2P/2F aggressive) available via the sender diagnostics panel. The
// value is read per-pass so changes apply on the next TX session without a
// reload. See docs/plans/2026-04-17-hdmi-tail-solver-and-rx-hardening.md Phase 3.
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

  const el = typeof document !== 'undefined'
    ? document.getElementById('hdmi-uvc-sender-debug-log')
    : null
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
  labCardActive: false,
  armedStartTimerId: null,
  systematicIndex: 0,
  systematicStride: 1,
  intermediateSystematicStride: 1,
  paritySystematicIndex: 0,
  paritySweepsInPass: 0,
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
  presentation: null,
  useExternalDisplay: true,
  txPerf: createSenderPerfState()
}

let elements = null
let showError = (msg) => console.error(msg)

const LAB_CARD_KIND_BY_VALUE = {
  binary4: CARD_KIND.BINARY_4,
  binary3: CARD_KIND.BINARY_3,
  binary2: CARD_KIND.BINARY_2,
  luma2: CARD_KIND.LUMA_2,
  codebook3: CARD_KIND.CODEBOOK_3,
  glyph5: CARD_KIND.GLYPH_5,
  candidate: CARD_KIND.CANDIDATE
}

function screenDimension(screen, primary, fallback = 0) {
  const value = screen?.[primary]
  if (Number.isFinite(value)) return Math.round(value)
  const fallbackValue = screen?.[fallback]
  return Number.isFinite(fallbackValue) ? Math.round(fallbackValue) : 0
}

function screenLeft(screen) {
  return screenDimension(screen, 'availLeft', 'left')
}

function screenTop(screen) {
  return screenDimension(screen, 'availTop', 'top')
}

function screenWidth(screen) {
  return screenDimension(screen, 'availWidth', 'width')
}

function screenHeight(screen) {
  return screenDimension(screen, 'availHeight', 'height')
}

function screenHasUsableBounds(screen) {
  return screenWidth(screen) > 0 && screenHeight(screen) > 0
}

function screenArea(screen) {
  return screenWidth(screen) * screenHeight(screen)
}

function sameScreen(a, b) {
  if (!a || !b) return false
  return screenLeft(a) === screenLeft(b) &&
    screenTop(a) === screenTop(b) &&
    screenWidth(a) === screenWidth(b) &&
    screenHeight(a) === screenHeight(b)
}

export function chooseExternalPresentationScreen(screens, currentScreen = null) {
  const candidates = Array.from(screens || []).filter((screen) =>
    screen && !sameScreen(screen, currentScreen)
  )
  if (candidates.length === 0) return null

  const ranked = candidates.slice().sort((a, b) => {
    const aUsable = screenHasUsableBounds(a) ? 1 : 0
    const bUsable = screenHasUsableBounds(b) ? 1 : 0
    if (aUsable !== bUsable) return bUsable - aUsable

    const aExact1080 = screenWidth(a) === 1920 && screenHeight(a) === 1080 ? 1 : 0
    const bExact1080 = screenWidth(b) === 1920 && screenHeight(b) === 1080 ? 1 : 0
    if (aExact1080 !== bExact1080) return bExact1080 - aExact1080

    const aPrimary = a.isPrimary ? 1 : 0
    const bPrimary = b.isPrimary ? 1 : 0
    if (aPrimary !== bPrimary) return aPrimary - bPrimary

    return screenArea(b) - screenArea(a)
  })

  return ranked[0]
}

function rawScreenDimension(screen, key) {
  const value = screen?.[key]
  return Number.isFinite(value) ? Math.round(value) : 'n/a'
}

function describeScreen(screen) {
  if (!screen) return 'none'
  const label = typeof screen.label === 'string' && screen.label
    ? ` label="${screen.label}"`
    : ''
  const dpr = Number.isFinite(screen.devicePixelRatio)
    ? ` dpr=${Number(screen.devicePixelRatio).toFixed(3)}`
    : ''
  return (
    `${screenWidth(screen)}x${screenHeight(screen)}@(${screenLeft(screen)},${screenTop(screen)}) ` +
    `raw=avail(${rawScreenDimension(screen, 'availWidth')}x${rawScreenDimension(screen, 'availHeight')}@` +
    `${rawScreenDimension(screen, 'availLeft')},${rawScreenDimension(screen, 'availTop')}) ` +
    `screen(${rawScreenDimension(screen, 'width')}x${rawScreenDimension(screen, 'height')}@` +
    `${rawScreenDimension(screen, 'left')},${rawScreenDimension(screen, 'top')}) ` +
    `primary=${screen.isPrimary === true} internal=${screen.isInternal === true}${dpr}${label}`
  )
}

function describeScreenList(screens) {
  return Array.from(screens || [])
    .map((screen, index) => `${index}:${describeScreen(screen)}`)
    .join('; ')
}

export function buildPresentationWindowFeatures(screen) {
  const left = screenLeft(screen)
  const top = screenTop(screen)
  const width = screenWidth(screen) || 1920
  const height = screenHeight(screen) || 1080
  return [
    'popup=yes',
    'toolbar=no',
    'location=no',
    'menubar=no',
    'status=no',
    'scrollbars=no',
    'resizable=no',
    `left=${left}`,
    `top=${top}`,
    `width=${width}`,
    `height=${height}`
  ].join(',')
}

export function getExternalDisplayReadiness(useExternalDisplay, preparedScreen, hasScreenDetails = true) {
  if (!useExternalDisplay) return null
  if (!hasScreenDetails) {
    return 'External display requires Chrome/Edge with Window Management API support. Uncheck External screen to use this window.'
  }
  return null
}

export function buildPresentationFullscreenOptions(target) {
  const options = { navigationUI: 'hide' }
  if (target?.external && target.screen) {
    options.screen = target.screen
  }
  return options
}

function getLocalPresentationTarget() {
  return {
    external: false,
    win: window,
    doc: document,
    container: elements.container,
    canvas: elements.canvas,
    frameCount: elements.frameCount,
    progressDisplay: elements.progressDisplay
  }
}

function getPresentationTarget() {
  return state.presentation || getLocalPresentationTarget()
}

function cancelArmedStartTimer() {
  if (!state.armedStartTimerId) return
  clearTimeout(state.armedStartTimerId)
  state.armedStartTimerId = null
}

function closeExternalPresentationWindow() {
  const presentation = state.presentation
  state.presentation = null
  if (!presentation?.external) return
  try {
    if (presentation.win && presentation.win !== window && !presentation.win.closed) {
      presentation.win.close()
    }
  } catch (_) {
    // Ignore cross-window cleanup failures; the next start creates a fresh window.
  }
}

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
  const presentation = getPresentationTarget()
  const usesMainDocument = presentation.doc === document
  presentation.container?.classList.toggle('signal-live', isLive)
  if (presentation.container !== elements?.container) {
    elements?.container?.classList.toggle('signal-live', false)
  }
  document.body?.classList.toggle('hdmi-uvc-signal-live', isLive && usesMainDocument)
}

function resetPreparedSessionState() {
  cancelArmedStartTimer()
  state.encoder = null
  state.packetSize = 0
  state.packetsPerFrame = 1
  state.isSending = false
  state.isPaused = false
  state.isAwaitingStart = false
  state.labCardActive = false
  state.systematicIndex = 0
  state.systematicStride = 1
  state.intermediateSystematicStride = 1
  state.paritySystematicIndex = 0
  state.paritySweepsInPass = 0
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
  closeExternalPresentationWindow()
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

function applyFullscreenCanvasStyles(target = getPresentationTarget()) {
  target.container?.classList.add('fullscreen')
  target.canvas.style.display = 'block'
  target.canvas.style.position = 'absolute'
  target.canvas.style.top = '0'
  target.canvas.style.left = '0'
  target.canvas.style.zIndex = '0'
  target.canvas.style.imageRendering = 'pixelated'
  target.canvas.style.background = '#000'
  target.canvas.style.width = '100%'
  target.canvas.style.height = '100%'
}

function clearSenderCanvasToBlack() {
  const canvas = getPresentationTarget().canvas
  if (!canvas?.width || !canvas?.height) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

function showArmedStartPrompt(autoStartDelayMs = 0) {
  elements.overlay.classList.add('hidden')
  elements.placeholder.style.display = 'flex'
  elements.placeholder.style.position = 'relative'
  elements.placeholder.style.zIndex = '1'
  elements.placeholder.style.textAlign = 'center'
  elements.placeholder.style.padding = '1.5rem'
  elements.placeholderIcon.textContent = '>'
  elements.placeholderText.textContent = autoStartDelayMs > 0
    ? 'External display ready. Transmission starts after the fullscreen tip clears.'
    : 'Fullscreen ready. Wait for the browser tip to disappear, then press Space or Enter to start.'
  debugCurrent(autoStartDelayMs > 0 ? 'ARMED - auto-starting external display' : 'ARMED - press Space or Enter to start')
}

function waitForLayoutFrames(count = 2, targetWindow = window) {
  const raf = targetWindow?.requestAnimationFrame?.bind(targetWindow) || requestAnimationFrame
  return new Promise((resolve) => {
    const step = () => {
      if (count <= 0) {
        resolve()
        return
      }
      count--
      raf(step)
    }
    raf(step)
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

async function waitForStableViewport(stableFrames = 3, maxFrames = 30, target = getPresentationTarget()) {
  let last = null
  let stableCount = 0

  for (let frame = 0; frame < maxFrames; frame++) {
    await waitForLayoutFrames(1, target.win)
    const current = getCanvasViewportMetrics(target)
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

  return last || getCanvasViewportMetrics(target)
}

function getCanvasViewportMetrics(target = getPresentationTarget()) {
  const targetWindow = target.win || window
  const targetDocument = target.doc || document
  const presentationEl = targetDocument.fullscreenElement || target.container || target.canvas
  const rect = presentationEl.getBoundingClientRect()
  const visual = targetWindow.visualViewport

  const rectWidth = Math.round(rect.width)
  const rectHeight = Math.round(rect.height)
  const visualWidth = visual ? Math.round(visual.width) : 0
  const visualHeight = visual ? Math.round(visual.height) : 0
  const innerWidth = Math.round(targetWindow.innerWidth)
  const innerHeight = Math.round(targetWindow.innerHeight)
  const screenWidth = Math.round(targetWindow.screen.width || 0)
  const screenHeight = Math.round(targetWindow.screen.height || 0)

  let width = rectWidth
  let height = rectHeight
  let source = targetDocument.fullscreenElement ? 'fullscreenRect' : 'containerRect'

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
    devicePixelRatio: targetWindow.devicePixelRatio || 1,
    fullscreenActive: !!targetDocument.fullscreenElement
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
  const devicePixelRatio = viewportMetrics.devicePixelRatio || 1

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
      displayScale: 1,
      physicalDisplayWidth: Math.round(viewportWidth * devicePixelRatio),
      physicalDisplayHeight: Math.round(viewportHeight * devicePixelRatio),
      effectiveDisplayScale: 1
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
    displayScale: fitted.scale,
    physicalDisplayWidth: Math.round(fitted.width * devicePixelRatio),
    physicalDisplayHeight: Math.round(fitted.height * devicePixelRatio),
    effectiveDisplayScale: Math.min(
      internalWidth ? Math.round(fitted.width * devicePixelRatio) / internalWidth : 0,
      internalHeight ? Math.round(fitted.height * devicePixelRatio) / internalHeight : 0
    )
  }
}

export function normalizeExternalPresentationMetrics(metrics, target = getPresentationTarget()) {
  if (!target?.external || metrics?.renderPresetId !== '1080p') return metrics
  if (metrics.width !== 1920 || metrics.height !== 1080) return metrics

  metrics.displayWidth = metrics.width
  metrics.displayHeight = metrics.height
  metrics.displayX = 0
  metrics.displayY = 0
  metrics.displayScale = 1
  metrics.physicalDisplayWidth = metrics.width
  metrics.physicalDisplayHeight = metrics.height
  metrics.effectiveDisplayScale = 1
  metrics.externalNativePresentation = true
  return metrics
}

function isCimbarMode() {
  return state.mode === HDMI_MODE.CIMBAR
}

function modeRequiresNative1080p(mode) {
  return mode === HDMI_MODE.BINARY_3
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

function measureAndApplyCanvasSize(viewportMetrics = getCanvasViewportMetrics(), target = getPresentationTarget()) {
  const metrics = resolveHdmiCanvasMetrics(viewportMetrics)
  if (target.external && target.screen && metrics.renderPresetId !== 'viewport') {
    const physicalWidth = screenWidth(target.screen)
    const physicalHeight = screenHeight(target.screen)
    if (physicalWidth > 0 && physicalHeight > 0) {
      metrics.physicalDisplayWidth = physicalWidth
      metrics.physicalDisplayHeight = physicalHeight
      metrics.effectiveDisplayScale = Math.min(
        metrics.width ? physicalWidth / metrics.width : 0,
        metrics.height ? physicalHeight / metrics.height : 0
      )
    }
  }
  normalizeExternalPresentationMetrics(metrics, target)

  target.canvas.width = metrics.width
  target.canvas.height = metrics.height
  target.canvas.style.setProperty('width', `${metrics.displayWidth}px`, 'important')
  target.canvas.style.setProperty('height', `${metrics.displayHeight}px`, 'important')
  target.canvas.style.left = `${metrics.displayX}px`
  target.canvas.style.top = `${metrics.displayY}px`

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
    `physical ${metrics.physicalDisplayWidth}x${metrics.physicalDisplayHeight} ` +
    `within viewport ${metrics.viewportWidth}x${metrics.viewportHeight}, ` +
    `scale=${metrics.displayScale.toFixed(3)}, effective=${metrics.effectiveDisplayScale.toFixed(3)}` +
    `${metrics.externalNativePresentation ? ', external-native=assumed' : ''}, ` +
    `data region ${dataWidth}x${dataHeight} (${dataUtil}% of frame)`
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

function getNativeGeometryIssue(metrics) {
  if (isNative1080pGeometry(metrics)) return null
  const width = metrics ? `${metrics.width}x${metrics.height}` : 'unknown'
  const display = metrics ? `${metrics.displayWidth}x${metrics.displayHeight}` : 'unknown'
  const physical = metrics ? `${metrics.physicalDisplayWidth || 'unknown'}x${metrics.physicalDisplayHeight || 'unknown'}` : 'unknown'
  const scale = metrics?.displayScale?.toFixed ? metrics.displayScale.toFixed(3) : 'unknown'
  const effective = metrics?.effectiveDisplayScale?.toFixed ? metrics.effectiveDisplayScale.toFixed(3) : 'unknown'
  const fullscreen = metrics?.fullscreenActive ? 'yes' : 'no'
  return (
    `Dense HDMI modes require native 1080p, but current canvas=${width}, ` +
    `display=${display}, physical=${physical}, scale=${scale}, effective=${effective}, fullscreen=${fullscreen}, ` +
    `preset=${metrics?.renderPresetName || metrics?.renderPresetId || 'unknown'}. ` +
    buildNativeGeometryGuidance()
  )
}

function getRenderScaleIssue(metrics, { requireNative1080p = false } = {}) {
  if (requireNative1080p) return getNativeGeometryIssue(metrics)
  if (!metrics || metrics.renderPresetId === 'viewport') return null
  if (hasEffectiveOneToOnePresentation(metrics)) return null
  if (Math.abs(metrics.displayScale - 1) <= 0.001) return null

  return (
    `Render preset ${metrics.renderPresetName} requires 1:1 presentation, but the active display path ` +
    `would resample it to ${metrics.displayWidth}x${metrics.displayHeight} ` +
    `(scale=${metrics.displayScale.toFixed(3)}, physical=${metrics.physicalDisplayWidth || 'unknown'}x${metrics.physicalDisplayHeight || 'unknown'}, ` +
    `effective=${metrics.effectiveDisplayScale?.toFixed ? metrics.effectiveDisplayScale.toFixed(3) : 'unknown'}). ` +
    buildNativeGeometryGuidance()
  )
}

function writeExternalPresentationDocument(popup, screen) {
  const doc = popup.document
  doc.open()
  doc.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Beam Me Up HDMI-UVC Display</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
    }
    #presentation-container {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      background: #000;
      overflow: hidden;
      cursor: none;
    }
    #presentation-canvas {
      display: block;
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      background: #000;
    }
    #presentation-overlay {
      position: absolute;
      top: 8px;
      left: 8px;
      color: #00d4ff;
      background: rgba(0, 0, 0, 0.7);
      font: 12px monospace;
      padding: 4px 8px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div id="presentation-container">
    <canvas id="presentation-canvas"></canvas>
    <div id="presentation-overlay"><span id="presentation-frame-count">0</span> <span id="presentation-progress">0%</span></div>
  </div>
</body>
</html>`)
  doc.close()

  return {
    external: true,
    screen,
    win: popup,
    doc,
    container: doc.getElementById('presentation-container'),
    canvas: doc.getElementById('presentation-canvas'),
    frameCount: doc.getElementById('presentation-frame-count'),
    progressDisplay: doc.getElementById('presentation-progress')
  }
}

async function openExternalPresentationTarget() {
  const readiness = getExternalDisplayReadiness(
    state.useExternalDisplay,
    null,
    !!window.getScreenDetails
  )
  if (readiness) throw new Error(readiness)

  const details = await window.getScreenDetails()
  const screen = chooseExternalPresentationScreen(details.screens, details.currentScreen)
  if (!screen) {
    throw new Error('No external display found. Connect UGREEN as an extended display, then try again.')
  }

  closeExternalPresentationWindow()
  const popup = window.open('', 'beammeup-hdmi-uvc-presentation', buildPresentationWindowFeatures(screen))
  if (!popup) {
    throw new Error('External presentation window was blocked after screen permission. Allow popups for this page and click Start again.')
  }
  popup.document.write('<!doctype html><title>Beam Me Up HDMI-UVC Display</title><body style="margin:0;background:#000"></body>')
  popup.document.close()

  const features = buildPresentationWindowFeatures(screen)
  debugLog(`External presentation features: ${features}`)

  try {
    popup.moveTo(screenLeft(screen), screenTop(screen))
    popup.resizeTo(screenWidth(screen) || 1920, screenHeight(screen) || 1080)
    popup.focus()
  } catch (_) {
    // Some browsers ignore scripted move/resize even after permission.
  }

  const target = writeExternalPresentationDocument(popup, screen)
  state.presentation = target
  debugLog(
    `External presentation window: screen=${screenWidth(screen)}x${screenHeight(screen)}@(${screenLeft(screen)},${screenTop(screen)})`
  )
  return target
}

async function prepareExternalFullscreenTarget() {
  const readiness = getExternalDisplayReadiness(
    state.useExternalDisplay,
    null,
    !!window.getScreenDetails
  )
  if (readiness) throw new Error(readiness)

  const details = await window.getScreenDetails()
  debugLog(`Screen details: current=${describeScreen(details.currentScreen)} screens=[${describeScreenList(details.screens)}]`)

  const screen = chooseExternalPresentationScreen(details.screens, details.currentScreen)
  if (!screen) {
    throw new Error('No external display found. Connect UGREEN as an extended display, then try again.')
  }

  const target = {
    ...getLocalPresentationTarget(),
    external: true,
    screen
  }
  state.presentation = target
  debugLog(`External fullscreen target: screen=${describeScreen(screen)}`)
  return target
}

async function preparePresentationTarget() {
  if (state.useExternalDisplay && !isCimbarMode()) {
    return prepareExternalFullscreenTarget()
  }
  state.presentation = null
  return getLocalPresentationTarget()
}

async function requestPresentationFullscreen(target) {
  const container = target.container
  if (!container?.requestFullscreen) {
    if (target.external) {
      throw new Error('External fullscreen is unavailable in this browser window. Transfer was not started on the main screen.')
    }
    debugLog('Fullscreen unavailable: falling back to window bounds')
    return
  }

  try {
    await container.requestFullscreen(buildPresentationFullscreenOptions(target))
    debugLog(target.external ? 'External fullscreen: OK (selected screen)' : 'Fullscreen: OK')
  } catch (e) {
    if (target.external) {
      throw new Error(
        `External fullscreen failed on selected screen (${describeScreen(target.screen)}): ${e.message}. ` +
        'Transfer was not started on the main screen.'
      )
    }
    try {
      await container.requestFullscreen()
      debugLog(target.external ? 'External fullscreen: OK (default navigation UI)' : 'Fullscreen: OK (default navigation UI)')
    } catch (fallbackErr) {
      debugLog(`Fullscreen failed: ${fallbackErr.message}, falling back to fixed window`)
    }
  }
}

async function preparePresentationForTransmission() {
  const target = await preparePresentationTarget()
  applyFullscreenCanvasStyles(target)
  await requestPresentationFullscreen(target)
  return {
    target,
    stableMetrics: await waitForStableViewport(3, 30, target)
  }
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
  if (elements.labCardSelect) {
    elements.labCardSelect.disabled = state.isSending || state.isPaused || state.isAwaitingStart
  }
  if (elements.btnLabRender) {
    elements.btnLabRender.disabled = state.isSending || state.isPaused || state.isAwaitingStart
  }
  updateEstimateSummary()
  updatePresentationControls()
}

function updatePresentationControls() {
  if (!elements?.externalDisplayToggle) return
  elements.externalDisplayToggle.checked = state.useExternalDisplay
  elements.externalDisplayToggle.disabled = state.isSending || state.isPaused || state.isAwaitingStart
  if (elements.presentationStatus) {
    if (!state.useExternalDisplay) {
      elements.presentationStatus.textContent = 'Current window'
    } else if (window.getScreenDetails) {
      elements.presentationStatus.textContent = 'Start selects screen'
    } else {
      elements.presentationStatus.textContent = 'Chrome/Edge only'
    }
  }
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
    case HDMI_MODE.BINARY_3:
      // Initial profile: 512-1024 B packets so one bad cell costs little.
      //
      // Preconditions to raise maxBlockSize toward 1536 / 2048 B:
      //   (a) Phase 2 lab confirms sustained BINARY_3 SER below the derived
      //       threshold in the Phase 3 pass-condition table.
      //   (b) Phase 4 packet salvage is wired into the receiver and measured
      //       on real-channel runs.
      //
      // Both gates are required because there is no backward channel and dense
      // modes need soft-decision recovery before larger packets are safe.
      return {
        minPacketsPerFrame: 4,
        fixedPacketsPerFrame: null,
        maxPacketsPerFrame: 32,
        targetFrameFill: 0.90,
        maxBlockSize: 1024,
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
  if (state.mode === HDMI_MODE.BINARY_3) return true
  if (frameNumber <= METADATA_BURST_FRAMES) return true
  if (
    frameNumber <= BOOTSTRAP_METADATA_WINDOW_FRAMES &&
    (frameNumber % BOOTSTRAP_METADATA_INTERVAL_FRAMES) === 0
  ) {
    return true
  }
  return frameNumber % state.metadataIntervalFrames === 0
}

function getMetadataSlotIndex(frameNumber, slots) {
  if (slots <= 1) return 0
  if (state.mode === HDMI_MODE.BINARY_3) {
    return (Math.max(1, frameNumber) - 1) % slots
  }
  return 0
}

function getMetadataScheduleDescription() {
  if (state.mode === HDMI_MODE.BINARY_3) {
    return `Metadata schedule: every frame, 1 rotating slot across ${state.packetsPerFrame} packet(s)`
  }
  return (
    `Metadata schedule: burst=${METADATA_BURST_FRAMES} frame(s), ` +
    `bootstrap=${BOOTSTRAP_METADATA_INTERVAL_FRAMES} frame(s) through frame ${BOOTSTRAP_METADATA_WINDOW_FRAMES}, ` +
    `interval=${state.metadataIntervalFrames} frame(s)`
  )
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
    const passDescs = []
    for (let p = 2; p <= 5; p++) {
      const pattern = getSlotMixPatternForPass(p)
      passDescs.push(describeSlotMixPattern(pattern))
    }
    return (
      `Hybrid schedule: source-only pass 1, then mixed ${modeName} slot replay ` +
      `(pass2=${getPass2Variant()}; ${passDescs.join(', ')})`
    )
  }

  return `Hybrid schedule: source-only pass 1, then fountain every ${HYBRID_FOUNTAIN_PACKET_INTERVAL} data packets`
}

function describeFountainInterval(interval) {
  return interval > 0
    ? `fountain every ${interval} data packet(s)`
    : 'source-only'
}

function getSlotMixPatternForPass(passNumber, { paritySweepsInPass = 0 } = {}) {
  if (!usesMixedSlotReplay()) return null
  if (passNumber <= 1) return ['source', 'source', 'source', 'source', 'source', 'source']
  if (passNumber === 2) {
    // Two-stage pass 2: emit one full parity sweep at 4S/2P so every parity
    // row reaches the receiver once, then swap the second parity slot for a
    // fountain slot (4S/1P/1F) for the rest of pass 2 so fountain symbols
    // start contributing during the replay tail instead of waiting for pass 3.
    // `mix` and `legacy` overrides keep their historical meaning.
    const variant = getPass2Variant()
    if (variant === 'legacy') {
      return ['source', 'source', 'source', 'source', 'source', 'parity']
    }
    if (variant === 'mix') {
      return ['source', 'source', 'parity', 'parity', 'fountain', 'fountain']
    }
    if (paritySweepsInPass === 0) {
      return ['source', 'source', 'source', 'source', 'parity', 'parity']
    }
    return ['source', 'source', 'source', 'source', 'parity', 'fountain']
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
  state.paritySweepsInPass = 0
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
  const nextIndex = (state.paritySystematicIndex + 1) % paritySpan
  if (nextIndex === 0) {
    state.paritySweepsInPass++
    if (state.systematicPass === 2 && state.paritySweepsInPass === 1) {
      debugLog(
        `Pass 2 first parity sweep complete — switching to 4S/1P/1F ` +
        `(paritySpan=${paritySpan})`
      )
    }
  }
  state.paritySystematicIndex = nextIndex
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
  const metadataSlotIndex = sendMetadata ? getMetadataSlotIndex(frameNumber, slots) : -1
  const tailSystematicBurst = isTailSystematicBurstFrame(frameNumber)
  const slotMixPattern = getSlotMixPatternForPass(state.systematicPass, {
    paritySweepsInPass: state.paritySweepsInPass
  })

  let dataSlotsBuilt = 0
  for (let slot = 0; slot < slots; slot++) {
    if (slot === metadataSlotIndex) {
      packets.push(state.encoder.generateSymbol(0))
      symbolIds.push(0)
      continue
    }

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
    outerSymbolId: sendMetadata ? 0 : (symbolIds[0] ?? 0),
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
  const presentation = getPresentationTarget()
  const canvas = presentation.canvas
  const cw = canvas.width
  const ch = canvas.height

  try {
    const nextFrameNumber = state.frameCount + 1
    const frameStartMs = performance.now()
    const batch = buildFramePacketBatch(nextFrameNumber)
    const batchReadyMs = performance.now()

    const frameImageData = ensureHdmiFrameResources(cw, ch)
    buildFrame(batch.payload, state.mode, cw, ch, fps.fps, batch.outerSymbolId, state.frameBuffer)
    const buildDoneMs = performance.now()

    const ctx = canvas.getContext('2d')
    ctx.putImageData(frameImageData, 0, 0)
    const blitDoneMs = performance.now()

    state.frameCount = nextFrameNumber
    elements.frameCount.textContent = state.frameCount
    if (presentation.frameCount && presentation.frameCount !== elements.frameCount) {
      presentation.frameCount.textContent = state.frameCount
    }

    const systematicSpan = Math.max(1, getCurrentSystematicSpan())
    const progress = Math.min(100, Math.round((state.systematicIndex / systematicSpan) * 100))
    elements.progressDisplay.textContent = progress + '%'
    if (presentation.progressDisplay && presentation.progressDisplay !== elements.progressDisplay) {
      presentation.progressDisplay.textContent = progress + '%'
    }
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

function armPreparedStart(autoStartDelayMs = 0) {
  cancelArmedStartTimer()
  state.isAwaitingStart = true
  state.isSending = false
  state.isPaused = false
  state.nextFrameDueMs = 0
  clearSenderCanvasToBlack()
  showArmedStartPrompt(autoStartDelayMs)
  setSignalLive(false)

  elements.fpsSlider.disabled = true
  updateActionButton()
  updateModeSelector()
  updateRenderSizeSelector()
  if (autoStartDelayMs > 0) {
    state.armedStartTimerId = setTimeout(() => {
      state.armedStartTimerId = null
      beginPreparedStart()
    }, autoStartDelayMs)
    debugLog(`Sender armed: external display auto-start in ${autoStartDelayMs}ms`)
  } else {
    debugLog('Sender armed: wait for the fullscreen tip to clear, then press Space or Enter to begin transmission')
  }
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
  cancelArmedStartTimer()
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

async function renderLabCard(kind) {
  try {
    resetRenderSchedule()
    resetHdmiFrameResources()
    resetPreparedSessionState()
    debugLog(`=== RENDER LAB CARD ${kind} ===`)

    const { target, stableMetrics } = await preparePresentationForTransmission()
    const { metrics } = measureAndApplyCanvasSize(stableMetrics, target)
    const issue = getRenderScaleIssue(metrics, {
      requireNative1080p: kind === CARD_KIND.BINARY_3 || kind === CARD_KIND.BINARY_4
    })
    if (issue) throw new Error(issue)

    const card = buildCard(kind, metrics.width, metrics.height)
    const imageData = new ImageData(new Uint8ClampedArray(card.imageData), metrics.width, metrics.height)
    const ctx = target.canvas.getContext('2d')
    ctx.putImageData(imageData, 0, 0)

    elements.placeholder.style.display = 'none'
    elements.overlay.classList.add('hidden')
    setSignalLive(true)
    state.labCardActive = true
    window.__hdmiUvcCurrentCard = { kind, width: metrics.width, height: metrics.height }
    debugLog(`Lab card rendered: ${kind} at ${metrics.width}x${metrics.height}`)
    debugCurrent(`LAB ${kind} ${metrics.width}x${metrics.height}`)
  } catch (err) {
    console.error('HDMI-UVC lab render error:', err)
    await restoreSenderReadyState()
    showError('Failed to render lab card: ' + err.message)
  }
}

function handleLabRenderClick() {
  if (state.isSending || state.isPaused || state.isAwaitingStart) return
  const kind = LAB_CARD_KIND_BY_VALUE[elements.labCardSelect?.value]
  if (!kind) {
    void restoreSenderReadyState()
    return
  }
  void renderLabCard(kind)
}

async function startSending() {
  if (!state.fileData || !state.fileHash) return

  try {
    debugLog('=== ARMING FULLSCREEN START ===')
    const selectedFps = getFps()

    // Fullscreen layout can settle a frame or two after the promise resolves.
    // Measure the actual fullscreen element box instead of trusting window.inner*.
    const { target, stableMetrics } = await preparePresentationForTransmission()
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

    const { metrics, capacity } = measureAndApplyCanvasSize(stableMetrics, target)
    const renderScaleIssue = getRenderScaleIssue(metrics, {
      requireNative1080p: modeRequiresNative1080p(state.mode)
    })
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
    debugLog(`Pass-2 variant: ${getPass2Variant()}`)
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
    debugLog(getMetadataScheduleDescription())
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
    armPreparedStart(target.external ? 2500 : 0)

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
  closeExternalPresentationWindow()
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
    elements.placeholder.style.display = 'none'

    const { target, stableMetrics } = await preparePresentationForTransmission()
    setSignalLive(true)
    if (isCimbarMode()) {
      scaleCimbarCanvasToViewport(stableMetrics)
    } else {
      const { metrics, capacity } = measureAndApplyCanvasSize(stableMetrics, target)
      const renderScaleIssue = getRenderScaleIssue(metrics, {
        requireNative1080p: modeRequiresNative1080p(state.mode)
      })
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
  closeExternalPresentationWindow()
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
    mode === HDMI_MODE.LUMA_2 ||
    mode === HDMI_MODE.BINARY_3
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

function handleExternalDisplayChange(e) {
  if (state.isSending || state.isPaused || state.isAwaitingStart) return
  state.useExternalDisplay = !!e.target.checked
  updatePresentationControls()
  debugLog(`External display ${state.useExternalDisplay ? 'enabled' : 'disabled'}`)
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
  if (shouldRestoreLabCardOnFullscreenExit(state, document.fullscreenElement)) {
    void restoreSenderReadyState()
    return
  }
  // If we were sending and fullscreen was exited (e.g. by pressing Escape), pause
  if (state.isSending && !state.isPaused && !document.fullscreenElement) {
    pauseSending()
  }
}

function shouldRestoreLabCardOnFullscreenExit(senderState, fullscreenElement) {
  return !!senderState?.labCardActive &&
    !fullscreenElement &&
    !senderState.isSending &&
    !senderState.isAwaitingStart
}

async function exitFullscreenSafely() {
  const presentationDoc = state.presentation?.doc
  if (presentationDoc?.fullscreenElement) {
    try {
      await presentationDoc.exitFullscreen()
    } catch {
      // Ignore fullscreen exit failures during cleanup.
    }
  }
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
    externalDisplayToggle: document.getElementById('hdmi-uvc-external-display-toggle'),
    presentationStatus: document.getElementById('hdmi-uvc-presentation-status'),
    fpsSlider: document.getElementById('hdmi-uvc-fps-slider'),
    fpsDisplay: document.getElementById('hdmi-uvc-fps-display'),
    fileInfo: document.getElementById('hdmi-uvc-file-info'),
    estimate: document.getElementById('hdmi-uvc-estimate'),
    btnAction: document.getElementById('btn-hdmi-uvc-action'),
    btnStop: document.getElementById('btn-hdmi-uvc-stop'),
    labCardSelect: document.getElementById('hdmi-uvc-lab-card-select'),
    btnLabRender: document.getElementById('btn-hdmi-uvc-lab-render')
  }
  elements.modeButtons = Array.from(elements.modeSelector?.querySelectorAll('.mode-btn') || [])

  elements.fpsSlider.value = getRecommendedFpsPreset(state.mode)
  if (elements.renderSizeSelect) {
    elements.renderSizeSelect.value = getRenderSizePreset().id
  }
  if (elements.externalDisplayToggle) {
    state.useExternalDisplay = elements.externalDisplayToggle.checked
  }

  updateDropZoneState()
  updateActionButton()
  handleFpsChange()
  updateModeSelector()
  updateRenderSizeSelector()

  elements.fileInput.onchange = handleFileSelect
  elements.renderSizeSelect.oninput = handleRenderSizeChange
  if (elements.externalDisplayToggle) {
    elements.externalDisplayToggle.onchange = handleExternalDisplayChange
  }
  elements.fpsSlider.oninput = handleFpsChange
  elements.modeButtons.forEach(button => {
    button.onclick = handleModeChange
  })
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending
  if (elements.btnLabRender) elements.btnLabRender.onclick = handleLabRenderClick

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
  const diagPanel = document.getElementById('hdmi-uvc-sender-diagnostics')
  if (diagPanel) {
    renderDiagnosticsPanel(diagPanel, ['pass2'], { title: 'Diagnostics (sender)' })
  }

  debugLog('HDMI-UVC Sender initialized')
  debugLog(`Pass-2 variant: ${getPass2Variant()}`)
}

// Pure function tests so the two-stage pass-2 schedule and parity-sweep wrap
// counter are verifiable without spinning up the encoder/DOM. The runtime
// contract: pass 2 emits 4S/2P for sweep 0, then 4S/1P/1F for every
// subsequent sweep; paritySweepsInPass increments when paritySystematicIndex
// wraps from paritySpan-1 back to 0.
export function testPass2TwoStageSchedule() {
  const sweep0 = getSlotMixPatternForPass(2, { paritySweepsInPass: 0 })
  const sweep1 = getSlotMixPatternForPass(2, { paritySweepsInPass: 1 })
  const sweep7 = getSlotMixPatternForPass(2, { paritySweepsInPass: 7 })

  const countSlots = (pattern) => {
    const c = { source: 0, parity: 0, fountain: 0 }
    for (const s of pattern) if (c[s] !== undefined) c[s]++
    return c
  }

  const c0 = countSlots(sweep0)
  const c1 = countSlots(sweep1)
  const c7 = countSlots(sweep7)

  const ok0 = c0.source === 4 && c0.parity === 2 && c0.fountain === 0
  const ok1 = c1.source === 4 && c1.parity === 1 && c1.fountain === 1
  const ok7 = c7.source === 4 && c7.parity === 1 && c7.fountain === 1

  // Pass 1 must still be source-only; pass 3+ unchanged.
  const pass1 = getSlotMixPatternForPass(1, { paritySweepsInPass: 0 })
  const pass3 = getSlotMixPatternForPass(3, { paritySweepsInPass: 0 })
  const c1Pass = countSlots(pass1)
  const c3Pass = countSlots(pass3)
  const okPass1 = c1Pass.source === 6 && c1Pass.parity === 0 && c1Pass.fountain === 0
  const okPass3 = c3Pass.source === 4 && c3Pass.parity === 1 && c3Pass.fountain === 1

  const pass = ok0 && ok1 && ok7 && okPass1 && okPass3
  console.log('Two-stage pass-2 schedule test:', pass ? 'PASS' : 'FAIL',
    { c0, c1, c7, c1Pass, c3Pass })
  return pass
}

export function testPresentationScreenSelection() {
  const current = { availLeft: 0, availTop: 0, availWidth: 1728, availHeight: 1084, isPrimary: true }
  const ugreen = { availLeft: 1728, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false }
  const largerPrimary = { availLeft: -2560, availTop: 0, availWidth: 2560, availHeight: 1440, isPrimary: true }
  const zeroSized = { availLeft: 0, availTop: 0, availWidth: 0, availHeight: 0, isPrimary: false }

  const selected = chooseExternalPresentationScreen([current, largerPrimary, zeroSized, ugreen], current)
  const none = chooseExternalPresentationScreen([current], current)
  const onlyZeroSized = chooseExternalPresentationScreen([current, zeroSized], current)
  const pass = selected === ugreen && none === null && onlyZeroSized === zeroSized
  console.log('Presentation screen selection test:', pass ? 'PASS' : 'FAIL', {
    selected: selected ? `${screenWidth(selected)}x${screenHeight(selected)}@(${screenLeft(selected)},${screenTop(selected)})` : null,
    onlyZeroSized: onlyZeroSized ? `${screenWidth(onlyZeroSized)}x${screenHeight(onlyZeroSized)}@(${screenLeft(onlyZeroSized)},${screenTop(onlyZeroSized)})` : null
  })
  return pass
}

export function testPresentationWindowFeatures() {
  const features = buildPresentationWindowFeatures({
    availLeft: -1920,
    availTop: 0,
    availWidth: 1920,
    availHeight: 1080
  })
  const required = [
    'popup=yes',
    'left=-1920',
    'top=0',
    'width=1920',
    'height=1080',
    'resizable=no'
  ]
  const missing = required.filter((token) => !features.includes(token))
  const pass = missing.length === 0
  console.log('Presentation window features test:', pass ? 'PASS' : `FAIL missing ${missing.join(', ')}`)
  return pass
}

export function testExternalDisplayReadiness() {
  const prepared = { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080 }
  const currentWindow = getExternalDisplayReadiness(false, null, false)
  const noApi = getExternalDisplayReadiness(true, prepared, false)
  const unprepared = getExternalDisplayReadiness(true, null, true)
  const ready = getExternalDisplayReadiness(true, prepared, true)
  const pass = currentWindow === null &&
    noApi?.includes('Chrome/Edge') &&
    unprepared === null &&
    ready === null
  console.log('External display readiness test:', pass ? 'PASS' : 'FAIL', {
    currentWindow, noApi, unprepared, ready
  })
  return pass
}

export function testExternalPresentationNativeMetrics() {
  const cssScaledMetrics = {
    renderPresetId: '1080p',
    renderPresetName: '1080p',
    width: 1920,
    height: 1080,
    displayWidth: 1652,
    displayHeight: 929,
    displayScale: 0.86,
    devicePixelRatio: 2,
    physicalDisplayWidth: 3304,
    physicalDisplayHeight: 1858,
    effectiveDisplayScale: 1.72,
    displayX: 0,
    displayY: 11,
    fullscreenActive: true
  }
  const normalized = normalizeExternalPresentationMetrics(cssScaledMetrics, { external: true })
  const pass = normalized === cssScaledMetrics &&
    normalized.displayWidth === 1920 &&
    normalized.displayHeight === 1080 &&
    normalized.displayScale === 1 &&
    normalized.displayX === 0 &&
    normalized.displayY === 0 &&
    normalized.physicalDisplayWidth === 1920 &&
    normalized.physicalDisplayHeight === 1080 &&
    normalized.effectiveDisplayScale === 1 &&
    normalized.externalNativePresentation === true &&
    hasEffectiveOneToOnePresentation(normalized) &&
    isNative1080pGeometry(normalized)
  console.log('External presentation native metrics test:', pass ? 'PASS' : 'FAIL', normalized)
  return pass
}

export function testExternalFullscreenUsesSelectedScreen() {
  const screen = { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080 }
  const externalOptions = buildPresentationFullscreenOptions({ external: true, screen })
  const localOptions = buildPresentationFullscreenOptions({ external: false })
  const pass = externalOptions.navigationUI === 'hide' &&
    externalOptions.screen === screen &&
    localOptions.navigationUI === 'hide' &&
    !('screen' in localOptions)
  console.log('External fullscreen screen option test:', pass ? 'PASS' : 'FAIL', {
    externalOptions,
    localOptions
  })
  return pass
}

export async function testExternalFullscreenFailureStopsBeforeMainFallback() {
  let calls = 0
  const target = {
    external: true,
    screen: { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080 },
    container: {
      requestFullscreen: async () => {
        calls++
        throw new Error('Permissions check failed')
      }
    }
  }

  let message = ''
  try {
    await requestPresentationFullscreen(target)
  } catch (err) {
    message = err.message
  }

  const pass = calls === 1 && message.includes('External fullscreen failed') && message.includes('Permissions check failed')
  console.log('External fullscreen failure stop test:', pass ? 'PASS' : 'FAIL', { calls, message })
  return pass
}

export function testLabCardFullscreenExitRequiresReadyRestore() {
  const activeLab = { labCardActive: true, isSending: false, isAwaitingStart: false }
  const sending = { labCardActive: true, isSending: true, isAwaitingStart: false }
  const armed = { labCardActive: true, isSending: false, isAwaitingStart: true }
  const inactive = { labCardActive: false, isSending: false, isAwaitingStart: false }
  const pass = shouldRestoreLabCardOnFullscreenExit(activeLab, null) === true &&
    shouldRestoreLabCardOnFullscreenExit(activeLab, {}) === false &&
    shouldRestoreLabCardOnFullscreenExit(sending, null) === false &&
    shouldRestoreLabCardOnFullscreenExit(armed, null) === false &&
    shouldRestoreLabCardOnFullscreenExit(inactive, null) === false
  console.log('Lab card fullscreen exit restore test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testParitySweepCounter() {
  // Simulate the wrap-counter logic in isolation. Produces the sequence a
  // sender would see: 0,0,...,0,1,1,...,1,2,... where the boundary is at
  // paritySpan-1 -> 0. This is the contract buildFramePacketBatch relies on.
  const paritySpan = 4
  let idx = 0
  let sweeps = 0
  const observed = []
  for (let i = 0; i < 12; i++) {
    observed.push(sweeps)
    const nextIdx = (idx + 1) % paritySpan
    if (nextIdx === 0) sweeps++
    idx = nextIdx
  }
  // Expected: 0,0,0,0,1,1,1,1,2,2,2,2
  const expected = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]
  const pass = observed.length === expected.length &&
    observed.every((v, i) => v === expected[i])
  console.log('Parity sweep counter test:', pass ? 'PASS' : 'FAIL',
    { observed, expected })
  return pass
}

export function testBinary3BatchingProfile() {
  const profile = getBatchingProfile(HDMI_MODE.BINARY_3)
  const pass = profile.maxBlockSize <= 1024 &&
    profile.minPacketsPerFrame >= 4 &&
    profile.maxPacketsPerFrame >= profile.minPacketsPerFrame &&
    profile.targetFrameFill >= 0.85
  console.log('BINARY_3 batching profile test:', pass ? 'PASS' : `FAIL ${JSON.stringify(profile)}`)
  return pass
}

export function testBinary3StrictGeometryGate() {
  try {
    const badViewport = {
      renderPresetId: 'viewport',
      renderPresetName: 'Viewport',
      width: 1728,
      height: 1084,
      displayWidth: 1728,
      displayHeight: 1084,
      displayX: 0,
      displayY: 0,
      displayScale: 1,
      physicalDisplayWidth: 1728,
      physicalDisplayHeight: 1084,
      effectiveDisplayScale: 1,
      fullscreenActive: true
    }
    const native1080 = {
      ...badViewport,
      renderPresetId: '1080p',
      renderPresetName: '1080p',
      width: 1920,
      height: 1080,
      displayWidth: 1920,
      displayHeight: 1080,
      physicalDisplayWidth: 1920,
      physicalDisplayHeight: 1080
    }
    const pass = modeRequiresNative1080p(HDMI_MODE.BINARY_3) &&
      !modeRequiresNative1080p(HDMI_MODE.COMPAT_4) &&
      !!getRenderScaleIssue(badViewport, { requireNative1080p: modeRequiresNative1080p(HDMI_MODE.BINARY_3) }) &&
      getRenderScaleIssue(native1080, { requireNative1080p: modeRequiresNative1080p(HDMI_MODE.BINARY_3) }) === null
    console.log('BINARY_3 strict geometry gate test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('BINARY_3 strict geometry gate test: FAIL', err?.message || err)
    return false
  }
}

export function testBinary3MetadataEveryFrame() {
  const oldMode = state.mode
  const oldInterval = state.metadataIntervalFrames
  try {
    state.mode = HDMI_MODE.BINARY_3
    state.metadataIntervalFrames = 90
    const frames = [1, 2, 5, 89, 181, 270]
    const observed = frames.map(frame => shouldSendMetadata(frame))
    const pass = observed.every(Boolean)
    console.log('BINARY_3 metadata every-frame test:', pass ? 'PASS' : 'FAIL', {
      frames,
      observed
    })
    return pass
  } finally {
    state.mode = oldMode
    state.metadataIntervalFrames = oldInterval
  }
}

export function testBinary3MetadataSlotRotates() {
  const snapshot = {
    mode: state.mode,
    encoder: state.encoder,
    packetsPerFrame: state.packetsPerFrame,
    systematicIndex: state.systematicIndex,
    systematicStride: state.systematicStride,
    intermediateSystematicIndex: state.intermediateSystematicIndex,
    intermediateSystematicStride: state.intermediateSystematicStride,
    paritySystematicIndex: state.paritySystematicIndex,
    paritySystematicStride: state.paritySystematicStride,
    paritySweepsInPass: state.paritySweepsInPass,
    fountainSymbolId: state.fountainSymbolId,
    dataPacketCount: state.dataPacketCount,
    systematicPass: state.systematicPass,
    tailStartFrame: state.tailStartFrame
  }

  try {
    state.mode = HDMI_MODE.BINARY_3
    state.encoder = {
      K: 100,
      K_prime: 120,
      generateSymbol: symbolId => new Uint8Array([symbolId & 0xff])
    }
    state.packetsPerFrame = 4
    state.systematicIndex = 0
    state.systematicStride = 1
    state.intermediateSystematicIndex = 0
    state.intermediateSystematicStride = 1
    state.paritySystematicIndex = 0
    state.paritySystematicStride = 1
    state.paritySweepsInPass = 0
    state.fountainSymbolId = 121
    state.dataPacketCount = 0
    state.systematicPass = 1
    state.tailStartFrame = 0

    const frame1 = buildFramePacketBatch(1).symbolIds
    const frame2 = buildFramePacketBatch(2).symbolIds
    const frame5 = buildFramePacketBatch(5).symbolIds
    const pass = frame1[0] === 0 &&
      frame2[1] === 0 &&
      frame5[0] === 0 &&
      frame1.filter(id => id === 0).length === 1 &&
      frame2.filter(id => id === 0).length === 1 &&
      frame5.filter(id => id === 0).length === 1

    console.log('BINARY_3 metadata slot rotation test:', pass ? 'PASS' : 'FAIL', {
      frame1,
      frame2,
      frame5
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}
