// Pure dense-binary receiver lock-state helpers. The DOM/camera receiver owns
// the mutable state object; this module only mutates the legacy DenseBinary lock
// fields, which now also hold Binary2 layouts.

import { HDMI_MODE } from './hdmi-uvc-constants.js'
import { precomputeDenseBinarySampleOffsets } from './hdmi-uvc-frame.js'

export function clearDenseBinaryLockState(target) {
  if (!target) return
  target.lockedDenseBinaryLayout = null
  target.lockedDenseBinaryOffsets = null
  target.denseBinaryLockFailStreak = 0
}

function isDenseBinaryLockMode(mode) {
  return mode === HDMI_MODE.BINARY_3 ||
    mode === HDMI_MODE.BINARY_2 ||
    mode === HDMI_MODE.BINARY_1 ||
    mode === HDMI_MODE.LUMA_1
}

function normalizeDenseBinaryLayout(layoutInput, header = null) {
  if (!layoutInput || !isDenseBinaryLockMode(layoutInput.frameMode)) return null

  return {
    blocksX: layoutInput.blocksX,
    blocksY: layoutInput.blocksY,
    headerBlocksX: layoutInput.headerBlocksX,
    headerBlocksY: layoutInput.headerBlocksY,
    frameMode: layoutInput.frameMode,
    bitsPerBlock: layoutInput.bitsPerBlock || (layoutInput.frameMode === HDMI_MODE.LUMA_1 ? 2 : 1),
    stepX: layoutInput.stepX,
    stepY: layoutInput.stepY,
    dataBs: layoutInput.dataBs,
    headerStepX: layoutInput.headerStepX,
    headerStepY: layoutInput.headerStepY,
    headerBs: layoutInput.headerBs,
    xOff: layoutInput.xOff || 0,
    yOff: layoutInput.yOff || 0,
    blackLevel: layoutInput.blackLevel,
    whiteLevel: layoutInput.whiteLevel,
    frameWidth: layoutInput.frameWidth ?? header?.width,
    frameHeight: layoutInput.frameHeight ?? header?.height,
    fps: layoutInput.fps ?? header?.fps
  }
}

export function lockDenseBinaryLayoutState(target, layoutInput, currentRegion, header = null) {
  if (!target) return { locked: false, wasLocked: false }

  const layout = normalizeDenseBinaryLayout(layoutInput, header)
  if (!layout) return { locked: false, wasLocked: !!target.lockedDenseBinaryLayout }

  const wasLocked = !!target.lockedDenseBinaryLayout
  if (currentRegion) {
    const precomputed = precomputeDenseBinarySampleOffsets(layout, currentRegion)
    layout.precomputedOffsets = precomputed.offsets
    layout.precomputedRegion = precomputed.region
    target.lockedDenseBinaryOffsets = precomputed.offsets
  } else {
    target.lockedDenseBinaryOffsets = layoutInput.precomputedOffsets || null
    layout.precomputedRegion = layoutInput.precomputedRegion || null
  }

  target.lockedDenseBinaryLayout = layout
  target.fixedLayout = { ...layout }
  target.preferredLayout = { ...layout }
  target.denseBinaryLockFailStreak = 0

  return { locked: true, wasLocked, layout }
}

export function lockDenseBinaryLayoutFromDecodeResult(target, result, currentRegion) {
  if (!result?._diag || !isDenseBinaryLockMode(result._diag.frameMode)) {
    return { locked: false, wasLocked: !!target?.lockedDenseBinaryLayout }
  }
  return lockDenseBinaryLayoutState(target, result._diag, currentRegion, result.header || null)
}

export function noteDenseBinaryUnrecoveredCrcFailure(target, result, invalidateAfter) {
  if (!target || !result?._diag || !isDenseBinaryLockMode(result._diag.frameMode)) {
    return { counted: false, invalidated: false, failStreak: target?.denseBinaryLockFailStreak || 0 }
  }

  target.denseBinaryLockFailStreak = (target.denseBinaryLockFailStreak || 0) + 1
  if (target.denseBinaryLockFailStreak >= invalidateAfter) {
    clearDenseBinaryLockState(target)
    return { counted: true, invalidated: true, failStreak: 0 }
  }

  return { counted: true, invalidated: false, failStreak: target.denseBinaryLockFailStreak }
}

export function testBinary3RecoveredLayoutKeepsLock() {
  const target = {
    lockedDenseBinaryLayout: { frameMode: HDMI_MODE.BINARY_3, stepX: 3, stepY: 3 },
    lockedDenseBinaryOffsets: new Int32Array([1, 2]),
    denseBinaryLockFailStreak: 4,
    fixedLayout: null,
    preferredLayout: null
  }
  const region = { x: 24, y: 24, w: 1872, h: 1032 }
  const layout = {
    frameMode: HDMI_MODE.BINARY_3,
    blocksX: 621,
    blocksY: 342,
    headerBlocksX: 468,
    headerBlocksY: 4,
    bitsPerBlock: 1,
    stepX: 3,
    stepY: 3,
    dataBs: 3,
    headerStepX: 4,
    headerStepY: 4,
    headerBs: 4,
    xOff: 0,
    yOff: 0,
    blackLevel: 1,
    whiteLevel: 249
  }

  const result = lockDenseBinaryLayoutState(target, layout, region, {
    width: 1920,
    height: 1080,
    fps: 60
  })
  const pass = result.locked === true &&
    target.denseBinaryLockFailStreak === 0 &&
    target.lockedDenseBinaryLayout?.frameMode === HDMI_MODE.BINARY_3 &&
    target.lockedDenseBinaryLayout?.frameWidth === 1920 &&
    target.fixedLayout?.frameMode === HDMI_MODE.BINARY_3 &&
    target.preferredLayout?.frameMode === HDMI_MODE.BINARY_3 &&
    target.lockedDenseBinaryOffsets instanceof Int32Array &&
    target.lockedDenseBinaryOffsets.length > 0

  console.log('BINARY_3 recovered layout lock test:', pass ? 'PASS' : 'FAIL', {
    result,
    failStreak: target.denseBinaryLockFailStreak,
    hasLock: !!target.lockedDenseBinaryLayout,
    offsets: target.lockedDenseBinaryOffsets?.length || 0
  })
  return pass
}

export function testBinary2RecoveredLayoutKeepsLock() {
  const target = {
    lockedDenseBinaryLayout: { frameMode: HDMI_MODE.BINARY_3, stepX: 3, stepY: 3 },
    lockedDenseBinaryOffsets: new Int32Array([1, 2]),
    denseBinaryLockFailStreak: 4,
    fixedLayout: null,
    preferredLayout: null
  }
  const region = { x: 24, y: 24, w: 1872, h: 1032 }
  const layout = {
    frameMode: HDMI_MODE.BINARY_2,
    blocksX: 932,
    blocksY: 512,
    headerBlocksX: 468,
    headerBlocksY: 4,
    bitsPerBlock: 1,
    stepX: 2,
    stepY: 2,
    dataBs: 2,
    headerStepX: 4,
    headerStepY: 4,
    headerBs: 4,
    xOff: 0,
    yOff: 0,
    blackLevel: 1,
    whiteLevel: 249
  }

  const result = lockDenseBinaryLayoutState(target, layout, region, {
    width: 1920,
    height: 1080,
    fps: 60
  })
  const pass = result.locked === true &&
    target.denseBinaryLockFailStreak === 0 &&
    target.lockedDenseBinaryLayout?.frameMode === HDMI_MODE.BINARY_2 &&
    target.lockedDenseBinaryLayout?.frameWidth === 1920 &&
    target.fixedLayout?.frameMode === HDMI_MODE.BINARY_2 &&
    target.preferredLayout?.frameMode === HDMI_MODE.BINARY_2 &&
    target.lockedDenseBinaryOffsets instanceof Int32Array &&
    target.lockedDenseBinaryOffsets.length > 0

  console.log('BINARY_2 recovered layout lock test:', pass ? 'PASS' : 'FAIL', {
    result,
    failStreak: target.denseBinaryLockFailStreak,
    hasLock: !!target.lockedDenseBinaryLayout,
    offsets: target.lockedDenseBinaryOffsets?.length || 0
  })
  return pass
}
