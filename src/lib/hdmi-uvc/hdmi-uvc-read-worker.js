// HDMI-UVC parallel read worker — one member of a small pool.
//
// Owns exactly one hot job: run the locked-layout payload read (the ~20ms
// Luma4 kernel pass that otherwise starves the main-thread capture loop) on
// one captured frame, probe its packet slots, and ship the results back.
// Capture stays on the main thread; decoder ingest stays on the main thread
// (it is cheap there). Frames are independent until ingest, so N of these
// workers decode N frames concurrently.
//
// Protocol (in):
//   { type: 'configureWasm', url }
//   { type: 'config', cfg: { configVersion, layout, region, payloadLength,
//       expectedPacketSize, sharpenLambda } }
//     layout arrives WITHOUT precomputed offsets (they are ~15MB at 1080p);
//     the worker precomputes its own copy once per config.
//   { type: 'read', seq, configVersion, buffer, width, height }
//     buffer is a transferred ArrayBuffer holding the RGBA ROI frame.
//
// Protocol (out):
//   { type: 'ready' }
//   { type: 'result', seq, configVersion, ok, readMs, slotCount, salvaged,
//     records, payloadBuffer, frameBuffer }
//     records: Uint32Array of 6 u32 per valid slot
//       [slotIndex, fileId, k, symbolId, versionAndFlags, payloadCrc]
//     payloadBuffer: the decoded frame payload (transferred; null on failure)
//     frameBuffer: the input buffer, transferred back for pool reuse.

import {
  readPayloadWithLayout,
  precomputeDenseBinarySampleOffsets,
  setLuma1SharpenCorrection,
  setLuma1DebugCapture
} from './hdmi-uvc-frame.js'
import { probeFramePackets } from './hdmi-uvc-packet-probe.js'
import {
  setHdmiUvcWasmUrl,
  loadHdmiUvcWasm,
  acquireWasmFrameView
} from './hdmi-uvc-wasm.js'

let cfg = null
let layout = null
let offsets = null

// The worker never runs blind sweeps, but keep the failed-sweep evidence
// builder off defensively — it costs ~100ms when it fires.
setLuma1DebugCapture(false)

function applyConfig(next) {
  cfg = next
  setLuma1SharpenCorrection(
    Number.isFinite(next.sharpenLambda) && next.sharpenLambda > 0 ? next.sharpenLambda : null
  )
  layout = { ...next.layout }
  const precomputed = precomputeDenseBinarySampleOffsets(layout, next.region)
  offsets = precomputed.offsets
  layout.precomputedOffsets = precomputed.offsets
  layout.precomputedRegion = precomputed.region
}

function handleRead(msg) {
  const t0 = performance.now()
  const frameBuffer = msg.buffer
  let payload = null
  let records = new Uint32Array(0)
  let slotCount = 0
  let salvaged = 0

  if (cfg && layout && msg.configVersion === cfg.configVersion) {
    const frameBytes = new Uint8ClampedArray(frameBuffer)
    // Copy into the worker's pinned WASM region so the kernel reads in place.
    const view = acquireWasmFrameView(frameBytes.length)
    let pixels = frameBytes
    if (view) {
      view.set(frameBytes)
      pixels = view
    }
    try {
      payload = readPayloadWithLayout(
        pixels,
        msg.width,
        cfg.region,
        layout,
        cfg.payloadLength,
        offsets,
        {}
      )
    } catch (_) {
      payload = null
    }
    if (payload) {
      const probe = probeFramePackets(payload, cfg.expectedPacketSize)
      slotCount = probe.slotCount || 0
      salvaged = probe.salvaged || 0
      const parsed = probe.parsedPackets || []
      records = new Uint32Array(parsed.length * 6)
      for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        const packetOffset = probe.packets[i].byteOffset - payload.byteOffset
        records[i * 6] = packetOffset / cfg.expectedPacketSize
        records[i * 6 + 1] = p.fileId >>> 0
        records[i * 6 + 2] = p.k >>> 0
        records[i * 6 + 3] = p.symbolId >>> 0
        records[i * 6 + 4] = ((p.isMetadata ? 1 : 0) | ((p.mode & 0x03) << 1)) >>> 0
        records[i * 6 + 5] = p.payloadCrc >>> 0
      }
    }
  }

  const readMs = performance.now() - t0
  const transfers = [frameBuffer, records.buffer]
  const payloadBuffer = payload ? payload.buffer : null
  if (payloadBuffer) transfers.push(payloadBuffer)
  self.postMessage({
    type: 'result',
    seq: msg.seq,
    configVersion: msg.configVersion,
    ok: !!payload && records.length > 0,
    readMs,
    slotCount,
    salvaged,
    records,
    payloadBuffer,
    frameBuffer
  }, transfers)
}

self.onmessage = (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  switch (msg.type) {
    case 'configureWasm':
      setHdmiUvcWasmUrl(msg.url)
      loadHdmiUvcWasm().catch(() => { /* JS fallback path still works */ })
      break
    case 'config':
      try {
        applyConfig(msg.cfg)
        self.postMessage({ type: 'configured', configVersion: msg.cfg.configVersion })
      } catch (err) {
        self.postMessage({ type: 'error', message: 'config failed: ' + (err?.message || err) })
      }
      break
    case 'read':
      try {
        handleRead(msg)
      } catch (err) {
        // Hand the buffer back even on unexpected failure so the pool
        // doesn't leak its capture buffers.
        self.postMessage({
          type: 'result',
          seq: msg.seq,
          configVersion: msg.configVersion,
          ok: false,
          readMs: 0,
          slotCount: 0,
          salvaged: 0,
          records: new Uint32Array(0),
          payloadBuffer: null,
          frameBuffer: msg.buffer,
          error: err?.message || String(err)
        }, [msg.buffer])
      }
      break
    default:
      break
  }
}

self.postMessage({ type: 'ready' })
