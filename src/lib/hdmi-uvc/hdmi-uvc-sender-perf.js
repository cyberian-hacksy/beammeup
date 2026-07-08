// Sender-side render/perf telemetry: rolling windows over frame timings plus
// frame-signature and symbol-kind counters. Everything operates on a perf
// object created by createSenderPerfState() and passed in by the caller
// (the sender keeps it in state.txPerf), so this module holds no state of
// its own.

import { debugLog } from './hdmi-uvc-sender-debug.js'
import {
  averagePerfWindow,
  createPerfWindow,
  recordPerfSample,
  resetPerfWindow
} from './hdmi-uvc-perf-window.js'

const TX_PERF_LOG_INTERVAL_FRAMES = 60

export function createSenderPerfState() {
  return {
    batchMs: createPerfWindow(),
    buildMs: createPerfWindow(),
    blitMs: createPerfWindow(),
    totalMs: createPerfWindow(),
    intervalMs: createPerfWindow(),
    jitterMs: createPerfWindow(),
    framesSinceLog: 0,
    lastFrameStartMs: 0,
    overBudgetCount: 0,
    sameFrameSignatures: 0,
    newFrameSignatures: 0,
    metadataSymbols: 0,
    sourceSymbols: 0,
    paritySymbols: 0,
    fountainSymbols: 0,
    lastFrameSignature: null
  }
}

export function clearSenderPerfSamples(perf) {
  resetPerfWindow(perf.batchMs)
  resetPerfWindow(perf.buildMs)
  resetPerfWindow(perf.blitMs)
  resetPerfWindow(perf.totalMs)
  resetPerfWindow(perf.intervalMs)
  resetPerfWindow(perf.jitterMs)
  perf.framesSinceLog = 0
  perf.overBudgetCount = 0
  perf.sameFrameSignatures = 0
  perf.newFrameSignatures = 0
  perf.metadataSymbols = 0
  perf.sourceSymbols = 0
  perf.paritySymbols = 0
  perf.fountainSymbols = 0
}

export function getSenderFrameSignatureSummary(perf) {
  if (!perf) return 'txSig=same0/0 new0/0'
  const frames = Math.max(1, perf.sameFrameSignatures + perf.newFrameSignatures)
  return `txSig=same${perf.sameFrameSignatures}/${frames} new${perf.newFrameSignatures}/${frames}`
}

export function noteSenderFrameSignature(perf, symbolIds) {
  if (!perf) return
  const signature = Array.isArray(symbolIds) ? symbolIds.join(',') : ''
  if (perf.lastFrameSignature !== null && perf.lastFrameSignature === signature) {
    perf.sameFrameSignatures++
  } else {
    perf.newFrameSignatures++
  }
  perf.lastFrameSignature = signature
}

export function getSenderSymbolKindSummary(perf) {
  if (!perf) return 'txKinds=src0 par0 fou0 meta0'
  return `txKinds=src${perf.sourceSymbols || 0} ` +
    `par${perf.paritySymbols || 0} ` +
    `fou${perf.fountainSymbols || 0} ` +
    `meta${perf.metadataSymbols || 0}`
}

export function noteSenderFrameSymbols(perf, symbolIds, encoder) {
  if (!perf) return
  noteSenderFrameSignature(perf, symbolIds)
  if (!Array.isArray(symbolIds)) return
  for (const symbolId of symbolIds) {
    if (symbolId === 0) perf.metadataSymbols++
    else if (!encoder) perf.sourceSymbols++
    else if (symbolId <= encoder.K) perf.sourceSymbols++
    else if (symbolId <= encoder.K_prime) perf.paritySymbols++
    else perf.fountainSymbols++
  }
}

export function noteSenderFramePerf(perf, frameStartMs, batchMs, buildMs, blitMs, totalMs, fps, canvasWidth, canvasHeight) {
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
    `overBudget=${perf.overBudgetCount}/${perf.totalMs.count} ` +
    `${getSenderFrameSignatureSummary(perf)} ` +
    `${getSenderSymbolKindSummary(perf)} ` +
    `canvas=${canvasWidth}x${canvasHeight}`
  )

  clearSenderPerfSamples(perf)
}

export function testSenderFrameSignatureSummary() {
  const perf = createSenderPerfState()
  noteSenderFrameSignature(perf, [1, 2, 3])
  noteSenderFrameSignature(perf, [1, 2, 3])
  noteSenderFrameSignature(perf, [4, 5, 6])
  const summary = getSenderFrameSignatureSummary(perf)
  const pass = summary.includes('txSig=same1/3') &&
    summary.includes('new2/3')
  console.log('Sender frame-signature summary test:', pass ? 'PASS' : `FAIL ${summary}`)
  return pass
}

export function testSenderFrameSymbolKindSummary() {
  const perf = createSenderPerfState()
  const encoder = { K: 10, K_prime: 13 }
  noteSenderFrameSymbols(perf, [0, 1, 10, 11, 13, 14], encoder)
  const summary = getSenderSymbolKindSummary(perf)
  const pass = summary.includes('txKinds=src2') &&
    summary.includes('par2') &&
    summary.includes('fou1') &&
    summary.includes('meta1')
  console.log('Sender symbol-kind summary test:', pass ? 'PASS' : `FAIL ${summary}`)
  return pass
}
