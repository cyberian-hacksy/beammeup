// Capture-pipeline feature detection and decision helpers. Pure — no DOM,
// no side effects. Worker and main thread both call detectCaptureCapabilities
// from their own globals so the decision stays local to the realm.

// Compute the ROI crop rectangle + translated data region for a newly locked
// anchor region. The sourceRect is the bounding box of the data region plus
// one-step padding, clamped to the source frame. The translated region is the
// same data region with its x/y shifted into sourceRect coordinates so the
// decoder's per-cell sampler indexes from (0,0) of the cropped buffer.
//
// Pure function — called from both main thread (getLockedCaptureRegion) and
// the worker's capture pump. Default blockSize mirrors
// hdmi-uvc-constants.js:BLOCK_SIZE (3×3 px anchor block) so callers who
// don't have the constant handy still get sensible padding.
export function computeLockedCaptureRect(region, sourceWidth, sourceHeight, blockSize = 3) {
  if (!region) return null
  const padX = Math.max(4, Math.ceil(region.stepX || blockSize))
  const padY = Math.max(4, Math.ceil(region.stepY || blockSize))
  const x = Math.max(0, Math.floor(region.x - padX))
  const y = Math.max(0, Math.floor(region.y - padY))
  const w = Math.max(1, Math.min(sourceWidth - x, Math.ceil(region.w + padX * 2)))
  const h = Math.max(1, Math.min(sourceHeight - y, Math.ceil(region.h + padY * 2)))
  return {
    sourceRect: { x, y, w, h },
    width: w,
    height: h,
    region: { ...region, x: region.x - x, y: region.y - y }
  }
}

export function detectCaptureCapabilities(g = globalThis) {
  return {
    hasVideoFrame: typeof g.VideoFrame !== 'undefined',
    hasMediaStreamTrackProcessor: typeof g.MediaStreamTrackProcessor !== 'undefined',
    hasOffscreenCanvas: typeof g.OffscreenCanvas !== 'undefined',
    hasVideoFrameCallback:
      typeof g.HTMLVideoElement !== 'undefined' &&
      'requestVideoFrameCallback' in g.HTMLVideoElement.prototype
  }
}

// Decide which capture path to use. `preferred` is the URL flag (or null).
// Requirements per path:
//   * 'worker' (track): main thread transfers a MediaStreamTrack; worker
//     pumps VideoFrame.copyTo directly into a Uint8ClampedArray. Needs
//     MediaStreamTrackProcessor + VideoFrame. Does NOT need OffscreenCanvas —
//     the track pump never touches a canvas.
//   * 'offscreen' (captureBitmap fallback): main thread calls
//     createImageBitmap(video) and posts the transferable bitmap; worker
//     draws it onto a private OffscreenCanvas + getImageData + runs the
//     pump. Needs OffscreenCanvas; createImageBitmap is effectively
//     universal so it's not detected explicitly.
//   * 'main': drawImage/getImageData on the main thread, unchanged.
export function chooseCaptureMethod(capabilities, preferred = null) {
  const canWorker = capabilities.hasMediaStreamTrackProcessor && capabilities.hasVideoFrame
  const canOffscreen = capabilities.hasOffscreenCanvas
  if (preferred === 'main') return 'main'
  if (preferred === 'worker' && canWorker) return 'worker'
  if (preferred === 'offscreen' && canOffscreen) return 'offscreen'
  if (preferred) return 'main'
  if (canWorker) return 'worker'
  if (canOffscreen) return 'offscreen'
  return 'main'
}

export function testCaptureMethodDecision() {
  const fullCaps = {
    hasVideoFrame: true, hasMediaStreamTrackProcessor: true,
    hasOffscreenCanvas: true, hasVideoFrameCallback: true
  }
  const minimalCaps = {
    hasVideoFrame: false, hasMediaStreamTrackProcessor: false,
    hasOffscreenCanvas: false, hasVideoFrameCallback: false
  }
  const offscreenOnly = { ...minimalCaps, hasOffscreenCanvas: true }
  // Regression: a browser that supports the worker track pump but not
  // OffscreenCanvas must still pick 'worker' — the track pump writes
  // VideoFrame.copyTo into a Uint8ClampedArray and never touches a canvas.
  const trackNoOffscreen = {
    ...minimalCaps,
    hasVideoFrame: true,
    hasMediaStreamTrackProcessor: true
  }

  const cases = [
    ['full/default', fullCaps, null, 'worker'],
    ['full/forced main', fullCaps, 'main', 'main'],
    ['full/forced worker', fullCaps, 'worker', 'worker'],
    ['full/forced offscreen', fullCaps, 'offscreen', 'offscreen'],
    ['minimal/default', minimalCaps, null, 'main'],
    ['minimal/forced worker', minimalCaps, 'worker', 'main'],
    ['offscreenOnly/default', offscreenOnly, null, 'offscreen'],
    ['offscreenOnly/forced worker', offscreenOnly, 'worker', 'main'],
    ['trackNoOffscreen/default', trackNoOffscreen, null, 'worker'],
    ['trackNoOffscreen/forced worker', trackNoOffscreen, 'worker', 'worker'],
    ['trackNoOffscreen/forced offscreen', trackNoOffscreen, 'offscreen', 'main']
  ]
  for (const [label, caps, pref, expected] of cases) {
    const got = chooseCaptureMethod(caps, pref)
    if (got !== expected) {
      console.log('FAIL', label, { got, expected })
      return false
    }
  }
  console.log('Capture method decision test: PASS')
  return true
}

export function testComputeLockedCaptureRect() {
  // Normal case: region with step, source larger than region+padding.
  const region = { x: 100, y: 100, w: 600, h: 400, stepX: 10, stepY: 10 }
  const r = computeLockedCaptureRect(region, 1920, 1080)
  const okOrigin = r.sourceRect.x === 90 && r.sourceRect.y === 90
  const okSize = r.sourceRect.w === 620 && r.sourceRect.h === 420
  const okTranslate = r.region.x === 10 && r.region.y === 10
  const okPreserve = r.region.w === 600 && r.region.h === 400

  // Clamp: region near source edge must not extend past it.
  const edge = computeLockedCaptureRect(
    { x: 1900, y: 1060, w: 20, h: 20, stepX: 10, stepY: 10 }, 1920, 1080
  )
  const okClampX = edge.sourceRect.x + edge.sourceRect.w <= 1920
  const okClampY = edge.sourceRect.y + edge.sourceRect.h <= 1080

  // Null region returns null.
  const nullCase = computeLockedCaptureRect(null, 1920, 1080) === null

  const pass = okOrigin && okSize && okTranslate && okPreserve && okClampX && okClampY && nullCase
  console.log('computeLockedCaptureRect test:', pass ? 'PASS' : 'FAIL',
    { okOrigin, okSize, okTranslate, okPreserve, okClampX, okClampY, nullCase })
  return pass
}
