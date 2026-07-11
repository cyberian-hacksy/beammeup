// HDMI-UVC anchor detection: locate the concentric-square anchor patterns
// in a captured frame, verify candidates at block scale, and derive the
// data region between them. Split out of hdmi-uvc-frame.js (which
// re-exports the public API, so importers are unaffected).
import { ANCHOR_PATTERN, BLOCK_SIZE } from './hdmi-uvc-constants.js'
import { scanBrightRunsWithFallback } from './hdmi-uvc-wasm.js'

// Sample the center of a block at (px, py) with given block size.
// Averages a 2×2 area around the block center for noise tolerance.
export function sampleBlockAt(imageData, width, px, py, bs) {
  if (bs <= 1.5) {
    const x = Math.round(px)
    const y = Math.round(py)
    return imageData[((y * width + x) * 4)]
  }
  const cx = Math.round(px + bs / 2) - 1
  const cy = Math.round(py + bs / 2) - 1
  let sum = 0
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      sum += imageData[((cy + dy) * width + (cx + dx)) * 4]
    }
  }
  return sum / 4
}

// Check if an 8×8 block grid at (originX, originY) matches the anchor pattern
// at the given block size. Returns true if all blocks match strict thresholds.
function verifyAnchorWithBlockSize(imageData, width, height, originX, originY, bs) {
  const aSize = Math.ceil(8 * bs)
  if (originX < 0 || originY < 0 ||
      originX + aSize > width || originY + aSize > height) {
    return false
  }

  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      const px = originX + Math.round(bx * bs)
      const py = originY + Math.round(by * bs)
      const val = sampleBlockAt(imageData, width, px, py, bs)
      const expected = ANCHOR_PATTERN[by][bx] === 1
      if (expected) {
        if (val < 180) return false
      } else {
        if (val > 75) return false
      }
    }
  }
  return true
}

// Check that the area around a detected anchor is dark (canvas margin/HDMI border).
// Rejects false positives from browser chrome where surroundings are bright.
// Checks 3 points per direction at increasing distances for robustness.
function verifyAnchorContext(imageData, width, height, originX, originY, bs) {
  const aSize = Math.ceil(8 * bs)
  const mid = Math.round(aSize / 2)

  const isDarkAt = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return true
    return imageData[(y * width + x) * 4] < 50
  }

  // For each of 4 directions, check 3 points at distances proportional to the
  // detected anchor size so smaller anchors are not over-penalized.
  // Direction counts as "dark" if majority (2+) of points are dark.
  let darkDirs = 0
  const distances = Array.from(new Set([
    Math.max(4, Math.round(bs * 2)),
    Math.max(6, Math.round(bs * 3.5)),
    Math.max(8, Math.round(bs * 5))
  ]))

  // Above
  let dk = 0
  for (const d of distances) if (isDarkAt(originX + mid, originY - d)) dk++
  if (dk >= 2) darkDirs++

  // Below
  dk = 0
  for (const d of distances) if (isDarkAt(originX + mid, originY + aSize + d)) dk++
  if (dk >= 2) darkDirs++

  // Left
  dk = 0
  for (const d of distances) if (isDarkAt(originX - d, originY + mid)) dk++
  if (dk >= 2) darkDirs++

  // Right
  dk = 0
  for (const d of distances) if (isDarkAt(originX + aSize + d, originY + mid)) dk++
  if (dk >= 2) darkDirs++

  return darkDirs >= 3
}

// Try to verify an anchor at (originX, originY) across multiple block sizes.
// Returns the matching block size, or 0 if no match.
export function verifyAnchorAt(imageData, width, height, originX, originY) {
  // Try block sizes starting from sender's native 3.0, spiraling outward.
  // This ensures exact match at 1:1 scale and finds scaled anchors efficiently.
  const blockSizes = [3.0, 2.75, 3.25, 2.5, 3.5, 2.25, 3.75, 2.0, 4.0, 4.25, 4.5, 4.75, 5.0]
  for (const bs of blockSizes) {
    if (verifyAnchorWithBlockSize(imageData, width, height, originX, originY, bs) &&
        verifyAnchorContext(imageData, width, height, originX, originY, bs)) {
      return bs
    }
  }
  return 0
}

// Find an anchor by scanning a corner for a bright rectangle, then verifying
// with a lightweight 2-point check (black ring + white center). The per-row
// bright-run scan delegates to scanBrightRunsWithFallback so the WASM kernel
// takes over once loaded. Scan order (yDir, row-by-row, left-to-right within
// a row) is preserved so the JS verifyBrightRun short-circuit still fires on
// the same first match as the pre-refactor loop.
function findCornerAnchor(imageData, width, height, xStart, xEnd, yStart, yEnd, yDir, corner) {
  const runs = scanBrightRunsWithFallback(
    imageData, width, height, xStart, xEnd, yStart, yEnd, yDir, 15, 50, 200
  )
  for (let i = 0; i < runs.length; i++) {
    const { runX, runY, runLen } = runs[i]
    const anchor = verifyBrightRun(imageData, width, height, runX, runY, runLen, yDir, corner)
    if (anchor) return anchor
  }
  return null
}

// Verify a bright run is an anchor edge and derive anchor position/block size
function verifyBrightRun(imageData, width, height, runX, runY, runLen, yDir, corner) {
  const bs = runLen / 8
  if (bs < 2 || bs > 6) return null

  // The bright run is an all-white row of the anchor.
  // If scanning from bottom (yDir=-1), this is the last row → origin is above.
  // If scanning from top (yDir=1), this is the first row → origin is here.
  const originX = runX
  const originY = yDir < 0 ? Math.round(runY - 7 * bs) : runY
  const aSize = Math.ceil(8 * bs)

  if (originY < 0 || originY + aSize > height) return null
  if (originX < 0 || originX + aSize > width) return null

  // Lightweight concentric-pattern check:
  // 1. Black ring at block (2,2) — should be dark
  const ringX = originX + Math.round(2.5 * bs)
  const ringY = originY + Math.round(2.5 * bs)
  if (ringX >= width || ringY >= height) return null
  if (imageData[(ringY * width + ringX) * 4] > 75) return null

  // 2. White center at block (3.5, 3.5) — should be bright
  const centerX = originX + Math.round(3.5 * bs)
  const centerY = originY + Math.round(3.5 * bs)
  if (centerX >= width || centerY >= height) return null
  if (imageData[(centerY * width + centerX) * 4] < 150) return null

  // 3. Black ring at block (5,5) — should be dark (opposite side)
  const ring2X = originX + Math.round(5.5 * bs)
  const ring2Y = originY + Math.round(5.5 * bs)
  if (ring2X >= width || ring2Y >= height) return null
  if (imageData[(ring2Y * width + ring2X) * 4] > 75) return null

  return { x: originX, y: originY, corner, blockSize: bs }
}

// Refine an anchor's block size by measuring the white→black transition at row 2.
// The anchor pattern row 2 is [W,W,B,B,B,B,W,W] — the transition at column 2
// gives a precise scale measurement that's more accurate than the bright-run width.
function refineAnchorScale(imageData, width, height, anchor) {
  const approxBs = anchor.blockSize
  // Sample at block row 2.5 (middle of the white-to-black transition row)
  const rowY = Math.round(anchor.y + 2.5 * approxBs)
  if (rowY >= height) return approxBs

  // Scan from anchor origin for the first dark pixel (transition from white border to black ring)
  // Scan right for the white→black transition. Require 3 consecutive dark
  // pixels to confirm (avoids single-pixel MJPEG noise).
  let transitionX = -1
  for (let x = anchor.x + Math.round(approxBs); x < anchor.x + Math.ceil(8 * approxBs) + 20 && x < width - 2; x++) {
    const v0 = imageData[(rowY * width + x) * 4]
    const v1 = imageData[(rowY * width + x + 1) * 4]
    const v2 = imageData[(rowY * width + x + 2) * 4]
    if (v0 < 100 && v1 < 100 && v2 < 100) {
      transitionX = x
      break
    }
  }

  if (transitionX < 0) return approxBs

  // The transition from white border to black ring occurs at 2 * BLOCK_SIZE sender pixels
  const captureDistance = transitionX - anchor.x
  const refinedBs = captureDistance / 2
  if (refinedBs >= 2.5 && refinedBs <= 6) return refinedBs
  return approxBs
}

// Detect chrome bottom edge: scan down center column for bright→dark transition.
// Only activates if the top of the frame is bright (actual browser chrome present).
function findChromeBottom(imageData, width, height) {
  const midX = Math.floor(width / 2)
  // If top of frame is dark, there's no chrome (e.g. unit test or direct canvas)
  if (imageData[(0 * width + midX) * 4] < 50) return 0
  for (let y = 0; y < Math.min(400, height - 1); y++) {
    const v = imageData[(y * width + midX) * 4]
    const vNext = imageData[((y + 1) * width + midX) * 4]
    if (v > 80 && vNext < 30) return y + 1
  }
  return 0
}

const ESTIMATED_ANCHOR_VERTICAL_RATIO = 1025 / 1648

// Scan the frame for anchor patterns. Returns array of {x, y, corner, blockSize}.
// Strategy: find bottom anchors first (reliable, away from browser chrome),
// then use their positions to guide top anchor search BELOW chromeBottom.
export function detectAnchors(imageData, width, height) {
  const anchors = []
  const margin = 300
  const chromeBottom = findChromeBottom(imageData, width, height)

  // Phase 1: Bottom anchors (scan upward from bottom — away from chrome)
  const bl = findCornerAnchor(imageData, width, height,
    0, Math.min(margin, width), height - 1, Math.max(0, height - margin), -1, 'BL')
  const br = findCornerAnchor(imageData, width, height,
    Math.max(0, width - margin), width, height - 1, Math.max(0, height - margin), -1, 'BR')

  if (bl) { bl.blockSize = refineAnchorScale(imageData, width, height, bl); anchors.push(bl) }
  if (br) { br.blockSize = refineAnchorScale(imageData, width, height, br); anchors.push(br) }

  // Phase 2: Top anchors — constrain search to a narrow band based on
  // expected canvas geometry (aspect ratio 0.45-0.75 of horizontal span).
  if (bl && br) {
    const hSpan = br.x - bl.x
    const expectedVSpan = Math.round(hSpan * ESTIMATED_ANCHOR_VERTICAL_RATIO)
    // Expected vertical span: between 45% and 75% of horizontal span
    const minVSpan = Math.round(hSpan * 0.40)
    const maxVSpan = Math.round(hSpan * 0.80)
    const topSearchLo = Math.max(chromeBottom, bl.y - maxVSpan - 50)
    const topSearchHi = Math.max(chromeBottom, bl.y - minVSpan + 50)

    const tl = findCornerAnchor(imageData, width, height,
      Math.max(0, bl.x - 20), Math.min(width, bl.x + 50), topSearchLo, topSearchHi, 1, 'TL')
    const tr = findCornerAnchor(imageData, width, height,
      Math.max(0, br.x - 20), Math.min(width, br.x + 50), topSearchLo, topSearchHi, 1, 'TR')

    // Only accept detected top anchors if they match each other and the
    // expected sender geometry. Fullscreen UI can create a plausible-looking
    // horizontal edge much lower than the true top anchors.
    const detectedTopYDelta = tl && tr ? Math.abs(tl.y - tr.y) : Infinity
    const leftDetectedVSpan = tl ? bl.y - tl.y : 0
    const rightDetectedVSpan = tr ? br.y - tr.y : 0
    const avgDetectedVSpan = (leftDetectedVSpan + rightDetectedVSpan) * 0.5
    const vSpanTolerance = Math.max(40, Math.round(hSpan * 0.08))
    const expectedVSpanTolerance = Math.max(60, Math.round(hSpan * 0.10))
    const detectedTopAnchorsLookValid =
      tl &&
      tr &&
      detectedTopYDelta <= 15 &&
      leftDetectedVSpan > 0 &&
      rightDetectedVSpan > 0 &&
      Math.abs(leftDetectedVSpan - rightDetectedVSpan) <= vSpanTolerance &&
      Math.abs(avgDetectedVSpan - expectedVSpan) <= expectedVSpanTolerance

    if (detectedTopAnchorsLookValid) {
      tl.blockSize = refineAnchorScale(imageData, width, height, tl)
      tr.blockSize = refineAnchorScale(imageData, width, height, tr)
      anchors.push(tl)
      anchors.push(tr)
    } else {
      // Fullscreen HDMI captures often preserve the bottom anchors cleanly while
      // the top anchors are obscured by transient browser/fullscreen UI. Fall
      // back to the known sender frame geometry using the trusted bottom pair.
      const avgBottomBs = ((bl.blockSize || BLOCK_SIZE) + (br.blockSize || BLOCK_SIZE)) * 0.5
      const estimatedTopY = Math.max(0, Math.round(Math.min(bl.y, br.y) - expectedVSpan))
      if (estimatedTopY < Math.min(bl.y, br.y)) {
        anchors.push({
          x: bl.x,
          y: estimatedTopY,
          corner: 'TL',
          blockSize: avgBottomBs,
          estimated: true
        })
        anchors.push({
          x: br.x,
          y: estimatedTopY,
          corner: 'TR',
          blockSize: avgBottomBs,
          estimated: true
        })
      }
    }
  }

  return anchors
}

// Derive data region from detected anchor positions.
// Requires at least one top and one bottom anchor with consistent block sizes.
export function dataRegionFromAnchors(anchors) {
  if (anchors.length < 2) return null

  const bl = anchors.find(a => a.corner === 'BL')
  const br = anchors.find(a => a.corner === 'BR')
  const tl = anchors.find(a => a.corner === 'TL')
  const tr = anchors.find(a => a.corner === 'TR')

  // On the HDMI-UVC fullscreen path, partial anchor sets are much more likely
  // to be browser/UI false positives than valid frames. Require all four
  // corners so a single fake top edge cannot create a plausible data region.
  if (!bl || !br || !tl || !tr) return null

  // Check block size consistency: all anchors within 20% of median
  const sizes = anchors.map(a => a.blockSize).sort((a, b) => a - b)
  const median = sizes[Math.floor(sizes.length / 2)]
  if (sizes.some(s => Math.abs(s - median) / median > 0.20)) return null

  const avgBs = anchors.reduce((s, a) => s + a.blockSize, 0) / anchors.length
  const actualAnchorSize = Math.ceil(8 * avgBs)

  // The captured HDMI feed should be axis-aligned: top anchors should sit
  // nearly above the bottom anchors, and the left/right vertical spans should
  // agree closely. UI chrome often creates fake top anchors that fail this.
  const maxHorizontalDrift = Math.max(12, Math.round(actualAnchorSize * 0.5))
  if (Math.abs(tl.x - bl.x) > maxHorizontalDrift) return null
  if (Math.abs(tr.x - br.x) > maxHorizontalDrift) return null

  const leftVSpan = bl.y - tl.y
  const rightVSpan = br.y - tr.y
  if (leftVSpan <= 0 || rightVSpan <= 0) return null
  const verticalSpanDelta = Math.abs(leftVSpan - rightVSpan)
  if (verticalSpanDelta > Math.max(18, Math.round(avgBs * 8))) return null

  const topSpan = tr.x - tl.x
  const bottomSpan = br.x - bl.x
  if (topSpan <= 0 || bottomSpan <= 0) return null
  const horizontalSpanDelta = Math.abs(topSpan - bottomSpan)
  if (horizontalSpanDelta > Math.max(18, Math.round(avgBs * 8))) return null

  // Compute bounds from available anchors
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const a of anchors) {
    if (a.x < minX) minX = a.x
    if (a.y < minY) minY = a.y
    if (a.x + actualAnchorSize > maxX) maxX = a.x + actualAnchorSize
    if (a.y + actualAnchorSize > maxY) maxY = a.y + actualAnchorSize
  }

  const w = maxX - minX - 2 * actualAnchorSize
  const h = maxY - minY - 2 * actualAnchorSize
  if (w < 100 || h < 100) return null

  return {
    x: minX + actualAnchorSize,
    y: minY + actualAnchorSize,
    w, h,
    frameW: maxX - minX,
    frameH: maxY - minY,
    anchorSize: actualAnchorSize,
    blockSize: avgBs,
    stepX: avgBs,
    stepY: avgBs
  }
}
