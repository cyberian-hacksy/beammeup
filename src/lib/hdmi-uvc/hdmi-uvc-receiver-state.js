// Shared mutable receiver state. A single module-level object (matching the
// original receiver module's singleton) so the receiver, its ARQ session
// module, and tests all observe the same session state.

import { createReceiverCaptureTuningState } from './hdmi-uvc-receiver-capture.js'
import { createReceiverPerfState } from './hdmi-uvc-receiver-perf.js'

export const CAPTURE_BENCHMARK_SAMPLES_PER_METHOD = 6

export function createCaptureTuningState() {
  return createReceiverCaptureTuningState({
    canUseVideoFrame: typeof VideoFrame !== 'undefined',
    samplesPerMethod: CAPTURE_BENCHMARK_SAMPLES_PER_METHOD
  })
}

export const state = {
  decoder: null,
  stream: null,
  canvas: null,
  ctx: null,
  animationId: null,
  callbackId: null,
  isScanning: false,
  frameCount: 0,
  validFrames: 0,
  startTime: null,
  detectedMode: null,
  detectedResolution: null,
  completedFile: null,
  fileDownloaded: false,
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
  lockedDenseBinaryLayout: null,
  lockedDenseBinaryOffsets: null,
  denseBinaryLockFailStreak: 0,
  lastDenseBinaryConfidenceLogFrame: 0,
  lockedLayoutFastPathMisses: 0,
  luma1CalPassCount: 0,       // Consecutive CRC-valid calibration frames
  luma1CalHoldUntilMs: 0,     // Decode throttle while cal frames keep passing
  luma1CalLastLogMs: 0,
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
  lastReceiverFrameSignature: null,
  lastImageData: null,
  lastImageDataSeq: 0,
  lastImageDataCapturedAtMs: 0,
  labFrameTapEnabled: false,
  arqTransport: null,
  arqConnected: false,
  arqHelperConnecting: false,
  arqHelperAutoAttempted: false,
  arqController: null,
  arqFileId: null,
  arqLastSeededSolved: null,
  arqCompleteRetryTimer: null,
  arqPendingSourceIds: new Map(),
  workerCompletionSuppressed: false
}
