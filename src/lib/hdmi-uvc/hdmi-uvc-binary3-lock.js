// Pure Binary3 receiver lock-state helpers. The DOM/camera receiver owns the
// mutable state object; this module only mutates the Binary3 lock fields.

import { HDMI_MODE } from './hdmi-uvc-constants.js'
import { precomputeBinary3SampleOffsets } from './hdmi-uvc-frame.js'

export function clearBinary3LockState(target) {
  if (!target) return
  target.lockedBinary3Layout = null
  target.lockedBinary3Offsets = null
  target.binary3LockFailStreak = 0
}

function normalizeBinary3Layout(layoutInput, header = null) {
  if (!layoutInput || layoutInput.frameMode !== HDMI_MODE.BINARY_3) return null

  return {
    blocksX: layoutInput.blocksX,
    blocksY: layoutInput.blocksY,
    headerBlocksX: layoutInput.headerBlocksX,
    headerBlocksY: layoutInput.headerBlocksY,
    frameMode: HDMI_MODE.BINARY_3,
    bitsPerBlock: 1,
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

export function lockBinary3LayoutState(target, layoutInput, currentRegion, header = null) {
  if (!target) return { locked: false, wasLocked: false }

  const layout = normalizeBinary3Layout(layoutInput, header)
  if (!layout) return { locked: false, wasLocked: !!target.lockedBinary3Layout }

  const wasLocked = !!target.lockedBinary3Layout
  if (currentRegion) {
    const { offsets } = precomputeBinary3SampleOffsets(layout, currentRegion)
    layout.precomputedOffsets = offsets
    target.lockedBinary3Offsets = offsets
  } else {
    target.lockedBinary3Offsets = layoutInput.precomputedOffsets || null
  }

  target.lockedBinary3Layout = layout
  target.fixedLayout = { ...layout }
  target.preferredLayout = { ...layout }
  target.binary3LockFailStreak = 0

  return { locked: true, wasLocked, layout }
}

export function lockBinary3LayoutFromDecodeResult(target, result, currentRegion) {
  if (!result?._diag || result._diag.frameMode !== HDMI_MODE.BINARY_3) {
    return { locked: false, wasLocked: !!target?.lockedBinary3Layout }
  }
  return lockBinary3LayoutState(target, result._diag, currentRegion, result.header || null)
}

export function noteBinary3UnrecoveredCrcFailure(target, result, invalidateAfter) {
  if (!target || !result?._diag || result._diag.frameMode !== HDMI_MODE.BINARY_3) {
    return { counted: false, invalidated: false, failStreak: target?.binary3LockFailStreak || 0 }
  }

  target.binary3LockFailStreak = (target.binary3LockFailStreak || 0) + 1
  if (target.binary3LockFailStreak >= invalidateAfter) {
    clearBinary3LockState(target)
    return { counted: true, invalidated: true, failStreak: 0 }
  }

  return { counted: true, invalidated: false, failStreak: target.binary3LockFailStreak }
}

export function testBinary3RecoveredLayoutKeepsLock() {
  const target = {
    lockedBinary3Layout: { frameMode: HDMI_MODE.BINARY_3, stepX: 3, stepY: 3 },
    lockedBinary3Offsets: new Int32Array([1, 2]),
    binary3LockFailStreak: 4,
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

  const result = lockBinary3LayoutState(target, layout, region, {
    width: 1920,
    height: 1080,
    fps: 60
  })
  const pass = result.locked === true &&
    target.binary3LockFailStreak === 0 &&
    target.lockedBinary3Layout?.frameMode === HDMI_MODE.BINARY_3 &&
    target.lockedBinary3Layout?.frameWidth === 1920 &&
    target.fixedLayout?.frameMode === HDMI_MODE.BINARY_3 &&
    target.preferredLayout?.frameMode === HDMI_MODE.BINARY_3 &&
    target.lockedBinary3Offsets instanceof Int32Array &&
    target.lockedBinary3Offsets.length > 0

  console.log('BINARY_3 recovered layout lock test:', pass ? 'PASS' : 'FAIL', {
    result,
    failStreak: target.binary3LockFailStreak,
    hasLock: !!target.lockedBinary3Layout,
    offsets: target.lockedBinary3Offsets?.length || 0
  })
  return pass
}
