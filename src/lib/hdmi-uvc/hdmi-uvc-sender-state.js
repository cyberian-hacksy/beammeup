// Shared mutable sender state. A single module-level object (matching the
// original sender module's singleton) so the sender UI, the frame scheduler,
// and tests all observe the same session state. Small mode/preset getters
// that read this state live here too, so other sender modules can use them
// without importing the whole sender.

import { METADATA_INTERVAL } from '../constants.js'
import {
  HDMI_MODE,
  FPS_PRESETS,
  DEFAULT_FPS_PRESET,
  RENDER_SIZE_PRESETS,
  DEFAULT_RENDER_SIZE_PRESET,
  isDenseBinaryMode
} from './hdmi-uvc-constants.js'
import { createSenderPerfState } from './hdmi-uvc-sender-perf.js'

export const state = {
  encoder: null,
  yolo: false,
  // True while `yolo` was switched on automatically because the back-channel
  // connected (as opposed to the user's own checkbox choice).
  yoloAutoEnabled: false,
  // The user touched the checkbox this session; automation must not fight it.
  yoloManualThisSession: false,
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
  paritySweepsInPass: 0,
  paritySystematicStride: 1,
  fountainSymbolId: 0,
  dataPacketCount: 0,
  frameCount: 0,
  mode: HDMI_MODE.LUMA_1,
  renderSizePresetId: DEFAULT_RENDER_SIZE_PRESET,
  systematicPass: 1,
  tailStartFrame: 0,
  metadataIntervalFrames: METADATA_INTERVAL * 2,
  nextFrameDueMs: 0,
  frameBuffer: null,
  frameImageData: null,
  frameBufferWidth: 0,
  frameBufferHeight: 0,
  presentation: null,
  useExternalDisplay: true,
  arqTransport: null,
  arqConnected: false,
  arqConnecting: false,
  arqController: null,
  arqCursor: 0,
  arqFallback: false,
  txPerf: createSenderPerfState()
}

// Frame rate is locked to 60 fps — the only rate Luma4 was validated at and
// the dongle's native capture rate. DEFAULT_FPS_PRESET indexes the 60 entry.
export function getFps() {
  return FPS_PRESETS[DEFAULT_FPS_PRESET]
}

export function getRenderSizePreset(id = state.renderSizePresetId) {
  return RENDER_SIZE_PRESETS.find((preset) => preset.id === id) ||
    RENDER_SIZE_PRESETS[0]
}

export function modeRequiresNative1080p(mode) {
  return isDenseBinaryMode(mode)
}
