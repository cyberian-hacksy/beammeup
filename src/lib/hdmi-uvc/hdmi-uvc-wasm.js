// HDMI-UVC WASM loader.
//
// Fetches and instantiates `hdmi_uvc.wasm` (compiled from wasm/hdmi-uvc/).
// Callable from both the main thread and the receiver worker. The result is
// cached so repeated calls return the same instance.
//
// The module is built with AssemblyScript --runtime stub: no GC, no allocator.
// JS is responsible for writing input bytes into the exported linear memory
// at the module-declared scratch offset, calling the kernel, and reading the
// result. We keep a JS-side cursor so callers can allocate scratch ranges
// without stomping on each other within one call chain.

import { crc32 as jsCrc32 } from './crc32.js'
import {
  createPacket,
  PACKET_HEADER_SIZE,
  parsePacket,
  isMetadataFlag,
  packetModeFromFlags
} from '../packet.js'

const WASM_FILENAME = 'hdmi_uvc.wasm'

let wasmModule = null
let wasmInitPromise = null
let wasmBytesView = null       // Reusable Uint8Array view; invalidated on memory.grow.
let wasmScratchBase = 0        // Offset returned by getScratchStart().
let wasmScratchCursor = 0      // Next free byte inside the scratch region.
let wasmMemoryPageCount = 0    // Track current size so we know when to re-view.
let wasmUrlOverride = null     // Absolute URL set by setHdmiUvcWasmUrl().

// Force the JS fallback branch inside crc32WithFallback / scanBrightRuns-
// WithFallback regardless of loader state. Used by testWasmVsJsDetectAnchors
// to exercise the pre-WASM code path after WASM has already loaded.
let forceJsFallbackForTesting = false

export function __setForceJsFallbackForTesting(value) {
  forceJsFallbackForTesting = !!value
}

function refreshMemoryView() {
  wasmBytesView = new Uint8Array(wasmModule.memory.buffer)
  wasmMemoryPageCount = wasmModule.memory.buffer.byteLength / 65536
}

// Pinned frame region. When the receiver captures directly into WASM memory
// (VideoFrame.copyTo into this region), the frame must survive every kernel
// call of that frame's processing — so it is reserved at the front of the JS
// scratch area and all transient kernel inputs/outputs go AFTER it. The
// reservation also pre-grows generous transient headroom: if a kernel call
// grew memory mid-frame, the receiver's frame view would detach silently.
const WASM_FRAME_TRANSIENT_HEADROOM = 8 * 1024 * 1024
let wasmFrameRegionBytes = 0

function transientBase() {
  return wasmScratchBase + wasmFrameRegionBytes
}

function ensureMemoryFor(byteLength) {
  const required = transientBase() + byteLength
  const currentBytes = wasmModule.memory.buffer.byteLength
  if (required <= currentBytes) {
    if (!wasmBytesView || wasmBytesView.buffer !== wasmModule.memory.buffer) {
      refreshMemoryView()
    }
    return
  }
  const deficit = required - currentBytes
  const pages = Math.ceil(deficit / 65536)
  const prev = wasmModule.growMemory(pages)
  if (prev < 0) {
    throw new Error('hdmi-uvc wasm: memory.grow failed (requested ' + pages + ' pages)')
  }
  refreshMemoryView()
}

// Reserve (or re-size) the pinned frame region and return a fresh
// Uint8ClampedArray view over it. The view must be re-acquired every frame:
// memory growth between frames detaches earlier views (their data survives at
// the same offset, but the old JS view object goes dead). Returns null until
// the module is loaded.
export function acquireWasmFrameView(bytes) {
  if (!wasmModule) return null
  const rounded = (bytes + 65535) & ~65535
  if (rounded > wasmFrameRegionBytes) wasmFrameRegionBytes = rounded
  ensureMemoryFor(WASM_FRAME_TRANSIENT_HEADROOM)
  return new Uint8ClampedArray(wasmModule.memory.buffer, wasmScratchBase, bytes)
}

// True when `view` aliases WASM linear memory — kernels can then use its
// byteOffset as a pointer instead of copying the pixels into scratch.
function isWasmBackedView(view) {
  return !!wasmModule && view && view.buffer === wasmModule.memory.buffer
}

function resolveWasmUrl() {
  // Prefer an explicit override. The receiver wires the worker with a URL
  // derived from document.baseURI because the worker's own self.location.href
  // is a blob:/data: URL inside Vite's ?worker&inline bundle — the URL spec
  // rejects blob: as a base for relative resolution, so self.location.href is
  // unusable here.
  if (wasmUrlOverride) return wasmUrlOverride
  if (typeof document !== 'undefined' && document.baseURI) {
    return new URL('hdmi-uvc/' + WASM_FILENAME, document.baseURI).href
  }
  // Worker without an override: self.origin + absolute path is a safe fallback
  // when the page is served from the root. This covers dev builds; production
  // worker callers should use setHdmiUvcWasmUrl() explicitly.
  if (typeof self !== 'undefined' && self.location && self.location.origin && self.location.origin !== 'null') {
    return self.location.origin + '/hdmi-uvc/' + WASM_FILENAME
  }
  throw new Error('hdmi-uvc wasm: cannot resolve base URL (no document, no self.origin, no override)')
}

// Set an explicit absolute URL for the WASM binary. Called from the worker
// before loadHdmiUvcWasm() so it sidesteps blob:/data: base resolution. The
// main thread computes this URL from document.baseURI and posts it to the
// worker at init time. Safe to call multiple times; the last URL wins until
// instantiation completes.
export function setHdmiUvcWasmUrl(url) {
  wasmUrlOverride = typeof url === 'string' && url.length > 0 ? url : null
}

// Shared instantiation path. Returns the module's exports object.
// Called via loadHdmiUvcWasm(); throws if WebAssembly is unavailable.
export function loadHdmiUvcWasm() {
  if (wasmModule) return Promise.resolve(wasmModule)
  if (wasmInitPromise) return wasmInitPromise
  if (typeof WebAssembly === 'undefined') {
    return Promise.reject(new Error('hdmi-uvc wasm: WebAssembly not supported'))
  }
  const url = resolveWasmUrl()
  wasmInitPromise = (async () => {
    const imports = {
      env: {
        abort: (msg, file, line, column) => {
          throw new Error('hdmi-uvc wasm abort: ' + [msg, file, line, column].join(':'))
        }
      }
    }
    let instance
    try {
      const resp = await fetch(url)
      if (!resp.ok) throw new Error('fetch failed: ' + resp.status)
      // Prefer streaming; fall back to buffer instantiation if the server
      // doesn't set Content-Type: application/wasm (dev servers sometimes don't).
      if (typeof WebAssembly.instantiateStreaming === 'function') {
        try {
          const result = await WebAssembly.instantiateStreaming(resp.clone(), imports)
          instance = result.instance
        } catch (streamErr) {
          const bytes = await resp.arrayBuffer()
          const result = await WebAssembly.instantiate(bytes, imports)
          instance = result.instance
        }
      } else {
        const bytes = await resp.arrayBuffer()
        const result = await WebAssembly.instantiate(bytes, imports)
        instance = result.instance
      }
    } catch (err) {
      wasmInitPromise = null
      throw new Error('hdmi-uvc wasm: load failed from ' + url + ' — ' + (err?.message || err))
    }
    wasmModule = instance.exports
    refreshMemoryView()
    wasmScratchBase = wasmModule.getScratchStart() >>> 0
    wasmScratchCursor = wasmScratchBase
    return wasmModule
  })()
  return wasmInitPromise
}

// Synchronous accessor. Returns null if the module hasn't loaded yet.
export function getHdmiUvcWasm() {
  return wasmModule
}

export function isHdmiUvcWasmLoaded() {
  return wasmModule !== null
}

// Predicate for the dispatch side: true when WASM kernels should run for new
// operations. Differs from isHdmiUvcWasmLoaded() in that it also honors the
// __setForceJsFallbackForTesting flag so unit tests can drive the JS fallback
// branch while the module is still instantiated. Frame.js's classifier
// dispatch checks this; crc32WithFallback and scanBrightRunsWithFallback do
// the same check internally.
export function isHdmiUvcWasmActive() {
  return wasmModule !== null && !forceJsFallbackForTesting
}

// CRC32 via the WASM kernel. Bit-for-bit identical to src/lib/hdmi-uvc/crc32.js.
// Throws if the module isn't loaded. Callers that need a graceful fallback
// should catch and call jsCrc32 themselves, or use crc32WithFallback below.
export function wasmCrc32(bytes) {
  if (!wasmModule || forceJsFallbackForTesting) throw new Error('hdmi-uvc wasm: not active')
  const len = bytes.length | 0
  if (len === 0) return jsCrc32(bytes) // 0xFFFFFFFF ^ 0xFFFFFFFF = 0; keep JS path.
  ensureMemoryFor(len)
  const base = transientBase()
  wasmBytesView.set(bytes, base)
  return wasmModule.crc32(base, len) >>> 0
}

// Prefer the WASM path when available; fall back to JS CRC32 if the module
// hasn't loaded or blew up. Useful for hot paths that shouldn't block on
// instantiation — the first frame or two will run through JS and subsequent
// frames through WASM.
export function crc32WithFallback(bytes) {
  if (wasmModule && !forceJsFallbackForTesting) {
    try { return wasmCrc32(bytes) } catch (_) { /* fall through to JS */ }
  }
  return jsCrc32(bytes)
}

// Pure-JS reference for scanBrightRuns. This is the contract the WASM kernel
// is tested against in testWasmScanBrightRunsMatchesJs. The findCornerAnchor
// inner loop uses this when WASM hasn't loaded yet so behavior is identical.
//
// Scans `pixels` (RGBA; luma read from the R channel) for horizontal bright
// runs where consecutive pixel luma > `threshold`, within the half-open rect
// [xStart, xEnd) × rows visited in `yDir` direction from `yStart` (inclusive)
// toward `yEnd` (exclusive). Returns only runs whose length ∈ [minRun, maxRun].
// Output is an array of {runX, runY, runLen} in scan order.
export function jsScanBrightRuns(pixels, width, height, xStart, xEnd, yStart, yEnd, yDir, minRun, maxRun, threshold) {
  const runs = []
  if (yDir === 0) return runs
  if (xStart >= xEnd || xEnd > width) return runs
  let y = yStart
  while (y !== yEnd) {
    if (y < 0 || y >= height) { y += yDir; continue }
    let runStart = -1
    let runLen = 0
    const rowBase = y * width * 4
    for (let x = xStart; x < xEnd; x++) {
      if (pixels[rowBase + x * 4] > threshold) {
        if (runStart < 0) runStart = x
        runLen++
      } else {
        if (runLen >= minRun && runLen <= maxRun) {
          runs.push({ runX: runStart, runY: y, runLen })
        }
        runStart = -1
        runLen = 0
      }
    }
    if (runLen >= minRun && runLen <= maxRun) {
      runs.push({ runX: runStart, runY: y, runLen })
    }
    y += yDir
  }
  return runs
}

// WASM wrapper for scanBrightRuns. Copies the input `pixels` into the scratch
// region, invokes the WASM kernel, reads the packed-u32 output back as
// {runX,runY,runLen} triples. Throws if the module isn't loaded. `maxRuns`
// defaults to 1024 which is well beyond what findCornerAnchor ever encounters
// per corner rectangle.
export function wasmScanBrightRuns(pixels, width, height, xStart, xEnd, yStart, yEnd, yDir, minRun, maxRun, threshold, maxRuns = 1024) {
  if (!wasmModule || forceJsFallbackForTesting) throw new Error('hdmi-uvc wasm: not active')
  // Zero-copy when the frame was captured straight into WASM memory; the
  // byteOffset is captured before ensureMemoryFor because growth detaches
  // the JS view while preserving the data at the same offset.
  const inWasm = isWasmBackedView(pixels)
  const wasmPixelsPtr = inWasm ? pixels.byteOffset : 0
  const pixelBytes = inWasm ? 0 : pixels.length
  // We need room for: (staged) pixel buffer + output runs (12 bytes each).
  const outByteCount = maxRuns * 12
  ensureMemoryFor(pixelBytes + outByteCount)
  const base = transientBase()
  if (!inWasm) wasmBytesView.set(pixels, base)
  const pixelsPtr = inWasm ? wasmPixelsPtr : base
  const outPtr = base + pixelBytes
  const count = wasmModule.scanBrightRuns(
    pixelsPtr, width, height,
    xStart >>> 0, xEnd >>> 0,
    yStart | 0, yEnd | 0, yDir | 0,
    minRun >>> 0, maxRun >>> 0, threshold >>> 0,
    outPtr, maxRuns >>> 0
  ) >>> 0
  // Re-view memory in case ensureMemoryFor grew it.
  const view = new Uint32Array(wasmModule.memory.buffer, outPtr, count * 3)
  const runs = new Array(count)
  for (let i = 0; i < count; i++) {
    runs[i] = { runX: view[i * 3], runY: view[i * 3 + 1], runLen: view[i * 3 + 2] }
  }
  return runs
}

// Prefer the WASM scan when available; fall back to the JS reference otherwise.
// Matches the crc32WithFallback pattern — callers stay on a single entry point
// and the loader state decides which kernel handles the call.
export function scanBrightRunsWithFallback(pixels, width, height, xStart, xEnd, yStart, yEnd, yDir, minRun, maxRun, threshold) {
  if (wasmModule && !forceJsFallbackForTesting) {
    try {
      return wasmScanBrightRuns(pixels, width, height, xStart, xEnd, yStart, yEnd, yDir, minRun, maxRun, threshold)
    } catch (_) { /* fall through */ }
  }
  return jsScanBrightRuns(pixels, width, height, xStart, xEnd, yStart, yEnd, yDir, minRun, maxRun, threshold)
}

// --- Per-cell classifier helpers (Task 4.3) -------------------------------
//
// The JS reference implementations below mirror the inline COMPAT_4 branch
// and decodeLuma2() + sampleCodebook3At() in hdmi-uvc-frame.js. They exist
// so the WASM kernels can be tested bit-for-bit without standing up the
// whole decodeDataRegion pipeline. The receiver's hot path still uses the
// inline JS branches today; these helpers are the scaffolding that lets a
// future patch swap in the batch WASM classifiers behind a feature flag.

function jsSample2x2R(pixels, width, height, cx, cy) {
  if (cx < 0 || cy < 0 || cx + 1 >= width || cy + 1 >= height) return 0
  const base = cy * width * 4 + cx * 4
  const rowStride = width * 4
  return (pixels[base] + pixels[base + 4] + pixels[base + rowStride] + pixels[base + rowStride + 4]) * 0.25
}

function jsSampleQuadrantsR(pixels, width, height, px, py, bs) {
  const xMid = px + bs * 0.5
  const yMid = py + bs * 0.5
  const xEnd = px + bs
  const yEnd = py + bs
  const quads = [
    [px, py, xMid, yMid],
    [xMid, py, xEnd, yMid],
    [px, yMid, xMid, yEnd],
    [xMid, yMid, xEnd, yEnd]
  ]
  const out = [0, 0, 0, 0]
  for (let q = 0; q < 4; q++) {
    let x0 = Math.max(0, Math.round(quads[q][0]))
    let y0 = Math.max(0, Math.round(quads[q][1]))
    let x1 = Math.min(width, Math.max(x0 + 1, Math.round(quads[q][2])))
    let y1 = Math.min(height, Math.max(y0 + 1, Math.round(quads[q][3])))
    let sum = 0
    let count = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        sum += pixels[y * width * 4 + x * 4]
        count++
      }
    }
    out[q] = count > 0 ? sum / count : 0
  }
  return out
}

// JS reference for classifyCompat4Cells: each cell is [px, py, bs, threshold].
// Produces one 0/1 symbol per cell using the same sample-and-threshold rule
// as the COMPAT_4 branch in decodeDataRegion.
export function jsClassifyCompat4Cells(pixels, width, height, cells) {
  const symbols = new Uint8Array(cells.length)
  for (let i = 0; i < cells.length; i++) {
    const [px, py, bs, threshold] = cells[i]
    const cx = Math.round(px + bs * 0.5) - 1
    const cy = Math.round(py + bs * 0.5) - 1
    const val = jsSample2x2R(pixels, width, height, cx, cy)
    symbols[i] = val >= threshold ? 1 : 0
  }
  return symbols
}

// JS reference for classifyLuma2Cells: each cell is [px, py, bs, black, white].
// Produces one 0..3 symbol per cell. Exactly mirrors normalizeBinarySample +
// decodeLuma2 (frame.js :236-282).
export function jsClassifyLuma2Cells(pixels, width, height, cells) {
  const symbols = new Uint8Array(cells.length)
  for (let i = 0; i < cells.length; i++) {
    const [px, py, bs, black, white] = cells[i]
    const samples = jsSampleQuadrantsR(pixels, width, height, px, py, bs)
    const rawSpan = Math.abs(white - black)
    const span = Math.max(48, rawSpan)
    const polarity = white >= black ? 1 : -1
    const norm = samples.map(s => {
      const v = (polarity * (s - black)) / span
      return Math.max(0, Math.min(1, v))
    })
    const top = (norm[0] + norm[1]) * 0.5
    const bottom = (norm[2] + norm[3]) * 0.5
    const left = (norm[0] + norm[2]) * 0.5
    const right = (norm[1] + norm[3]) * 0.5
    const hContrast = Math.abs(top - bottom)
    const vContrast = Math.abs(left - right)
    if (hContrast >= vContrast) symbols[i] = top >= bottom ? 0 : 1
    else symbols[i] = left >= right ? 2 : 3
  }
  return symbols
}

// Pack cells into a Float32Array matching the WASM kernel's input layout.
// COMPAT_4 cells are 4 floats (px, py, bs, threshold) = 16 bytes.
// LUMA_2 cells are 5 floats (px, py, bs, black, white) = 20 bytes.
function packCells(cells, fieldsPerCell) {
  const f = new Float32Array(cells.length * fieldsPerCell)
  for (let i = 0; i < cells.length; i++) {
    for (let k = 0; k < fieldsPerCell; k++) f[i * fieldsPerCell + k] = cells[i][k]
  }
  return f
}

// WASM wrapper for classifyCompat4Cells. Copies pixels + packed cells to WASM
// scratch, invokes the kernel, reads the symbols back as a Uint8Array.
export function wasmClassifyCompat4Cells(pixels, width, height, cells) {
  if (!wasmModule || forceJsFallbackForTesting) throw new Error('hdmi-uvc wasm: not active')
  const packed = packCells(cells, 4)
  const cellCount = cells.length
  const inWasm = isWasmBackedView(pixels)
  const wasmPixelsPtr = inWasm ? pixels.byteOffset : 0
  const stagedPixelBytes = inWasm ? 0 : pixels.length
  ensureMemoryFor(stagedPixelBytes + packed.byteLength + cellCount)
  const base = transientBase()
  if (!inWasm) wasmBytesView.set(pixels, base)
  const pixelsPtr = inWasm ? wasmPixelsPtr : base
  const cellsPtr = base + stagedPixelBytes
  const outPtr = cellsPtr + packed.byteLength
  new Uint8Array(wasmModule.memory.buffer).set(new Uint8Array(packed.buffer), cellsPtr)
  wasmModule.classifyCompat4Cells(pixelsPtr, width, height, cellsPtr, cellCount, outPtr)
  return new Uint8Array(wasmModule.memory.buffer.slice(outPtr, outPtr + cellCount))
}

export function wasmClassifyLuma2Cells(pixels, width, height, cells) {
  if (!wasmModule || forceJsFallbackForTesting) throw new Error('hdmi-uvc wasm: not active')
  const packed = packCells(cells, 5)
  const cellCount = cells.length
  const inWasm = isWasmBackedView(pixels)
  const wasmPixelsPtr = inWasm ? pixels.byteOffset : 0
  const stagedPixelBytes = inWasm ? 0 : pixels.length
  ensureMemoryFor(stagedPixelBytes + packed.byteLength + cellCount)
  const base = transientBase()
  if (!inWasm) wasmBytesView.set(pixels, base)
  const pixelsPtr = inWasm ? wasmPixelsPtr : base
  const cellsPtr = base + stagedPixelBytes
  const outPtr = cellsPtr + packed.byteLength
  new Uint8Array(wasmModule.memory.buffer).set(new Uint8Array(packed.buffer), cellsPtr)
  wasmModule.classifyLuma2Cells(pixelsPtr, width, height, cellsPtr, cellCount, outPtr)
  return new Uint8Array(wasmModule.memory.buffer.slice(outPtr, outPtr + cellCount))
}

export function wasmPackBinary1Payload(pixels, width, height, rowStarts, thresholds, payloadCellsX, payloadCellsY, payloadLength) {
  if (!wasmModule || forceJsFallbackForTesting) throw new Error('hdmi-uvc wasm: not active')
  const rowStartBytes = rowStarts.byteLength
  const thresholdBytes = thresholds.byteLength
  const inWasm = isWasmBackedView(pixels)
  const wasmPixelsPtr = inWasm ? pixels.byteOffset : 0
  const stagedPixelBytes = inWasm ? 0 : pixels.length
  ensureMemoryFor(stagedPixelBytes + rowStartBytes + thresholdBytes + payloadLength)
  const base = transientBase()
  if (!inWasm) wasmBytesView.set(pixels, base)
  const pixelsPtr = inWasm ? wasmPixelsPtr : base
  const rowStartsPtr = base + stagedPixelBytes
  const thresholdsPtr = rowStartsPtr + rowStartBytes
  const outPtr = thresholdsPtr + thresholdBytes
  new Uint8Array(wasmModule.memory.buffer).set(new Uint8Array(rowStarts.buffer, rowStarts.byteOffset, rowStartBytes), rowStartsPtr)
  new Uint8Array(wasmModule.memory.buffer).set(new Uint8Array(thresholds.buffer, thresholds.byteOffset, thresholdBytes), thresholdsPtr)
  const written = wasmModule.packBinary1Payload(
    pixelsPtr,
    width >>> 0,
    height >>> 0,
    rowStartsPtr,
    thresholdsPtr,
    payloadCellsX >>> 0,
    payloadCellsY >>> 0,
    payloadLength >>> 0,
    outPtr
  ) >>> 0
  if (written !== payloadLength) return null
  return new Uint8Array(wasmModule.memory.buffer.slice(outPtr, outPtr + payloadLength))
}

// WASM wrapper for readLuma1Payload — the locked Luma4 native-grid reader
// (gather + peaking deconvolution + 4-level classify + 2-bit pack) in one
// linear-memory pass. rowStarts: Int32Array pairs per row; rowParams:
// Float64Array x5 per row (t01, t12, t23, railLo, railHi). lambda 0 = no
// deconvolution. Returns the payload bytes or null (bad geometry / kernel
// missing), letting the caller fall back to the JS reader.
export function wasmReadLuma1Payload(pixels, width, height, rowStarts, rowParams, payloadCellsX, payloadCellsY, payloadLength, pixelStep, lambda) {
  if (!wasmModule || forceJsFallbackForTesting) throw new Error('hdmi-uvc wasm: not active')
  if (typeof wasmModule.readLuma1Payload !== 'function') return null // stale artifact predating the kernel
  const align8 = (v) => (v + 7) & ~7
  const rowStartBytes = rowStarts.byteLength
  const rowParamBytes = rowParams.byteLength
  const workBytes = payloadCellsX * 12 // f32 row buffer + Thomas c'/d'
  const inWasm = isWasmBackedView(pixels)
  const wasmPixelsPtr = inWasm ? pixels.byteOffset : 0
  const stagedPixelBytes = inWasm ? 0 : align8(pixels.length)
  ensureMemoryFor(stagedPixelBytes + rowStartBytes + align8(rowParamBytes) + workBytes + payloadLength + 16)
  const base = transientBase()
  if (!inWasm) wasmBytesView.set(pixels, base)
  const pixelsPtr = inWasm ? wasmPixelsPtr : base
  const rowStartsPtr = align8(base + stagedPixelBytes)
  const rowParamsPtr = align8(rowStartsPtr + rowStartBytes)
  const workPtr = rowParamsPtr + rowParamBytes
  const outPtr = workPtr + workBytes
  new Uint8Array(wasmModule.memory.buffer).set(new Uint8Array(rowStarts.buffer, rowStarts.byteOffset, rowStartBytes), rowStartsPtr)
  new Uint8Array(wasmModule.memory.buffer).set(new Uint8Array(rowParams.buffer, rowParams.byteOffset, rowParamBytes), rowParamsPtr)
  const written = wasmModule.readLuma1Payload(
    pixelsPtr,
    width >>> 0,
    height >>> 0,
    rowStartsPtr,
    rowParamsPtr,
    payloadCellsX >>> 0,
    payloadCellsY >>> 0,
    payloadLength >>> 0,
    pixelStep >>> 0,
    lambda,
    workPtr,
    outPtr
  ) >>> 0
  if (written !== payloadLength) return null
  return new Uint8Array(wasmModule.memory.buffer.slice(outPtr, outPtr + payloadLength))
}

export function wasmProbeExpectedPackets(framePayload, expectedPacketSize, options = {}) {
  if (!wasmModule || forceJsFallbackForTesting) throw new Error('hdmi-uvc wasm: not active')
  if (!framePayload || !expectedPacketSize || expectedPacketSize <= PACKET_HEADER_SIZE) return null
  if (framePayload.length % expectedPacketSize !== 0) {
    return {
      packets: [],
      parsedPackets: [],
      slotCount: null,
      packetSize: expectedPacketSize,
      strategy: 'expected-wasm',
      salvaged: 0
    }
  }

  const slotCount = Math.floor(framePayload.length / expectedPacketSize)
  const maxSlots = slotCount
  const recordBytes = slotCount * 24
  const total = framePayload.length + recordBytes
  ensureMemoryFor(total)
  const base = transientBase()
  wasmBytesView.set(framePayload, base)

  const outPtr = base + framePayload.length
  const session = options.session || null
  const kFilter = session?.k ?? session?.K_prime ?? 0
  let filterFlags = 0
  if (session?.fileId != null) filterFlags |= 1
  if (session?.k != null || session?.K_prime != null) filterFlags |= 2

  const count = wasmModule.probeExpectedPackets(
    base,
    framePayload.length >>> 0,
    expectedPacketSize >>> 0,
    (session?.fileId ?? 0) >>> 0,
    kFilter >>> 0,
    filterFlags >>> 0,
    outPtr,
    maxSlots >>> 0
  ) >>> 0

  const records = new DataView(wasmModule.memory.buffer, outPtr, count * 24)
  const packets = []
  const parsedPackets = []
  for (let i = 0; i < count; i++) {
    const base = i * 24
    const slotIndex = records.getUint32(base, true)
    const offset = slotIndex * expectedPacketSize
    if (offset < 0 || offset + expectedPacketSize > framePayload.length) continue
    const packet = framePayload.subarray(offset, offset + expectedPacketSize)
    const versionAndFlags = records.getUint32(base + 16, true)
    const payload = packet.subarray(PACKET_HEADER_SIZE)
    packets.push(packet)
    parsedPackets.push({
      fileId: records.getUint32(base + 4, true),
      k: records.getUint32(base + 8, true),
      symbolId: records.getUint32(base + 12, true),
      blockSize: expectedPacketSize - PACKET_HEADER_SIZE,
      isMetadata: isMetadataFlag(versionAndFlags),
      mode: packetModeFromFlags(versionAndFlags),
      payloadCrc: records.getUint32(base + 20, true),
      payload
    })
  }

  return {
    packets,
    parsedPackets,
    slotCount,
    packetSize: expectedPacketSize,
    strategy: 'expected-wasm',
    salvaged: 0
  }
}

export async function testWasmProbeExpectedPacketsMatchesJs() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('WASM expected packet probe test: FAIL (load)', err?.message || err)
    return false
  }

  const fileId = 0x12345678
  const k = 849
  const blockSize = 31
  const slotCount = 4
  const packetSize = PACKET_HEADER_SIZE + blockSize
  const framePayload = new Uint8Array(slotCount * packetSize)
  for (let slot = 0; slot < slotCount; slot++) {
    const payload = new Uint8Array(blockSize)
    payload.fill((slot + 17) & 0xff)
    const packet = createPacket(fileId, k, slot + 1, payload, false, blockSize)
    framePayload.set(packet, slot * packetSize)
  }

  const wasmProbe = wasmProbeExpectedPackets(framePayload, packetSize, {
    session: { fileId, k },
    maxPackets: 64
  })
  const jsParsed = []
  for (let offset = 0; offset < framePayload.length; offset += packetSize) {
    const parsed = parsePacket(framePayload.subarray(offset, offset + packetSize))
    if (parsed) jsParsed.push(parsed)
  }
  const mismatchProbe = wasmProbeExpectedPackets(framePayload, packetSize, {
    session: { fileId: fileId ^ 1, k },
    maxPackets: 64
  })

  const pass = wasmProbe?.packets.length === slotCount &&
    wasmProbe?.parsedPackets.length === jsParsed.length &&
    wasmProbe?.parsedPackets.every((parsed, idx) =>
      parsed.fileId === jsParsed[idx].fileId &&
      parsed.k === jsParsed[idx].k &&
      parsed.symbolId === jsParsed[idx].symbolId &&
      parsed.blockSize === jsParsed[idx].blockSize &&
      parsed.payloadCrc === jsParsed[idx].payloadCrc &&
      parsed.payload.length === jsParsed[idx].payload.length
    ) &&
    mismatchProbe?.packets.length === 0

  console.log('WASM expected packet probe test:', pass ? 'PASS' : 'FAIL', {
    wasmPackets: wasmProbe?.packets.length,
    jsPackets: jsParsed.length,
    mismatchPackets: mismatchProbe?.packets.length
  })
  return pass
}

export async function testWasmPackBinary1PayloadMatchesJs() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('WASM binary1 packer test: FAIL (load)', err?.message || err)
    return false
  }

  const width = 32
  const height = 8
  const payloadCellsX = 17
  const payloadCellsY = 3
  const payloadLength = 6
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const base = (y * width + x) * 4
      const v = (x * 31 + y * 47) & 0xff
      pixels[base] = v
      pixels[base + 1] = v
      pixels[base + 2] = v
      pixels[base + 3] = 255
    }
  }
  const rowStarts = new Int32Array([3, 2, 5, 3, 1, 4])
  const thresholds = new Float32Array([96, 128, 160])
  const js = new Uint8Array(payloadLength)
  let byteIdx = 0
  let bitBuffer = 0
  let bitCount = 0
  for (let cy = 0; cy < payloadCellsY && byteIdx < payloadLength; cy++) {
    const rowX = rowStarts[cy * 2]
    const rowY = rowStarts[cy * 2 + 1]
    const threshold = thresholds[cy]
    for (let cx = 0; cx < payloadCellsX && byteIdx < payloadLength; cx++) {
      const bit = pixels[(rowY * width + rowX + cx) * 4] >= threshold ? 1 : 0
      bitBuffer = (bitBuffer << 1) | bit
      bitCount++
      if (bitCount >= 8) {
        js[byteIdx++] = bitBuffer & 0xff
        bitBuffer = 0
        bitCount = 0
      }
    }
  }
  const wasm = wasmPackBinary1Payload(pixels, width, height, rowStarts, thresholds, payloadCellsX, payloadCellsY, payloadLength)
  const pass = wasm?.length === js.length && js.every((v, i) => wasm[i] === v)
  console.log('WASM binary1 packer test:', pass ? 'PASS' : 'FAIL', {
    js: Array.from(js),
    wasm: wasm ? Array.from(wasm) : null
  })
  return pass
}

// Test: WASM classifiers produce the same symbols as the JS references on a
// synthetic pixel buffer populated with canonical LUMA_2 quadrant patterns.
// The COMPAT_4 case additionally spans cells with thresholds at the boundary
// to exercise the >= comparison. (Task 4.3.)
export async function testWasmClassifiersMatchJs() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('WASM classifiers test: FAIL (load)', err?.message || err)
    return false
  }

  const width = 64
  const height = 64
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255

  const paint = (x0, y0, w, h, luma) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const j = (y * width + x) * 4
        pixels[j] = luma
        pixels[j + 1] = luma
        pixels[j + 2] = luma
      }
    }
  }

  // COMPAT_4 test cells: vary luma and threshold to exercise both branches.
  paint(4, 4, 4, 4, 220)    // bright cell
  paint(12, 4, 4, 4, 30)    // dark cell
  paint(20, 4, 4, 4, 128)   // on-boundary cell
  paint(28, 4, 4, 4, 127)   // just below boundary
  const compat4Cells = [
    [4, 4, 4, 128],
    [12, 4, 4, 128],
    [20, 4, 4, 128],
    [28, 4, 4, 128],
  ]

  // LUMA_2 test cells: canonical TL/TR/BL/BR patterns covering all 4 symbols.
  const paintQuad = (px, py, bs, tl, tr, bl, br) => {
    const h = bs / 2
    paint(px, py, h, h, tl)
    paint(px + h, py, h, h, tr)
    paint(px, py + h, h, h, bl)
    paint(px + h, py + h, h, h, br)
  }
  paintQuad(40, 4, 4, 240, 240, 10, 10)
  paintQuad(48, 4, 4, 10, 10, 240, 240)
  paintQuad(40, 14, 4, 240, 10, 240, 10)
  paintQuad(48, 14, 4, 10, 240, 10, 240)
  paintQuad(40, 24, 4, 120, 180, 200, 60) // mixed — exercises the contrast tie-breaker
  const luma2Cells = [
    [40, 4, 4, 0, 255],
    [48, 4, 4, 0, 255],
    [40, 14, 4, 0, 255],
    [48, 14, 4, 0, 255],
    [40, 24, 4, 0, 255],
  ]

  const jsCompat = jsClassifyCompat4Cells(pixels, width, height, compat4Cells)
  let wasmCompat
  try {
    wasmCompat = wasmClassifyCompat4Cells(pixels, width, height, compat4Cells)
  } catch (err) {
    console.log('WASM classifiers test: FAIL (compat4 call)', err?.message || err)
    return false
  }
  if (jsCompat.length !== wasmCompat.length || jsCompat.some((v, i) => v !== wasmCompat[i])) {
    console.log('WASM classifiers test: FAIL (compat4 mismatch)',
      { js: Array.from(jsCompat), wasm: Array.from(wasmCompat) })
    return false
  }

  const jsLuma = jsClassifyLuma2Cells(pixels, width, height, luma2Cells)
  let wasmLuma
  try {
    wasmLuma = wasmClassifyLuma2Cells(pixels, width, height, luma2Cells)
  } catch (err) {
    console.log('WASM classifiers test: FAIL (luma2 call)', err?.message || err)
    return false
  }
  if (jsLuma.length !== wasmLuma.length || jsLuma.some((v, i) => v !== wasmLuma[i])) {
    console.log('WASM classifiers test: FAIL (luma2 mismatch)',
      { js: Array.from(jsLuma), wasm: Array.from(wasmLuma) })
    return false
  }

  console.log('WASM classifiers test: PASS',
    { compat4: Array.from(wasmCompat), luma2: Array.from(wasmLuma) })
  return true
}

// Test: loads the module and asserts wasmScanBrightRuns matches jsScanBrightRuns
// on a synthetic pixel buffer containing a mix of runs (in-range, too-short,
// too-long, split across rows, end-of-row tail). Exercises both scan directions.
export async function testWasmScanBrightRunsMatchesJs() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('WASM scanBrightRuns test: FAIL (load)', err?.message || err)
    return false
  }

  const width = 200, height = 40
  const pixels = new Uint8ClampedArray(width * height * 4)
  const paint = (y, x0, x1) => {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4
      pixels[i] = 240; pixels[i + 1] = 240; pixels[i + 2] = 240; pixels[i + 3] = 255
    }
  }
  paint(3, 10, 31)    // in range (len 21)
  paint(5, 60, 66)    // too short (len 6)
  paint(8, 20, 81)    // too long (len 61)
  paint(12, 20, 41)   // in range (len 21)
  paint(12, 60, 76)   // in range (len 16) on same row
  paint(15, 190, 200) // tail run hitting xEnd (len 10, too short)
  paint(18, 50, 65)   // in range (len 15 == minRun)
  paint(25, 50, 100)  // in range (len 50 == maxRun)
  paint(30, 0, 50)    // starts at xStart=0 (len 50)

  const cases = [
    { xStart: 0, xEnd: width, yStart: 0, yEnd: height, yDir: 1 },
    { xStart: 0, xEnd: width, yStart: height - 1, yEnd: -1, yDir: -1 },
    { xStart: 50, xEnd: 100, yStart: 0, yEnd: height, yDir: 1 },
    { xStart: 0, xEnd: width, yStart: 10, yEnd: 20, yDir: 1 },
  ]
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]
    const js = jsScanBrightRuns(pixels, width, height, c.xStart, c.xEnd, c.yStart, c.yEnd, c.yDir, 15, 50, 200)
    let wasm
    try {
      wasm = wasmScanBrightRuns(pixels, width, height, c.xStart, c.xEnd, c.yStart, c.yEnd, c.yDir, 15, 50, 200)
    } catch (err) {
      console.log('WASM scanBrightRuns test: FAIL (call)', { i, err: err?.message || err })
      return false
    }
    if (js.length !== wasm.length) {
      console.log('WASM scanBrightRuns test: FAIL (count)', { i, js: js.length, wasm: wasm.length })
      return false
    }
    for (let k = 0; k < js.length; k++) {
      if (js[k].runX !== wasm[k].runX || js[k].runY !== wasm[k].runY || js[k].runLen !== wasm[k].runLen) {
        console.log('WASM scanBrightRuns test: FAIL (mismatch)', { i, k, js: js[k], wasm: wasm[k] })
        return false
      }
    }
  }
  console.log('WASM scanBrightRuns test: PASS')
  return true
}

// Test: end-to-end integration check that the frame-payload CRC path uses the
// WASM kernel and produces the same byte-for-byte result as JS. Exercises
// crc32WithFallback against jsCrc32 before and after loading so we catch
// regressions in either branch. (Task 4.4.)
export async function testFrameCrcWasmIntegration() {
  const fixtures = [
    new Uint8Array(0),
    new TextEncoder().encode('hdmi-uvc frame payload'),
    new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  ]
  const realistic = new Uint8Array(1024)
  let s = 0xDECAFBAD >>> 0
  for (let i = 0; i < realistic.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    realistic[i] = (s >>> 16) & 0xFF
  }
  fixtures.push(realistic)

  // Capture JS-only output before instantiation so we can diff later.
  const jsOutputs = fixtures.map(f => jsCrc32(f) >>> 0)

  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('Frame CRC WASM integration test: FAIL (load)', err?.message || err)
    return false
  }

  for (let i = 0; i < fixtures.length; i++) {
    const viaFallback = crc32WithFallback(fixtures[i]) >>> 0
    if (viaFallback !== jsOutputs[i]) {
      console.log('Frame CRC WASM integration test: FAIL (fallback mismatch)',
        { i, len: fixtures[i].length, js: jsOutputs[i], fallback: viaFallback })
      return false
    }
  }
  console.log('Frame CRC WASM integration test: PASS')
  return true
}

// Test: decodeDataRegion() returns the same payload + header + crcValid flag
// whether its per-cell classification runs through the WASM batch (Task 4.3
// integration) or the inline JS branches. Exercises both COMPAT_4 and LUMA_2
// through a synthetic buildFrame → detectAnchors → decodeDataRegion cycle.
export async function testWasmVsJsDecodeDataRegionEquivalent() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('WASM vs JS decodeDataRegion test: FAIL (load)', err?.message || err)
    return false
  }
  const { buildFrame, detectAnchors, dataRegionFromAnchors, decodeDataRegion } =
    await import('./hdmi-uvc-frame.js')
  const { HDMI_MODE } = await import('./hdmi-uvc-constants.js')

  // Build inner frames at a size where testAnchorDetectionWithOffset already
  // passes (400x300), embedded in a slightly larger outer canvas — the exact
  // layout that the HDMI-UVC receiver sees after locking a sub-region.
  const fixtures = [
    { mode: HDMI_MODE.COMPAT_4, innerW: 400, innerH: 300, outerW: 460, outerH: 350, offsetX: 22, offsetY: 20, symbolId: 7 },
    { mode: HDMI_MODE.LUMA_2,   innerW: 400, innerH: 300, outerW: 460, outerH: 350, offsetX: 22, offsetY: 20, symbolId: 9 },
  ]

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i]
    const payload = fillSynthPayload(80)
    const innerFrame = buildFrame(payload, f.mode, f.innerW, f.innerH, 30, f.symbolId)
    const outer = new Uint8ClampedArray(f.outerW * f.outerH * 4)
    for (let k = 3; k < outer.length; k += 4) outer[k] = 255
    for (let y = 0; y < f.innerH; y++) {
      for (let x = 0; x < f.innerW; x++) {
        const srcIdx = (y * f.innerW + x) * 4
        const dstIdx = ((y + f.offsetY) * f.outerW + (x + f.offsetX)) * 4
        outer[dstIdx] = innerFrame[srcIdx]
        outer[dstIdx + 1] = innerFrame[srcIdx + 1]
        outer[dstIdx + 2] = innerFrame[srcIdx + 2]
      }
    }

    __setForceJsFallbackForTesting(false)
    const wasmAnchors = detectAnchors(outer, f.outerW, f.outerH)
    const wasmRegion = wasmAnchors.length >= 2 ? dataRegionFromAnchors(wasmAnchors) : null
    if (!wasmRegion) {
      console.log('WASM vs JS decodeDataRegion test: FAIL (no wasm region)', { i })
      return false
    }
    const wasmResult = decodeDataRegion(outer, f.outerW, wasmRegion)

    __setForceJsFallbackForTesting(true)
    const jsAnchors = detectAnchors(outer, f.outerW, f.outerH)
    const jsRegion = jsAnchors.length >= 2 ? dataRegionFromAnchors(jsAnchors) : null
    if (!jsRegion) {
      console.log('WASM vs JS decodeDataRegion test: FAIL (no js region)', { i })
      __setForceJsFallbackForTesting(false)
      return false
    }
    const jsResult = decodeDataRegion(outer, f.outerW, jsRegion)
    __setForceJsFallbackForTesting(false)

    if (!wasmResult || !jsResult) {
      console.log('WASM vs JS decodeDataRegion test: FAIL (null result)',
        { i, wasm: !!wasmResult, js: !!jsResult })
      return false
    }
    if (wasmResult.crcValid !== jsResult.crcValid) {
      console.log('WASM vs JS decodeDataRegion test: FAIL (crcValid)',
        { i, wasm: wasmResult.crcValid, js: jsResult.crcValid })
      return false
    }
    if (wasmResult.header.symbolId !== jsResult.header.symbolId) {
      console.log('WASM vs JS decodeDataRegion test: FAIL (symbolId)',
        { i, wasm: wasmResult.header.symbolId, js: jsResult.header.symbolId })
      return false
    }
    if (wasmResult.payload.length !== jsResult.payload.length) {
      console.log('WASM vs JS decodeDataRegion test: FAIL (payload length)',
        { i, wasm: wasmResult.payload.length, js: jsResult.payload.length })
      return false
    }
    for (let k = 0; k < wasmResult.payload.length; k++) {
      if (wasmResult.payload[k] !== jsResult.payload[k]) {
        console.log('WASM vs JS decodeDataRegion test: FAIL (payload byte)',
          { fixture: i, k, wasm: wasmResult.payload[k], js: jsResult.payload[k] })
        return false
      }
    }
  }
  console.log('WASM vs JS decodeDataRegion test: PASS')
  return true
}

// Test: the locked LUMA_1 reader produces byte-identical payloads through the
// WASM kernel and the JS reference, with the peaking deconvolution both armed
// and disarmed — on a frame distorted with the live-measured horizontal
// sharpening, so the rail-pinned Thomas solve is actually exercised.
export async function testWasmVsJsLuma1ReadEquivalent() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('WASM vs JS Luma4 read test: FAIL (load)', err?.message || err)
    return false
  }
  const {
    buildFrame, detectAnchors, dataRegionFromAnchors, decodeDataRegion,
    precomputeDenseBinarySampleOffsets, readPayloadWithLayout, getPayloadCapacity,
    setLuma1SharpenCorrection, setLuma1SenderMidLevels, getLuma1SenderLevels
  } = await import('./hdmi-uvc-frame.js')
  const { HDMI_MODE } = await import('./hdmi-uvc-constants.js')

  const priorLevels = getLuma1SenderLevels()
  try {
    const width = 640
    const height = 407
    const lambda = 0.45
    setLuma1SenderMidLevels(85, 170) // rail-pinning-safe regime (see sharpen roundtrip test)
    const cap = getPayloadCapacity(width, height, HDMI_MODE.LUMA_1)
    const payload = new Uint8Array(cap)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 73 + 41) & 0xff
    const frame = buildFrame(payload, HDMI_MODE.LUMA_1, width, height, 30, 83)
    const sharpened = new Uint8ClampedArray(frame)
    for (let y = 0; y < height; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = (y * width + x) * 4
        sharpened[i] = sharpened[i + 1] = sharpened[i + 2] =
          Math.round(frame[i] + lambda * (frame[i] - (frame[i - 4] + frame[i + 4]) / 2))
      }
    }
    const anchors = detectAnchors(sharpened, width, height)
    const region = dataRegionFromAnchors(anchors)
    setLuma1SharpenCorrection(lambda)
    const blind = region ? decodeDataRegion(sharpened, width, region) : null
    if (!blind?.crcValid) {
      console.log('WASM vs JS Luma4 read test: FAIL (initial decode)', { crc: blind?.crcValid })
      return false
    }
    const precomputed = precomputeDenseBinarySampleOffsets(blind._diag, region)
    const layout = { ...blind._diag, precomputedOffsets: precomputed.offsets, precomputedRegion: precomputed.region }

    const cases = [
      { label: 'armed', lambda, source: sharpened },
      { label: 'off', lambda: null, source: frame }
    ]
    for (const c of cases) {
      setLuma1SharpenCorrection(c.lambda)
      __setForceJsFallbackForTesting(false)
      const wasmStats = {}
      const viaWasm = readPayloadWithLayout(c.source, width, region, layout, payload.length, precomputed.offsets, { stats: wasmStats })
      __setForceJsFallbackForTesting(true)
      const jsStats = {}
      const viaJs = readPayloadWithLayout(c.source, width, region, layout, payload.length, precomputed.offsets, { stats: jsStats })
      __setForceJsFallbackForTesting(false)
      if (wasmStats.reader !== 'luma1-wasm' || jsStats.reader !== 'luma1-bytepack') {
        console.log('WASM vs JS Luma4 read test: FAIL (reader dispatch)', { case: c.label, wasm: wasmStats.reader, js: jsStats.reader })
        return false
      }
      if (!viaWasm || !viaJs || viaWasm.length !== viaJs.length) {
        console.log('WASM vs JS Luma4 read test: FAIL (length)', { case: c.label, wasm: viaWasm?.length, js: viaJs?.length })
        return false
      }
      for (let k = 0; k < viaWasm.length; k++) {
        if (viaWasm[k] !== viaJs[k]) {
          console.log('WASM vs JS Luma4 read test: FAIL (payload byte)', { case: c.label, k, wasm: viaWasm[k], js: viaJs[k] })
          return false
        }
      }
      const exact = viaWasm.every((v, k) => v === payload[k])
      if (!exact) {
        console.log('WASM vs JS Luma4 read test: FAIL (not exact vs sender payload)', { case: c.label })
        return false
      }
    }

    // Zero-copy: the frame living IN wasm memory (as the capture path writes
    // it) must read identically to the staged-copy path.
    setLuma1SharpenCorrection(lambda)
    const frameView = acquireWasmFrameView(sharpened.length)
    frameView.set(sharpened)
    const zcStats = {}
    const viaZeroCopy = readPayloadWithLayout(frameView, width, region, layout, payload.length, precomputed.offsets, { stats: zcStats })
    if (zcStats.reader !== 'luma1-wasm' || !viaZeroCopy || !viaZeroCopy.every((v, k) => v === payload[k])) {
      console.log('WASM vs JS Luma4 read test: FAIL (zero-copy)', { reader: zcStats.reader, ok: !!viaZeroCopy })
      return false
    }

    console.log('WASM vs JS Luma4 read test: PASS')
    return true
  } catch (err) {
    console.log('WASM vs JS Luma4 read test: FAIL', err?.message || err)
    return false
  } finally {
    setLuma1SharpenCorrection(null)
    setLuma1SenderMidLevels(priorLevels[1], priorLevels[2])
    __setForceJsFallbackForTesting(false)
  }
}

// Test: detectAnchors() output is bit-identical whether the bright-run scan
// inside findCornerAnchor goes through the WASM kernel or the JS reference.
// Proves Phase 4 Task 4.2's end-to-end correctness: the outer anchor geometry
// is unchanged and WASM doesn't introduce rounding or ordering drift.
export async function testWasmVsJsDetectAnchorsEquivalent() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('WASM vs JS detectAnchors test: FAIL (load)', err?.message || err)
    return false
  }
  const { buildFrame, detectAnchors } = await import('./hdmi-uvc-frame.js')
  const { HDMI_MODE } = await import('./hdmi-uvc-constants.js')

  // Build a couple of realistic frames so we exercise more than one anchor
  // layout. Sizes chosen to roughly mimic the detectAnchors corner bands
  // (margin=300) while staying small enough to keep the test quick.
  const fixtures = [
    { width: 640, height: 480, payload: fillSynthPayload(300), symbolId: 1 },
    { width: 800, height: 600, payload: fillSynthPayload(500), symbolId: 2 },
  ]

  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i]
    const frame = buildFrame(f.payload, HDMI_MODE.COMPAT_4, f.width, f.height, 30, f.symbolId)
    __setForceJsFallbackForTesting(false)
    const wasmAnchors = detectAnchors(frame, f.width, f.height)
    __setForceJsFallbackForTesting(true)
    const jsAnchors = detectAnchors(frame, f.width, f.height)
    __setForceJsFallbackForTesting(false)

    if (!anchorsEqual(wasmAnchors, jsAnchors)) {
      console.log('WASM vs JS detectAnchors test: FAIL (mismatch)',
        { fixture: i, wasm: wasmAnchors, js: jsAnchors })
      return false
    }
    // A passing run would not produce empty anchor sets for a well-formed
    // synthetic frame — guard against both returning [] silently.
    if (wasmAnchors.length < 2) {
      console.log('WASM vs JS detectAnchors test: FAIL (too few anchors)',
        { fixture: i, found: wasmAnchors.length })
      return false
    }
  }
  console.log('WASM vs JS detectAnchors test: PASS')
  return true
}

function fillSynthPayload(n) {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 13 + 7) & 0xFF
  return out
}

function anchorsEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].corner !== b[i].corner) return false
    // blockSize is a f32-adjacent refine step; compare with a small tolerance.
    if (Math.abs((a[i].blockSize || 0) - (b[i].blockSize || 0)) > 1e-6) return false
    if (!!a[i].estimated !== !!b[i].estimated) return false
  }
  return true
}

// Test: loads the module and asserts the WASM crc32 matches the JS crc32 for
// a small set of fixed inputs and a 4 KiB pseudo-random buffer. This is the
// WASM analogue of testCrc32 in src/lib/hdmi-uvc/crc32.js.
export async function testWasmCrc32MatchesJs() {
  try {
    await loadHdmiUvcWasm()
  } catch (err) {
    console.log('WASM CRC32 test: FAIL (load)', err?.message || err)
    return false
  }

  const fixtures = [
    new Uint8Array(0),
    new TextEncoder().encode('123456789'),
    new TextEncoder().encode(''),
    new Uint8Array([0]),
    new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]),
    new TextEncoder().encode('The quick brown fox jumps over the lazy dog'),
  ]
  // Deterministic pseudo-random buffer (4 KiB). We don't want a crypto PRNG
  // here — the point is a fixed input for a fixed expected output.
  const big = new Uint8Array(4096)
  let s = 0x12345678 >>> 0
  for (let i = 0; i < big.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0
    big[i] = s & 0xFF
  }
  fixtures.push(big)

  for (let i = 0; i < fixtures.length; i++) {
    const input = fixtures[i]
    const jsOut = jsCrc32(input) >>> 0
    let wasmOut
    try {
      wasmOut = wasmCrc32(input) >>> 0
    } catch (err) {
      console.log('WASM CRC32 test: FAIL (call)', { i, len: input.length, err: err?.message || err })
      return false
    }
    if (jsOut !== wasmOut) {
      console.log('WASM CRC32 test: FAIL (mismatch)', { i, len: input.length, jsOut, wasmOut })
      return false
    }
  }
  console.log('WASM CRC32 test: PASS')
  return true
}
