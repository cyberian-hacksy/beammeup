// Receiver-side debug log: a debug panel instance bound to the receiver's DOM
// elements. Split out of hdmi-uvc-receiver.js so the telemetry/ARQ modules
// can log without importing the whole receiver.

import { createDebugLogPanel } from './hdmi-uvc-debug-log.js'
import { isPerfMode } from './hdmi-uvc-diagnostics.js'

// Comes from the diagnostics module (which reads URL -> localStorage ->
// default). Captured at init time because it controls intervals and
// pipelines baked in for the session.
export const PERF_MODE = isPerfMode()

const panel = createDebugLogPanel({
  logElementId: 'hdmi-uvc-receiver-debug-log',
  currentElementId: 'hdmi-uvc-receiver-debug-current',
  consoleTag: '[HDMI-RX]',
  maxLines: 500,
  visibleLines: PERF_MODE ? 80 : 120,
  renderIntervalMs: PERF_MODE ? 480 : 120
})

export const debugLogBuffer = panel.buffer
export const setReceiverDiagPanelVisible = panel.setVisible
export const isReceiverDiagPanelVisible = panel.isVisible
export const flushDebugLogRender = panel.flush
export const debugLog = panel.debugLog
export const debugCurrent = panel.debugCurrent
