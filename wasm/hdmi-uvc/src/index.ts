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
const PROTOCOL_VERSION: u32 = 1
const PACKET_HEADER_SIZE: u32 = 15
const PROBE_FILTER_FILE_ID: u32 = 1
const PROBE_FILTER_K: u32 = 2

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

// Packs a locked 1x1 binary payload grid into bytes. JS precomputes one
// starting pixel (x,y) and one threshold per payload row. This kernel owns the
// hot loop over the contiguous RGBA row bytes.
export function packBinary1Payload(
  pixelsPtr: u32,
  width: u32,
  height: u32,
  rowStartsPtr: u32,
  thresholdsPtr: u32,
  payloadCellsX: u32,
  payloadCellsY: u32,
  payloadLength: u32,
  outPtr: u32
): u32 {
  const rowStride: u32 = width * 4
  let byteIdx: u32 = 0
  let bitBuffer: u32 = 0
  let bitCount: u32 = 0

  for (let cy: u32 = 0; cy < payloadCellsY && byteIdx < payloadLength; cy++) {
    const rowBasePtr: u32 = rowStartsPtr + cy * 8
    const rowX: i32 = load<i32>(rowBasePtr)
    const rowY: i32 = load<i32>(rowBasePtr + 4)
    if (rowX < 0 || rowY < 0) return 0
    if (<u32>rowY >= height) return 0
    if (<u32>rowX + payloadCellsX > width) return 0

    const threshold: f32 = load<f32>(thresholdsPtr + cy * 4)
    let base: u32 = pixelsPtr + <u32>rowY * rowStride + <u32>rowX * 4
    let cx: u32 = 0

    while (cx < payloadCellsX && byteIdx < payloadLength) {
      if (bitCount === 0 && cx + 8 <= payloadCellsX) {
        const remainingCells: u32 = payloadCellsX - cx
        const rowFullBytes: u32 = remainingCells >> 3
        const remainingBytes: u32 = payloadLength - byteIdx
        const fullBytes: u32 = rowFullBytes < remainingBytes ? rowFullBytes : remainingBytes

        for (let i: u32 = 0; i < fullBytes; i++) {
          let value: u32 = 0
          if (<f32>load<u8>(base) >= threshold) value |= 0x80
          if (<f32>load<u8>(base + 4) >= threshold) value |= 0x40
          if (<f32>load<u8>(base + 8) >= threshold) value |= 0x20
          if (<f32>load<u8>(base + 12) >= threshold) value |= 0x10
          if (<f32>load<u8>(base + 16) >= threshold) value |= 0x08
          if (<f32>load<u8>(base + 20) >= threshold) value |= 0x04
          if (<f32>load<u8>(base + 24) >= threshold) value |= 0x02
          if (<f32>load<u8>(base + 28) >= threshold) value |= 0x01
          store<u8>(outPtr + byteIdx, <u8>value)
          byteIdx++
          base += 32
        }

        cx += fullBytes * 8
        continue
      }

      bitBuffer = (bitBuffer << 1) | (<f32>load<u8>(base) >= threshold ? 1 : 0)
      bitCount++
      base += 4
      cx++
      if (bitCount >= 8) {
        store<u8>(outPtr + byteIdx, <u8>(bitBuffer & 0xff))
        byteIdx++
        bitBuffer = 0
        bitCount = 0
      }
    }
  }

  return byteIdx
}

// Four-level Gray-coded classifier for a deconvolved (f32) sample. Thresholds
// are the midpoints between adjacent reference levels; ties resolve to the
// lower level (mirrors getLuma1ClassifyLut in hdmi-uvc-frame.js, which uses
// `v <= t`). The Gray map [0,1,3,2] is exactly level ^ (level >> 1).
// @inline
function luma1SymbolFromValue(vi: f64, t01: f64, t12: f64, t23: f64): u32 {
  const level: u32 = vi <= t01 ? 0 : vi <= t12 ? 1 : vi <= t23 ? 2 : 3
  return level ^ (level >> 1)
}

// Clamp + round a post-solve f32 sample the way the JS reader does before its
// LUT lookup: `v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0`.
// @inline
function luma1RoundSample(v: f64): f64 {
  if (v <= 0) return 0
  if (v >= 255) return 255
  return <f64><i32>(v + 0.5)
}

// In-place segmented Thomas deconvolution of one payload row. Bit-for-bit
// port of unsharpenLuma1Row in hdmi-uvc-frame.js: arithmetic in f64,
// storage in f32 (the JS row buffer and solve scratch are Float32Arrays, so
// every intermediate store rounds to f32 there too). Samples at the rails are
// pinned (u = v) and split the row into independent segments; row ends use a
// Neumann boundary; n=1 and n=2 segments take closed forms.
function unsharpenLuma1RowWasm(
  valsPtr: u32,
  cPtr: u32,
  dPtr: u32,
  count: u32,
  lambda: f64,
  railLo: f64,
  railHi: f64
): void {
  const sub: f64 = -lambda / 2
  const diagMain: f64 = 1 + lambda
  const diagEnd: f64 = 1 + lambda / 2
  let segStart: u32 = 0
  while (segStart < count) {
    const v0: f64 = <f64>load<f32>(valsPtr + segStart * 4)
    if (v0 <= railLo || v0 >= railHi) {
      segStart++
      continue
    }
    let segEnd: u32 = segStart
    while (segEnd + 1 < count) {
      const vn: f64 = <f64>load<f32>(valsPtr + (segEnd + 1) * 4)
      if (vn > railLo && vn < railHi) segEnd++
      else break
    }
    const n: u32 = segEnd - segStart + 1
    const leftPinned: bool = segStart > 0
    const rightPinned: bool = segEnd < count - 1

    if (n === 1) {
      let diag: f64 = diagMain
      let rhs: f64 = <f64>load<f32>(valsPtr + segStart * 4)
      if (leftPinned) rhs -= sub * <f64>load<f32>(valsPtr + (segStart - 1) * 4)
      else diag += sub
      if (rightPinned) rhs -= sub * <f64>load<f32>(valsPtr + (segEnd + 1) * 4)
      else diag += sub
      store<f32>(valsPtr + segStart * 4, <f32>(rhs / diag))
      segStart = segEnd + 1
      continue
    }
    if (n === 2) {
      const dA: f64 = leftPinned ? diagMain : diagEnd
      const dB: f64 = rightPinned ? diagMain : diagEnd
      const rA: f64 = <f64>load<f32>(valsPtr + segStart * 4) -
        (leftPinned ? sub * <f64>load<f32>(valsPtr + (segStart - 1) * 4) : 0)
      const rB: f64 = <f64>load<f32>(valsPtr + segEnd * 4) -
        (rightPinned ? sub * <f64>load<f32>(valsPtr + (segEnd + 1) * 4) : 0)
      const inv: f64 = 1 / (dA * dB - sub * sub)
      store<f32>(valsPtr + segStart * 4, <f32>((rA * dB - sub * rB) * inv))
      store<f32>(valsPtr + segEnd * 4, <f32>((dA * rB - sub * rA) * inv))
      segStart = segEnd + 1
      continue
    }

    // Thomas forward sweep; c'/d' stored as f32 like the JS scratch.
    const diag0: f64 = leftPinned ? diagMain : diagEnd
    const rhs0: f64 = <f64>load<f32>(valsPtr + segStart * 4) -
      (leftPinned ? sub * <f64>load<f32>(valsPtr + (segStart - 1) * 4) : 0)
    store<f32>(cPtr, <f32>(sub / diag0))
    store<f32>(dPtr, <f32>(rhs0 / diag0))
    for (let i: u32 = 1; i < n; i++) {
      const isLast: bool = i === n - 1
      const diag: f64 = isLast ? (rightPinned ? diagMain : diagEnd) : diagMain
      let rhs: f64 = <f64>load<f32>(valsPtr + (segStart + i) * 4)
      if (isLast && rightPinned) rhs -= sub * <f64>load<f32>(valsPtr + (segEnd + 1) * 4)
      const denom: f64 = diag - sub * <f64>load<f32>(cPtr + (i - 1) * 4)
      store<f32>(cPtr + i * 4, <f32>((isLast ? 0 : sub) / denom))
      store<f32>(dPtr + i * 4, <f32>((rhs - sub * <f64>load<f32>(dPtr + (i - 1) * 4)) / denom))
    }
    // Back substitution.
    store<f32>(valsPtr + segEnd * 4, load<f32>(dPtr + (n - 1) * 4))
    for (let i: i32 = <i32>n - 2; i >= 0; i--) {
      const x: f64 = <f64>load<f32>(dPtr + <u32>i * 4) -
        <f64>load<f32>(cPtr + <u32>i * 4) * <f64>load<f32>(valsPtr + (segStart + <u32>i + 1) * 4)
      store<f32>(valsPtr + (segStart + <u32>i) * 4, <f32>x)
    }
    segStart = segEnd + 1
  }
}

// Locked LUMA_1 (1x1 Luma4) payload reader: per row, gather the R channel,
// optionally deconvolve the dongle's horizontal peaking (lambda > 0), classify
// each cell against the row's level thresholds, and pack 2-bit Gray symbols
// into bytes with the bit buffer carried across rows — mirroring
// readDenseLuma1PayloadLockedNativeGrid in hdmi-uvc-frame.js byte for byte.
//
// rowStartsPtr: i32 pairs (rowX, rowY) per payload row.
// rowParamsPtr: f64 x5 per row: t01, t12, t23, railLo, railHi.
// workPtr: f32 x (payloadCellsX * 3) scratch: row buffer + Thomas c'/d'.
// Returns bytes written (== payloadLength on success, 0 on bad geometry).
export function readLuma1Payload(
  pixelsPtr: u32,
  width: u32,
  height: u32,
  rowStartsPtr: u32,
  rowParamsPtr: u32,
  payloadCellsX: u32,
  payloadCellsY: u32,
  payloadLength: u32,
  pixelStep: u32,
  lambda: f64,
  workPtr: u32,
  outPtr: u32
): u32 {
  const rowStride: u32 = width * 4
  const byteStep: u32 = pixelStep * 4
  const rowBufPtr: u32 = workPtr
  const cPtr: u32 = workPtr + payloadCellsX * 4
  const dPtr: u32 = workPtr + payloadCellsX * 8
  let byteIdx: u32 = 0
  let bitBuffer: u32 = 0
  let bitCount: u32 = 0

  for (let cy: u32 = 0; cy < payloadCellsY && byteIdx < payloadLength; cy++) {
    const rowBase: u32 = rowStartsPtr + cy * 8
    const rowX: i32 = load<i32>(rowBase)
    const rowY: i32 = load<i32>(rowBase + 4)
    if (rowX < 0 || rowY < 0) return 0
    if (<u32>rowY >= height) return 0
    if (<u32>rowX + (payloadCellsX - 1) * pixelStep >= width) return 0

    const paramBase: u32 = rowParamsPtr + cy * 40
    const t01: f64 = load<f64>(paramBase)
    const t12: f64 = load<f64>(paramBase + 8)
    const t23: f64 = load<f64>(paramBase + 16)
    const railLo: f64 = load<f64>(paramBase + 24)
    const railHi: f64 = load<f64>(paramBase + 32)

    let base: u32 = pixelsPtr + <u32>rowY * rowStride + <u32>rowX * 4

    if (lambda > 0) {
      // Gather the row, deconvolve, then classify from the corrected buffer.
      let p: u32 = base
      for (let cx: u32 = 0; cx < payloadCellsX; cx++, p += byteStep) {
        store<f32>(rowBufPtr + cx * 4, <f32><u32>load<u8>(p))
      }
      unsharpenLuma1RowWasm(rowBufPtr, cPtr, dPtr, payloadCellsX, lambda, railLo, railHi)

      let cx: u32 = 0
      while (cx < payloadCellsX && byteIdx < payloadLength) {
        if (bitCount === 0 && cx + 4 <= payloadCellsX) {
          const rowFullBytes: u32 = (payloadCellsX - cx) >> 2
          const remainingBytes: u32 = payloadLength - byteIdx
          const fullBytes: u32 = rowFullBytes < remainingBytes ? rowFullBytes : remainingBytes
          for (let i: u32 = 0; i < fullBytes; i++) {
            const s0: u32 = luma1SymbolFromValue(luma1RoundSample(<f64>load<f32>(rowBufPtr + cx * 4)), t01, t12, t23)
            const s1: u32 = luma1SymbolFromValue(luma1RoundSample(<f64>load<f32>(rowBufPtr + (cx + 1) * 4)), t01, t12, t23)
            const s2: u32 = luma1SymbolFromValue(luma1RoundSample(<f64>load<f32>(rowBufPtr + (cx + 2) * 4)), t01, t12, t23)
            const s3: u32 = luma1SymbolFromValue(luma1RoundSample(<f64>load<f32>(rowBufPtr + (cx + 3) * 4)), t01, t12, t23)
            store<u8>(outPtr + byteIdx, <u8>((s0 << 6) | (s1 << 4) | (s2 << 2) | s3))
            byteIdx++
            cx += 4
          }
          continue
        }
        bitBuffer = (bitBuffer << 2) | luma1SymbolFromValue(luma1RoundSample(<f64>load<f32>(rowBufPtr + cx * 4)), t01, t12, t23)
        bitCount += 2
        cx++
        if (bitCount >= 8) {
          store<u8>(outPtr + byteIdx, <u8>((bitBuffer >> (bitCount - 8)) & 0xff))
          byteIdx++
          bitCount -= 8
          bitBuffer = bitCount > 0 ? (bitBuffer & ((1 << bitCount) - 1)) : 0
        }
      }
      continue
    }

    // No correction armed: classify raw bytes directly.
    let cx: u32 = 0
    while (cx < payloadCellsX && byteIdx < payloadLength) {
      if (bitCount === 0 && cx + 4 <= payloadCellsX) {
        const rowFullBytes: u32 = (payloadCellsX - cx) >> 2
        const remainingBytes: u32 = payloadLength - byteIdx
        const fullBytes: u32 = rowFullBytes < remainingBytes ? rowFullBytes : remainingBytes
        for (let i: u32 = 0; i < fullBytes; i++) {
          const s0: u32 = luma1SymbolFromValue(<f64><u32>load<u8>(base), t01, t12, t23)
          const s1: u32 = luma1SymbolFromValue(<f64><u32>load<u8>(base + byteStep), t01, t12, t23)
          const s2: u32 = luma1SymbolFromValue(<f64><u32>load<u8>(base + byteStep * 2), t01, t12, t23)
          const s3: u32 = luma1SymbolFromValue(<f64><u32>load<u8>(base + byteStep * 3), t01, t12, t23)
          store<u8>(outPtr + byteIdx, <u8>((s0 << 6) | (s1 << 4) | (s2 << 2) | s3))
          byteIdx++
          base += byteStep * 4
        }
        cx += fullBytes * 4
        continue
      }
      bitBuffer = (bitBuffer << 2) | luma1SymbolFromValue(<f64><u32>load<u8>(base), t01, t12, t23)
      bitCount += 2
      base += byteStep
      cx++
      if (bitCount >= 8) {
        store<u8>(outPtr + byteIdx, <u8>((bitBuffer >> (bitCount - 8)) & 0xff))
        byteIdx++
        bitCount -= 8
        bitBuffer = bitCount > 0 ? (bitBuffer & ((1 << bitCount) - 1)) : 0
      }
    }
  }

  return byteIdx
}

// Validates fixed-size inner Beam Me Up packet slots inside an already decoded
// HDMI-UVC frame payload. Writes one 24-byte record per valid slot:
//   u32 slotIndex, fileId, k, symbolId, versionAndFlags, payloadCrc
// This keeps the hot expected-size probe in WASM and lets JS build parsed
// packet views without re-running CRC32 in parsePacket().
export function probeExpectedPackets(
  framePtr: u32,
  frameLength: u32,
  packetSize: u32,
  fileIdFilter: u32,
  kFilter: u32,
  filterFlags: u32,
  outPtr: u32,
  maxSlots: u32
): u32 {
  if (packetSize <= PACKET_HEADER_SIZE) return 0
  if (frameLength < packetSize) return 0
  if (frameLength % packetSize !== 0) return 0

  const payloadLength: u32 = packetSize - PACKET_HEADER_SIZE
  let slotCount: u32 = frameLength / packetSize
  if (slotCount > maxSlots) slotCount = maxSlots
  const useFileId: bool = (filterFlags & PROBE_FILTER_FILE_ID) !== 0
  const useK: bool = (filterFlags & PROBE_FILTER_K) !== 0

  let count: u32 = 0
  for (let slot: u32 = 0; slot < slotCount; slot++) {
    const base: u32 = framePtr + slot * packetSize
    const versionAndFlags: u32 = <u32>load<u8>(base)
    if ((versionAndFlags >>> 3) !== PROTOCOL_VERSION) continue

    const fileId: u32 = loadU32BE(base + 1)
    if (useFileId && fileId !== fileIdFilter) continue

    const k: u32 = loadU24BE(base + 5)
    if (useK && k !== kFilter) continue

    const symbolId: u32 = loadU24BE(base + 8)
    const payloadCrc: u32 = loadU32BE(base + 11)
    if (crc32(base + PACKET_HEADER_SIZE, payloadLength) !== payloadCrc) continue

    const record: u32 = outPtr + count * 24
    store<u32>(record, slot)
    store<u32>(record + 4, fileId)
    store<u32>(record + 8, k)
    store<u32>(record + 12, symbolId)
    store<u32>(record + 16, versionAndFlags)
    store<u32>(record + 20, payloadCrc)
    count++
  }

  return count
}

// @inline
function loadU24BE(ptr: u32): u32 {
  return ((<u32>load<u8>(ptr)) << 16) |
    ((<u32>load<u8>(ptr + 1)) << 8) |
    (<u32>load<u8>(ptr + 2))
}

// @inline
function loadU32BE(ptr: u32): u32 {
  return ((<u32>load<u8>(ptr)) << 24) |
    ((<u32>load<u8>(ptr + 1)) << 16) |
    ((<u32>load<u8>(ptr + 2)) << 8) |
    (<u32>load<u8>(ptr + 3))
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
