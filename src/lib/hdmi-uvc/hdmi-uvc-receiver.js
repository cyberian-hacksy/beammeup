// HDMI-UVC Receiver module - captures from UVC device and decodes frames

import { createDecoder } from '../decoder.js'
import { PACKET_HEADER_SIZE, parsePacket } from '../packet.js'
import { loadCimbarWasm, getModule as getCimbarModule } from '../cimbar/cimbar-loader.js'
import {
  BLOCK_SIZE,
  DEVICE_STORAGE_KEY,
  HDMI_MODE,
  HDMI_MODE_NAMES,
  HEADER_SIZE,
  getModeHeaderBlockSize
} from './hdmi-uvc-constants.js'
import {
  detectAnchors,
  dataRegionFromAnchors,
  decodeDataRegion,
  readPayloadWithLayout,
  resetClassifierPerfAccumulator,
  getClassifierPerfAccumulator
} from './hdmi-uvc-frame.js'
import ReceiverWorker from './hdmi-uvc-receiver-worker.js?worker&inline'
import {
  detectCaptureCapabilities,
  chooseCaptureMethod,
  computeLockedCaptureRect,
  getWorkerCaptureCopyRect,
  shouldUseLockedCaptureRegion
} from './hdmi-uvc-receiver-capture.js'
import { loadHdmiUvcWasm } from './hdmi-uvc-wasm.js'
import {
  isPerfMode,
  getWorkerMode,
  getCaptureMethod as getCaptureMethodSetting,
  renderDiagnosticsPanel
} from './hdmi-uvc-diagnostics.js'

// Kick off WASM instantiation on the main thread so the ?capture=main fallback
// path (which runs decodeDataRegion on the main thread) uses the WASM CRC32
// from the first decoded frame. Swallowed errors fall back to JS crc32.
loadHdmiUvcWasm().catch(() => {})

// Debug mode - always on while diagnosing HDMI-UVC issues
const DEBUG_MODE = true
const MAX_DEBUG_LINES = 500
// All three come from the diagnostics module (which reads URL → localStorage
// → default). Captured at init time because each controls an interval or
// pipeline baked in for the session; the diagnostics panel shows a Reload
// prompt when the user changes one so the next load picks it up cleanly.
const PERF_MODE = isPerfMode()
const RX_PERF_LOG_INTERVAL_FRAMES = PERF_MODE ? 240 : 60
const RX_PROGRESS_LOG_INTERVAL_FRAMES = PERF_MODE ? 40 : 10
const DEBUG_RENDER_INTERVAL_MS = PERF_MODE ? 480 : 120
const RECEIVER_UI_UPDATE_INTERVAL_MS = PERF_MODE ? 500 : 120
const LOCKED_LAYOUT_RECOVERY_PROBE_INTERVAL_FRAMES = 8
const DEBUG_CONSOLE = false
const CAPTURE_BENCHMARK_SAMPLES_PER_METHOD = 6
const CAPTURE_BENCH_ONLY = typeof location !== 'undefined' &&
  new URLSearchParams(location.search).has('captureBench')
// Worker decode-pump mode: 'off' | 'hash' (diagnostic round-trip) | 'anchors'
// (offload anchor detection) | 'full' (anchor + decoder ingest + tail). On
// any worker error the receiver falls back to the main-thread path for the
// session.
const WORKER_MODE = getWorkerMode()
const WORKER_ANCHORS_ENABLED = WORKER_MODE === 'anchors' || WORKER_MODE === 'full'
const WORKER_FULL_ENABLED = WORKER_MODE === 'full'
// Capture pipeline: 'main' (drawImage/getImageData on main thread), 'worker'
// (MediaStreamTrackProcessor + VideoFrame.copyTo in worker), 'offscreen'
// (createImageBitmap + OffscreenCanvas transferred to worker). 'main' is the
// safe fallback at every branch. Diagnostic setting 'auto' → feature-detect.
const CAPTURE_CAPABILITIES = detectCaptureCapabilities()
const CAPTURE_METHOD = (() => {
  const setting = getCaptureMethodSetting()
  const preferred = setting === 'auto' ? null : setting
  return chooseCaptureMethod(CAPTURE_CAPABILITIES, preferred)
})()
// Frames between diagnostic hash probes. Probing every frame is wasteful for
// a pure diagnostic; every ~30 frames is enough to confirm transport.
const WORKER_PROBE_INTERVAL_FRAMES = 30
const debugLines = []
let debugRenderTimer = null

function renderDebugLog() {
  const el = document.getElementById('hdmi-uvc-receiver-debug-log')
  if (!el) return
  el.textContent = debugLines.join('\n')
  el.scrollTop = el.scrollHeight
}

function scheduleDebugLogRender() {
  if (debugRenderTimer !== null) return
  debugRenderTimer = setTimeout(() => {
    debugRenderTimer = null
    renderDebugLog()
  }, DEBUG_RENDER_INTERVAL_MS)
}

function flushDebugLogRender() {
  if (debugRenderTimer !== null) {
    clearTimeout(debugRenderTimer)
    debugRenderTimer = null
  }
  renderDebugLog()
}

function debugLog(text) {
  if (!DEBUG_MODE) return

  const timestamp = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
  debugLines.push(timestamp + ' ' + text)
  if (debugLines.length > MAX_DEBUG_LINES) {
    debugLines.splice(0, debugLines.length - MAX_DEBUG_LINES)
  }
  scheduleDebugLogRender()
  if (DEBUG_CONSOLE) {
    console.log('[HDMI-RX]', text)
  }
}

function debugCurrent(text) {
  if (!DEBUG_MODE) return
  const el = document.getElementById('hdmi-uvc-receiver-debug-current')
  if (el) el.textContent = text
}

function shouldUpdateReceiverUi(lastUpdateMs, nowMs, force = false) {
  if (force) return true
  if (!Number.isFinite(lastUpdateMs) || lastUpdateMs <= 0) return true
  return (nowMs - lastUpdateMs) >= RECEIVER_UI_UPDATE_INTERVAL_MS
}

// Phase 5 worker client. Constructed via Vite's ?worker&inline so all module
// imports inside the worker (frame.js, decoder, etc.) bundle into a single
// inline Blob and survive vite-plugin-singlefile. The worker silently
// disables itself on construction error so the receiver keeps working on the
// main thread. Mode selection:
//   'hash'    → sub-phase 1: diagnostic round-trip hash every N frames
//   'anchors' → sub-phase 2: offload anchor detection (pre-lock phase)
//   'full'    → sub-phase 3: offload anchor + decoder ingest + tail work
let receiverWorker = null
let receiverWorkerReady = false
let receiverWorkerNextId = 1
let receiverWorkerFailed = false
const receiverWorkerPending = new Map()
const receiverWorkerProbeState = {
  framesSinceProbe: 0,
  samplesReceived: 0,
  samplesSent: 0,
  lastHash: 0,
  lastWorkerMs: 0,
  lastRoundTripMs: 0,
  lastByteLength: 0,
  logsEmitted: 0
}
// Shadow state mirror for the worker's decoder when running in 'full' mode.
// The main thread reads from this object like it used to read from the
// in-process decoder; the worker ships back deltas on every ingest/reset.
let receiverWorkerDecoderState = null
// Pending reconstruct requests keyed by id → { resolve, reject }.
const receiverWorkerReconstructPending = new Map()

function initReceiverWorker() {
  // Worker is needed for either a decode-pump mode (?worker=...) or a
  // worker-side capture path (CAPTURE_METHOD='worker'/'offscreen'). Off
  // only when both are disabled.
  const captureNeedsWorker = CAPTURE_METHOD === 'worker' || CAPTURE_METHOD === 'offscreen'
  if (WORKER_MODE === 'off' && !captureNeedsWorker) return false
  if (receiverWorker) return true
  if (receiverWorkerFailed) return false
  try {
    receiverWorker = new ReceiverWorker()
    receiverWorker.onmessage = handleReceiverWorkerMessage
    receiverWorker.onerror = (event) => {
      debugLog(`Worker error: ${event.message || 'unknown'} — falling back to main thread`)
      teardownReceiverWorker(true)
    }
    receiverWorker.onmessageerror = () => {
      debugLog('Worker message deserialization failed — falling back to main thread')
      teardownReceiverWorker(true)
    }
    // Resolve the WASM URL on the main thread (document.baseURI) and hand it
    // to the worker. The inline worker's own self.location is a blob:/data:
    // URL that URL resolution rejects as a base, so without this the worker
    // silently falls back to the JS crc32/scanBrightRuns implementations.
    try {
      const wasmUrl = new URL('hdmi-uvc/hdmi_uvc.wasm', document.baseURI).href
      receiverWorker.postMessage({ type: 'configureWasm', url: wasmUrl })
    } catch (err) {
      debugLog(`Failed to post WASM URL to worker: ${err?.message || err}`)
    }
    debugLog(`Worker mode: ON (${WORKER_MODE})`)
    return true
  } catch (err) {
    debugLog(`Worker construction failed: ${(err && err.message) || err} — falling back to main thread`)
    teardownReceiverWorker(true)
    return false
  }
}

function teardownReceiverWorker(markFailed = false) {
  if (receiverWorker) {
    try { receiverWorker.terminate() } catch (_) { /* ignore */ }
    receiverWorker = null
  }
  receiverWorkerReady = false
  // If worker-driven capture was active when the worker died, clear the
  // flags so scheduleNextFrame falls back to the main-thread processFrame
  // path instead of silently dropping frames.
  const wasWorkerCapturing = state.workerCaptureActive ||
    state.workerCapturePending ||
    state.offscreenCaptureActive
  state.workerCaptureActive = false
  state.workerCapturePending = false
  state.offscreenCaptureActive = false
  state.workerCaptureStartPendingAfterStop = false
  state.workerCaptureStopRequested = false
  receiverWorkerPending.clear()
  if (wasWorkerCapturing && state.isScanning) {
    // Kick the main-thread loop so the user doesn't freeze on a dead worker.
    scheduleNextFrame()
  }
  // Reject any pending reconstruct requests so callers don't hang forever.
  for (const { reject } of receiverWorkerReconstructPending.values()) {
    try { reject(new Error('Worker terminated')) } catch (_) { /* ignore */ }
  }
  receiverWorkerReconstructPending.clear()
  if (markFailed) receiverWorkerFailed = true
}

// === Phase 3.4: worker-side capture orchestration ============================
// When CAPTURE_METHOD === 'worker', the main thread hands a MediaStreamTrack
// clone to the worker and stops scheduling its own processFrame loop. The
// worker self-acquires anchors and pumps captureFrame messages back; the
// main thread updates the shadow decoder + UI from those deltas.

// Arm a short safety timeout: if the worker never posts captureStarted
// (silent crash, handler exception before the ack), clear the pending flag
// and fall back to the main-thread loop instead of wedging scanning.
const WORKER_CAPTURE_START_TIMEOUT_MS = 2000
function armWorkerCaptureStartTimeout() {
  if (state.workerCaptureStartDeadlineId) {
    clearTimeout(state.workerCaptureStartDeadlineId)
  }
  state.workerCaptureStartDeadlineId = setTimeout(() => {
    state.workerCaptureStartDeadlineId = null
    if (state.workerCaptureActive) return
    if (!state.workerCapturePending) return
    debugLog(
      `Worker capture startup timed out after ${WORKER_CAPTURE_START_TIMEOUT_MS}ms — ` +
      `falling back to main-thread processFrame`
    )
    fallBackFromWorkerCapture()
  }, WORKER_CAPTURE_START_TIMEOUT_MS)
}

function clearWorkerCaptureStartTimeout() {
  if (state.workerCaptureStartDeadlineId) {
    clearTimeout(state.workerCaptureStartDeadlineId)
    state.workerCaptureStartDeadlineId = null
  }
}

function fallBackFromWorkerCapture() {
  clearWorkerCaptureStartTimeout()
  const wasActive = state.workerCaptureActive || state.offscreenCaptureActive || state.workerCapturePending
  state.workerCapturePending = false
  state.workerCaptureActive = false
  state.offscreenCaptureActive = false
  state.workerCaptureSourceRect = null
  state.offscreenBitmapInFlightAt = null
  // If a restart was deferred behind a stopCapture ack, fall-back means
  // we're abandoning worker mode for this session — drop the pending start
  // so captureStopped doesn't try to resume into it.
  state.workerCaptureStartPendingAfterStop = false
  // startWorkerCapture / startOffscreenCapture create a worker-backed shadow
  // decoder before the worker ack arrives. On fallback, the shadow's
  // receiveParsed() returns false synchronously and only queues async
  // ingestBatch work — breaking the main-thread acceptPackets path on
  // non-?worker=full sessions. Clear it so ensureDecoder() rebuilds a fresh
  // decoder that matches the current WORKER_FULL_ENABLED state (native when
  // off, a new shadow when on).
  state.decoder = null
  receiverWorkerDecoderState = null
  // Tell the worker to halt its pump if it got far enough to start one.
  // Set stopRequested so the captureStopped response doesn't trigger a
  // nested fallback (we're already falling back).
  if (wasActive && !state.workerCaptureStopRequested) {
    state.workerCaptureStopRequested = true
    postToWorker({ type: 'stopCapture' })
  }
  if (state.isScanning) scheduleNextFrame()
}

function startWorkerCapture() {
  if (CAPTURE_METHOD !== 'worker') return false
  if (!state.stream) return false
  if (state.workerCaptureActive) return true
  if (!receiverWorker) {
    if (!initReceiverWorker()) return false
  }
  // A stopCapture posted earlier in the same tick (resetReceiver +
  // handleReceiveAnother, etc.) hasn't been ack'd yet. The worker's track
  // pump is still draining, so starting now would race against the "already
  // active" check and trigger a spurious fallback. Defer until the
  // captureStopped message arrives.
  if (state.workerCaptureStopRequested) {
    state.workerCaptureStartPendingAfterStop = true
    return false
  }
  if (!receiverWorkerReady) {
    // Defer until the worker posts 'ready' — the ready handler fires this
    // again when the pending flag is set.
    state.workerCapturePending = true
    return false
  }

  const track = state.stream.getVideoTracks()[0]
  if (!track) return false

  // Clone the track so the main thread's <video> element keeps a live
  // source; transferring the original would end it on the main realm.
  let workerTrack
  try {
    workerTrack = track.clone()
  } catch (err) {
    debugLog(`Worker capture: track.clone() failed (${err?.message || err}) — falling back`)
    return false
  }

  // Shadow decoder creation is deferred to the captureStarted handler so a
  // startup timeout or error never leaves state.decoder pointing at a
  // worker-backed shadow that the main-thread fallback path can't use
  // synchronously. See ensureWorkerCaptureShadowDecoder().
  // Pending until we receive captureStarted from the worker; only then flip
  // workerCaptureActive. scheduleNextFrame gates on either flag, so the main
  // loop stays suppressed during startup.
  state.workerCapturePending = true
  const ok = postToWorker({
    type: 'startCaptureWithTrack',
    track: workerTrack,
    region: null,
    expectedPacketSize: getExpectedPacketSize() || null,
    labFrameTapEnabled: state.labFrameTapEnabled
  }, [workerTrack])
  if (!ok) {
    state.workerCapturePending = false
    try { workerTrack.stop() } catch (_) { /* ignore */ }
    return false
  }
  armWorkerCaptureStartTimeout()
  debugLog('Worker capture requested (awaiting captureStarted)')
  return true
}

function stopWorkerCapture() {
  if (
    !state.workerCaptureActive &&
    !state.workerCapturePending &&
    !state.offscreenCaptureActive
  ) return
  clearWorkerCaptureStartTimeout()
  state.workerCapturePending = false
  state.workerCaptureActive = false
  state.offscreenCaptureActive = false
  state.workerCaptureSourceRect = null
  state.offscreenBitmapInFlightAt = null
  // Mark this as an expected stop so the captureStopped response handler
  // treats it as a normal teardown rather than an unexpected worker exit.
  state.workerCaptureStopRequested = true
  postToWorker({ type: 'stopCapture' })
}

// Phase 3.5: offscreen mode keeps the main-thread frame loop but replaces
// drawImage/getImageData with createImageBitmap + transferable postMessage.
// The worker does the readback locally.
function startOffscreenCapture() {
  if (CAPTURE_METHOD !== 'offscreen') return false
  if (!state.stream) return false
  if (state.offscreenCaptureActive) return true
  if (!receiverWorker) {
    if (!initReceiverWorker()) return false
  }
  if (state.workerCaptureStopRequested) {
    // Symmetry with startWorkerCapture: if a stopCapture is in flight,
    // wait for its ack before starting a new session.
    state.workerCaptureStartPendingAfterStop = true
    return false
  }
  if (!receiverWorkerReady) {
    state.workerCapturePending = true
    return false
  }
  // As with the track path: defer shadow creation until captureStarted so
  // a start failure doesn't leave a stale shadow around.
  // Offscreen mode has the same ack semantics as the track mode. Mark
  // pending and activate only when captureStarted arrives; worker errors
  // from the start handler will trip the fallback path.
  state.workerCapturePending = true
  const ok = postToWorker({
    type: 'startCaptureWithOffscreen',
    region: null,
    expectedPacketSize: getExpectedPacketSize() || null,
    labFrameTapEnabled: state.labFrameTapEnabled
  })
  if (!ok) {
    state.workerCapturePending = false
    return false
  }
  armWorkerCaptureStartTimeout()
  debugLog('Worker capture requested (offscreen/createImageBitmap, awaiting captureStarted)')
  return true
}

function processFrameForOffscreen() {
  if (!state.isScanning || !state.stream || !state.offscreenCaptureActive) return
  // Don't bump state.frameCount here — backpressure-dropped frames would
  // inflate the counter, and worker-driven frames are already counted in
  // handleWorkerCaptureFrame when the worker reports the captureFrame.
  // Keeping a single source of truth aligns offscreen and track modes so
  // diagnostics keyed off frameCount stay comparable.
  const video = elements.video
  if (!video.videoWidth || !video.videoHeight) {
    scheduleNextFrame()
    return
  }

  // Backpressure: if a bitmap is already in flight to the worker, drop this
  // frame and let rVFC/rAF fire again. Under load the worker can lag behind
  // the main thread, and queuing bitmaps just wastes memory and latency.
  // The 1-second cap lets us recover if captureFrame never arrives (worker
  // stall or missed ack).
  const nowMs = performance.now()
  if (state.offscreenBitmapInFlightAt != null &&
      (nowMs - state.offscreenBitmapInFlightAt) < 1000) {
    scheduleNextFrame()
    return
  }

  // Narrow to the locked ROI once the worker has reported it, except while
  // the lab needs full-frame taps so anchors remain measurable.
  const roi = state.workerCaptureSourceRect
  const vw = video.videoWidth
  const vh = video.videoHeight
  const copyRect = getWorkerCaptureCopyRect(roi ? { sourceRect: roi } : null, vw, vh, state.labFrameTapEnabled)
  const usesFullFrame = copyRect.x === 0 &&
    copyRect.y === 0 &&
    copyRect.width === vw &&
    copyRect.height === vh
  const bitmapPromise = !usesFullFrame &&
    copyRect.x >= 0 && copyRect.y >= 0 &&
    copyRect.width > 0 && copyRect.height > 0 &&
    (copyRect.x + copyRect.width) <= vw &&
    (copyRect.y + copyRect.height) <= vh
    ? createImageBitmap(video, copyRect.x, copyRect.y, copyRect.width, copyRect.height)
    : createImageBitmap(video)

  state.offscreenBitmapInFlightAt = nowMs
  bitmapPromise
    .then((bitmap) => {
      if (!state.offscreenCaptureActive) {
        state.offscreenBitmapInFlightAt = null
        try { bitmap.close() } catch (_) { /* ignore */ }
        return
      }
      const ok = postToWorker({
        type: 'captureBitmap',
        bitmap,
        expectedPacketSize: getExpectedPacketSize() || null
      }, [bitmap])
      if (!ok) {
        state.offscreenBitmapInFlightAt = null
        try { bitmap.close() } catch (_) { /* ignore */ }
      }
    })
    .catch((err) => {
      state.offscreenBitmapInFlightAt = null
      debugLog(`createImageBitmap failed: ${err?.message || err}`)
    })
  scheduleNextFrame()
}

function postToWorker(msg, transfer) {
  if (!receiverWorker) return false
  try {
    if (transfer && transfer.length) receiverWorker.postMessage(msg, transfer)
    else receiverWorker.postMessage(msg)
    return true
  } catch (err) {
    debugLog(`Worker postMessage failed: ${(err && err.message) || err}`)
    teardownReceiverWorker(true)
    return false
  }
}

function postLabFrameTapStateToWorker() {
  if (!receiverWorker || !receiverWorkerReady) return
  postToWorker({ type: 'setLabFrameTap', enabled: state.labFrameTapEnabled })
}

export function setHdmiUvcLabFrameTapEnabled(enabled) {
  state.labFrameTapEnabled = !!enabled
  if (state.labFrameTapEnabled) {
    state.lastImageData = null
    state.lastImageDataSeq = 0
    state.lastImageDataCapturedAtMs = 0
  }
  postLabFrameTapStateToWorker()
}

function handleReceiverWorkerMessage(event) {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'ready':
      receiverWorkerReady = true
      debugLog(`Worker ready (protocol v${msg.protocolVersion})`)
      postLabFrameTapStateToWorker()
      if (state.workerCapturePending) {
        if (CAPTURE_METHOD === 'worker') startWorkerCapture()
        else if (CAPTURE_METHOD === 'offscreen') startOffscreenCapture()
      }
      return
    case 'wasmReady':
      debugLog('Worker WASM kernels loaded')
      return
    case 'hashResult':
      handleWorkerHashResult(msg)
      return
    case 'anchorsResult': {
      const pending = receiverWorkerPending.get(msg.id)
      receiverWorkerPending.delete(msg.id)
      if (pending && pending.resolve) pending.resolve(msg)
      return
    }
    case 'decoderDelta':
      handleWorkerDecoderDelta(msg)
      return
    case 'ingestBatchResult': {
      const pending = receiverWorkerPending.get(msg.id)
      receiverWorkerPending.delete(msg.id)
      // Update the shadow with the delta fields in the same tick as the
      // caller resolves its promise. This is what makes ?worker=full's
      // innovation/stall telemetry honest: the main thread gets the
      // authoritative innovations count from the worker instead of guessing.
      handleWorkerDecoderDelta(msg)
      if (pending && pending.resolve) pending.resolve(msg)
      return
    }
    case 'decodeAndIngestResult': {
      const pending = receiverWorkerPending.get(msg.id)
      receiverWorkerPending.delete(msg.id)
      // On CRC-valid, the response also carries shadow-state fields — apply
      // them to keep the shadow in sync with the worker's post-ingest state.
      if (msg.decodeResult && msg.decodeResult.crcValid) {
        handleWorkerDecoderDelta(msg)
      }
      if (pending && pending.resolve) pending.resolve(msg)
      return
    }
    case 'reconstructResult': {
      const pending = receiverWorkerReconstructPending.get(msg.id)
      receiverWorkerReconstructPending.delete(msg.id)
      if (pending && pending.resolve) {
        pending.resolve({
          data: msg.data ? new Uint8Array(msg.data) : null,
          error: msg.error || null
        })
      }
      return
    }
    case 'captureStarted': {
      // Ack of startCaptureWithTrack / startCaptureWithOffscreen. Only now
      // is it safe to declare the worker the authoritative capture owner.
      clearWorkerCaptureStartTimeout()
      state.workerCapturePending = false
      if (msg.method === 'track') state.workerCaptureActive = true
      else if (msg.method === 'offscreen') state.offscreenCaptureActive = true
      // Create the shadow decoder now — not at post time — so a start
      // failure never leaves state.decoder pointing at a worker-backed
      // shadow that the non-?worker=full fallback path can't drive via
      // synchronous receiveParsed().
      if (!state.decoder) {
        state.decoder = createWorkerDecoderShadow()
        state.startTime = Date.now()
        showReceivingStatus()
        debugLog(`Decoder created (worker capture shadow, ${msg.method || 'unknown'})`)
      }
      debugLog(`Worker capture started (${msg.method || 'unknown'})`)
      // Offscreen mode is main-thread-driven; kick the loop now that the
      // worker is ready to receive bitmaps.
      if (msg.method === 'offscreen' && state.isScanning) scheduleNextFrame()
      return
    }
    case 'captureAnchorsLocked':
      // The worker has a cached data region and an ROI crop rect. Stash the
      // rect so processFrameForOffscreen can narrow createImageBitmap to
      // just the ROI — that's the main win of Finding 1.
      if (msg.sourceRect && typeof msg.sourceRect.x === 'number') {
        state.workerCaptureSourceRect = msg.sourceRect
        debugLog(
          `Worker anchors locked — ROI ` +
          `(${msg.sourceRect.x},${msg.sourceRect.y}) ` +
          `${msg.sourceRect.w}x${msg.sourceRect.h}`
        )
      } else {
        state.workerCaptureSourceRect = null
        debugLog('Worker anchors locked (no ROI rect provided)')
      }
      return
    case 'captureFrame':
      handleWorkerCaptureFrame(msg)
      return
    case 'captureStopped': {
      const wasRequested = state.workerCaptureStopRequested
      state.workerCaptureStopRequested = false
      if (wasRequested) {
        // Clean teardown (stopWorkerCapture / fallBackFromWorkerCapture /
        // resetReceiver). The initiator already cleared the relevant flags
        // before posting stopCapture.
        state.workerCaptureActive = false
        state.offscreenCaptureActive = false
        debugLog('Worker capture stopped (expected)')
        // If a restart was requested during the stop window, fire it now
        // that the worker has confirmed teardown — this is what keeps
        // Reset / Receive-another from silently downgrading a healthy
        // worker-capture session to the main-thread path.
        if (state.workerCaptureStartPendingAfterStop) {
          state.workerCaptureStartPendingAfterStop = false
          if (state.isScanning) {
            if (CAPTURE_METHOD === 'worker') startWorkerCapture()
            else if (CAPTURE_METHOD === 'offscreen') startOffscreenCapture()
            scheduleNextFrame()
          }
        }
        return
      }
      // Unexpected: worker pump exited without our asking — track ended,
      // reader drained, VideoFrame allocation failed, etc. If we only
      // cleared workerCaptureActive here the main thread would stay
      // suppressed by scheduleNextFrame's gate and scanning would go idle.
      // Route through the fallback path so processFrame picks up.
      debugLog('Worker capture stopped unexpectedly — falling back to main-thread processFrame')
      fallBackFromWorkerCapture()
      return
    }
    case 'error': {
      debugLog(`Worker error message: ${msg.message}`)
      // Capture-side errors come without an id and prefix the failed handler
      // name — map those to a clean fallback so a browser/worker feature
      // mismatch doesn't freeze scanning.
      const text = typeof msg.message === 'string' ? msg.message : ''
      const captureStartFailed =
        text.startsWith('startCaptureWithTrack:') ||
        text.startsWith('startCaptureWithOffscreen:')
      const captureLoopFailed =
        text.startsWith('capture loop:') ||
        text.startsWith('captureBitmap:')
      if (captureStartFailed) {
        debugLog('Worker capture startup failed — falling back to main-thread processFrame')
        fallBackFromWorkerCapture()
      } else if (captureLoopFailed) {
        // Runtime pump error — worker may have already posted captureStopped;
        // if it didn't, we still want a clean fallback next tick.
        fallBackFromWorkerCapture()
      }
      if (msg.id && receiverWorkerPending.has(msg.id)) {
        const p = receiverWorkerPending.get(msg.id)
        receiverWorkerPending.delete(msg.id)
        if (p && p.reject) p.reject(new Error(msg.message))
      }
      if (msg.id && receiverWorkerReconstructPending.has(msg.id)) {
        const p = receiverWorkerReconstructPending.get(msg.id)
        receiverWorkerReconstructPending.delete(msg.id)
        if (p && p.reject) p.reject(new Error(msg.message))
      }
      return
    }
  }
}

function handleWorkerHashResult(msg) {
  const probe = receiverWorkerPending.get(msg.id)
  receiverWorkerPending.delete(msg.id)
  const probeState = receiverWorkerProbeState
  probeState.samplesReceived++
  probeState.lastHash = msg.hash
  probeState.lastWorkerMs = msg.elapsedMs
  probeState.lastByteLength = msg.byteLength
  if (probe) probeState.lastRoundTripMs = performance.now() - probe.sentAtMs
  if ((probeState.samplesReceived & 3) === 0) {
    probeState.logsEmitted++
    debugLog(
      `Worker probe: hash=0x${msg.hash.toString(16).padStart(8, '0')} ` +
      `bytes=${msg.byteLength} worker=${msg.elapsedMs.toFixed(2)}ms ` +
      `rt=${probeState.lastRoundTripMs.toFixed(2)}ms ` +
      `n=${probeState.samplesReceived}`
    )
  }
}

function handleWorkerDecoderDelta(msg) {
  const s = receiverWorkerDecoderState
  if (!s) return
  if (typeof msg.solved === 'number') s.solved = msg.solved
  if (typeof msg.solvedTotal === 'number') s.solvedTotal = msg.solvedTotal
  if (typeof msg.K === 'number') s.K = msg.K
  if (typeof msg.K_prime === 'number') s.K_prime = msg.K_prime
  if (typeof msg.blockSize === 'number') s.blockSize = msg.blockSize
  if (typeof msg.progress === 'number') s.progress = msg.progress
  if (typeof msg.uniqueSymbols === 'number') s.uniqueSymbols = msg.uniqueSymbols
  if (typeof msg.pendingSymbolCount === 'number') s.pendingSymbolCount = msg.pendingSymbolCount
  if (typeof msg.unresolvedSourceCount === 'number') s.unresolvedSourceCount = msg.unresolvedSourceCount
  if (msg.metadata !== undefined) s.metadata = msg.metadata
  if (msg.telemetry) s.telemetry = msg.telemetry
  if (typeof msg.isComplete === 'boolean') s.isComplete = msg.isComplete
  if (msg.symbolBreakdown) s.symbolBreakdown = msg.symbolBreakdown
  if (msg.newSessionEvent || msg.newSession) {
    // Worker detected a new session (sender restart / config change) and
    // already reset its decoder. Mirror the companion state reset that
    // main-thread acceptPackets() does on the 'new_session' return.
    debugLog('New session detected (worker); resetting receiver companion state')
    state.validFrames = 0
    state.startTime = Date.now()
    state.completedFile = null
    state.completionStarted = false
    state.progressSamples = []
    state.expectedPacketCount = 0
    state.fixedLayout = null
    state.preferredLayout = null
    state.lockedLayoutFastPathMisses = 0
    state.decodeFailCount = 0
    s.completionHandled = false
  }
  if (msg.completionEvent && !s.completionHandled) {
    s.completionHandled = true
    // The worker signals completion asynchronously; bubble it into the
    // existing completion path. handleComplete guards against re-entry.
    if (!state.completedFile && typeof handleComplete === 'function') {
      debugLog('=== TRANSFER COMPLETE (via worker decoder) ===')
      void handleComplete()
    }
  }
}

// Worker capture pump posts one captureFrame per video frame. The worker has
// already done capture, decode, and decoder-ingest; this handler just updates
// the main-thread UI and validFrames bookkeeping that acceptPackets would have
// handled in the main-thread path.
function handleWorkerCaptureFrame(msg) {
  if (msg.labFrame?.buffer && msg.labFrame.width > 0 && msg.labFrame.height > 0) {
    rememberCapturedFrame({
      data: new Uint8ClampedArray(msg.labFrame.buffer),
      width: msg.labFrame.width,
      height: msg.labFrame.height
    })
  }
  // Release the offscreen backpressure slot — one bitmap round-trip is done,
  // the main thread can create the next.
  state.offscreenBitmapInFlightAt = null
  state.frameCount++
  // Apply decoder deltas first so completion / newSession are handled by the
  // existing delta path (which already owns those transitions).
  handleWorkerDecoderDelta(msg)

  if (msg.scanning) {
    // Worker hasn't locked anchors yet — nothing more to do; UI stays in
    // "Connected - scanning..." state.
    return
  }

  if (msg.accepted > 0) {
    state.validFrames++
    state.decodeFailCount = 0
    state.frameAcceptedThisFrame = true
    if (msg.innovations > 0) state.frameInnovatedThisFrame = true
    recordProgressSample()
  } else {
    state.decodeFailCount++
  }

  const nowMs = performance.now()
  const shadow = state.decoder
  const isComplete = shadow && typeof shadow.isComplete === 'function' && shadow.isComplete()
  const forceUiUpdate = isComplete || state.validFrames <= 1
  const shouldRefreshUi = shouldUpdateReceiverUi(state.lastReceivingUiUpdateMs, nowMs, forceUiUpdate)

  if (msg.accepted > 0 && shouldRefreshUi) {
    elements.statFrames.textContent = state.validFrames + ' valid frames'
  }

  if (msg.accepted > 0 && state.validFrames > 0 && state.validFrames % RX_PROGRESS_LOG_INTERVAL_FRAMES === 0) {
    const breakdown = msg.symbolBreakdown || {}
    const throughput = getThroughputStats()
    const rateSuffix = throughput
      ? ` rate=${formatBytes(throughput.average)}/s recent=${formatBytes(throughput.recent ?? throughput.average)}/s`
      : ''
    debugLog(
      `Progress: ${getDisplayProgressPercent(shadow)}% ` +
      `solved=${msg.solved ?? shadow?.solved ?? 0}/${msg.K ?? shadow?.K ?? '?'} ` +
      `unique=${shadow?.uniqueSymbols ?? 0} ` +
      `src=${breakdown.sourceCount ?? '?'} ` +
      `par=${breakdown.parityCount ?? '?'} ` +
      `fou=${breakdown.fountainCount ?? '?'} ` +
      `meta=${breakdown.metadataCount ?? '?'} ` +
      `pending=${shadow?.pendingSymbolCount ?? '?'} ` +
      `missing=${shadow?.unresolvedSourceCount ?? '?'} ` +
      `pkts=${msg.accepted}` +
      rateSuffix
    )
  }

  if (shouldRefreshUi) {
    updateProgress()
    state.lastReceivingUiUpdateMs = nowMs
  }

  // Stall counter — the delta handler doesn't know about frame boundaries;
  // drive it from here so the GF(2) tail solver can still fire.
  if (state.frameAcceptedThisFrame && shadow && typeof shadow.noteFrameBoundary === 'function') {
    shadow.noteFrameBoundary()
  }
  state.frameAcceptedThisFrame = false
  state.frameInnovatedThisFrame = false
}

function maybeProbeReceiverWorker(imageData) {
  if (!receiverWorker || !receiverWorkerReady) return
  if (!imageData || !imageData.data) return
  const probe = receiverWorkerProbeState
  probe.framesSinceProbe++
  if (probe.framesSinceProbe < WORKER_PROBE_INTERVAL_FRAMES) return
  probe.framesSinceProbe = 0
  // Clone the payload so the main thread keeps working on the original
  // ImageData. Worst-case cost — a full migration would transfer directly.
  const copy = new Uint8ClampedArray(imageData.data)
  const id = receiverWorkerNextId++
  const sentAtMs = performance.now()
  receiverWorkerPending.set(id, { sentAtMs })
  probe.samplesSent++
  postToWorker({
    type: 'hash',
    id,
    buffer: copy.buffer,
    width: imageData.width,
    height: imageData.height
  }, [copy.buffer])
}

// Offload a full frame's primary decode + ingest to the worker. Returns
// the worker's response or null if the worker is unavailable. On a CRC-
// invalid result the caller should still run the local salvage paths.
function workerDecodeAndIngest(imageData, width, region, expectedPacketSize) {
  if (!receiverWorker || !receiverWorkerReady) return Promise.resolve(null)
  // Transfer the full pixel buffer. The main thread retains `imageData`
  // (it's the canvas-backed buffer) — we ship a copy so the worker gets
  // an owned ArrayBuffer without stealing the main thread's next-frame
  // backing store.
  const copy = new Uint8ClampedArray(imageData.data)
  const id = receiverWorkerNextId++
  return new Promise((resolve) => {
    receiverWorkerPending.set(id, {
      resolve: (msg) => resolve(msg),
      reject: (_err) => resolve(null)
    })
    const ok = postToWorker({
      type: 'decodeAndIngest',
      id,
      buffer: copy.buffer,
      width,
      region,
      expectedPacketSize
    }, [copy.buffer])
    if (!ok) {
      receiverWorkerPending.delete(id)
      resolve(null)
    }
  })
}

// Offload anchor detection to the worker. Returns { anchors, region } or
// null if worker is unavailable / errored. The caller should fall back to
// running detectAnchors/dataRegionFromAnchors locally.
function workerDetectAnchors(imageData, width, height) {
  if (!receiverWorker || !receiverWorkerReady) return Promise.resolve(null)
  // Copy the pixel buffer so the main thread's ImageData stays intact for
  // subsequent locked-layout decode. The copy is ~300 KB for typical ROIs
  // and cheap compared to detectAnchors cost.
  const copy = new Uint8ClampedArray(imageData.data)
  const id = receiverWorkerNextId++
  return new Promise((resolve) => {
    receiverWorkerPending.set(id, {
      resolve: (msg) => resolve(msg),
      reject: (_err) => resolve(null)
    })
    const ok = postToWorker({
      type: 'detectAnchors',
      id,
      buffer: copy.buffer,
      width,
      height
    }, [copy.buffer])
    if (!ok) {
      receiverWorkerPending.delete(id)
      resolve(null)
    }
  })
}

// Create a shadow decoder object that looks like the real createDecoder()
// return value but forwards ingest/reset/reconstruct to the worker. The
// shadow state is updated from worker deltas.
function freshShadowSymbolBreakdown() {
  return {
    unique: 0,
    duplicate: 0,
    sourceCount: 0,
    parityCount: 0,
    fountainCount: 0,
    metadataCount: 0
  }
}

function freshShadowTelemetry() {
  return {
    stallFramesSinceLastSolve: 0,
    paritySweepComplete: 0,
    parityNoProgressSweeps: 0,
    tailSolveTriggerCount: 0,
    pendingSymbolCount: 0
  }
}

// Default block size mirrors decoder.js initialization (`let blockSize = 200`)
// so getExpectedPacketSize() returns a sane value on frame 1 before any delta
// has arrived. Without this, the first frame would probe 15-byte slots and
// skip all packets, delaying the first ingest by another frame.
const WORKER_SHADOW_DEFAULT_BLOCK_SIZE = 200

function createWorkerDecoderShadow() {
  const s = {
    solved: 0,
    solvedTotal: 0,
    K: null,
    K_prime: null,
    blockSize: WORKER_SHADOW_DEFAULT_BLOCK_SIZE,
    metadata: null,
    progress: 0,
    uniqueSymbols: 0,
    pendingSymbolCount: 0,
    unresolvedSourceCount: null,
    isComplete: false,
    completionHandled: false,
    symbolBreakdown: freshShadowSymbolBreakdown(),
    telemetry: freshShadowTelemetry()
  }
  receiverWorkerDecoderState = s
  postToWorker({ type: 'initDecoder' })
  return {
    get metadata() { return s.metadata },
    get solved() { return s.solved },
    get solvedTotal() { return s.solvedTotal },
    get K() { return s.K },
    get K_prime() { return s.K_prime },
    get blockSize() { return s.blockSize || 0 },
    get progress() { return s.progress },
    get uniqueSymbols() { return s.uniqueSymbols },
    get pendingSymbolCount() { return s.pendingSymbolCount },
    get unresolvedSourceCount() { return s.unresolvedSourceCount },
    get symbolBreakdown() { return s.symbolBreakdown },
    get telemetry() { return s.telemetry },
    isComplete() { return s.isComplete },
    // Async batch-ingest used by acceptPackets(). Returns a Promise with the
    // authoritative { innovations, newSession, isComplete, ... } snapshot.
    // Innovation count is computed in the worker, so main-thread telemetry
    // no longer over-counts on duplicate-only frames.
    ingestBatch(parsedList) {
      if (!parsedList || parsedList.length === 0) {
        return Promise.resolve({
          innovations: 0,
          accepted: 0,
          newSession: false,
          completionEvent: false,
          isComplete: s.isComplete
        })
      }
      const id = receiverWorkerNextId++
      return new Promise((resolve) => {
        receiverWorkerPending.set(id, {
          resolve: (msg) => resolve(msg),
          reject: (_err) => resolve({
            innovations: 0,
            accepted: 0,
            newSession: false,
            completionEvent: false,
            isComplete: s.isComplete,
            error: 'worker-unavailable'
          })
        })
        const wireList = parsedList.map(serializeParsedPacket)
        const ok = postToWorker({
          type: 'ingestBatch',
          id,
          parsedList: wireList
        })
        if (!ok) {
          receiverWorkerPending.delete(id)
          resolve({
            innovations: 0,
            accepted: 0,
            newSession: false,
            completionEvent: false,
            isComplete: s.isComplete,
            error: 'worker-post-failed'
          })
        }
      })
    },
    // Kept for backwards compatibility with the main-thread decoder interface.
    // In worker mode, acceptPackets uses ingestBatch() and should not call
    // receiveParsed — but if something does, fall back to posting a
    // single-packet batch and return false so it doesn't inflate innovation.
    receiveParsed(parsed) {
      if (!parsed) return false
      void this.ingestBatch([parsed])
      return false
    },
    reset() {
      s.solved = 0
      s.solvedTotal = 0
      s.K = null
      s.K_prime = null
      s.blockSize = WORKER_SHADOW_DEFAULT_BLOCK_SIZE
      s.metadata = null
      s.progress = 0
      s.uniqueSymbols = 0
      s.pendingSymbolCount = 0
      s.unresolvedSourceCount = null
      s.isComplete = false
      s.completionHandled = false
      s.symbolBreakdown = freshShadowSymbolBreakdown()
      s.telemetry = freshShadowTelemetry()
      postToWorker({ type: 'resetDecoder' })
    },
    noteFrameBoundary() {
      postToWorker({ type: 'noteFrameBoundary' })
    },
    reconstruct() {
      const id = receiverWorkerNextId++
      return new Promise((resolve, reject) => {
        receiverWorkerReconstructPending.set(id, {
          resolve: (res) => {
            if (res && res.error) reject(new Error(res.error))
            else if (res && res.data) resolve(res.data)
            else reject(new Error('Worker reconstruct returned no data'))
          },
          reject
        })
        if (!postToWorker({ type: 'reconstruct', id })) {
          receiverWorkerReconstructPending.delete(id)
          reject(new Error('Worker unavailable'))
        }
      })
    }
  }
}

function serializeParsedPacket(parsed) {
  // parsePacket returns a flat object with fileId/symbolId/etc. plus a
  // zero-copy payload subarray. Copy the payload so the worker gets an
  // owned buffer and the main thread's capture buffer stays reusable.
  const payload = parsed.payload
    ? new Uint8Array(parsed.payload.buffer, parsed.payload.byteOffset, parsed.payload.byteLength).slice()
    : null
  return {
    fileId: parsed.fileId,
    k: parsed.k,
    symbolId: parsed.symbolId,
    blockSize: parsed.blockSize,
    isMetadata: parsed.isMetadata,
    mode: parsed.mode,
    payloadCrc: parsed.payloadCrc,
    payload
  }
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

function createReceiverPerfState() {
  return {
    captureMs: createPerfWindow(),
    anchorMs: createPerfWindow(),
    fastPathMs: createPerfWindow(),
    decodeMs: createPerfWindow(),
    classifierMs: createPerfWindow(),
    totalMs: createPerfWindow(),
    intervalMs: createPerfWindow(),
    acceptMs: createPerfWindow(),
    framesSinceLog: 0,
    lastFrameStartMs: 0,
    lastCaptureMethod: null,
    acceptCalls: 0,
    acceptedPackets: 0,
    crcFailFrames: 0,
    salvagedFrames: 0,
    salvagedPackets: 0,
    phaseRecoveredFrames: 0,
    phaseRecoveredPackets: 0,
    fixedRecoveredFrames: 0,
    fixedRecoveredPackets: 0,
    headerlessRecoveredFrames: 0,
    headerlessRecoveredPackets: 0
  }
}

function clearReceiverPerfSamples(perf) {
  resetPerfWindow(perf.captureMs)
  resetPerfWindow(perf.anchorMs)
  resetPerfWindow(perf.fastPathMs)
  resetPerfWindow(perf.decodeMs)
  resetPerfWindow(perf.classifierMs)
  resetPerfWindow(perf.totalMs)
  resetPerfWindow(perf.intervalMs)
  resetPerfWindow(perf.acceptMs)
  perf.framesSinceLog = 0
  perf.acceptCalls = 0
  perf.acceptedPackets = 0
  perf.crcFailFrames = 0
  perf.salvagedFrames = 0
  perf.salvagedPackets = 0
  perf.phaseRecoveredFrames = 0
  perf.phaseRecoveredPackets = 0
  perf.fixedRecoveredFrames = 0
  perf.fixedRecoveredPackets = 0
  perf.headerlessRecoveredFrames = 0
  perf.headerlessRecoveredPackets = 0
}

function resetReceiverPerfState() {
  state.rxPerf = createReceiverPerfState()
}

const CAPTURE_REBENCH_INTERVAL_FRAMES = 2000

function createCaptureTuningState() {
  const canUseVideoFrame = typeof VideoFrame !== 'undefined'
  return {
    canUseVideoFrame,
    preferredMethod: canUseVideoFrame ? null : 'video',
    benchmarkRemaining: canUseVideoFrame ? CAPTURE_BENCHMARK_SAMPLES_PER_METHOD * 2 : 0,
    videoSampleCount: 0,
    videoSampleTotalMs: 0,
    videoFrameSampleCount: 0,
    videoFrameSampleTotalMs: 0,
    roiPreferredMethod: canUseVideoFrame ? null : 'video',
    roiBenchmarkRemaining: canUseVideoFrame ? CAPTURE_BENCHMARK_SAMPLES_PER_METHOD * 2 : 0,
    roiVideoSampleCount: 0,
    roiVideoSampleTotalMs: 0,
    roiVideoFrameSampleCount: 0,
    roiVideoFrameSampleTotalMs: 0,
    totalFramesSeen: 0
  }
}

// Periodically invalidate the previous capture-method decision so the receiver
// adapts when GPU load shifts mid-session. The initial benchmark runs under
// whatever load was present at start; if the user later launches a game or
// closes one, the old winner may stop being the faster path.
function maybeRebenchmarkCaptureMethod() {
  const tuning = state.captureTuning
  if (!tuning || !tuning.canUseVideoFrame) return
  tuning.totalFramesSeen++
  if (tuning.totalFramesSeen % CAPTURE_REBENCH_INTERVAL_FRAMES !== 0) return
  tuning.preferredMethod = null
  tuning.benchmarkRemaining = CAPTURE_BENCHMARK_SAMPLES_PER_METHOD * 2
  tuning.videoSampleCount = 0
  tuning.videoSampleTotalMs = 0
  tuning.videoFrameSampleCount = 0
  tuning.videoFrameSampleTotalMs = 0
  tuning.roiPreferredMethod = null
  tuning.roiBenchmarkRemaining = CAPTURE_BENCHMARK_SAMPLES_PER_METHOD * 2
  tuning.roiVideoSampleCount = 0
  tuning.roiVideoSampleTotalMs = 0
  tuning.roiVideoFrameSampleCount = 0
  tuning.roiVideoFrameSampleTotalMs = 0
  debugLog('Capture-method benchmark re-entered (periodic)')
}

function resetCaptureTuningState() {
  state.captureTuning = createCaptureTuningState()
}

function noteCaptureTuningSample(method, durationMs, isRoi = false) {
  const tuning = state.captureTuning
  if (!tuning || !Number.isFinite(durationMs)) return
  if (method !== 'video' && method !== 'VideoFrame') return
  const preferredKey = isRoi ? 'roiPreferredMethod' : 'preferredMethod'
  if (tuning[preferredKey]) return

  const videoCountKey = isRoi ? 'roiVideoSampleCount' : 'videoSampleCount'
  const videoTotalKey = isRoi ? 'roiVideoSampleTotalMs' : 'videoSampleTotalMs'
  const videoFrameCountKey = isRoi ? 'roiVideoFrameSampleCount' : 'videoFrameSampleCount'
  const videoFrameTotalKey = isRoi ? 'roiVideoFrameSampleTotalMs' : 'videoFrameSampleTotalMs'
  const benchmarkRemainingKey = isRoi ? 'roiBenchmarkRemaining' : 'benchmarkRemaining'

  if (method === 'video') {
    tuning[videoCountKey]++
    tuning[videoTotalKey] += durationMs
  } else {
    tuning[videoFrameCountKey]++
    tuning[videoFrameTotalKey] += durationMs
  }
  if (tuning[benchmarkRemainingKey] > 0) tuning[benchmarkRemainingKey]--

  const haveEnoughVideo = tuning[videoCountKey] >= CAPTURE_BENCHMARK_SAMPLES_PER_METHOD
  const haveEnoughVideoFrame = tuning[videoFrameCountKey] >= CAPTURE_BENCHMARK_SAMPLES_PER_METHOD
  if (!haveEnoughVideo || !haveEnoughVideoFrame) return

  const avgVideoMs = tuning[videoTotalKey] / tuning[videoCountKey]
  const avgVideoFrameMs = tuning[videoFrameTotalKey] / tuning[videoFrameCountKey]
  tuning[preferredKey] = avgVideoMs <= avgVideoFrameMs ? 'video' : 'VideoFrame'
  debugLog(
    `Capture tuning: prefer ${tuning[preferredKey]}${isRoi ? ' ROI' : ''} ` +
    `(video=${avgVideoMs.toFixed(2)}ms, VideoFrame=${avgVideoFrameMs.toFixed(2)}ms)`
  )
}

// innovationCount counts packets that delivered a new symbol to the decoder
// (receiveParsed returned true). Duplicate-only frames contribute 0 here so
// `pkts=` in the RX perf log reflects useful decoder throughput rather than
// raw parse count, which would otherwise overstate progress under replay.
function noteReceiverAcceptPerf(durationMs, innovationCount, accepted) {
  const perf = state.rxPerf
  if (!perf) return

  recordPerfSample(perf.acceptMs, durationMs)
  perf.acceptCalls++
  if (accepted) perf.acceptedPackets += innovationCount
}

function noteReceiverCrcFailFrame() {
  const perf = state.rxPerf
  if (!perf) return
  perf.crcFailFrames++
}

function noteReceiverRecovery(kind, packetCount) {
  const perf = state.rxPerf
  if (!perf) return

  switch (kind) {
    case 'salvage':
      perf.salvagedFrames++
      perf.salvagedPackets += packetCount
      break
    case 'phase':
      perf.phaseRecoveredFrames++
      perf.phaseRecoveredPackets += packetCount
      break
    case 'fixed':
      perf.fixedRecoveredFrames++
      perf.fixedRecoveredPackets += packetCount
      break
    case 'headerless':
      perf.headerlessRecoveredFrames++
      perf.headerlessRecoveredPackets += packetCount
      break
  }
}

function noteReceiverFramePerf(frameStartMs, captureMethod, captureMs, anchorMs, fastPathMs, decodeMs, classifierMs = 0) {
  const perf = state.rxPerf
  if (!perf) return

  if (perf.lastFrameStartMs > 0) {
    recordPerfSample(perf.intervalMs, frameStartMs - perf.lastFrameStartMs)
  }
  perf.lastFrameStartMs = frameStartMs

  recordPerfSample(perf.captureMs, captureMs)
  recordPerfSample(perf.anchorMs, anchorMs)
  recordPerfSample(perf.fastPathMs, fastPathMs)
  recordPerfSample(perf.decodeMs, decodeMs)
  recordPerfSample(perf.classifierMs, classifierMs)
  recordPerfSample(perf.totalMs, performance.now() - frameStartMs)
  perf.framesSinceLog++
  perf.lastCaptureMethod = captureMethod || perf.lastCaptureMethod
  maybeRebenchmarkCaptureMethod()

  if (perf.framesSinceLog < RX_PERF_LOG_INTERVAL_FRAMES) return

  const avgIntervalMs = averagePerfWindow(perf.intervalMs)
  const processedFps = avgIntervalMs > 0 ? 1000 / avgIntervalMs : 0
  const avgAcceptCalls = perf.framesSinceLog > 0 ? perf.acceptCalls / perf.framesSinceLog : 0
  const avgAcceptedPackets = perf.framesSinceLog > 0 ? perf.acceptedPackets / perf.framesSinceLog : 0
  const frameBase = perf.framesSinceLog > 0 ? perf.framesSinceLog : 1
  const recoverySummary =
    `crcFail=${perf.crcFailFrames}/${perf.framesSinceLog} ` +
    `recover=s${(perf.salvagedFrames / frameBase).toFixed(2)}/${(perf.salvagedPackets / frameBase).toFixed(2)} ` +
    `p${(perf.phaseRecoveredFrames / frameBase).toFixed(2)}/${(perf.phaseRecoveredPackets / frameBase).toFixed(2)} ` +
    `f${(perf.fixedRecoveredFrames / frameBase).toFixed(2)}/${(perf.fixedRecoveredPackets / frameBase).toFixed(2)} ` +
    `h${(perf.headerlessRecoveredFrames / frameBase).toFixed(2)}/${(perf.headerlessRecoveredPackets / frameBase).toFixed(2)}`

  const t = state.decoder?.telemetry
  const telemetrySummary = t
    ? `stall=${t.stallFramesSinceLastSolve} paritySeen=${t.paritySweepComplete} pNoProg=${t.parityNoProgressSweeps} tailTrig=${t.tailSolveTriggerCount}`
    : 'stall=n/a paritySeen=n/a pNoProg=n/a tailTrig=n/a'

  debugLog(
    `RX perf: fps=${processedFps.toFixed(1)} ` +
    `capture=${averagePerfWindow(perf.captureMs).toFixed(2)}ms ` +
    `anchor=${averagePerfWindow(perf.anchorMs).toFixed(2)}ms ` +
    `fast=${averagePerfWindow(perf.fastPathMs).toFixed(2)}ms ` +
    `decode=${averagePerfWindow(perf.decodeMs).toFixed(2)}ms ` +
    `cls=${averagePerfWindow(perf.classifierMs).toFixed(2)}ms ` +
    `acceptCall=${averagePerfWindow(perf.acceptMs).toFixed(2)}ms ` +
    `total=${averagePerfWindow(perf.totalMs).toFixed(2)}ms ` +
    `acceptCalls=${avgAcceptCalls.toFixed(2)}/frame pkts=${avgAcceptedPackets.toFixed(2)}/frame ` +
    `${recoverySummary} method=${perf.lastCaptureMethod || 'n/a'} ` +
    `${telemetrySummary}`
  )

  clearReceiverPerfSamples(perf)
}

let captureBenchFrames = 0

function noteCaptureBenchFrame(method, width, height) {
  captureBenchFrames++
  if (captureBenchFrames < RX_PERF_LOG_INTERVAL_FRAMES) return

  const perf = state.rxPerf
  if (!perf) return

  const avgIntervalMs = averagePerfWindow(perf.intervalMs)
  const processedFps = avgIntervalMs > 0 ? 1000 / avgIntervalMs : 0
  const captureAvgMs = averagePerfWindow(perf.captureMs)

  debugLog(
    `captureBench: method=${method} roi=${width}x${height} ` +
    `capture=${captureAvgMs.toFixed(2)}ms fps=${processedFps.toFixed(1)}`
  )

  captureBenchFrames = 0
}

function formatMaybeNumber(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

function formatMaybeInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : 'n/a'
}

function formatDecisionCandidate(candidate) {
  if (!candidate) return 'n/a'
  const name = `${candidate.hypothesis}${candidate.refined ? '*' : ''}`
  return (
    `${name}(score=${formatMaybeInt(candidate.score)} crc=${candidate.crcValid ? 1 : 0} ` +
    `${candidate.width}x${candidate.height}@${candidate.fps} len=${candidate.payloadLength} ` +
    `off=(${formatMaybeInt(candidate.xOff)},${formatMaybeInt(candidate.yOff)}) ` +
    `step=${formatMaybeNumber(candidate.stepX)}/${formatMaybeNumber(candidate.stepY)} ` +
    `grid=${formatMaybeInt(candidate.blocksX)}x${formatMaybeInt(candidate.blocksY)})`
  )
}

function formatDecisionScale(diag) {
  if (!diag) return null
  return (
    `Scale: measured=${formatMaybeInt(diag.measuredFrameW)}x${formatMaybeInt(diag.measuredFrameH)} ` +
    `decoded=${formatMaybeInt(diag.decodedFrameW)}x${formatMaybeInt(diag.decodedFrameH)} ` +
    `ratio=${formatMaybeNumber(diag.decodedToMeasuredX)}/${formatMaybeNumber(diag.decodedToMeasuredY)} ` +
    `geom=${diag.geometryClass || 'n/a'} winner=${diag.decision?.winner?.hypothesis || diag.hypothesis || 'base'}${diag.decision?.winner?.refined ? '*' : ''} ` +
    `score=${formatMaybeInt(diag.decision?.winner?.score ?? diag.score)} ` +
    `reason=${diag.decision?.reason || 'n/a'}`
  )
}

function formatDecisionCandidates(diag) {
  const candidates = diag?.decision?.candidates || []
  if (candidates.length === 0) return null
  return `Tried: ${candidates.map(formatDecisionCandidate).join('; ')}`
}

function formatRecoveryState(expectedPacketSize, totalFramePackets, salvagedCount, fixedCount, salvageStrategy = null, salvagePacketSize = null) {
  return (
    `Recovery: expectedPkt=${formatMaybeInt(expectedPacketSize)} ` +
    `slots=${formatMaybeInt(totalFramePackets)} salvage=${formatMaybeInt(salvagedCount)} ` +
    `fixed=${formatMaybeInt(fixedCount)} expectedSlots=${formatMaybeInt(state.expectedPacketCount)} ` +
    `salvageMode=${salvageStrategy || 'n/a'}@${formatMaybeInt(salvagePacketSize)}`
  )
}

function getDisplayProgressPercent(decoder = state.decoder) {
  if (!decoder) return 0
  const raw = Math.floor((decoder.progress || 0) * 100)
  if (decoder.isComplete()) return 100
  return Math.max(0, Math.min(99, raw))
}

function getProgressBytes() {
  if (!state.decoder?.metadata) return null
  return state.decoder.progress * state.decoder.metadata.fileSize
}

function recordProgressSample() {
  const bytes = getProgressBytes()
  if (bytes === null) return

  const now = Date.now()
  state.progressSamples.push({ time: now, bytes })

  const cutoff = now - 10000
  while (state.progressSamples.length > 0 && state.progressSamples[0].time < cutoff) {
    state.progressSamples.shift()
  }
}

function getThroughputStats() {
  const bytes = getProgressBytes()
  if (bytes === null || !state.startTime) return null

  const now = Date.now()
  const elapsed = (now - state.startTime) / 1000
  const average = elapsed > 0 ? bytes / elapsed : 0

  let recent = null
  if (state.progressSamples.length >= 2) {
    const first = state.progressSamples[0]
    const last = state.progressSamples[state.progressSamples.length - 1]
    const recentElapsed = (last.time - first.time) / 1000
    if (recentElapsed > 0) {
      recent = (last.bytes - first.bytes) / recentElapsed
    }
  }

  return { average, recent }
}

function tryVariableFramePackets(framePayload) {
  // HDMI-UVC batching uses equal-sized packets inside each frame payload.
  // Keep the variable-path disabled so bootstrap salvage relies on the more
  // reliable equal-chunk probe instead of stale block-size header offsets.
  return []
}

function tryEqualChunkFramePackets(framePayload, maxPackets = 16) {
  let best = null

  for (let slotCount = 2; slotCount <= maxPackets; slotCount++) {
    if (framePayload.length % slotCount !== 0) continue

    const packetSize = framePayload.length / slotCount
    if (packetSize < PACKET_HEADER_SIZE) continue

    const packets = []
    for (let offset = 0; offset < framePayload.length; offset += packetSize) {
      const packet = framePayload.slice(offset, offset + packetSize)
      if (parsePacket(packet)) packets.push(packet)
    }

    if (packets.length === 0) continue

    const validBytes = packets.length * packetSize
    if (
      !best ||
      packets.length > best.packets.length ||
      (packets.length === best.packets.length && validBytes > best.validBytes) ||
      (packets.length === best.packets.length && validBytes === best.validBytes && slotCount > best.slotCount)
    ) {
      best = { packets, slotCount, packetSize, validBytes }
    }
  }

  return best
}

function probeFramePackets(framePayload, expectedPacketSize = null) {
  if (expectedPacketSize && expectedPacketSize >= PACKET_HEADER_SIZE) {
    if (framePayload.length % expectedPacketSize !== 0) {
      return { packets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'expected' }
    }

    const packets = []
    for (let offset = 0; offset < framePayload.length; offset += expectedPacketSize) {
      const packet = framePayload.slice(offset, offset + expectedPacketSize)
      if (parsePacket(packet)) {
        packets.push(packet)
      }
    }
    return {
      packets,
      slotCount: Math.floor(framePayload.length / expectedPacketSize),
      packetSize: expectedPacketSize,
      strategy: 'expected'
    }
  }

  const variablePackets = tryVariableFramePackets(framePayload)
  if (variablePackets.length > 0) {
    return {
      packets: variablePackets,
      slotCount: variablePackets.length,
      packetSize: variablePackets[0]?.length ?? null,
      strategy: 'variable'
    }
  }

  const equalChunk = tryEqualChunkFramePackets(framePayload)
  if (equalChunk) {
    return {
      packets: equalChunk.packets,
      slotCount: equalChunk.slotCount,
      packetSize: equalChunk.packetSize,
      strategy: 'equal'
    }
  }

  return { packets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'none' }
}

function isBetterPacketProbe(candidate, best) {
  if (!candidate) return false
  if (!best) return true

  const candidatePackets = candidate.probe?.packets?.length || 0
  const bestPackets = best.probe?.packets?.length || 0
  if (candidatePackets !== bestPackets) return candidatePackets > bestPackets

  const candidatePacketSize = candidate.probe?.packetSize || 0
  const bestPacketSize = best.probe?.packetSize || 0
  const candidateBytes = candidatePackets * candidatePacketSize
  const bestBytes = bestPackets * bestPacketSize
  if (candidateBytes !== bestBytes) return candidateBytes > bestBytes

  const candidateDistance = Math.abs(candidate.xAdjust) + Math.abs(candidate.yAdjust)
  const bestDistance = Math.abs(best.xAdjust) + Math.abs(best.yAdjust)
  return candidateDistance < bestDistance
}

function probeLayoutPackets(imageData, width, region, layout, payloadLength, expectedPacketSize = null, options = {}) {
  if (!layout || !payloadLength || payloadLength <= 0) return null

  const {
    includeScaleSearch = false,
    offsets: customOffsets = null,
    scales: customScales = null
  } = options

  const offsets = customOffsets || [0, -1, 1, -2, 2]
  const scales = customScales || (includeScaleSearch ? [1, 0.995, 1.005] : [1])

  let best = null

  for (const scale of scales) {
    for (const xAdjust of offsets) {
      for (const yAdjust of offsets) {
        const candidateLayout = {
          ...layout,
          xOff: (layout.xOff || 0) + xAdjust,
          yOff: (layout.yOff || 0) + yAdjust,
          stepX: layout.stepX * scale,
          stepY: layout.stepY * scale,
          dataBs: layout.dataBs * scale,
          headerStepX: layout.headerStepX ? layout.headerStepX * scale : undefined,
          headerStepY: layout.headerStepY ? layout.headerStepY * scale : undefined,
          headerBs: layout.headerBs ? layout.headerBs * scale : undefined
        }
        const payload = readPayloadWithLayout(imageData, width, region, candidateLayout, payloadLength)
        if (!payload) continue

        const probe = probeFramePackets(payload, expectedPacketSize)
        const candidate = { payload, probe, layout: candidateLayout, xAdjust, yAdjust }
        if (isBetterPacketProbe(candidate, best)) best = candidate
      }
    }
  }

  return best
}

function getLayoutProbeOptions(layout) {
  if (!layout) return {}

  switch (layout.frameMode) {
    case HDMI_MODE.CODEBOOK_3:
      return {
        includeScaleSearch: true,
        offsets: [0, -1, 1, -2, 2, -3, 3],
        scales: [1, 0.995, 1.005]
      }
    case HDMI_MODE.LUMA_2:
      return {
        offsets: [0, -1, 1, -2, 2]
      }
    default:
      return {}
  }
}

function getLockedLayoutProbeOptions(layout) {
  if (!layout) return {}

  switch (layout.frameMode) {
    case HDMI_MODE.COMPAT_4:
    case HDMI_MODE.RAW_GRAY:
    case HDMI_MODE.RAW_RGB:
    case HDMI_MODE.LUMA_2:
      return {
        offsets: [0, -1, 1]
      }
    case HDMI_MODE.CODEBOOK_3:
      return {
        offsets: [0, -1, 1, -2, 2],
        scales: [1, 0.995, 1.005]
      }
    default:
      return {}
  }
}

function extractFramePackets(framePayload, expectedPacketSize = null) {
  return probeFramePackets(framePayload, expectedPacketSize).packets
}

function getFramePacketSlotCount(framePayload, expectedPacketSize = null) {
  return probeFramePackets(framePayload, expectedPacketSize).slotCount
}

function readLayoutPacketsExact(imageData, width, region, layout, payloadLength, expectedPacketSize = null) {
  if (!layout || !payloadLength || payloadLength <= 0) return null

  const payload = readPayloadWithLayout(imageData, width, region, layout, payloadLength)
  if (!payload) return null

  return {
    payload,
    probe: probeFramePackets(payload, expectedPacketSize),
    layout
  }
}

function ensureDecoder() {
  if (!state.decoder) {
    if (WORKER_FULL_ENABLED && receiverWorker && receiverWorkerReady) {
      state.decoder = createWorkerDecoderShadow()
      debugLog('Decoder created (worker-backed shadow)')
    } else {
      state.decoder = createDecoder()
      debugLog('Decoder created')
    }
    state.startTime = Date.now()
    showReceivingStatus()
  }
}

function noteSignalDetected(mode, resolution = null) {
  if (mode === null || mode === undefined) return

  const firstDetection = state.detectedMode === null
  if (state.detectedMode === null) {
    state.detectedMode = mode
    if (state.detectedMode !== HDMI_MODE.CIMBAR) {
      resetCimbarSink()
    }
  }

  if (resolution?.width && resolution?.height) {
    state.detectedResolution = { width: resolution.width, height: resolution.height }
    elements.signalStatus.textContent = `Detected: ${resolution.width}x${resolution.height}`
  } else if (firstDetection) {
    elements.signalStatus.textContent = `Detected: ${HDMI_MODE_NAMES[mode]}`
  }

  if (firstDetection) {
    debugLog(`=== SIGNAL DETECTED ===`)
    debugLog(
      resolution?.width && resolution?.height
        ? `Mode: ${HDMI_MODE_NAMES[mode]}, ${resolution.width}x${resolution.height}`
        : `Mode: ${HDMI_MODE_NAMES[mode]}`
    )
  }
}

function getExpectedPacketSize() {
  return state.decoder ? state.decoder.blockSize + PACKET_HEADER_SIZE : null
}

function tryFixedLayoutPackets(imageData, width, region) {
  const expectedPacketSize = getExpectedPacketSize()
  if (!expectedPacketSize || !state.fixedLayout || state.expectedPacketCount < 1) return []

  const payloadLength = expectedPacketSize * state.expectedPacketCount
  const best = probeLayoutPackets(
    imageData,
    width,
    region,
    state.fixedLayout,
    payloadLength,
    expectedPacketSize,
    getLayoutProbeOptions(state.fixedLayout)
  )
  if (!best) return []
  if (best.layout) state.fixedLayout = { ...best.layout }
  return best.probe?.packets || []
}

async function tryLockedLayoutFastPath(imageData, width, region) {
  const activeMode = state.detectedMode ?? state.fixedLayout?.frameMode ?? state.preferredLayout?.frameMode
  if (
    activeMode !== HDMI_MODE.COMPAT_4 &&
    activeMode !== HDMI_MODE.RAW_GRAY &&
    activeMode !== HDMI_MODE.RAW_RGB &&
    activeMode !== HDMI_MODE.LUMA_2 &&
    activeMode !== HDMI_MODE.CODEBOOK_3
  ) {
    return false
  }
  const lockedLayout = state.fixedLayout || state.preferredLayout
  if (!lockedLayout || state.expectedPacketCount < 1) return false

  const expectedPacketSize = getExpectedPacketSize()
  if (!expectedPacketSize) return false

  const payloadLength = expectedPacketSize * state.expectedPacketCount
  const exact = readLayoutPacketsExact(
    imageData,
    width,
    region,
    lockedLayout,
    payloadLength,
    expectedPacketSize
  )
  const exactPackets = exact?.probe?.packets || []
  if (exactPackets.length > 0) {
    if (await acceptPackets(exactPackets, state.frameCount, true, state.expectedPacketCount)) {
      state.lockedLayoutFastPathMisses = 0
      if (exact.layout) {
        state.fixedLayout = { ...exact.layout }
        state.preferredLayout = { ...exact.layout }
      }
      if (state.decoder?.isComplete()) return true
      scheduleNextFrame()
      return true
    }
  }

  state.lockedLayoutFastPathMisses++
  const shouldRunRecoveryProbe =
    state.lockedLayoutFastPathMisses === 1 ||
    (state.lockedLayoutFastPathMisses % LOCKED_LAYOUT_RECOVERY_PROBE_INTERVAL_FRAMES) === 0
  if (!shouldRunRecoveryProbe) return false

  const best = probeLayoutPackets(
    imageData,
    width,
    region,
    lockedLayout,
    payloadLength,
    expectedPacketSize,
    getLockedLayoutProbeOptions(lockedLayout)
  )
  if (!best) return false

  const packets = best.probe?.packets || []
  if (packets.length === 0) return false
  if (best.layout) {
    state.fixedLayout = { ...best.layout }
    state.preferredLayout = { ...best.layout }
  }

  if (await acceptPackets(packets, state.frameCount, true, state.expectedPacketCount)) {
    state.lockedLayoutFastPathMisses = 0
    if (state.decoder?.isComplete()) return true
    scheduleNextFrame()
    return true
  }

  return false
}

async function acceptPackets(packets, fallbackSymbolId, countAsValidFrame = true, expectedFramePacketCount = packets.length, preIngestedResult = null) {
  const acceptStartMs = performance.now()
  let accepted = false
  let innovationCount = 0

  try {
    if (!preIngestedResult && packets.length === 0) return false

    ensureDecoder()
    const decoder = state.decoder

    let lastParsed = null
    const parsedList = []
    // Count of packets the ingest stage actually accepted this frame. For the
    // non-worker path this is parsedList.length (pre-dedup); for the worker
    // path we trust the worker's reported `accepted`. Drives progress/UI
    // displays and the "did we make real progress" guard.
    let acceptedPacketCount = 0
    if (preIngestedResult) {
      // The worker already decoded and ingested this frame's packets in a
      // single round trip (see workerDecodeAndIngest). If the decode came
      // back CRC-valid but zero inner packets parsed, treat the same as an
      // empty-packets frame on the non-worker path — no progress, don't
      // count as valid, don't clear decodeFailCount. Otherwise relock
      // heuristics stall while the receiver happily counts useless frames.
      acceptedPacketCount = preIngestedResult.accepted || 0
      if (acceptedPacketCount === 0) return false
      innovationCount = preIngestedResult.innovations || 0
      if (preIngestedResult.header) {
        lastParsed = { symbolId: preIngestedResult.header.symbolId }
      } else {
        lastParsed = { symbolId: fallbackSymbolId }
      }
    } else {
      for (const packet of packets) {
        const parsed = parsePacket(packet)
        if (!parsed) continue
        lastParsed = parsed
        parsedList.push(parsed)
      }
      if (!lastParsed) return false
      acceptedPacketCount = parsedList.length
    }

    if (preIngestedResult) {
      // Worker already did the ingest — nothing more to do here. Fall
      // through to the bookkeeping block below.
    } else if (WORKER_FULL_ENABLED && receiverWorker && receiverWorkerReady &&
        typeof decoder.ingestBatch === 'function') {
      // Worker ingests the whole frame's batch and returns the authoritative
      // innovation count — main-thread telemetry stays honest for
      // duplicate-only frames.
      const batchResult = await decoder.ingestBatch(parsedList)
      if (batchResult && batchResult.error) {
        // Worker went away (postMessage failed, terminated, etc.). Treat
        // the frame as a failure so relock/decodeFailCount can respond;
        // subsequent frames will fall through to the main-thread path.
        debugLog(`Worker ingestBatch failed: ${batchResult.error} — frame dropped`)
        return false
      }
      innovationCount = batchResult.innovations || 0
      // Trust the worker's accepted count — it reflects packets the decoder
      // actually took (post-dedup). Our local parsedList count overstates
      // that for duplicate-only frames.
      if (typeof batchResult.accepted === 'number') {
        acceptedPacketCount = batchResult.accepted
      }
      if (acceptedPacketCount === 0) return false
      // Companion state reset still runs from the delta handler on
      // newSessionEvent; don't re-run it here to avoid double-reset.
    } else {
      for (const parsed of parsedList) {
        let result = decoder.receiveParsed(parsed)
        // Sender restarted — reset in-flight session state and re-ingest the packet.
        if (result === 'new_session') {
          debugLog('New session detected (sender restart / config change); resetting decoder state')
          decoder.reset()
          state.validFrames = 0
          // Reseed the rate clock — ensureDecoder() only runs when state.decoder
          // is null, so it won't fire again for the reused decoder object.
          state.startTime = Date.now()
          state.completedFile = null
          state.completionStarted = false
          state.progressSamples = []
          state.expectedPacketCount = 0
          state.fixedLayout = null
          state.preferredLayout = null
          state.lockedLayoutFastPathMisses = 0
          state.decodeFailCount = 0
          result = decoder.receiveParsed(parsed)
        }
        // receiveParsed returns true for new symbols, false for duplicates
        // (dedup at decoder.js:190). Only `true` counts as innovation.
        if (result === true) innovationCount++
      }
    }
    const anyInnovation = innovationCount > 0

    if (countAsValidFrame) {
      state.validFrames++
      state.decodeFailCount = 0
    }

    state.expectedPacketCount = Math.max(acceptedPacketCount, expectedFramePacketCount || 0)
    recordProgressSample()

    const nowMs = performance.now()
    const forceUiUpdate = decoder.isComplete() || state.validFrames <= 1
    const shouldRefreshUi = shouldUpdateReceiverUi(state.lastReceivingUiUpdateMs, nowMs, forceUiUpdate)

    if (countAsValidFrame && shouldRefreshUi) {
      elements.statFrames.textContent = state.validFrames + ' valid frames'
    }

    if (state.validFrames % RX_PROGRESS_LOG_INTERVAL_FRAMES === 0) {
      const throughput = getThroughputStats()
      const symbolBreakdown = decoder.symbolBreakdown || {}
      const rateSuffix = throughput
        ? ` rate=${formatBytes(throughput.average)}/s recent=${formatBytes(throughput.recent ?? throughput.average)}/s`
        : ''
      debugLog(
        `Progress: ${getDisplayProgressPercent(decoder)}% ` +
        `solved=${decoder.solved}/${decoder.K || '?'} ` +
        `unique=${decoder.uniqueSymbols} ` +
        `src=${symbolBreakdown.sourceCount ?? '?'} ` +
        `par=${symbolBreakdown.parityCount ?? '?'} ` +
        `fou=${symbolBreakdown.fountainCount ?? '?'} ` +
        `meta=${symbolBreakdown.metadataCount ?? '?'} ` +
        `pending=${decoder.pendingSymbolCount ?? '?'} ` +
        `missing=${decoder.unresolvedSourceCount ?? '?'} ` +
        `sym=${lastParsed.symbolId ?? fallbackSymbolId} pkts=${acceptedPacketCount}` +
        rateSuffix
      )
    }

    if (shouldRefreshUi) {
      debugCurrent(
        `#${state.validFrames} sym=${lastParsed.symbolId ?? fallbackSymbolId} ` +
        `${getDisplayProgressPercent(decoder)}% x${acceptedPacketCount}`
      )
      updateProgress()
      state.lastReceivingUiUpdateMs = nowMs
    }

    if (decoder.isComplete()) {
      if (!shouldRefreshUi) {
        updateProgress()
        state.lastReceivingUiUpdateMs = nowMs
      }
      debugLog('=== TRANSFER COMPLETE ===')
      handleComplete()
    }

    // Signal this frame was accepted. The stall counter (noteFrameBoundary) must
    // tick on *every* accepted frame, including duplicate-only frames, so the
    // tail solver fires in the replay-heavy endgame. Innovation is tracked
    // separately for telemetry only. Delegates to updateFrameAcceptSignals so
    // the rule stays in sync with testReceiverFrameAcceptSignals.
    const nextSignals = updateFrameAcceptSignals(state, {
      acceptedAnyPacket: true,
      innovationCount
    })
    state.frameAcceptedThisFrame = nextSignals.frameAcceptedThisFrame
    state.frameInnovatedThisFrame = nextSignals.frameInnovatedThisFrame
    accepted = true
    return true
  } finally {
    noteReceiverAcceptPerf(performance.now() - acceptStartMs, innovationCount, accepted)
  }
}

const HDMI_CIMBAR_MODE = 68
const HDMI_CIMBAR_VARIANT_NAME = 'B'
const HDMI_CIMBAR_TILE_COUNT = 1
const HDMI_CIMBAR_TILE_GAP = 0
const HDMI_CIMBAR_TILE_PADDING = {
  top: 20,
  right: 20,
  bottom: 10,
  left: 10
}
const TENTATIVE_ANCHOR_MAX_FAILS = 10

function getHdmiCimbarLayout(width, height) {
  return {
    captureRoi: {
      x: Math.max(0, Math.floor((width - Math.min(width, height)) / 2)),
      y: Math.max(0, Math.floor((height - Math.min(width, height)) / 2)),
      w: Math.min(width, height),
      h: Math.min(width, height)
    }
  }
}

const state = {
  decoder: null,
  cimbarCurrentMode: 0,
  cimbarLoaded: false,
  cimbarRecentDecode: -1,
  cimbarRecentExtract: -1,
  cimbarFileSize: 0,
  cimbarRawBytes: 0,
  cimbarProgressSamples: [],
  cimbarRoi: null,
  cimbarTileRois: null,
  cimbarRoiMisses: 0,
  cimbarImgBuff: null,
  cimbarFountainBuff: null,
  cimbarReportBuff: null,
  stream: null,
  canvas: null,
  ctx: null,
  cimbarCanvas: null,
  cimbarCtx: null,
  animationId: null,
  callbackId: null,
  isScanning: false,
  frameCount: 0,
  validFrames: 0,
  startTime: null,
  detectedMode: null,
  detectedResolution: null,
  completedFile: null,
  completionStarted: false,  // Synchronous guard — set before await in handleComplete()
  anchorBounds: null,  // Cached data region from detected anchors
  lockedCaptureRegion: null,
  tentativeAnchorBounds: null,
  tentativeLockedCaptureRegion: null,
  tentativeAnchors: null,
  decodeFailCount: 0,  // Consecutive decode failures (triggers relock when too many)
  activeCaptureMethod: null,
  fixedLayout: null,
  expectedPacketCount: 0,
  preferredLayout: null,
  lockedLayoutFastPathMisses: 0,
  progressSamples: [],
  lastReceivingUiUpdateMs: 0,
  rxPerf: createReceiverPerfState(),
  captureTuning: createCaptureTuningState(),
  workerCaptureActive: false,
  workerCapturePending: false,
  offscreenCaptureActive: false,
  workerCaptureSourceRect: null,
  offscreenBitmapInFlightAt: null,
  workerCaptureStartDeadlineId: null,
  workerCaptureStopRequested: false,
  workerCaptureStartPendingAfterStop: false,
  frameAcceptedThisFrame: false,
  frameInnovatedThisFrame: false,
  lastImageData: null,
  lastImageDataSeq: 0,
  lastImageDataCapturedAtMs: 0,
  labFrameTapEnabled: false
}

const CIMBAR_MODE_LABELS = {
  [HDMI_CIMBAR_MODE]: HDMI_CIMBAR_VARIANT_NAME
}

// Check if requestVideoFrameCallback is available (better sync than requestAnimationFrame)
const hasVideoFrameCallback = typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype

// Check if VideoFrame API is available (direct frame access)
const hasVideoFrame = typeof VideoFrame !== 'undefined'

// Check if ImageCapture API is available (better for UVC devices)
const hasImageCapture = typeof ImageCapture !== 'undefined'

let elements = null
let imageCapture = null
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

function ensureCimbarBuffers(Module, imgSize) {
  if (!state.cimbarImgBuff || state.cimbarImgBuff.length < imgSize) {
    if (state.cimbarImgBuff) Module._free(state.cimbarImgBuff.byteOffset)
    const imgPtr = Module._malloc(imgSize)
    state.cimbarImgBuff = new Uint8Array(Module.HEAPU8.buffer, imgPtr, imgSize)
  }

  const bufSize = Module._cimbard_get_bufsize()
  if (!state.cimbarFountainBuff || state.cimbarFountainBuff.length < bufSize) {
    if (state.cimbarFountainBuff) Module._free(state.cimbarFountainBuff.byteOffset)
    const ptr = Module._malloc(bufSize)
    state.cimbarFountainBuff = new Uint8Array(Module.HEAPU8.buffer, ptr, bufSize)
  }

  if (!state.cimbarReportBuff) {
    const ptr = Module._malloc(1024)
    state.cimbarReportBuff = new Uint8Array(Module.HEAPU8.buffer, ptr, 1024)
  }
}

function getCimbarReport(Module) {
  if (!state.cimbarReportBuff) return null
  const reportLen = Module._cimbard_get_report(state.cimbarReportBuff.byteOffset, 1024)
  if (reportLen <= 0) return null

  const reportView = new Uint8Array(Module.HEAPU8.buffer, state.cimbarReportBuff.byteOffset, reportLen)
  const text = new TextDecoder().decode(reportView)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function getCimbarProgressFraction(report) {
  if (Array.isArray(report) && typeof report[0] === 'number' && Number.isFinite(report[0])) {
    return Math.max(0, Math.min(1, report[0]))
  }
  if (report && typeof report === 'object') {
    const value = report.progress ?? report.pct ?? report.percent
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value > 1 ? Math.max(0, Math.min(1, value / 100)) : Math.max(0, Math.min(1, value))
    }
  }
  return null
}

function getCimbarReportedFileSize(report) {
  if (Array.isArray(report)) {
    for (let i = 1; i < report.length; i++) {
      const value = report[i]
      if (typeof value === 'number' && Number.isFinite(value) && value > 1024) {
        return Math.round(value)
      }
    }
  }
  if (report && typeof report === 'object') {
    const value = report.fileSize ?? report.filesize ?? report.totalBytes ?? report.bytesTotal ?? report.size
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return Math.round(value)
    }
  }
  return 0
}

function recordCimbarProgressSample(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return

  const now = Date.now()
  state.cimbarProgressSamples.push({ time: now, bytes })

  const cutoff = now - 10000
  while (state.cimbarProgressSamples.length > 0 && state.cimbarProgressSamples[0].time < cutoff) {
    state.cimbarProgressSamples.shift()
  }
}

function getCimbarThroughputStats(currentBytes) {
  if (!state.startTime || !Number.isFinite(currentBytes)) return null

  recordCimbarProgressSample(currentBytes)

  const now = Date.now()
  const elapsed = (now - state.startTime) / 1000
  const average = elapsed > 0 ? currentBytes / elapsed : 0

  let recent = average
  if (state.cimbarProgressSamples.length >= 2) {
    const first = state.cimbarProgressSamples[0]
    const last = state.cimbarProgressSamples[state.cimbarProgressSamples.length - 1]
    const recentElapsed = (last.time - first.time) / 1000
    if (recentElapsed > 0) {
      recent = (last.bytes - first.bytes) / recentElapsed
    }
  }

  return { average, recent }
}

function resetCimbarSink() {
  state.cimbarCurrentMode = 0
  state.cimbarRecentDecode = -1
  state.cimbarRecentExtract = -1
  state.cimbarFileSize = 0
  state.cimbarRawBytes = 0
  state.cimbarProgressSamples = []
  state.cimbarRoi = null
  state.cimbarTileRois = null
  state.cimbarRoiMisses = 0

  const Module = getCimbarModule()
  if (!Module) return
  Module._cimbard_configure_decode(4)
  Module._cimbard_configure_decode(HDMI_CIMBAR_MODE)
}

async function ensureCimbarLoaded() {
  if (state.cimbarLoaded) return true
  try {
    await loadCimbarWasm()
    state.cimbarLoaded = true
    resetCimbarSink()
    debugLog('CIMBAR decoder ready')
    return true
  } catch (err) {
    debugLog(`CIMBAR load failed: ${err.message}`)
    return false
  }
}

async function handleCimbarComplete(fileId) {
  const Module = getCimbarModule()
  if (!Module) return false

  state.isScanning = false
  cancelNextFrame()

  const fileSize = Module._cimbard_get_filesize(fileId)
  const fnLen = Module._cimbard_get_filename(fileId, state.cimbarReportBuff.byteOffset, 1024)
  const fileName = fnLen > 0
    ? new TextDecoder().decode(new Uint8Array(Module.HEAPU8.buffer, state.cimbarReportBuff.byteOffset, fnLen))
    : 'download'

  const bufSize = Module._cimbard_get_decompress_bufsize()
  const decompBuff = Module._malloc(bufSize)
  const chunks = []
  let bytesRead
  do {
    bytesRead = Module._cimbard_decompress_read(fileId, decompBuff, bufSize)
    if (bytesRead > 0) {
      chunks.push(new Uint8Array(Module.HEAPU8.buffer, decompBuff, bytesRead).slice())
    }
  } while (bytesRead > 0)
  Module._free(decompBuff)

  const fileData = new Blob(chunks, { type: 'application/octet-stream' })
  const arrayBuffer = await fileData.arrayBuffer()
  const elapsed = (Date.now() - state.startTime) / 1000
  const rate = fileSize / Math.max(elapsed, 0.001)

  state.completedFile = {
    data: arrayBuffer,
    name: fileName,
    type: 'application/octet-stream'
  }
  elements.completeName.textContent = `${fileName} (${formatBytes(fileSize)})`
  elements.completeRate.textContent = `${formatBytes(rate)}/s`
  debugLog('=== TRANSFER COMPLETE ===')
  debugLog(`Complete: ${formatBytes(fileSize)} in ${elapsed.toFixed(1)}s (${formatBytes(rate)}/s)`)
  showCompleteStatus()
  return true
}

function fitAspectRect(maxWidth, maxHeight, ratio) {
  let width = maxWidth
  let height = Math.floor(width / ratio)
  if (height > maxHeight) {
    height = maxHeight
    width = Math.floor(height * ratio)
  }
  return {
    width: Math.max(1, width),
    height: Math.max(1, height)
  }
}

function buildCimbarTileLayout(width, height) {
  const layout = getHdmiCimbarLayout(width, height)
  return {
    captureRoi: layout.captureRoi,
    absoluteTiles: [layout.captureRoi],
    relativeTiles: [{ x: 0, y: 0, w: layout.captureRoi.w, h: layout.captureRoi.h }]
  }
}

function copyCimbarImageRect(Module, imageData, imageWidth, rect) {
  const rgbaSize = rect.w * rect.h * 4
  ensureCimbarBuffers(Module, rgbaSize)

  const src = imageData.data
  const rowBytes = rect.w * 4
  let dstOffset = 0
  let srcOffset = ((rect.y * imageWidth) + rect.x) * 4

  for (let y = 0; y < rect.h; y++) {
    state.cimbarImgBuff.set(src.subarray(srcOffset, srcOffset + rowBytes), dstOffset)
    dstOffset += rowBytes
    srcOffset += imageWidth * 4
  }
}

function scanCimbarFrame(Module, imageData, width, height, mode, rect = null) {
  let scanWidth = width
  let scanHeight = height

  if (rect) {
    copyCimbarImageRect(Module, imageData, width, rect)
    scanWidth = rect.w
    scanHeight = rect.h
  } else {
    ensureCimbarBuffers(Module, imageData.data.length)
    state.cimbarImgBuff.set(imageData.data)
  }

  Module._cimbard_configure_decode(mode)
  return Module._cimbard_scan_extract_decode(
    state.cimbarImgBuff.byteOffset,
    scanWidth,
    scanHeight,
    4,
    state.cimbarFountainBuff.byteOffset,
    state.cimbarFountainBuff.length
  )
}

function resetCimbarRoiAfterMisses() {
  state.cimbarRoiMisses++
  if (state.cimbarRoiMisses === 3 && state.cimbarRoi) {
    debugLog(
      `CIMBAR ROI reset after misses: (${state.cimbarRoi.x},${state.cimbarRoi.y}) ` +
      `${state.cimbarRoi.w}x${state.cimbarRoi.h} tiles=${HDMI_CIMBAR_TILE_COUNT}`
    )
    state.cimbarRoi = null
    state.cimbarTileRois = null
    state.cimbarRoiMisses = 0
  }
}

async function tryCimbarDecode(imageData, width, height, { roiCaptured = false } = {}) {
  if (!(await ensureCimbarLoaded())) return false

  const Module = getCimbarModule()
  if (!Module) return false

  const effectiveMode = HDMI_CIMBAR_MODE
  ensureCimbarBuffers(Module, imageData.data.length)

  if (!state.cimbarRoi) {
    const layout = buildCimbarTileLayout(width, height)
    state.cimbarRoi = layout.captureRoi
    state.cimbarTileRois = {
      absolute: layout.absoluteTiles,
      relative: layout.relativeTiles
    }
    state.cimbarRoiMisses = 0
    debugLog(
      `CIMBAR ROI preset: (${state.cimbarRoi.x},${state.cimbarRoi.y}) ` +
      `${state.cimbarRoi.w}x${state.cimbarRoi.h} tiles=${HDMI_CIMBAR_TILE_COUNT}`
    )
  }

  let len = 0
  let tileHits = 0
  let completeResult = 0
  let usedRoi = roiCaptured
  if (roiCaptured) {
    len = scanCimbarFrame(Module, imageData, width, height, effectiveMode)
    if (len > 0) {
      tileHits = 1
      completeResult = Module._cimbard_fountain_decode(state.cimbarFountainBuff.byteOffset, len)
    }
    if (len <= 0) {
      resetCimbarRoiAfterMisses()
    }
  } else if (state.cimbarRoi) {
    len = scanCimbarFrame(Module, imageData, width, height, effectiveMode, state.cimbarRoi)
    if (len > 0) {
      tileHits = 1
      completeResult = Module._cimbard_fountain_decode(state.cimbarFountainBuff.byteOffset, len)
    }
    usedRoi = len > 0
    if (len <= 0) {
      resetCimbarRoiAfterMisses()
    }
  }

  if (len <= 0 && !roiCaptured) {
    len = scanCimbarFrame(Module, imageData, width, height, effectiveMode)
    if (len > 0) {
      tileHits = 1
      completeResult = Module._cimbard_fountain_decode(state.cimbarFountainBuff.byteOffset, len)
    }
    usedRoi = false
  }

  if (len > 0) {
    state.cimbarRecentDecode = state.frameCount
    state.cimbarRawBytes += len
    if (state.cimbarCurrentMode !== effectiveMode) {
      debugLog(`CIMBAR mode pinned: ${CIMBAR_MODE_LABELS[effectiveMode] || effectiveMode} (${effectiveMode})`)
    }
    state.cimbarCurrentMode = effectiveMode
    if (!state.cimbarRoi) {
      const layout = buildCimbarTileLayout(width, height)
      state.cimbarRoi = layout.captureRoi
      debugLog(
        `CIMBAR ROI locked: (${state.cimbarRoi.x},${state.cimbarRoi.y}) ` +
        `${state.cimbarRoi.w}x${state.cimbarRoi.h} tiles=${HDMI_CIMBAR_TILE_COUNT}`
      )
    }
    state.cimbarRoiMisses = 0
    if (state.detectedMode !== HDMI_MODE.CIMBAR) {
      state.detectedMode = HDMI_MODE.CIMBAR
      elements.signalStatus.textContent = 'Detected: CIMBAR'
      debugLog('=== SIGNAL DETECTED ===')
      debugLog(`Mode: ${HDMI_MODE_NAMES[HDMI_MODE.CIMBAR]}`)
    }

    const report = getCimbarReport(Module)
    const progress = getCimbarProgressFraction(report)
    const reportedFileSize = getCimbarReportedFileSize(report)
    if (reportedFileSize > 0) {
      state.cimbarFileSize = reportedFileSize
    }

    if (progress !== null) {
      if (!state.startTime) {
        state.startTime = Date.now()
        showReceivingStatus()
      }
      const pct = Math.round(progress * 100)
      elements.fileName.textContent = 'CIMBAR transfer'
      elements.statProgress.textContent = `${pct}%`
      elements.progressFill.style.width = `${pct}%`
      const currentBytes = state.cimbarFileSize > 0
        ? state.cimbarFileSize * progress
        : state.cimbarRawBytes
      const throughput = getCimbarThroughputStats(currentBytes)
      if (throughput) {
        const rawSuffix = state.cimbarFileSize > 0 ? '' : ' raw'
        elements.statRate.textContent = `${formatBytes(throughput.average)}/s${rawSuffix}`
      } else {
        elements.statRate.textContent = '-'
      }
      if (state.frameCount % 10 === 0) {
        const rateSuffix = throughput
          ? ` rate=${formatBytes(throughput.average)}/s recent=${formatBytes(throughput.recent)}/s${state.cimbarFileSize > 0 ? '' : ' raw'}`
          : ''
        debugLog(
          `CIMBAR Progress: ${pct}% len=${len} mode=${effectiveMode}` +
          `${usedRoi ? ' roi=1' : ' roi=0'} tiles=${tileHits}/${HDMI_CIMBAR_TILE_COUNT}${rateSuffix}`
        )
      }
    }

    if (completeResult > 0) {
      const fileId = Number(completeResult & BigInt(0xFFFFFFFF))
      await handleCimbarComplete(fileId)
    } else {
      debugCurrent(`#${state.frameCount} CIMBAR len=${len} x${tileHits}`)
    }
    return true
  }

  if (len === 0) {
    state.cimbarRecentExtract = state.frameCount
  }
  return false
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
    if (PERF_MODE) {
      debugLog(
        `Perf mode on: rxPerfLog=${RX_PERF_LOG_INTERVAL_FRAMES}f ` +
        `progressLog=${RX_PROGRESS_LOG_INTERVAL_FRAMES}f ` +
        `uiUpdate=${RECEIVER_UI_UPDATE_INTERVAL_MS}ms`
      )
    }

    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 60 }
      }
    }

    state.stream = await navigator.mediaDevices.getUserMedia(constraints)
    resetReceiverPerfState()
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

    // Log frame callback method
    debugLog(`Frame capture method: ${hasVideoFrameCallback ? 'requestVideoFrameCallback' : 'requestAnimationFrame'}`)

    // Set up ImageCapture if available
    if (hasImageCapture && track) {
      try {
        imageCapture = new ImageCapture(track)
        debugLog('ImageCapture API: initialized')
      } catch (e) {
        debugLog(`ImageCapture API: failed to initialize (${e.message})`)
        imageCapture = null
      }
    } else {
      debugLog('ImageCapture API: not available')
    }

    state.canvas = document.createElement('canvas')
    state.ctx = state.canvas.getContext('2d', {
      willReadFrequently: true,
      alpha: false,  // Might help with consistent color handling
      colorSpace: 'srgb'
    })
    state.cimbarCanvas = document.createElement('canvas')
    state.cimbarCtx = state.cimbarCanvas.getContext('2d', {
      willReadFrequently: true,
      alpha: false,
      colorSpace: 'srgb'
    })

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

function scheduleNextFrame() {
  if (!state.isScanning || !state.stream) return
  // Full-handoff worker capture mode pumps frames inside the worker via
  // MediaStreamTrackProcessor — main thread must not schedule its own
  // processFrame, since that would re-enable the drawImage/getImageData
  // path we just moved off.
  if (state.workerCaptureActive || state.workerCapturePending) return
  // During a reset→restart in worker mode, we've posted stopCapture and are
  // waiting for the ack before reissuing startCaptureWithTrack. Don't let
  // the main-thread loop quietly take over that window — scanning resumes
  // via the deferred start once captureStopped arrives.
  if (state.workerCaptureStartPendingAfterStop) return

  const video = elements.video
  const callback = state.offscreenCaptureActive ? processFrameForOffscreen : processFrame

  if (hasVideoFrameCallback) {
    // Use requestVideoFrameCallback for accurate frame timing
    state.callbackId = video.requestVideoFrameCallback(callback)
  } else {
    // Fallback to requestAnimationFrame
    state.animationId = requestAnimationFrame(callback)
  }
}

function ensureCaptureCanvas(canvas, width, height) {
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
}

function captureImageDataToCanvas(source, canvas, ctx, width, height, sourceRect = null) {
  ensureCaptureCanvas(canvas, width, height)
  if (sourceRect) {
    ctx.drawImage(
      source,
      sourceRect.x,
      sourceRect.y,
      sourceRect.w,
      sourceRect.h,
      0,
      0,
      width,
      height
    )
  } else {
    ctx.drawImage(source, 0, 0, width, height)
  }
  return ctx.getImageData(0, 0, width, height)
}

function rememberCapturedFrame(imageData) {
  if (!imageData) return
  state.lastImageData = imageData
  state.lastImageDataSeq++
  state.lastImageDataCapturedAtMs = performance.now()
}

export function getLastCapturedFrame() {
  return state.lastImageData
    ? {
        data: state.lastImageData.data,
        width: state.lastImageData.width,
        height: state.lastImageData.height,
        seq: state.lastImageDataSeq,
        capturedAtMs: state.lastImageDataCapturedAtMs
      }
    : null
}

function getLockedCaptureRegion(region, sourceWidth, sourceHeight) {
  const base = computeLockedCaptureRect(region, sourceWidth, sourceHeight, BLOCK_SIZE)
  if (!base) return null
  // Main-thread callers also read sourceWidth / sourceHeight off the result
  // (see processFrame's ROI freshness check) — tack them on here without
  // polluting the shared pure helper.
  return {
    ...base,
    sourceWidth,
    sourceHeight
  }
}

function lockAnchorRegion(region, sourceWidth, sourceHeight, anchors = null) {
  if (!region) return

  state.anchorBounds = region
  state.lockedCaptureRegion = getLockedCaptureRegion(region, sourceWidth, sourceHeight)
  state.tentativeAnchorBounds = null
  state.tentativeLockedCaptureRegion = null
  state.tentativeAnchors = null

  if (anchors?.length) {
    const pos = anchors.map(a => `${a.corner}(${a.x},${a.y} bs=${a.blockSize.toFixed(1)})`).join(' ')
    debugLog(`*** ANCHORS LOCKED: ${anchors.length} found, region (${region.x},${region.y}) ${region.w}x${region.h} step=${region.stepX.toFixed(1)}/${region.stepY.toFixed(1)} ***`)
    debugLog(`  Anchors: ${pos}`)
    if (state.lockedCaptureRegion) {
      const { sourceRect } = state.lockedCaptureRegion
      debugLog(`  Capture ROI: (${sourceRect.x},${sourceRect.y}) ${sourceRect.w}x${sourceRect.h}`)
    }
  }
}

function setTentativeAnchorRegion(region, sourceWidth, sourceHeight, anchors = null) {
  if (!region || state.anchorBounds) return

  state.tentativeAnchorBounds = region
  state.tentativeLockedCaptureRegion = getLockedCaptureRegion(region, sourceWidth, sourceHeight)
  state.tentativeAnchors = anchors || null
}

function clearTentativeAnchorRegion() {
  state.tentativeAnchorBounds = null
  state.tentativeLockedCaptureRegion = null
  state.tentativeAnchors = null
}

async function processFrame(now, metadata) {
  if (!state.isScanning || !state.stream) return

  const video = elements.video
  if (video.videoWidth === 0) {
    scheduleNextFrame()
    return
  }

  const width = video.videoWidth
  const height = video.videoHeight

  let imageData
  let imageWidth = width
  let imageHeight = height
  let decodeRegion = state.anchorBounds || state.tentativeAnchorBounds
  let captureMethod = 'video'
  let usedCimbarRoiCapture = false
  const frameStartMs = performance.now()
  let captureMs = 0
  let anchorMs = 0
  let fastPathMs = 0
  let decodeMs = 0
  let classifierMs = 0
  let framePerfFinalized = false
  // Reset per-frame accept signals. frameAcceptedThisFrame drives
  // noteFrameBoundary; frameInnovatedThisFrame drives innovation stats only.
  state.frameAcceptedThisFrame = false
  state.frameInnovatedThisFrame = false
  const finalizeFramePerf = () => {
    if (framePerfFinalized) return
    framePerfFinalized = true
    noteReceiverFramePerf(frameStartMs, captureMethod, captureMs, anchorMs, fastPathMs, decodeMs, classifierMs)
    if (state.frameAcceptedThisFrame &&
        typeof state.decoder?.noteFrameBoundary === 'function') {
      state.decoder.noteFrameBoundary()
      // If the tail solver just closed the file, surface completion now
      // rather than on the next frame — acceptPackets already checked
      // isComplete() before noteFrameBoundary ran.
      if (state.decoder.isComplete() && !state.completedFile) {
        debugLog('=== TRANSFER COMPLETE (via tail solver) ===')
        handleComplete()
      }
    }
  }
  const captureStartMs = performance.now()

  // ImageCapture is useful for initial acquisition, but it is noticeably
  // slower than drawing the video element directly. Once we have either HDMI
  // anchor lock or a CIMBAR ROI / signal lock, prioritize raw video frames.
  const useImageCapture = imageCapture &&
    !state.anchorBounds &&
    !state.tentativeAnchorBounds &&
    !(state.detectedMode === HDMI_MODE.CIMBAR && state.cimbarRoi) &&
    state.detectedMode !== HDMI_MODE.CIMBAR
  const useCimbarRoiCapture = state.detectedMode === HDMI_MODE.CIMBAR && !!state.cimbarRoi
  let lockedCapture = null
  const anchorRegionForCapture = state.anchorBounds || state.tentativeAnchorBounds
  if (shouldUseLockedCaptureRegion(anchorRegionForCapture, state.labFrameTapEnabled) && state.detectedMode !== HDMI_MODE.CIMBAR) {
    const needsLockedCaptureRefresh =
      state.anchorBounds
        ? (
            !state.lockedCaptureRegion ||
            state.lockedCaptureRegion.sourceWidth !== width ||
            state.lockedCaptureRegion.sourceHeight !== height
          )
        : (
            !state.tentativeLockedCaptureRegion ||
            state.tentativeLockedCaptureRegion.sourceWidth !== width ||
            state.tentativeLockedCaptureRegion.sourceHeight !== height
          )
    if (needsLockedCaptureRefresh) {
      const refreshedCaptureRegion = getLockedCaptureRegion(anchorRegionForCapture, width, height)
      if (state.anchorBounds) {
        state.lockedCaptureRegion = refreshedCaptureRegion
      } else {
        state.tentativeLockedCaptureRegion = refreshedCaptureRegion
      }
      if (refreshedCaptureRegion) {
        const { sourceRect } = refreshedCaptureRegion
        debugLog(
          `Capture ROI ${state.anchorBounds ? 'locked' : 'candidate'}: src=(${sourceRect.x},${sourceRect.y}) ` +
          `${sourceRect.w}x${sourceRect.h}`
        )
      }
    }
    lockedCapture = state.anchorBounds
      ? state.lockedCaptureRegion
      : state.tentativeLockedCaptureRegion
  }

  if (useCimbarRoiCapture) {
    const roi = state.cimbarRoi
    imageWidth = roi.w
    imageHeight = roi.h

    if (hasVideoFrame && metadata) {
      try {
        const frame = new VideoFrame(video, { timestamp: metadata.mediaTime * 1000000 || 0 })
        imageData = captureImageDataToCanvas(
          frame,
          state.cimbarCanvas,
          state.cimbarCtx,
          roi.w,
          roi.h,
          roi
        )
        frame.close()
        captureMethod = 'VideoFrame ROI'
        usedCimbarRoiCapture = true
      } catch (e) {
        // Fall through to direct video ROI capture
      }
    }

    if (!imageData) {
      imageData = captureImageDataToCanvas(
        video,
        state.cimbarCanvas,
        state.cimbarCtx,
        roi.w,
        roi.h,
        roi
      )
      captureMethod = 'video ROI'
      usedCimbarRoiCapture = true
    }
  }

  // Try ImageCapture API first while scanning for initial lock
  if (useImageCapture) {
    try {
      const bitmap = await imageCapture.grabFrame()
      imageData = captureImageDataToCanvas(bitmap, state.canvas, state.ctx, width, height)
      bitmap.close()
      captureMethod = 'ImageCapture'
    } catch (e) {
      // Fall through to other methods
    }
  }

  // For the steady-state HDMI path, benchmark VideoFrame against direct video
  // capture and keep whichever is faster for the session.
  if (!imageData) {
    const tuning = state.captureTuning
    const roiCapture = !!lockedCapture
    const preferredMethod = roiCapture ? tuning?.roiPreferredMethod : tuning?.preferredMethod
    const videoFrameSampleCount = roiCapture ? tuning?.roiVideoFrameSampleCount : tuning?.videoFrameSampleCount
    const videoSampleCount = roiCapture ? tuning?.roiVideoSampleCount : tuning?.videoSampleCount
    const useVideoFrameCapture = hasVideoFrame && metadata && (
      preferredMethod === 'VideoFrame' ||
      (!preferredMethod && videoFrameSampleCount <= videoSampleCount)
    )

    if (useVideoFrameCapture) {
      try {
        const frame = new VideoFrame(video, { timestamp: metadata.mediaTime * 1000000 || 0 })
        if (lockedCapture) {
          imageData = captureImageDataToCanvas(
            frame,
            state.canvas,
            state.ctx,
            lockedCapture.width,
            lockedCapture.height,
            lockedCapture.sourceRect
          )
          imageWidth = lockedCapture.width
          imageHeight = lockedCapture.height
          decodeRegion = lockedCapture.region
          captureMethod = 'VideoFrame ROI'
        } else {
          imageData = captureImageDataToCanvas(frame, state.canvas, state.ctx, width, height)
          captureMethod = 'VideoFrame'
        }
        frame.close()
      } catch (e) {
        // Fall through to direct video capture
      }
    }
  }

  // Default steady-state path: draw video directly to canvas.
  if (!imageData) {
    if (lockedCapture) {
      imageData = captureImageDataToCanvas(
        video,
        state.canvas,
        state.ctx,
        lockedCapture.width,
        lockedCapture.height,
        lockedCapture.sourceRect
      )
      imageWidth = lockedCapture.width
      imageHeight = lockedCapture.height
      decodeRegion = lockedCapture.region
      captureMethod = 'video ROI'
    } else {
      imageData = captureImageDataToCanvas(video, state.canvas, state.ctx, width, height)
      captureMethod = 'video'
    }
  }
  captureMs = performance.now() - captureStartMs
  rememberCapturedFrame(imageData)
  noteCaptureTuningSample(
    captureMethod.startsWith('VideoFrame') ? 'VideoFrame' : captureMethod.startsWith('video') ? 'video' : captureMethod,
    captureMs,
    captureMethod.endsWith('ROI')
  )
  // Phase 5 sub-phase 1 diagnostic: the hash probe clones the full
  // ImageData buffer every 30 frames, which pollutes worker-vs-nonworker
  // A/B numbers. Restrict it to the dedicated ?worker=hash mode so anchors
  // and full runs give clean measurements.
  if (WORKER_MODE === 'hash') maybeProbeReceiverWorker(imageData)

  // Capture-only benchmark mode: once anchors are locked (so lockedCapture
  // drove the ROI capture this frame), skip all decode work and just record
  // capture timing. Pre-lock frames fall through to anchor detection — we
  // need the lock to measure the locked-ROI path the feedback asks for.
  if (CAPTURE_BENCH_ONLY && state.anchorBounds) {
    noteCaptureBenchFrame(captureMethod, imageWidth, imageHeight)
    finalizeFramePerf()
    if (state.isScanning) scheduleNextFrame()
    return
  }

  const frameWidth = imageWidth
  const frameHeight = imageHeight

  if (captureMethod !== state.activeCaptureMethod) {
    state.activeCaptureMethod = captureMethod
    debugLog(`Capture path: ${captureMethod}`)
  }

  state.frameCount++
  const isDiagFrame = state.frameCount <= 5 || state.frameCount % 30 === 0

  if (state.detectedMode === HDMI_MODE.CIMBAR) {
    let cimbarDetected = await tryCimbarDecode(imageData, imageWidth, imageHeight, { roiCaptured: usedCimbarRoiCapture })
    if (!cimbarDetected && usedCimbarRoiCapture) {
      let fallbackImageData = null
      let fallbackMethod = captureMethod
      if (hasVideoFrame && metadata) {
        try {
          const frame = new VideoFrame(video, { timestamp: metadata.mediaTime * 1000000 || 0 })
          fallbackImageData = captureImageDataToCanvas(frame, state.canvas, state.ctx, width, height)
          frame.close()
          fallbackMethod = 'VideoFrame'
        } catch (e) {
          // Fall through to direct video capture
        }
      }
      if (!fallbackImageData) {
        fallbackImageData = captureImageDataToCanvas(video, state.canvas, state.ctx, width, height)
        fallbackMethod = 'video'
      }
      if (fallbackMethod !== state.activeCaptureMethod) {
        state.activeCaptureMethod = fallbackMethod
        debugLog(`Capture path: ${fallbackMethod}`)
      }
      cimbarDetected = await tryCimbarDecode(fallbackImageData, width, height)
    }
    if (state.isScanning) scheduleNextFrame()
    finalizeFramePerf()
    return
  }

  if (!state.anchorBounds && (state.detectedMode === null || state.detectedMode === HDMI_MODE.CIMBAR)) {
    const cimbarDetected = await tryCimbarDecode(imageData, width, height)
    if (cimbarDetected) {
      if (state.isScanning) scheduleNextFrame()
      finalizeFramePerf()
      return
    }
  }

  // Diagnostic: find canvas bounds and scan for anchors
  if (!state.anchorBounds && isDiagFrame) {
    const p = imageData.data

    // Step 1: Find chrome bottom (transition from bright to dark at center x)
    const midX = Math.floor(frameWidth / 2)
    let chromeBottom = 0
    for (let y = 0; y < Math.min(200, frameHeight - 1); y++) {
      if (p[(y * frameWidth + midX) * 4] > 100 && p[((y + 1) * frameWidth + midX) * 4] < 30) {
        chromeBottom = y + 1
        break
      }
    }

    // Step 2: Find canvas left edge — scan right from x=0 at chromeBottom+16
    // (skip MJPEG ringing zone, probe mid-margin area)
    const probeY = chromeBottom + 16
    let canvasLeft = 0
    // The canvas margin is black (≤5). Find where values go from HDMI-black to canvas-black.
    // They look the same, so instead scan for first pixel >20 (data region)
    // then subtract margin width to estimate canvas left.
    let firstData = -1
    for (let x = 0; x < frameWidth; x++) {
      if (p[(probeY * frameWidth + x) * 4] > 20) { firstData = x; break }
    }

    debugLog(`Chrome bottom: ${chromeBottom}, probeY: ${probeY}, firstData@probeY: ${firstData}`)

    // Step 3: Scan for ANY bright pixel below chrome, skipping the chrome area
    // Search in top-left quadrant below chrome
    let tlX = -1, tlY = -1
    outer_tl:
    for (let y = chromeBottom; y < Math.min(chromeBottom + 200, frameHeight); y++) {
      for (let x = 0; x < Math.min(300, frameWidth); x++) {
        if (p[(y * frameWidth + x) * 4] > 150) { tlX = x; tlY = y; break outer_tl }
      }
    }
    debugLog(`TL first bright(>150) below chrome: (${tlX},${tlY})`)

    if (tlX >= 0 && tlY >= 0) {
      // Dump horizontal and vertical strips around the find
      const hstrip = []
      for (let x = Math.max(0, tlX - 5); x < Math.min(frameWidth, tlX + 45); x++) {
        hstrip.push(p[(tlY * frameWidth + x) * 4])
      }
      debugLog(`  Row${tlY} R[${Math.max(0,tlX-5)}..+50]: ${hstrip.join(',')}`)

      const vstrip = []
      for (let y = Math.max(0, tlY - 5); y < Math.min(frameHeight, tlY + 40); y++) {
        vstrip.push(p[(y * frameWidth + tlX) * 4])
      }
      debugLog(`  Col${tlX} R[${Math.max(0,tlY-5)}..+45]: ${vstrip.join(',')}`)
    } else {
      // No bright pixel found! Dump raw values in the expected anchor zone
      debugLog(`NO bright pixel found below chrome! Dumping rows ${chromeBottom}..${chromeBottom+5} x=0..60:`)
      for (let y = chromeBottom; y < Math.min(chromeBottom + 6, frameHeight); y++) {
        const row = []
        for (let x = 0; x < Math.min(60, frameWidth); x++) row.push(p[(y * frameWidth + x) * 4])
        debugLog(`  Row${y}: ${row.join(',')}`)
      }
    }

    // Bottom-right scan (skip last few rows which might be chrome/dock)
    let brX = -1, brY = -1
    outer_br:
    for (let y = frameHeight - 1; y >= Math.max(0, frameHeight - 200); y--) {
      for (let x = frameWidth - 1; x >= Math.max(0, frameWidth - 300); x--) {
        if (p[(y * frameWidth + x) * 4] > 150) { brX = x; brY = y; break outer_br }
      }
    }
    debugLog(`BR last bright(>150): (${brX},${brY})`)
    if (brX >= 0) {
      const hstrip = []
      for (let x = Math.max(0, brX - 40); x < Math.min(frameWidth, brX + 10); x++) {
        hstrip.push(p[(brY * frameWidth + x) * 4])
      }
      debugLog(`  Row${brY} R[${Math.max(0,brX-40)}..+50]: ${hstrip.join(',')}`)
    }

    // Center
    const cx = Math.floor(frameWidth / 2), cy = Math.floor(frameHeight / 2)
    const center = []
    for (let x = cx - 5; x <= cx + 5; x++) center.push(p[(cy * frameWidth + x) * 4])
    debugLog(`Center[${cx},${cy}]: ${center.join(',')}`)
  }

  // === ANCHOR DETECTION ===
  let region = decodeRegion
  let candidateRegion = null
  let candidateAnchors = null

  if (!region) {
    const anchorStartMs = performance.now()
    let anchors = null
    if (WORKER_ANCHORS_ENABLED && receiverWorker && receiverWorkerReady) {
      const workerResult = await workerDetectAnchors(imageData, frameWidth, frameHeight)
      if (workerResult) {
        anchors = workerResult.anchors || []
        // Prefer the worker-computed region when present; it used the same
        // dataRegionFromAnchors locally. Fall back to null so the
        // length-gate below handles insufficient anchors cleanly.
        if (anchors.length >= 2 && workerResult.region) {
          candidateRegion = workerResult.region
        }
      }
    }
    if (!anchors) {
      anchors = detectAnchors(imageData.data, frameWidth, frameHeight)
    }
    anchorMs += performance.now() - anchorStartMs
    if (anchors.length >= 2) {
      if (!candidateRegion) candidateRegion = dataRegionFromAnchors(anchors)
      if (candidateRegion) {
        setTentativeAnchorRegion(candidateRegion, frameWidth, frameHeight, anchors)
        region = candidateRegion
        candidateAnchors = anchors
      } else if (isDiagFrame) {
        // Anchors found but region invalid (e.g. all at same y = false positives)
        const pos = anchors.map(a => `(${a.x},${a.y} ${a.corner})`).join(' ')
        debugLog(`Frame ${state.frameCount}: ${anchors.length} anchors but invalid region: ${pos}`)
        debugCurrent(`#${state.frameCount} bad anchors`)
      }
    } else if (isDiagFrame) {
      debugLog(`Frame ${state.frameCount}: ${anchors.length} anchors found (need ≥2)`)
      debugCurrent(`#${state.frameCount} scanning...`)
    }
  }

  if (!region) {
    scheduleNextFrame()
    finalizeFramePerf()
    return
  }

  const fastPathStartMs = performance.now()
  const fastPathAccepted = await tryLockedLayoutFastPath(imageData, frameWidth, region)
  fastPathMs += performance.now() - fastPathStartMs
  if (fastPathAccepted) {
    finalizeFramePerf()
    return
  }

  // === DECODE DATA REGION ===
  region.preferredLayout = state.preferredLayout
  let result = null
  let workerDecodedFrame = false
  let workerDecodedResp = null

  if (WORKER_FULL_ENABLED && receiverWorker && receiverWorkerReady) {
    // Worker runs decodeDataRegion + (on CRC-valid) the ingest batch in one
    // round-trip. This is the real Phase 5 frame-pump offload — on CRC-valid
    // frames the main thread spends decodeMs on transport + bookkeeping only.
    const expectedPacketSize = getExpectedPacketSize()
    const decodeStartMs = performance.now()
    const resp = await workerDecodeAndIngest(imageData, frameWidth, region, expectedPacketSize)
    decodeMs += performance.now() - decodeStartMs
    if (resp && resp.decodeResult) {
      workerDecodedResp = resp
      const dr = resp.decodeResult
      if (dr.crcValid) {
        // Worker already ingested; synthesize the `result` shape the
        // downstream code expects without shipping the full payload back.
        result = {
          crcValid: true,
          header: dr.header,
          payload: null,
          _diag: dr._diag || null
        }
        workerDecodedFrame = true
      } else {
        // CRC-invalid: worker shipped payload back as an ArrayBuffer so the
        // salvage paths can try it locally. Rehydrate into a Uint8Array so
        // the existing local code reads it the same way.
        result = {
          crcValid: false,
          header: dr.header,
          payload: dr.payload ? new Uint8Array(dr.payload) : null,
          _diag: dr._diag || null
        }
      }
    }
  }

  if (!result) {
    resetClassifierPerfAccumulator()
    const decodeStartMs = performance.now()
    result = decodeDataRegion(imageData.data, frameWidth, region)
    decodeMs += performance.now() - decodeStartMs
    classifierMs += getClassifierPerfAccumulator()
  }

  if (result && result.crcValid) {
    noteSignalDetected(result.header.mode, {
      width: result.header.width,
      height: result.header.height
    })

    let frameAccepted = false
    if (workerDecodedFrame && workerDecodedResp) {
      // Worker already ingested — run the bookkeeping via the preIngested
      // path. Synthesize totalFramePackets from the worker's reported slot
      // count so downstream progress logs stay accurate.
      const totalFramePackets = workerDecodedResp.decodeResult.slotCount || workerDecodedResp.accepted || 0
      frameAccepted = await acceptPackets(
        [],
        result.header.symbolId,
        true,
        totalFramePackets,
        {
          header: result.header,
          accepted: workerDecodedResp.accepted || 0,
          innovations: workerDecodedResp.innovations || 0
        }
      )
    } else {
      const expectedPacketSize = getExpectedPacketSize()
      const totalFramePackets = getFramePacketSlotCount(result.payload, expectedPacketSize)
      const packets = extractFramePackets(result.payload, expectedPacketSize)
      frameAccepted = await acceptPackets(packets, result.header.symbolId, true, totalFramePackets)
    }

    if (frameAccepted) {
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (result._diag) state.fixedLayout = { ...result._diag }
      if (result._diag) state.preferredLayout = { ...result._diag }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
    } else {
      // CRC-valid outer frame but zero inner packets accepted (wrong block
      // size, CRC-loss on every slot, worker transport failure, etc.). Drive
      // the same relock path the CRC-fail branches use so repeated bad
      // frames don't silently keep the lock and starve progress.
      state.decodeFailCount++
      if (isDiagFrame) {
        const expectedPacketSize = getExpectedPacketSize()
        const slotCount = workerDecodedResp?.decodeResult?.slotCount ?? null
        debugLog(
          `Frame ${state.frameCount}: CRC-valid outer but 0 packets ingested ` +
          `(expectedPkt=${formatMaybeInt(expectedPacketSize)} slots=${formatMaybeInt(slotCount)} ` +
          `worker=${workerDecodedFrame ? 'yes' : 'no'})`
        )
      }
      debugCurrent(`#${state.frameCount} empty CRC-valid`)
    }
  } else if (result && !result.crcValid) {
    noteReceiverCrcFailFrame()
    if (result._diag) state.preferredLayout = { ...result._diag }
    const expectedPacketSize = getExpectedPacketSize()
    const salvageProbe = probeFramePackets(result.payload, expectedPacketSize)
    const totalFramePackets = salvageProbe.slotCount
    const salvagedPackets = salvageProbe.packets
    const fixedPackets = tryFixedLayoutPackets(imageData.data, frameWidth, region)
    const phasePayloadLength =
      expectedPacketSize && state.expectedPacketCount > 0
        ? expectedPacketSize * state.expectedPacketCount
        : result.header.payloadLength
    const phaseProbe = probeLayoutPackets(
      imageData.data,
      frameWidth,
      region,
      result._diag || state.fixedLayout || state.preferredLayout,
      phasePayloadLength,
      expectedPacketSize,
      getLayoutProbeOptions(result._diag || state.fixedLayout || state.preferredLayout)
    )
    const phasePackets = phaseProbe?.probe?.packets || []
    if (await acceptPackets(salvagedPackets, result.header.symbolId, true, totalFramePackets)) {
      noteSignalDetected(result.header.mode)
      noteReceiverRecovery('salvage', salvagedPackets.length)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (result._diag) state.fixedLayout = { ...result._diag }
      if (result._diag) state.preferredLayout = { ...result._diag }
      if (isDiagFrame) {
        debugLog(`Frame ${state.frameCount}: salvaged ${salvagedPackets.length} packet(s) from CRC-fail frame`)
      }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }
    if (await acceptPackets(phasePackets, result.header.symbolId, true, phaseProbe?.probe?.slotCount || totalFramePackets)) {
      noteSignalDetected(phaseProbe?.layout?.frameMode ?? result.header.mode)
      noteReceiverRecovery('phase', phasePackets.length)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (phaseProbe?.layout) state.fixedLayout = { ...phaseProbe.layout }
      if (phaseProbe?.layout) state.preferredLayout = { ...phaseProbe.layout }
      if (isDiagFrame) {
        debugLog(`Frame ${state.frameCount}: phase-recovered ${phasePackets.length} packet(s) from CRC-fail frame`)
      }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }
    if (await acceptPackets(fixedPackets, result.header.symbolId, true, state.expectedPacketCount)) {
      noteSignalDetected(state.fixedLayout?.frameMode ?? result.header.mode)
      noteReceiverRecovery('fixed', fixedPackets.length)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (isDiagFrame) {
        debugLog(`Frame ${state.frameCount}: recovered ${fixedPackets.length} packet(s) via fixed layout`)
      }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }

    state.decodeFailCount++
    if (isDiagFrame) {
      // Dump full header for diagnosis
      const h = result.header
      const hBytes = `magic=${h.magic.toString(16)} mode=${h.mode} ${h.width}x${h.height} fps=${h.fps} sym=${h.symbolId} len=${h.payloadLength} crc=${h.payloadCrc.toString(16)}`
      const diag = result._diag || {}
      debugLog(`Frame ${state.frameCount}: CRC fail — ${hBytes}`)
      const scaleLine = formatDecisionScale(diag)
      if (scaleLine) debugLog(`  ${scaleLine}`)
      const triedLine = formatDecisionCandidates(diag)
      if (triedLine) debugLog(`  ${triedLine}`)
      debugLog(`  ${formatRecoveryState(expectedPacketSize, totalFramePackets, salvagedPackets.length + phasePackets.length, fixedPackets.length, salvageProbe.strategy, salvageProbe.packetSize)}`)
    }
    debugCurrent(`#${state.frameCount} CRC fail`)
  } else {
    const fixedPackets = tryFixedLayoutPackets(imageData.data, frameWidth, region)
    if (await acceptPackets(fixedPackets, state.frameCount, true, state.expectedPacketCount)) {
      noteReceiverRecovery('headerless', fixedPackets.length)
      if (!state.anchorBounds && (candidateRegion || state.tentativeAnchorBounds)) {
        lockAnchorRegion(
          candidateRegion || state.tentativeAnchorBounds,
          frameWidth,
          frameHeight,
          candidateAnchors || state.tentativeAnchors
        )
      }
      if (isDiagFrame) {
        debugLog(`Frame ${state.frameCount}: recovered ${fixedPackets.length} packet(s) without outer header`)
      }
      if (state.decoder?.isComplete()) {
        finalizeFramePerf()
        return
      }
      scheduleNextFrame()
      finalizeFramePerf()
      return
    }

    state.decodeFailCount++
    if (isDiagFrame) {
      debugLog(`Frame ${state.frameCount}: decode failed`)
      debugLog(
        `  Recovery: expectedPkt=${formatMaybeInt(getExpectedPacketSize())} ` +
        `fixedLayout=${state.fixedLayout ? 'yes' : 'no'} ` +
        `expectedSlots=${formatMaybeInt(state.expectedPacketCount)} fixed=${fixedPackets.length}`
      )
      // Sample first header block values for diagnosis using the actual mode's
      // header block size instead of assuming a fixed anchor-to-data ratio.
      const anchorBs = region.blockSize || BLOCK_SIZE
      const modeBlockSize = getModeHeaderBlockSize(state.detectedMode ?? HDMI_MODE.COMPAT_4) || 4
      const dataScale = modeBlockSize / BLOCK_SIZE
      const bs = anchorBs * dataScale
      const stepX = (region.stepX || anchorBs) * dataScale
      const rx = region.x
      const ry = region.y
      const blocksX = Math.floor(region.w / stepX)
      const probeCount = Math.min(176, blocksX) // 22 bytes × 8 bits
      const rawValues = []
      for (let i = 0; i < Math.min(24, probeCount); i++) {
        const px = rx + Math.round(i * stepX)
        const py = ry
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const cx = Math.round(px + bs / 2) - 1
          const cy = Math.round(py + bs / 2) - 1
          let sum = 0
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              sum += imageData.data[((cy + dy) * width + (cx + dx)) * 4]
            }
          }
          rawValues.push(Math.round(sum / 4))
        }
      }
      debugLog(`First 24 block values: [${rawValues.join(',')}]`)
      // Decode as binary: show what bytes they produce
      const decodedBytes = []
      for (let b = 0; b < Math.min(3, Math.floor(rawValues.length / 8)); b++) {
        let byte = 0
        for (let bit = 0; bit < 8; bit++) {
          if (rawValues[b * 8 + bit] > 128) byte |= (1 << (7 - bit))
        }
        decodedBytes.push(byte)
      }
      debugLog(`Decoded bytes: [${decodedBytes.join(',')}] (expect magic: 255,0,255,0)`)
    }
    debugCurrent(`#${state.frameCount} no data`)
  }

  // Relock anchors after too many consecutive failures (CRC or decode)
  if (!state.anchorBounds && state.tentativeAnchorBounds && state.decodeFailCount >= TENTATIVE_ANCHOR_MAX_FAILS) {
    debugLog(`Tentative anchor cleared after ${state.decodeFailCount} consecutive failures`)
    clearTentativeAnchorRegion()
  }
  if (state.decodeFailCount > 30) {
    debugLog(`Relock: ${state.decodeFailCount} consecutive failures`)
    state.anchorBounds = null
    state.lockedCaptureRegion = null
    clearTentativeAnchorRegion()
    state.fixedLayout = null
    state.preferredLayout = null
    state.expectedPacketCount = 0
    state.lockedLayoutFastPathMisses = 0
    state.decodeFailCount = 0
  }

  // Update debug canvas
  if (isDiagFrame) {
    const debugCanvas = document.getElementById('hdmi-uvc-receiver-debug-canvas')
    if (debugCanvas) {
      debugCanvas.width = Math.min(width, 640)
      debugCanvas.height = Math.min(height, 360)
      debugCanvas.getContext('2d').drawImage(state.canvas, 0, 0, debugCanvas.width, debugCanvas.height)
    }
  }

  scheduleNextFrame()
  finalizeFramePerf()
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
  const pct = getDisplayProgressPercent(state.decoder)
  elements.statProgress.textContent = pct + '%'
  elements.progressFill.style.width = pct + '%'

  const elapsed = (Date.now() - state.startTime) / 1000
  if (elapsed > 0) {
    const bytesReceived = progress * meta.fileSize
    const rate = bytesReceived / elapsed
    elements.statRate.textContent = formatBytes(rate) + '/s'
  }
}

async function handleComplete() {
  // Synchronous re-entry guard. `state.completedFile` is only set after the
  // awaited hash, so two same-tick callers (acceptPackets + finalizeFramePerf
  // when the tail solver closes the file) can both see it unset and race.
  if (state.completionStarted) return
  state.completionStarted = true

  state.isScanning = false

  cancelNextFrame()

  const decoder = state.decoder
  const meta = decoder.metadata

  // In worker mode reconstruct() returns a Promise; awaiting a non-Promise
  // value is a no-op, so this handles both the main-thread and worker paths.
  const fileData = await decoder.reconstruct()

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
  debugLog(`Complete: ${formatBytes(fileData.byteLength)} in ${elapsed.toFixed(1)}s (${formatBytes(rate)}/s)`)

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

function cancelNextFrame() {
  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }
  if (state.callbackId && hasVideoFrameCallback && elements.video) {
    elements.video.cancelVideoFrameCallback(state.callbackId)
    state.callbackId = null
  }
}

function resetReceiver() {
  state.isScanning = false
  stopWorkerCapture()

  cancelNextFrame()

  state.decoder = null
  state.cimbarCurrentMode = 0
  state.cimbarRecentDecode = -1
  state.cimbarRecentExtract = -1
  state.cimbarFileSize = 0
  state.cimbarRawBytes = 0
  state.cimbarProgressSamples = []
  state.cimbarRoi = null
  state.cimbarTileRois = null
  state.cimbarRoiMisses = 0
  state.frameCount = 0
  state.validFrames = 0
  state.startTime = null
  state.detectedMode = null
  state.detectedResolution = null
  state.completedFile = null
  state.completionStarted = false
  state.anchorBounds = null
  state.lockedCaptureRegion = null
  clearTentativeAnchorRegion()
  state.decodeFailCount = 0
  state.activeCaptureMethod = null
  state.fixedLayout = null
  state.preferredLayout = null
  state.lockedLayoutFastPathMisses = 0
  state.expectedPacketCount = 0
  state.progressSamples = []
  state.lastReceivingUiUpdateMs = 0
  state.lastImageData = null
  state.lastImageDataSeq = 0
  state.lastImageDataCapturedAtMs = 0
  resetReceiverPerfState()
  resetCaptureTuningState()
  resetCimbarSink()
  // Keep the worker alive across transfers, but reset the probe counters so
  // each transfer's telemetry starts from zero. Pending probes from a prior
  // transfer are dropped (their hashResult messages will be ignored because
  // the id is gone from the pending map).
  receiverWorkerPending.clear()
  receiverWorkerProbeState.framesSinceProbe = 0
  receiverWorkerProbeState.samplesReceived = 0
  receiverWorkerProbeState.samplesSent = 0
  receiverWorkerProbeState.logsEmitted = 0

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
  initReceiverWorker()
  // Worker-capture modes take over (or intercept) the frame pump. Attempt
  // the handoff here; if the worker isn't ready yet, the start function
  // sets state.workerCapturePending and the 'ready' handler retries.
  // scheduleNextFrame is still called so the appropriate callback kicks in
  // (worker-full mode no-ops, offscreen uses processFrameForOffscreen, main
  // falls through to the existing processFrame path).
  if (CAPTURE_METHOD === 'worker') startWorkerCapture()
  else if (CAPTURE_METHOD === 'offscreen') startOffscreenCapture()
  scheduleNextFrame()
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
  void ensureCimbarLoaded()
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

  imageCapture = null
  teardownReceiverWorker()

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

  // Debug panel buttons
  const copyBtn = document.getElementById('btn-hdmi-uvc-receiver-copy-log')
  if (copyBtn) {
    copyBtn.onclick = async () => {
      if (debugLines.length > 0) {
        try {
          await navigator.clipboard.writeText(debugLines.join('\n'))
          copyBtn.textContent = 'Copied!'
          setTimeout(() => copyBtn.textContent = 'Copy Log', 1500)
        } catch (e) {
          console.error('Copy failed:', e)
        }
      }
    }
  }
  const clearBtn = document.getElementById('btn-hdmi-uvc-receiver-clear-log')
  if (clearBtn) {
    clearBtn.onclick = () => {
      debugLines.length = 0
      flushDebugLogRender()
      debugLog('=== LOG CLEARED ===')
      debugLog(`Frame count at clear: ${state.frameCount}`)
    }
  }
  const diagPanel = document.getElementById('hdmi-uvc-receiver-diagnostics')
  if (diagPanel) {
    renderDiagnosticsPanel(
      diagPanel,
      ['captureMethod', 'wasmClassifier', 'perf', 'worker'],
      { title: 'Diagnostics (receiver)' }
    )
  }

  debugLog('HDMI-UVC Receiver initialized')
  debugLog(
    `Capture method chosen: ${CAPTURE_METHOD} ` +
    `(capabilities=${JSON.stringify(CAPTURE_CAPABILITIES)})`
  )
  debugLog(
    `Worker mode: ${WORKER_MODE} ` +
    `perf=${PERF_MODE ? 'on' : 'off'}`
  )
}

// Pure helper extracted so Phase 1's stall-counter contract is unit-testable
// without standing up a DOM/video pipeline. Mirrors the signalling rules used
// in acceptPackets + finalizeFramePerf: the frame-accepted flag ticks on any
// accepted packet, the innovated flag only when innovation occurred.
export function updateFrameAcceptSignals(prev, { acceptedAnyPacket, innovationCount }) {
  return {
    frameAcceptedThisFrame: prev.frameAcceptedThisFrame || !!acceptedAnyPacket,
    frameInnovatedThisFrame: prev.frameInnovatedThisFrame || innovationCount > 0
  }
}

export function testReceiverFrameAcceptSignals() {
  const zero = { frameAcceptedThisFrame: false, frameInnovatedThisFrame: false }

  // A duplicate-only frame: accepted but no innovation.
  const dup = updateFrameAcceptSignals(zero, { acceptedAnyPacket: true, innovationCount: 0 })
  if (!dup.frameAcceptedThisFrame || dup.frameInnovatedThisFrame) {
    console.log('FAIL dup:', dup); return false
  }

  // An innovating frame: both flags on.
  const innov = updateFrameAcceptSignals(zero, { acceptedAnyPacket: true, innovationCount: 2 })
  if (!innov.frameAcceptedThisFrame || !innov.frameInnovatedThisFrame) {
    console.log('FAIL innov:', innov); return false
  }

  // A frame that didn't accept anything: both flags stay false.
  const empty = updateFrameAcceptSignals(zero, { acceptedAnyPacket: false, innovationCount: 0 })
  if (empty.frameAcceptedThisFrame || empty.frameInnovatedThisFrame) {
    console.log('FAIL empty:', empty); return false
  }

  // Flags are sticky within a frame: once true they stay true even if a later
  // inner call reports the opposite. (The per-frame reset happens in the
  // caller, finalizeFramePerf, not in this helper.)
  const sticky = updateFrameAcceptSignals(
    { frameAcceptedThisFrame: true, frameInnovatedThisFrame: true },
    { acceptedAnyPacket: false, innovationCount: 0 }
  )
  if (!sticky.frameAcceptedThisFrame || !sticky.frameInnovatedThisFrame) {
    console.log('FAIL sticky:', sticky); return false
  }

  console.log('Receiver frame-accept signals test: PASS')
  return true
}

export async function testStallCounterTicksOnDuplicateFrames() {
  const { createDecoder } = await import('../decoder.js')
  const { createEncoder } = await import('../encoder.js')

  const fileSize = 6000
  const data = new Uint8Array(fileSize)
  for (let i = 0; i < fileSize; i++) data[i] = (i * 7 + 3) & 0xff
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  const enc = createEncoder(data.buffer, 's.bin', 'application/octet-stream', hash)
  const dec = createDecoder()

  dec.receive(enc.generateSymbol(0))          // metadata
  for (let id = 1; id <= enc.K - 2; id++) {   // feed all but the last two source blocks
    dec.receive(enc.generateSymbol(id))
  }
  // At this point the decoder should be stuck with 2 missing source blocks.
  const missingBefore = dec.unresolvedSourceCount
  if (missingBefore < 2) { console.log('FAIL setup: missing=', missingBefore); return false }

  // Now send 60 "frames" that are all duplicates of symbol 1 (already received).
  // The decoder must see noteFrameBoundary() ticks so stallFramesSinceLastSolve
  // climbs past 30 and triggers the GF(2) tail solver.
  const dupSym = enc.generateSymbol(1)
  for (let f = 0; f < 60; f++) {
    dec.receive(dupSym)
    dec.noteFrameBoundary()
  }
  const tel = dec.telemetry
  const pass = tel.stallFramesSinceLastSolve >= 60 && tel.tailSolveTriggerCount >= 1
  console.log('Duplicate-frame stall test:', pass ? 'PASS' : 'FAIL', tel)
  return pass
}
