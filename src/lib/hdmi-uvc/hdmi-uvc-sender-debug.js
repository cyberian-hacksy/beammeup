// Sender-side debug log: a debug panel instance bound to the sender's DOM
// elements. Split out of hdmi-uvc-sender.js so the scheduler/perf modules can
// log without importing the whole sender.

import { createDebugLogPanel } from './hdmi-uvc-debug-log.js'

const panel = createDebugLogPanel({
  logElementId: 'hdmi-uvc-sender-debug-log',
  currentElementId: 'hdmi-uvc-sender-debug-current',
  consoleTag: '[HDMI-TX]',
  maxLines: 500,
  visibleLines: 120,
  renderIntervalMs: 120
})

export const senderDebugLogBuffer = panel.buffer
export const setSenderDiagPanelVisible = panel.setVisible
export const renderSenderDebugLog = panel.render
export const debugLog = panel.debugLog
export const debugCurrent = panel.debugCurrent
