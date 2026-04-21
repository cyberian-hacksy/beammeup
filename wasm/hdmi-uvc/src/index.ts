// HDMI-UVC WebAssembly hot kernels.
//
// Compiled with AssemblyScript --runtime stub: no GC, no allocator, all memory
// is manually managed via a scratch region. The module exports a small
// collection of per-frame helpers that the receiver worker calls on every
// captured frame (CRC over the payload, per-cell classification, anchor
// detection scaffolding). JS remains the source of truth for the full frame
// decoder; this file only owns the hot loops.
//
// Layout of the linear memory:
//   [0 .. 1024)       CRC32 IEEE table (256 * 4 bytes), computed at first use.
//   [1024 .. 1040)    Private classifier scratch (4 * f32).
//   [1040 .. N)       JS scratch region: JS writes input buffers here and
//                     passes the returned pointer into the exported kernels.

const CRC_TABLE_ADDR: u32 = 0
const CRC_TABLE_BYTES: u32 = 256 * 4
const CLASSIFY_SCRATCH_ADDR: u32 = CRC_TABLE_BYTES      // 1024
const CLASSIFY_SCRATCH_BYTES: u32 = 4 * 4               // 4 f32
const SCRATCH_START: u32 = CRC_TABLE_BYTES + CLASSIFY_SCRATCH_BYTES

const classifyScratch: u32 = CLASSIFY_SCRATCH_ADDR

let crcTableInit: bool = false

function ensureCrcTable(): void {
  if (crcTableInit) return
  for (let i: u32 = 0; i < 256; i++) {
    let c: u32 = i
    for (let j: i32 = 0; j < 8; j++) {
      c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    store<u32>(CRC_TABLE_ADDR + i * 4, c)
  }
  crcTableInit = true
}

// CRC32 over `len` bytes starting at `ptr`. Polynomial 0xEDB88320 (IEEE
// 802.3), matching src/lib/hdmi-uvc/crc32.js bit-for-bit.
export function crc32(ptr: u32, len: u32): u32 {
  ensureCrcTable()
  let crc: u32 = 0xFFFFFFFF
  for (let i: u32 = 0; i < len; i++) {
    const b: u32 = <u32>load<u8>(ptr + i)
    const idx: u32 = (crc ^ b) & 0xFF
    crc = load<u32>(CRC_TABLE_ADDR + idx * 4) ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// Exported so the JS loader can locate the scratch region without hard-coding
// the layout on both sides.
export function getScratchStart(): u32 {
  return SCRATCH_START
}

// Exported so JS can query/extend memory without reaching into internals.
export function getMemorySize(): i32 {
  return memory.size()
}

export function growMemory(pages: i32): i32 {
  return memory.grow(pages)
}

// Per-cell sampler shared by the COMPAT_4 and LUMA_2 classifier kernels.
// Mirrors sampleBlockAt in hdmi-uvc-frame.js: average R channel of a 2x2 block
// centered on the integer-rounded midpoint of (px+bs/2, py+bs/2) - 1. Returns
// the average as f32. Returns 0 for out-of-bounds centers (matches the guarded
// JS path `px >= 0 && px < width && py >= 0 && py < height`).
// @inline
function sample2x2R(pixelsPtr: u32, width: u32, height: u32, cx: i32, cy: i32): f32 {
  if (cx < 0 || cy < 0) return 0
  if (<u32>(cx + 1) >= width) return 0
  if (<u32>(cy + 1) >= height) return 0
  const rowStride: u32 = width * 4
  const base: u32 = pixelsPtr + <u32>cy * rowStride + <u32>cx * 4
  const s0: u32 = <u32>load<u8>(base)
  const s1: u32 = <u32>load<u8>(base + 4)
  const s2: u32 = <u32>load<u8>(base + rowStride)
  const s3: u32 = <u32>load<u8>(base + rowStride + 4)
  return <f32>(s0 + s1 + s2 + s3) * 0.25
}

// Quadrant sampler shared by LUMA_2 / Codebook3. Mirrors sampleCodebook3At in
// hdmi-uvc-frame.js: splits the block into 4 equal quadrants and averages the
// R channel across each. Writes the four means via store<f32> to outPtr[0..3].
// @inline
function sampleQuadrants(
  pixelsPtr: u32, width: u32, height: u32,
  px: f32, py: f32, bs: f32,
  outPtr: u32
): void {
  const xMid: f32 = px + bs * 0.5
  const yMid: f32 = py + bs * 0.5
  const xEnd: f32 = px + bs
  const yEnd: f32 = py + bs
  const imgW: i32 = <i32>width
  const imgH: i32 = <i32>height

  // Iterate TL, TR, BL, BR matching the JS tuple array in sampleCodebook3At.
  for (let q: i32 = 0; q < 4; q++) {
    let x0f: f32, y0f: f32, x1f: f32, y1f: f32
    if (q === 0) { x0f = px;   y0f = py;   x1f = xMid; y1f = yMid }
    else if (q === 1) { x0f = xMid; y0f = py;   x1f = xEnd; y1f = yMid }
    else if (q === 2) { x0f = px;   y0f = yMid; x1f = xMid; y1f = yEnd }
    else              { x0f = xMid; y0f = yMid; x1f = xEnd; y1f = yEnd }

    let x0: i32 = <i32>Mathf.round(x0f)
    if (x0 < 0) x0 = 0
    let y0: i32 = <i32>Mathf.round(y0f)
    if (y0 < 0) y0 = 0
    let x1: i32 = <i32>Mathf.round(x1f)
    if (x1 > imgW) x1 = imgW
    if (x1 < x0 + 1) x1 = x0 + 1
    let y1: i32 = <i32>Mathf.round(y1f)
    if (y1 > imgH) y1 = imgH
    if (y1 < y0 + 1) y1 = y0 + 1

    let sum: u32 = 0
    let count: u32 = 0
    for (let y: i32 = y0; y < y1; y++) {
      for (let x: i32 = x0; x < x1; x++) {
        sum += <u32>load<u8>(pixelsPtr + <u32>y * width * 4 + <u32>x * 4)
        count++
      }
    }
    store<f32>(outPtr + <u32>q * 4, count > 0 ? <f32>sum / <f32>count : 0)
  }
}

// Binary classifier for COMPAT_4 cells. Input `cellsPtr` is a packed array of
// (f32 px, f32 py, f32 bs, f32 threshold) per cell (16 bytes). Writes 0 or 1
// per cell into `outPtr`. Returns the number of cells processed. Equivalent
// to the inline branch in decodeDataRegion (frame.js :1275-1282) with the
// per-cell threshold pre-computed by JS.
export function classifyCompat4Cells(
  pixelsPtr: u32,
  width: u32,
  height: u32,
  cellsPtr: u32,
  cellCount: u32,
  outPtr: u32
): u32 {
  for (let i: u32 = 0; i < cellCount; i++) {
    const cellBase: u32 = cellsPtr + i * 16
    const px: f32 = load<f32>(cellBase)
    const py: f32 = load<f32>(cellBase + 4)
    const bs: f32 = load<f32>(cellBase + 8)
    const threshold: f32 = load<f32>(cellBase + 12)
    const cx: i32 = <i32>Mathf.round(px + bs * 0.5) - 1
    const cy: i32 = <i32>Mathf.round(py + bs * 0.5) - 1
    const val: f32 = sample2x2R(pixelsPtr, width, height, cx, cy)
    store<u8>(outPtr + i, val >= threshold ? 1 : 0)
  }
  return cellCount
}

// Four-level LUMA_2 classifier. Input `cellsPtr` is a packed array of
// (f32 px, f32 py, f32 bs, f32 blackLevel, f32 whiteLevel) per cell (20
// bytes). Writes symbol 0..3 per cell into `outPtr`. Matches decodeLuma2 +
// sampleCodebook3At in frame.js.
export function classifyLuma2Cells(
  pixelsPtr: u32,
  width: u32,
  height: u32,
  cellsPtr: u32,
  cellCount: u32,
  outPtr: u32
): u32 {
  // Reserve 16 bytes at the end of the CRC table region for temporary
  // quadrant samples. The CRC table occupies [0, 1024); we co-opt the last 16
  // bytes as a scratch slot for 4 x f32 samples. The CRC table only uses the
  // first 1024 bytes, so anything at [1008, 1024) in the CRC region would
  // actually collide — use an address past the table instead. Place it at a
  // known offset guaranteed unused by the CRC path.
  // Simpler: declare a small module-global scratch (see classifyScratch below).
  for (let i: u32 = 0; i < cellCount; i++) {
    const cellBase: u32 = cellsPtr + i * 20
    const px: f32 = load<f32>(cellBase)
    const py: f32 = load<f32>(cellBase + 4)
    const bs: f32 = load<f32>(cellBase + 8)
    const blackLevel: f32 = load<f32>(cellBase + 12)
    const whiteLevel: f32 = load<f32>(cellBase + 16)
    sampleQuadrants(pixelsPtr, width, height, px, py, bs, classifyScratch)

    const s0: f32 = load<f32>(classifyScratch)
    const s1: f32 = load<f32>(classifyScratch + 4)
    const s2: f32 = load<f32>(classifyScratch + 8)
    const s3: f32 = load<f32>(classifyScratch + 12)

    // normalizeBinarySample: span = max(48, |white - black|), polarity signed,
    // clamp to [0, 1].
    const rawSpan: f32 = Mathf.abs(whiteLevel - blackLevel)
    const span: f32 = rawSpan < 48 ? 48 : rawSpan
    const polarity: f32 = whiteLevel >= blackLevel ? 1 : -1
    const n0: f32 = clamp01((polarity * (s0 - blackLevel)) / span)
    const n1: f32 = clamp01((polarity * (s1 - blackLevel)) / span)
    const n2: f32 = clamp01((polarity * (s2 - blackLevel)) / span)
    const n3: f32 = clamp01((polarity * (s3 - blackLevel)) / span)

    // decodeLuma2: compare horizontal (top/bottom) and vertical (left/right)
    // contrasts, return 0..3.
    const top: f32 = (n0 + n1) * 0.5
    const bottom: f32 = (n2 + n3) * 0.5
    const left: f32 = (n0 + n2) * 0.5
    const right: f32 = (n1 + n3) * 0.5
    const hContrast: f32 = Mathf.abs(top - bottom)
    const vContrast: f32 = Mathf.abs(left - right)

    let symbol: u32
    if (hContrast >= vContrast) {
      symbol = top >= bottom ? 0 : 1
    } else {
      symbol = left >= right ? 2 : 3
    }
    store<u8>(outPtr + i, <u8>symbol)
  }
  return cellCount
}

// @inline
function clamp01(v: f32): f32 {
  if (v < 0) return 0
  if (v > 1) return 1
  return v
}

// Anchor-detection inner loop: scan a rectangle of an RGBA frame buffer for
// horizontal bright runs (consecutive pixels whose R-channel luma exceeds
// `threshold`). A run is reported when its length ∈ [minRun, maxRun]; shorter
// or longer runs are discarded by the caller's geometry check. Rows are
// visited in `yDir` direction (+1 top→bottom, -1 bottom→top) and within each
// row pixels are scanned left to right, matching findCornerAnchor's original
// traversal order so JS verifyBrightRun() sees the same first-match row.
//
// Output layout at `outPtr`: packed triples of u32 (runX, runY, runLen),
// written in scan order. Returns the number of triples written, capped at
// `maxRuns`.
export function scanBrightRuns(
  pixelsPtr: u32,
  width: u32,
  height: u32,
  xStart: u32,
  xEnd: u32,
  yStart: i32,
  yEnd: i32,
  yDir: i32,
  minRun: u32,
  maxRun: u32,
  threshold: u32,
  outPtr: u32,
  maxRuns: u32
): u32 {
  if (yDir === 0) return 0
  if (xStart >= xEnd) return 0
  if (xEnd > width) return 0

  let count: u32 = 0
  let y: i32 = yStart
  while (y !== yEnd) {
    if (y < 0) { y += yDir; continue }
    if (<u32>y >= height) { y += yDir; continue }

    const rowBase: u32 = <u32>y * width * 4
    let runStart: i32 = -1
    let runLen: u32 = 0

    for (let x: u32 = xStart; x < xEnd; x++) {
      const luma: u32 = <u32>load<u8>(pixelsPtr + rowBase + x * 4)
      if (luma > threshold) {
        if (runStart < 0) runStart = <i32>x
        runLen++
      } else {
        if (runLen >= minRun && runLen <= maxRun) {
          if (count >= maxRuns) return count
          const slot: u32 = outPtr + count * 12
          store<u32>(slot, <u32>runStart)
          store<u32>(slot + 4, <u32>y)
          store<u32>(slot + 8, runLen)
          count++
        }
        runStart = -1
        runLen = 0
      }
    }

    // End-of-row flush: tail run that touched xEnd without a dark pixel
    // terminator still counts, matching the JS implementation's behavior.
    if (runLen >= minRun && runLen <= maxRun) {
      if (count >= maxRuns) return count
      const slot: u32 = outPtr + count * 12
      store<u32>(slot, <u32>runStart)
      store<u32>(slot + 4, <u32>y)
      store<u32>(slot + 8, runLen)
      count++
    }

    y += yDir
  }
  return count
}
