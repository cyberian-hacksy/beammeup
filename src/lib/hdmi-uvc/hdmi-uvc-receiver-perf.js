// Receiver-side perf/telemetry primitives: rolling perf windows, the rxPerf
// state factory, summary formatters, frame-signature classification, and the
// frame-accept signal helper. Everything here is pure or operates on a perf
// object passed in by the caller (the receiver keeps it in state.rxPerf).

import {
  averagePerfWindow,
  createPerfWindow,
  resetPerfWindow
} from './hdmi-uvc-perf-window.js'

export function createReceiverPerfState() {
  return {
    captureMs: createPerfWindow(),
    anchorMs: createPerfWindow(),
    fastPathMs: createPerfWindow(),
    decodeMs: createPerfWindow(),
    classifierMs: createPerfWindow(),
    totalMs: createPerfWindow(),
    intervalMs: createPerfWindow(),
    hotCaptureMs: createPerfWindow(),
    hotAnchorMs: createPerfWindow(),
    hotFastPathMs: createPerfWindow(),
    hotDecodeMs: createPerfWindow(),
    hotClassifierMs: createPerfWindow(),
    hotTotalMs: createPerfWindow(),
    hotIntervalMs: createPerfWindow(),
    lockedFastExactReadMs: createPerfWindow(),
    lockedFastExactProbeMs: createPerfWindow(),
    acceptMs: createPerfWindow(),
    framesSinceLog: 0,
    hotFramesSinceLog: 0,
    lastFrameStartMs: 0,
    lastHotFrameStartMs: 0,
    lastCaptureMethod: null,
    lastHotCaptureMethod: null,
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
    headerlessRecoveredPackets: 0,
    lockedFastExactHits: 0,
    lockedFastExactMisses: 0,
    lockedFastExactPackets: 0,
    lockedFastRecoveryProbes: 0,
    lockedFastRecoveryHits: 0,
    lockedFastRecoveryPackets: 0,
    lockedFastReaderCounts: {},
    acceptedFrames: 0,
    innovatingFrames: 0,
    duplicateAcceptedFrames: 0,
    emptyFrames: 0,
    repeatedAcceptedFrames: 0,
    changedDuplicateFrames: 0,
    changedInnovatingFrames: 0,
    unknownAcceptedFrames: 0
  }
}

export function clearReceiverPerfSamples(perf) {
  resetPerfWindow(perf.captureMs)
  resetPerfWindow(perf.anchorMs)
  resetPerfWindow(perf.fastPathMs)
  resetPerfWindow(perf.decodeMs)
  resetPerfWindow(perf.classifierMs)
  resetPerfWindow(perf.totalMs)
  resetPerfWindow(perf.intervalMs)
  resetPerfWindow(perf.hotCaptureMs)
  resetPerfWindow(perf.hotAnchorMs)
  resetPerfWindow(perf.hotFastPathMs)
  resetPerfWindow(perf.hotDecodeMs)
  resetPerfWindow(perf.hotClassifierMs)
  resetPerfWindow(perf.hotTotalMs)
  resetPerfWindow(perf.hotIntervalMs)
  resetPerfWindow(perf.lockedFastExactReadMs)
  resetPerfWindow(perf.lockedFastExactProbeMs)
  resetPerfWindow(perf.acceptMs)
  perf.framesSinceLog = 0
  perf.hotFramesSinceLog = 0
  perf.lastHotFrameStartMs = 0
  perf.lastHotCaptureMethod = null
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
  perf.lockedFastExactHits = 0
  perf.lockedFastExactMisses = 0
  perf.lockedFastExactPackets = 0
  perf.lockedFastRecoveryProbes = 0
  perf.lockedFastRecoveryHits = 0
  perf.lockedFastRecoveryPackets = 0
  perf.lockedFastReaderCounts = {}
  perf.acceptedFrames = 0
  perf.innovatingFrames = 0
  perf.duplicateAcceptedFrames = 0
  perf.emptyFrames = 0
  perf.repeatedAcceptedFrames = 0
  perf.changedDuplicateFrames = 0
  perf.changedInnovatingFrames = 0
  perf.unknownAcceptedFrames = 0
}

function getLockedFastReaderSummary(perf) {
  const counts = perf?.lockedFastReaderCounts || {}
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return 'reader=n/a'
  return 'reader=' + entries.map(([reader, count]) => `${reader}:${count}`).join(',')
}

export function getLockedFastStageSummary(perf) {
  if (!perf) return 'lockedStage=read=0.00ms probe=0.00ms'
  return `lockedStage=read=${averagePerfWindow(perf.lockedFastExactReadMs).toFixed(2)}ms ` +
    `probe=${averagePerfWindow(perf.lockedFastExactProbeMs).toFixed(2)}ms ` +
    getLockedFastReaderSummary(perf)
}

export function getReceiverFrameUseSummary(perf) {
  if (!perf) return 'frameUse=acc0/0 innov0/0 dup0/0 empty0/0'
  const countedFrames = (perf.acceptedFrames || 0) + (perf.emptyFrames || 0)
  const frames = Math.max(1, perf.framesSinceLog || countedFrames)
  return `frameUse=acc${perf.acceptedFrames || 0}/${frames} ` +
    `innov${perf.innovatingFrames || 0}/${frames} ` +
    `dup${perf.duplicateAcceptedFrames || 0}/${frames} ` +
    `empty${perf.emptyFrames || 0}/${frames}`
}

export function classifyReceiverFrameSignature(prevSignature, { signature, accepted, innovated } = {}) {
  if (!accepted) return { nextSignature: prevSignature || null, kind: 'empty' }
  if (!signature) return { nextSignature: prevSignature || null, kind: 'unknown' }
  if (prevSignature && prevSignature === signature) {
    return { nextSignature: signature, kind: 'repeat' }
  }
  return { nextSignature: signature, kind: innovated ? 'changedInnovating' : 'changedDuplicate' }
}

export function getReceiverFrameSignatureSummary(perf) {
  if (!perf) return 'frameSig=same0/0 newDup0/0 newInnov0/0 unk0/0'
  const acceptedFrames = Math.max(1, perf.acceptedFrames || 0)
  return `frameSig=same${perf.repeatedAcceptedFrames || 0}/${acceptedFrames} ` +
    `newDup${perf.changedDuplicateFrames || 0}/${acceptedFrames} ` +
    `newInnov${perf.changedInnovatingFrames || 0}/${acceptedFrames} ` +
    `unk${perf.unknownAcceptedFrames || 0}/${acceptedFrames}`
}

export function getReceiverPacketYieldSummary(perf, expectedPacketCount) {
  const expected = Number.isFinite(expectedPacketCount) ? expectedPacketCount : 0
  if (!perf || expected <= 0 || perf.framesSinceLog <= 0) return 'yield=n/a'
  const possiblePackets = perf.framesSinceLog * expected
  const usefulPackets = perf.acceptedPackets || 0
  const pct = possiblePackets > 0 ? (usefulPackets / possiblePackets) * 100 : 0
  return `yield=${pct.toFixed(0)}%(${usefulPackets}/${possiblePackets})`
}

export function buildReceiverPacketFrameSignature(parsedList, fallbackSymbolId = null, acceptedPacketCount = 0) {
  if (!Array.isArray(parsedList) || parsedList.length === 0) {
    return fallbackSymbolId == null ? null : `fallback:${fallbackSymbolId}:${acceptedPacketCount}`
  }
  const first = parsedList[0]
  const last = parsedList[parsedList.length - 1]
  if (!first || !last) return null
  return [
    first.fileId ?? 'f?',
    first.k ?? 'k?',
    first.symbolId ?? 's?',
    last.symbolId ?? 's?',
    parsedList.length
  ].join(':')
}

export function buildReceiverPreIngestedFrameSignature(preIngestedResult, fallbackSymbolId = null, acceptedPacketCount = 0) {
  const h = preIngestedResult?.header
  if (!h) return fallbackSymbolId == null ? null : `pre:${fallbackSymbolId}:${acceptedPacketCount}`
  return `outer:${h.mode ?? 'm?'}:${h.symbolId ?? 's?'}:${acceptedPacketCount}`
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
