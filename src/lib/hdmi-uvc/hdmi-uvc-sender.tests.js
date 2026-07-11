// Test functions for hdmi-uvc-sender.js, extracted from the production module.
// Registered via src/test-suite.js (?test).
import { resolveYoloAutoState, _internals } from './hdmi-uvc-sender.js'
import { HDMI_MODE, HDMI_MODE_NAMES, FPS_PRESETS } from './hdmi-uvc-constants.js'
import { getDiagnosticDefinition } from './hdmi-uvc-diagnostics.js'
import { state, getFps, getRenderSizePreset, modeRequiresNative1080p } from './hdmi-uvc-sender-state.js'

const {
  getRenderScaleIssue,
  getSenderRenderPace,
  getRecommendedFpsPreset
} = _internals

export function testHdmiUvcSenderDefaults() {
  // The sender is locked to 1x1 Luma4 at native 1080p / 60 fps.
  const renderPreset = getRenderSizePreset()
  const fps = getFps()
  const pass = state.mode === HDMI_MODE.LUMA_1 &&
    renderPreset.id === '1080p' &&
    fps?.fps === 60
  console.log('HDMI-UVC sender defaults test:', pass ? 'PASS' : 'FAIL', {
    mode: HDMI_MODE_NAMES[state.mode],
    renderPresetId: renderPreset.id,
    fps
  })
  return pass
}

export function testBinary1RecommendedFpsIs60() {
  const binary1Preset = FPS_PRESETS[Number(getRecommendedFpsPreset(HDMI_MODE.BINARY_1))]
  const binary2Preset = FPS_PRESETS[Number(getRecommendedFpsPreset(HDMI_MODE.BINARY_2))]
  const luma1Preset = FPS_PRESETS[Number(getRecommendedFpsPreset(HDMI_MODE.LUMA_1))]
  const pass = binary1Preset?.fps === 60 &&
    binary2Preset?.fps === 60 &&
    luma1Preset?.fps === 60
  console.log('BINARY_1 60fps recommendation test:', pass ? 'PASS' : 'FAIL', {
    binary1: binary1Preset,
    binary2: binary2Preset,
    luma1: luma1Preset
  })
  return pass
}

export function testBinary1UsesTimerPacedRender() {
  const pass = getSenderRenderPace(HDMI_MODE.BINARY_1, { fps: 60 }, 'timer') === 'timer' &&
    getSenderRenderPace(HDMI_MODE.BINARY_1, { fps: 58 }, 'timer') === 'timer' &&
    getSenderRenderPace(HDMI_MODE.BINARY_2, { fps: 60 }, 'timer') === 'timer' &&
    getSenderRenderPace(HDMI_MODE.BINARY_1, { fps: 30 }, 'timer') === 'timer'
  console.log('BINARY_1 timer-paced render policy test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBinary1PacingLocksTimer() {
  const def = getDiagnosticDefinition('txPace')
  const pass = def?.default === 'timer' &&
    def.allowed?.length === 1 &&
    def.allowed[0] === 'timer' &&
    getSenderRenderPace(HDMI_MODE.BINARY_1, { fps: 60 }, 'timer') === 'timer' &&
    getSenderRenderPace(HDMI_MODE.BINARY_1, { fps: 60 }, 'raf') === 'timer' &&
    getSenderRenderPace(HDMI_MODE.BINARY_1, { fps: 58 }, 'raf') === 'timer' &&
    getSenderRenderPace(HDMI_MODE.BINARY_2, { fps: 60 }, 'raf') === 'timer'
  console.log('BINARY_1 timer-only pacing test:', pass ? 'PASS' : 'FAIL', { definition: def })
  return pass
}

export function testBinary1CadenceFpsPresets() {
  const fpsValues = FPS_PRESETS.map(preset => preset.fps)
  const recommended = FPS_PRESETS[Number(getRecommendedFpsPreset(HDMI_MODE.BINARY_1))]
  const pass = fpsValues.includes(55) &&
    fpsValues.includes(58) &&
    fpsValues.includes(60) &&
    recommended?.fps === 60
  console.log('BINARY_1 cadence FPS preset test:', pass ? 'PASS' : 'FAIL', {
    fpsValues,
    recommended
  })
  return pass
}

export function testDenseBinaryStrictGeometryGate() {
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
      modeRequiresNative1080p(HDMI_MODE.BINARY_2) &&
      modeRequiresNative1080p(HDMI_MODE.BINARY_1) &&
      !modeRequiresNative1080p(HDMI_MODE.COMPAT_4) &&
      !!getRenderScaleIssue(badViewport, { requireNative1080p: modeRequiresNative1080p(HDMI_MODE.BINARY_3) }) &&
      getRenderScaleIssue(native1080, { requireNative1080p: modeRequiresNative1080p(HDMI_MODE.BINARY_3) }) === null
    console.log('dense-binary strict geometry gate test:', pass ? 'PASS' : 'FAIL')
    return pass
  } catch (err) {
    console.log('dense-binary strict geometry gate test: FAIL', err?.message || err)
    return false
  }
}

export function testYoloFollowsBackchannel() {
  const cases = [
    // Connect with the box off and no manual choice: auto-enable.
    [{ yolo: false, autoEnabled: false, manualThisSession: false, stored: false }, 'connected', { yolo: true, autoEnabled: true }],
    // The user unchecked it this session: connecting must not re-check it.
    [{ yolo: false, autoEnabled: false, manualThisSession: true, stored: false }, 'connected', { yolo: false, autoEnabled: false }],
    // Already on by the user's own choice: connected leaves it manual.
    [{ yolo: true, autoEnabled: false, manualThisSession: false, stored: true }, 'connected', { yolo: true, autoEnabled: false }],
    // Disconnect reverts an auto-enable to the stored preference (off).
    [{ yolo: true, autoEnabled: true, manualThisSession: false, stored: false }, 'disconnected', { yolo: false, autoEnabled: false }],
    // ...and to the stored preference (on).
    [{ yolo: true, autoEnabled: true, manualThisSession: false, stored: true }, 'disconnected', { yolo: true, autoEnabled: false }],
    // Disconnect leaves a manual choice alone.
    [{ yolo: true, autoEnabled: false, manualThisSession: true, stored: false }, 'disconnected', { yolo: true, autoEnabled: false }]
  ]
  for (const [current, event, expected] of cases) {
    const got = resolveYoloAutoState(current, event)
    if (got.yolo !== expected.yolo || got.autoEnabled !== expected.autoEnabled) {
      console.log('yolo follows back-channel test: FAIL', { current, event, expected, got })
      return false
    }
  }
  console.log('yolo follows back-channel test: PASS')
  return true
}
