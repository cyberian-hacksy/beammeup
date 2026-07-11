// HDMI-UVC sender frame scheduler: batching profiles, metadata cadence,
// systematic/parity/fountain slot mixes, mixed-replay pass advancement, and
// per-frame packet-batch construction (including the ARQ repair/beacon
// paths). Operates on the shared sender state singleton; the sender itself
// keeps rendering, presentation, and UI. Scheduler tests and their state
// snapshot/setup helpers live here with the code they exercise.

import { PACKET_HEADER_SIZE } from '../packet.js'
import {
  HDMI_MODE,
  HDMI_MODE_NAMES,
  isDenseBinaryMode,
  usesBinary1DenseDefaults
} from './hdmi-uvc-constants.js'
import { getPayloadCapacity } from './hdmi-uvc-frame.js'
import {
  getDenseBinaryDegree,
  getDenseBinaryLateMix,
  getDenseBinaryPass2SweepMix,
  getDenseBinaryPass3Mix,
  getDenseBinaryProfile,
  getDiagnosticDefinition,
  getPass2Variant,
  setDiagnostic
} from './hdmi-uvc-diagnostics.js'
import { debugLog } from './hdmi-uvc-sender-debug.js'
import { state } from './hdmi-uvc-sender-state.js'

// tickArqFallback reports status into the sender's ARQ UI row. The sender
// registers its updater at load time; a direct import would be circular.
let notifyArqSenderStatus = () => {}
export function setArqSenderStatusNotifier(fn) {
  notifyArqSenderStatus = typeof fn === 'function' ? fn : () => {}
}

// Sender experiments are now locked to the best live baseline. Keep the
// helper plumbing for tests and stale URL/localStorage cleanup, but do not
// expose runtime variants in the UI.
const BINARY1_SYNC_PORCH_FRAMES = 0
const BINARY1_PASS2_SOURCE_WARMUP_FRAMES = 0

// Once the HDMI-UVC decode path is stable, repeating every symbol wastes most
// of the available bandwidth. Let fountain redundancy absorb frame loss.
const FRAMES_PER_SYMBOL = 1
const METADATA_BURST_FRAMES = 4
const BOOTSTRAP_METADATA_INTERVAL_FRAMES = 12
const BOOTSTRAP_METADATA_WINDOW_FRAMES = 180
const MIN_METADATA_INTERVAL_FRAMES = 90
const MAX_METADATA_INTERVAL_FRAMES = 90
const MIN_BLOCK_SIZE = 512
const MAX_BLOCK_SIZE = 16384
const BINARY1_HUGE_MAX_BLOCK_SIZE = 32768
const MAX_FRAME_PACKET_SLOTS = 32
const MAX_BINARY1_FRAME_PACKET_SLOTS = 64
const TARGET_SOURCE_BLOCKS = 128
const HYBRID_FOUNTAIN_PACKET_INTERVAL = 8
const RAW_RGB_PASS2_FOUNTAIN_PACKET_INTERVAL = 2
const RAW_RGB_PASS3_FOUNTAIN_PACKET_INTERVAL = 1
const COMPAT4_PASS2_FOUNTAIN_PACKET_INTERVAL = 8
const COMPAT4_PASS3_FOUNTAIN_PACKET_INTERVAL = 4
const COMPAT4_PASS4_FOUNTAIN_PACKET_INTERVAL = 2
const COMPAT4_PASS5_FOUNTAIN_PACKET_INTERVAL = 1
const COMPAT4_PASS6_FOUNTAIN_PACKET_INTERVAL = 1
const COMPAT4_PASS7_FOUNTAIN_PACKET_INTERVAL = 1
const TAIL_SYSTEMATIC_BURST_PERIOD_FRAMES = 6
const TAIL_SYSTEMATIC_BURST_FRAMES = 1

export function computeMetadataIntervalFrames() {
  if (!state.encoder || !state.packetsPerFrame) return MIN_METADATA_INTERVAL_FRAMES
  const cycleFrames = Math.ceil(state.encoder.K_prime / state.packetsPerFrame)
  if (state.mode === HDMI_MODE.RAW_RGB) {
    const targetInterval = Math.ceil(cycleFrames / 3)
    return Math.max(45, Math.min(120, targetInterval))
  }
  const targetInterval = Math.ceil(cycleFrames / 2)
  return Math.max(
    MIN_METADATA_INTERVAL_FRAMES,
    Math.min(MAX_METADATA_INTERVAL_FRAMES, targetInterval)
  )
}

function gcd(a, b) {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const t = x % y
    x = y
    y = t
  }
  return x || 1
}

export function chooseSystematicStride(span) {
  if (span <= 2) return 1

  // Use a large coprime stride so any contiguous receive window sees symbols
  // spread across the whole systematic space instead of waiting for wrap.
  let stride = Math.max(2, Math.floor(span * 0.61803398875))
  if (stride >= span) stride = span - 1

  while (stride > 1 && gcd(stride, span) !== 1) {
    stride--
  }

  return Math.max(1, stride)
}

const DENSE_BINARY_BATCHING_PROFILES = {
  safe: {
    targetFrameFill: 0.90,
    maxBlockSize: 1024
  },
  fill99: {
    targetFrameFill: 0.99,
    maxBlockSize: 1024
  },
  medium: {
    targetFrameFill: 0.99,
    maxBlockSize: 1536
  },
  large: {
    targetFrameFill: 0.99,
    maxBlockSize: 2048
  },
  // Fewer, larger blocks → smaller K → shorter fountain endgame (the
  // coupon-collector cost scales with the source-block count). Decoder
  // auto-adapts: block size is self-describing in each packet's payload.
  // The batcher still maximizes frame payload, so a high maxBlockSize lets it
  // settle on the payload-optimal *large* block (~3.9KB → K≈2664 for 10MB,
  // roughly half of large's K) rather than the ~2KB/29-packet point.
  xlarge: {
    targetFrameFill: 0.99,
    maxBlockSize: 4096
  },
  // Aggressive K-reduction ladder. The batcher picks the payload-optimal block
  // up to maxBlockSize, so these settle on ~8 and ~4 packets/frame respectively
  // (minPacketsPerFrame=4 is the floor). For a 10MB file: xxlarge → K≈1419,
  // huge → K≈709. Smaller K shrinks the parity-recovery tail; the tradeoff is
  // coarser granularity (a dropped frame loses a larger block).
  xxlarge: {
    targetFrameFill: 0.99,
    maxBlockSize: 8192
  },
  huge: {
    targetFrameFill: 0.99,
    maxBlockSize: 16384
  }
}

function getDenseBinaryMaxPacketSlots(mode) {
  return usesBinary1DenseDefaults(mode) ? MAX_BINARY1_FRAME_PACKET_SLOTS : MAX_FRAME_PACKET_SLOTS
}

function getDenseBinaryBatchingProfile(profileId = null, mode = null, options = {}) {
  const defaultId = getDiagnosticDefinition('denseBinaryProfile')?.default || 'large'
  const requestedId = profileId ?? getDenseBinaryProfile()
  const diagnosticId = Object.prototype.hasOwnProperty.call(DENSE_BINARY_BATCHING_PROFILES, requestedId)
    ? requestedId
    : defaultId
  const selectedId = options.useModeDefault === false
    ? diagnosticId
    : (usesBinary1DenseDefaults(mode) && diagnosticId === defaultId ? 'huge' : diagnosticId)
  const selected = DENSE_BINARY_BATCHING_PROFILES[selectedId]
  const maxBlockSize = usesBinary1DenseDefaults(mode) && selectedId === 'huge'
    ? BINARY1_HUGE_MAX_BLOCK_SIZE
    : selected.maxBlockSize
  return {
    id: selectedId,
    minPacketsPerFrame: 4,
    fixedPacketsPerFrame: null,
    maxPacketsPerFrame: getDenseBinaryMaxPacketSlots(mode),
    targetFrameFill: selected.targetFrameFill,
    maxBlockSize,
    absoluteMaxBlockSize: Math.max(MAX_BLOCK_SIZE, maxBlockSize),
    maxUsedBytes: null
  }
}

export function selectFrameBatching({ capacity, fileSize, profile }) {
  const {
    minPacketsPerFrame,
    fixedPacketsPerFrame,
    maxPacketsPerFrame,
    targetFrameFill,
    maxBlockSize: profileMaxBlockSize,
    absoluteMaxBlockSize: profileAbsoluteMaxBlockSize,
    maxUsedBytes
  } = profile

  const frameBlockSize = Math.max(200, capacity - PACKET_HEADER_SIZE)
  const preferredBlockSize = Math.ceil(fileSize / TARGET_SOURCE_BLOCKS)
  const maxBlockSize = Math.min(
    frameBlockSize,
    profileMaxBlockSize ?? MAX_BLOCK_SIZE,
    profileAbsoluteMaxBlockSize ?? MAX_BLOCK_SIZE
  )
  const minBlockSize = Math.min(MIN_BLOCK_SIZE, maxBlockSize)
  let blockSize = Math.min(maxBlockSize, Math.max(preferredBlockSize, minBlockSize))
  let bestBlockSize = blockSize
  let bestPacketsPerFrame = 1
  let bestUsedBytes = blockSize + PACKET_HEADER_SIZE
  let bestPayloadPerFrame = blockSize
  let foundTargetFit = false

  for (let candidate = minBlockSize; candidate <= maxBlockSize; candidate += 4) {
    const maxPacketsThatFit = Math.min(
      maxPacketsPerFrame,
      Math.floor(capacity / (candidate + PACKET_HEADER_SIZE))
    )
    if (maxPacketsThatFit < 1) continue

    if (!fixedPacketsPerFrame && minPacketsPerFrame && maxPacketsThatFit < minPacketsPerFrame) {
      continue
    }

    const minPackets = fixedPacketsPerFrame
      ? Math.min(fixedPacketsPerFrame, maxPacketsThatFit)
      : (minPacketsPerFrame ?? 1)
    const maxPackets = fixedPacketsPerFrame
      ? Math.min(fixedPacketsPerFrame, maxPacketsThatFit)
      : maxPacketsThatFit

    for (let packetsPerFrame = minPackets; packetsPerFrame <= maxPackets; packetsPerFrame++) {
      const usedBytes = packetsPerFrame * (candidate + PACKET_HEADER_SIZE)
      if (maxUsedBytes && usedBytes > maxUsedBytes) continue

      const fitsTarget = usedBytes / capacity <= targetFrameFill
      if (foundTargetFit && !fitsTarget) continue

      const payloadPerFrame = packetsPerFrame * candidate
      const shouldSelect =
        (!foundTargetFit && fitsTarget) ||
        (fitsTarget === foundTargetFit && (
          payloadPerFrame > bestPayloadPerFrame ||
          (payloadPerFrame === bestPayloadPerFrame && packetsPerFrame < bestPacketsPerFrame) ||
          (payloadPerFrame === bestPayloadPerFrame && packetsPerFrame === bestPacketsPerFrame && candidate > bestBlockSize)
        ))

      if (shouldSelect) {
        bestBlockSize = candidate
        bestPacketsPerFrame = packetsPerFrame
        bestUsedBytes = usedBytes
        bestPayloadPerFrame = payloadPerFrame
        foundTargetFit = fitsTarget
      }
    }
  }

  return {
    blockSize: bestBlockSize,
    packetsPerFrame: bestPacketsPerFrame,
    usedBytes: bestUsedBytes,
    payloadPerFrame: bestPayloadPerFrame,
    frameBlockSize,
    maxBlockSize,
    minBlockSize,
    targetFrameFill,
    maxPacketsPerFrame,
    maxUsedBytes
  }
}

export function getBatchingProfile(mode) {
  switch (mode) {
    case HDMI_MODE.RAW_RGB:
      // Four calibrated colors per 4x4 block. The current HDMI-UVC path is
      // packet-loss limited, so bias toward a lighter per-frame load rather
      // than maxing out nominal frame capacity. Keep shard size moderate, but
      // trim total slots and fill so more packets survive end-to-end.
      return {
        maxPacketsPerFrame: 10,
        targetFrameFill: 0.36,
        maxBlockSize: 896,
        maxUsedBytes: 10240
      }
    case HDMI_MODE.RAW_GRAY:
      // Gray2 is denser but materially less tolerant of capture noise than
      // binary 4x4. Keep total bytes/frame conservative and shard them across
      // many packets so packet-level salvage still has useful granularity.
      return {
        maxPacketsPerFrame: 12,
        targetFrameFill: 0.40,
        maxBlockSize: 768,
        maxUsedBytes: 8192
      }
    case HDMI_MODE.LUMA_2:
      // Luma2 keeps the 4x4 grid but replaces fragile mid-tones/chroma with a
      // balanced black/white quadrant alphabet. Start just above the proven
      // binary 4x4 byte budget so live results isolate symbol robustness.
      return {
        maxPacketsPerFrame: 10,
        targetFrameFill: 0.32,
        maxBlockSize: 896,
        maxUsedBytes: 8192
      }
    case HDMI_MODE.COMPAT_4:
      // 4x4 mode is the most robust live path. Permuted systematic order helps
      // late-stage completion, but the best sustained throughput still comes
      // from the 6-7 packet large-shard family rather than 4-5 packets.
      return {
        minPacketsPerFrame: 6,
        maxPacketsPerFrame: 7,
        targetFrameFill: 0.99,
        maxBlockSize: MAX_BLOCK_SIZE,
        maxUsedBytes: null
      }
    case HDMI_MODE.BINARY_3:
      return getDenseBinaryBatchingProfile(undefined, mode)
    case HDMI_MODE.BINARY_2:
      return getDenseBinaryBatchingProfile(undefined, mode)
    case HDMI_MODE.BINARY_1:
    case HDMI_MODE.LUMA_1:
      return getDenseBinaryBatchingProfile(undefined, mode)
    case HDMI_MODE.CODEBOOK_3:
      // Binary quadrant glyphs keep the payload alphabet black/white while
      // increasing density over plain 4x4. Use many small shards and keep the
      // total bytes/frame only slightly above the proven 4x4 baseline so this
      // mode tests symbol robustness separately from batching pressure.
      return {
        maxPacketsPerFrame: 12,
        targetFrameFill: 0.25,
        maxBlockSize: 768,
        maxUsedBytes: 8400
      }
    case HDMI_MODE.GLYPH_5:
      // Larger 8x8 glyph tiles with nearest-match decoding. Start near the
      // proven 4x4 byte budget so the first live run isolates symbol quality
      // instead of immediately hitting the batching cliff.
      return {
        maxPacketsPerFrame: 10,
        targetFrameFill: 0.28,
        maxBlockSize: 768,
        maxUsedBytes: 8192
      }
    default:
      return { maxPacketsPerFrame: 4, targetFrameFill: 0.90, maxBlockSize: MAX_BLOCK_SIZE, maxUsedBytes: null }
  }
}

export function usesMixedSlotReplay(mode = state.mode) {
  return (
    mode === HDMI_MODE.COMPAT_4 ||
    mode === HDMI_MODE.LUMA_2 ||
    mode === HDMI_MODE.CODEBOOK_3 ||
    isDenseBinaryMode(mode)
  )
}

function shouldSendMetadata(frameNumber) {
  if (frameNumber <= METADATA_BURST_FRAMES) return true
  if (
    frameNumber <= BOOTSTRAP_METADATA_WINDOW_FRAMES &&
    (frameNumber % BOOTSTRAP_METADATA_INTERVAL_FRAMES) === 0
  ) {
    return true
  }
  return frameNumber % state.metadataIntervalFrames === 0
}

export function getSyncPorchFrameCount(mode = state.mode) {
  return usesBinary1DenseDefaults(mode) ? BINARY1_SYNC_PORCH_FRAMES : 0
}

function isSyncPorchFrame(frameNumber, mode = state.mode) {
  return frameNumber > 0 && frameNumber <= getSyncPorchFrameCount(mode)
}

function getMetadataSlotIndex(frameNumber, slots) {
  if (slots <= 1) return 0
  if (isDenseBinaryMode(state.mode)) {
    return (Math.max(1, frameNumber) - 1) % slots
  }
  return 0
}

export function getMetadataScheduleDescription() {
  const slotNote = isDenseBinaryMode(state.mode)
    ? `, rotating slot across ${state.packetsPerFrame} packet(s)`
    : ''
  return (
    `Metadata schedule: burst=${METADATA_BURST_FRAMES} frame(s), ` +
    `bootstrap=${BOOTSTRAP_METADATA_INTERVAL_FRAMES} frame(s) through frame ${BOOTSTRAP_METADATA_WINDOW_FRAMES}, ` +
    `interval=${state.metadataIntervalFrames} frame(s)${slotNote}`
  )
}

function getFountainPacketInterval() {
  if (state.mode === HDMI_MODE.RAW_RGB) {
    if (state.systematicPass >= 3) return RAW_RGB_PASS3_FOUNTAIN_PACKET_INTERVAL
    if (state.systematicPass >= 2) return RAW_RGB_PASS2_FOUNTAIN_PACKET_INTERVAL
    return HYBRID_FOUNTAIN_PACKET_INTERVAL
  }
  if (
    state.mode !== HDMI_MODE.COMPAT_4 &&
    state.mode !== HDMI_MODE.LUMA_2 &&
    state.mode !== HDMI_MODE.CODEBOOK_3
  ) {
    return HYBRID_FOUNTAIN_PACKET_INTERVAL
  }
  if (state.systematicPass >= 7) return COMPAT4_PASS7_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 6) return COMPAT4_PASS6_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 5) return COMPAT4_PASS5_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 4) return COMPAT4_PASS4_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 3) return COMPAT4_PASS3_FOUNTAIN_PACKET_INTERVAL
  if (state.systematicPass >= 2) return COMPAT4_PASS2_FOUNTAIN_PACKET_INTERVAL
  return HYBRID_FOUNTAIN_PACKET_INTERVAL
}

export function getHybridScheduleDescription() {
  if (state.mode === HDMI_MODE.RAW_RGB) {
    return (
      'Hybrid schedule: source-only pass 1, then fountain every ' +
      `${RAW_RGB_PASS2_FOUNTAIN_PACKET_INTERVAL}/${RAW_RGB_PASS3_FOUNTAIN_PACKET_INTERVAL} ` +
      `data packets in later Color4 replay passes (default=${HYBRID_FOUNTAIN_PACKET_INTERVAL})`
    )
  }

  if (usesMixedSlotReplay()) {
    if (isDenseBinaryMode(state.mode)) {
      const slots = Math.max(1, state.packetsPerFrame || 1)
      const pass2First = describeSlotMixPattern(getSlotMixPatternForPass(2, {
        slots,
        paritySweepsInPass: 0
      }))
      const pass2Later = describeSlotMixPattern(getSlotMixPatternForPass(2, {
        slots,
        paritySweepsInPass: 1
      }))
      const pass3 = describeSlotMixPattern(getSlotMixPatternForPass(3, { slots }))
      const pass4 = describeSlotMixPattern(getSlotMixPatternForPass(4, { slots }))
      const modeName = HDMI_MODE_NAMES[state.mode] || 'Dense binary'
      return (
        `Hybrid schedule: source-only pass 1, then mixed ${modeName} slot replay ` +
        `(${slots} data slot(s) without metadata; pass2=${pass2First}->${pass2Later}, ` +
        `pass3=${pass3}, pass4+=${pass4})`
      )
    }

    const modeName =
      state.mode === HDMI_MODE.LUMA_2
        ? 'Luma2'
        : state.mode === HDMI_MODE.CODEBOOK_3
          ? 'Tile3'
          : '4x4'
    const passDescs = []
    for (let p = 2; p <= 5; p++) {
      const pattern = getSlotMixPatternForPass(p)
      passDescs.push(describeSlotMixPattern(pattern))
    }
    return (
      `Hybrid schedule: source-only pass 1, then mixed ${modeName} slot replay ` +
      `(pass2=${getPass2Variant()}; ${passDescs.join(', ')})`
    )
  }

  return `Hybrid schedule: source-only pass 1, then fountain every ${HYBRID_FOUNTAIN_PACKET_INTERVAL} data packets`
}

export function nextFrameSymbolId(workList, cursor) {
  if (!Array.isArray(workList) || cursor >= workList.length) {
    return { symbolId: null, cursor: Math.max(0, cursor || 0), exhausted: true }
  }
  return {
    symbolId: workList[cursor],
    cursor: cursor + 1,
    exhausted: cursor + 1 >= workList.length
  }
}

function describeFountainInterval(interval) {
  return interval > 0
    ? `fountain every ${interval} data packet(s)`
    : 'source-only'
}

function buildSlotMix(slots, counts) {
  const slotCount = Math.max(0, Math.floor(slots || 0))
  const pattern = []
  for (let i = 0; i < (counts.source || 0); i++) pattern.push('source')
  for (let i = 0; i < (counts.parity || 0); i++) pattern.push('parity')
  for (let i = 0; i < (counts.fountain || 0); i++) pattern.push('fountain')
  while (pattern.length < slotCount) pattern.push('source')
  return pattern.slice(0, slotCount)
}

function slotCountsFromRatios(slots, ratios) {
  const slotCount = Math.max(0, Math.floor(slots || 0))
  const keys = ['source', 'parity', 'fountain']
  const entries = keys.map((key, order) => {
    const raw = slotCount * (ratios[key] || 0)
    const count = Math.floor(raw)
    return { key, order, count, remainder: raw - count }
  })

  let used = entries.reduce((sum, entry) => sum + entry.count, 0)
  let remaining = slotCount - used
  const byLargestRemainder = [...entries].sort((a, b) =>
    (b.remainder - a.remainder) || (a.order - b.order)
  )
  for (let i = 0; remaining > 0; i++, remaining--) {
    byLargestRemainder[i % byLargestRemainder.length].count++
  }

  used = entries.reduce((sum, entry) => sum + entry.count, 0)
  const bySmallestRemainder = [...entries].sort((a, b) =>
    (a.remainder - b.remainder) || (b.order - a.order)
  )
  for (let i = 0; used > slotCount; i++, used--) {
    const entry = bySmallestRemainder[i % bySmallestRemainder.length]
    if (entry.count > 0) entry.count--
  }

  return Object.fromEntries(entries.map(entry => [entry.key, entry.count]))
}

// Slot-mix ratio tables, keyed by the corresponding diagnostics knob value.
// Unknown values fall back to the `default` row.

const DENSE_BINARY_LATE_MIX_RATIOS = {
  // Tail recovery on a clean link is duplicate-bound: re-sent source/parity
  // blocks the receiver already holds waste bandwidth. Ship mostly fresh
  // fountain symbols, keeping a thin source trickle for any clustered misses.
  fountain: { source: 0.10, parity: 0.0, fountain: 0.90 },
  source: { source: 0.62, parity: 0.08, fountain: 0.30 },
  default: { source: 0.45, parity: 0.20, fountain: 0.35 }
}

const DENSE_BINARY_PASS3_MIX_RATIOS = {
  source: { source: 0.77, parity: 0.08, fountain: 0.15 },
  default: { source: 0.65, parity: 0.15, fountain: 0.20 }
}

const DENSE_BINARY_PASS2_SWEEP_MIX_RATIOS = {
  source8: { source: 1.0, parity: 0, fountain: 0 },
  source7: { source: 0.875, parity: 0.125, fountain: 0 },
  parity: { source: 0.625, parity: 0.375, fountain: 0 },
  even: { source: 0.50, parity: 0.50, fountain: 0 },
  fountain: { source: 0.50, parity: 0.25, fountain: 0.25 },
  default: { source: 0.75, parity: 0.25, fountain: 0 }
}

function getDenseBinaryLateMixRatios(lateMix = getDenseBinaryLateMix()) {
  return DENSE_BINARY_LATE_MIX_RATIOS[lateMix] || DENSE_BINARY_LATE_MIX_RATIOS.default
}

function getDenseBinaryPass3MixRatios(pass3Mix = getDenseBinaryPass3Mix()) {
  return DENSE_BINARY_PASS3_MIX_RATIOS[pass3Mix] || DENSE_BINARY_PASS3_MIX_RATIOS.default
}

function getDenseBinaryPass2SweepMixRatios(pass2SweepMix = getDenseBinaryPass2SweepMix()) {
  return DENSE_BINARY_PASS2_SWEEP_MIX_RATIOS[pass2SweepMix] || DENSE_BINARY_PASS2_SWEEP_MIX_RATIOS.default
}

function getDenseBinarySlotMixPatternForPass(passNumber, slots, paritySweepsInPass, {
  lateMix = getDenseBinaryLateMix(),
  pass3Mix = getDenseBinaryPass3Mix(),
  pass2SweepMix = getDenseBinaryPass2SweepMix()
} = {}) {
  const slotCount = Math.max(0, Math.floor(slots || 0))
  const fountainTail = lateMix === 'fountain'
  if (passNumber <= 1) {
    return buildSlotMix(slotCount, { source: slotCount })
  }
  if (passNumber === 2) {
    if (paritySweepsInPass === 0) {
      // First sweep still delivers every parity row once, whatever the tail mix.
      return buildSlotMix(slotCount, slotCountsFromRatios(
        slotCount,
        getDenseBinaryPass2SweepMixRatios(pass2SweepMix)
      ))
    }
    if (fountainTail) {
      // On a fast link the receiver is already in recovery by pass 2, so this
      // is where the duplicate waste happens. Flip to fountain-heavy here.
      return buildSlotMix(slotCount, slotCountsFromRatios(slotCount, {
        source: 0.15,
        parity: 0.05,
        fountain: 0.80
      }))
    }
    return buildSlotMix(slotCount, slotCountsFromRatios(slotCount, {
      source: 0.75,
      parity: 0.125,
      fountain: 0.125
    }))
  }
  if (passNumber === 3) {
    if (fountainTail) {
      return buildSlotMix(slotCount, slotCountsFromRatios(slotCount, {
        source: 0.10,
        parity: 0.05,
        fountain: 0.85
      }))
    }
    return buildSlotMix(slotCount, slotCountsFromRatios(slotCount, getDenseBinaryPass3MixRatios(pass3Mix)))
  }
  return buildSlotMix(slotCount, slotCountsFromRatios(slotCount, getDenseBinaryLateMixRatios(lateMix)))
}

function getSlotMixPatternForPass(passNumber, {
  paritySweepsInPass = 0,
  slots = 6,
  mode = state.mode,
  lateMix = getDenseBinaryLateMix(),
  pass3Mix = getDenseBinaryPass3Mix(),
  pass2SweepMix = getDenseBinaryPass2SweepMix()
} = {}) {
  if (!usesMixedSlotReplay(mode)) return null
  if (isDenseBinaryMode(mode)) {
    return getDenseBinarySlotMixPatternForPass(passNumber, slots, paritySweepsInPass, {
      lateMix,
      pass3Mix,
      pass2SweepMix
    })
  }
  if (passNumber <= 1) return ['source', 'source', 'source', 'source', 'source', 'source']
  if (passNumber === 2) {
    // Two-stage pass 2: emit one full parity sweep at 4S/2P so every parity
    // row reaches the receiver once, then swap the second parity slot for a
    // fountain slot (4S/1P/1F) for the rest of pass 2 so fountain symbols
    // start contributing during the replay tail instead of waiting for pass 3.
    // `mix` and `legacy` overrides keep their historical meaning.
    const variant = getPass2Variant()
    if (variant === 'legacy') {
      return ['source', 'source', 'source', 'source', 'source', 'parity']
    }
    if (variant === 'mix') {
      return ['source', 'source', 'parity', 'parity', 'fountain', 'fountain']
    }
    if (paritySweepsInPass === 0) {
      return ['source', 'source', 'source', 'source', 'parity', 'parity']
    }
    return ['source', 'source', 'source', 'source', 'parity', 'fountain']
  }
  if (passNumber === 3) return ['source', 'source', 'source', 'source', 'parity', 'fountain']
  if (passNumber === 4) return ['source', 'source', 'source', 'parity', 'fountain', 'fountain']
  return ['source', 'parity', 'parity', 'fountain', 'fountain', 'fountain']
}

function getActiveSlotMixPatternForFrame(passNumber, {
  paritySweepsInPass = 0,
  slots = 6,
  mode = state.mode,
  sourceIndex = state.systematicIndex
} = {}) {
  if (
    usesBinary1DenseDefaults(mode) &&
    passNumber === 2 &&
    paritySweepsInPass === 0 &&
    sourceIndex < Math.max(1, slots) * BINARY1_PASS2_SOURCE_WARMUP_FRAMES
  ) {
    return buildSlotMix(slots, { source: slots })
  }
  return getSlotMixPatternForPass(passNumber, {
    paritySweepsInPass,
    slots,
    mode
  })
}

function describeSlotMixPattern(pattern) {
  if (!pattern || pattern.length === 0) return 'systematic'
  const counts = { source: 0, parity: 0, fountain: 0 }
  for (const slot of pattern) {
    if (counts[slot] !== undefined) counts[slot]++
  }
  const parts = []
  if (counts.source) parts.push(`${counts.source}S`)
  if (counts.parity) parts.push(`${counts.parity}P`)
  if (counts.fountain) parts.push(`${counts.fountain}F`)
  return parts.join('/')
}

export function getCurrentSystematicSpan() {
  if (!state.encoder) return 0
  if (usesMixedSlotReplay()) return state.encoder.K
  return state.systematicPass <= 1 ? state.encoder.K : state.encoder.K_prime
}

function getCurrentSystematicStride() {
  if (!state.encoder) return 1
  if (usesMixedSlotReplay()) return state.systematicStride
  return state.systematicPass <= 1
    ? state.systematicStride
    : state.intermediateSystematicStride
}

function getCurrentSystematicLabel() {
  if (usesMixedSlotReplay()) return 'mixed'
  return state.systematicPass <= 1 ? 'source' : 'intermediate'
}

function getSystematicPassIndexOffset(sourceSpan, passNumber = state.systematicPass, mode = state.mode, symbolKind = 'source') {
  if (sourceSpan <= 1) return 0
  if (passNumber === 1) return 0
  if (symbolKind === 'source' && usesBinary1DenseDefaults(mode) && passNumber === 2) return 0
  if (passNumber === 2) return Math.floor(sourceSpan / 2)
  if (passNumber === 3) return Math.floor(sourceSpan / 4)
  if (passNumber === 4) return Math.floor((sourceSpan * 3) / 4)
  if (passNumber === 5) return Math.floor(sourceSpan / 8)
  return Math.floor((sourceSpan * 5) / 8)
}

function getParitySystematicSpan() {
  if (!state.encoder) return 0
  return Math.max(0, state.encoder.K_prime - state.encoder.K)
}

function getSystematicSymbolIdForPass(index, span, stride, passNumber, base = 0, symbolKind = 'source') {
  if (span <= 0) return base + 1
  const passOffset = getSystematicPassIndexOffset(span, passNumber, state.mode, symbolKind)
  return base + ((((index + passOffset) * stride) % span) + 1)
}

function advanceMixedReplayPass(frameNumber) {
  state.systematicPass++
  state.systematicIndex = 0
  state.paritySweepsInPass = 0
  if (state.yolo) {
    debugLog(
      `YOLO source-only loop: pass ${state.systematicPass} at frame ${frameNumber + 1} ` +
      `(stride=${state.systematicStride}/${state.encoder.K})`
    )
    return
  }
  const paritySpan = getParitySystematicSpan()
  const pattern = getSlotMixPatternForPass(state.systematicPass, {
    slots: Math.max(1, state.packetsPerFrame || 1),
    paritySweepsInPass: state.paritySweepsInPass
  })
  debugLog(
    `Starting mixed replay pass ${state.systematicPass} at frame ${frameNumber + 1} ` +
    `(mix=${describeSlotMixPattern(pattern)}, ` +
    `source stride=${state.systematicStride}/${state.encoder.K}, ` +
    `offset=${getSystematicPassIndexOffset(state.encoder.K)}/${state.encoder.K}, ` +
    `parity stride=${state.paritySystematicStride}/${paritySpan || 1})`
  )
}

function nextSourceSystematicSymbolId(frameNumber) {
  const span = state.encoder.K
  const symbolId = getSystematicSymbolIdForPass(
    state.systematicIndex,
    span,
    state.systematicStride,
    state.systematicPass
  )
  state.systematicIndex++
  if (state.systematicIndex >= span) {
    advanceMixedReplayPass(frameNumber)
  }
  return symbolId
}

function nextParitySystematicSymbolId() {
  const paritySpan = getParitySystematicSpan()
  if (paritySpan <= 0) return state.encoder.K
  const symbolId = getSystematicSymbolIdForPass(
    state.paritySystematicIndex,
    paritySpan,
    state.paritySystematicStride,
    state.systematicPass,
    state.encoder.K,
    'parity'
  )
  const nextIndex = (state.paritySystematicIndex + 1) % paritySpan
  if (nextIndex === 0) {
    state.paritySweepsInPass++
    if (state.systematicPass === 2 && state.paritySweepsInPass === 1) {
      const nextPattern = getSlotMixPatternForPass(2, {
        slots: Math.max(1, state.packetsPerFrame || 1),
        paritySweepsInPass: state.paritySweepsInPass
      })
      debugLog(
        `Pass 2 first parity sweep complete — switching to ${describeSlotMixPattern(nextPattern)} ` +
        `(paritySpan=${paritySpan})`
      )
    }
  }
  state.paritySystematicIndex = nextIndex
  return symbolId
}

function nextDataSymbolId(frameNumber, strategy = 'auto') {
  if (usesMixedSlotReplay()) {
    let symbolId
    if (strategy === 'fountain') {
      symbolId = state.fountainSymbolId++
    } else if (strategy === 'parity') {
      symbolId = nextParitySystematicSymbolId()
    } else {
      symbolId = nextSourceSystematicSymbolId(frameNumber)
    }
    if (frameNumber % FRAMES_PER_SYMBOL === 0) {
      state.dataPacketCount++
    }
    return symbolId
  }

  const systematicSpan = getCurrentSystematicSpan()
  const systematicStride = getCurrentSystematicStride()
  const fountainPacketInterval = getFountainPacketInterval()
  const shouldSendFountain =
    strategy !== 'systematic' && (
      strategy === 'fountain' ||
      (
        fountainPacketInterval > 0 &&
        state.systematicPass > 1 &&
        state.fountainSymbolId > state.encoder.K_prime &&
        state.dataPacketCount > 0 &&
        state.dataPacketCount % fountainPacketInterval === 0
      )
    )

  let symbolId
  if (shouldSendFountain) {
    symbolId = state.fountainSymbolId++
  } else {
    const passOffset = getSystematicPassIndexOffset(systematicSpan)
    symbolId = (((state.systematicIndex + passOffset) * systematicStride) % systematicSpan) + 1
    if (frameNumber % FRAMES_PER_SYMBOL === 0) {
      state.systematicIndex++
      if (state.systematicIndex >= systematicSpan) {
        state.systematicPass++
        state.systematicIndex = 0
        if (
          state.tailStartFrame === 0 &&
          (
            state.mode === HDMI_MODE.COMPAT_4 ||
            state.mode === HDMI_MODE.LUMA_2 ||
            state.mode === HDMI_MODE.CODEBOOK_3
          ) &&
          state.systematicPass >= 5
        ) {
          state.tailStartFrame = frameNumber + 1
          debugLog(
            `Late-phase schedule: systematic burst frames start at frame ${state.tailStartFrame} ` +
            `(every ${TAIL_SYSTEMATIC_BURST_PERIOD_FRAMES} frame(s))`
          )
        }
        const nextSpan = getCurrentSystematicSpan()
        const nextStride = getCurrentSystematicStride()
        const nextLabel = getCurrentSystematicLabel()
        debugLog(
          `Starting ${nextLabel} replay pass ${state.systematicPass} at frame ${frameNumber + 1} ` +
          `(stride=${nextStride}/${nextSpan}, ` +
          `offset=${getSystematicPassIndexOffset(nextSpan)}/${nextSpan}, ` +
          `${describeFountainInterval(getFountainPacketInterval())})`
        )
      }
    }
  }

  if (frameNumber % FRAMES_PER_SYMBOL === 0) {
    state.dataPacketCount++
  }

  return symbolId
}

function isTailSystematicBurstFrame(frameNumber) {
  if (usesMixedSlotReplay()) return false
  if (
    state.mode !== HDMI_MODE.COMPAT_4 &&
    state.mode !== HDMI_MODE.LUMA_2 &&
    state.mode !== HDMI_MODE.CODEBOOK_3
  ) {
    return false
  }
  if (state.tailStartFrame <= 0 || frameNumber < state.tailStartFrame) return false

  const tailFrameIndex = frameNumber - state.tailStartFrame
  return (tailFrameIndex % TAIL_SYSTEMATIC_BURST_PERIOD_FRAMES) < TAIL_SYSTEMATIC_BURST_FRAMES
}

function tickArqFallback() {
  if (!state.arqController || state.arqFallback) return false
  if (!state.arqController.tickFallback(performance.now())) return false
  state.arqFallback = true
  state.arqCursor = 0
  state.systematicIndex = 0
  state.paritySystematicIndex = 0
  state.paritySweepsInPass = 0
  state.fountainSymbolId = state.encoder.K_prime + 1
  state.dataPacketCount = 0
  state.systematicPass = 1
  state.tailStartFrame = 0
  // Keep the back-channel open: the silence may be a transient receiver-side
  // stall (occluded window, helper reconnect). A fresh NACK re-engages repair
  // and a COMPLETE still stops the sender.
  debugLog(state.yolo
    ? 'ARQ back-channel silent - falling back to no-redundancy source loop'
    : 'ARQ back-channel silent - falling back to normal fountain/parity schedule')
  notifyArqSenderStatus(
    state.yolo ? 'ARQ fallback: source loop (listening)' : 'ARQ fallback: normal stream (listening)',
    state.arqConnected
  )
  return true
}

function buildArqBeaconBatch() {
  const packets = [state.encoder.generateSymbol(0, { repairIdle: true })]
  const symbolIds = [0]
  const slots = Math.max(1, state.packetsPerFrame)
  const workList = state.arqController?.workList || []
  for (let slot = 1; slot < slots && workList.length > 0; slot++) {
    if (state.arqCursor >= workList.length) state.arqCursor = 0
    const next = nextFrameSymbolId(workList, state.arqCursor)
    if (next.symbolId === null) break
    state.arqCursor = next.cursor
    packets.push(state.encoder.generateSymbol(next.symbolId))
    symbolIds.push(next.symbolId)
  }
  return {
    payload: concatPackets(packets),
    symbolIds,
    outerSymbolId: 0,
    sendMetadata: true,
    repairIdleBeacon: true
  }
}

function concatPackets(packets) {
  let totalLength = 0
  for (const packet of packets) totalLength += packet.length
  const payload = new Uint8Array(totalLength)
  let offset = 0
  for (const packet of packets) {
    payload.set(packet, offset)
    offset += packet.length
  }
  return payload
}

function createPacketBatch({ packets, symbolIds, metadataEmitted = false, extra = null }) {
  return {
    payload: concatPackets(packets),
    symbolIds,
    outerSymbolId: metadataEmitted ? 0 : (symbolIds[0] ?? 0),
    sendMetadata: metadataEmitted,
    ...(extra || {})
  }
}

function buildArqPacketBatch(frameNumber) {
  if (!state.arqController || state.arqFallback || state.arqController.mode === 'fallback') return null
  if (state.arqController.mode === 'done') return buildArqBeaconBatch()

  if (state.arqController.mode === 'beacon') {
    tickArqFallback()
    return state.arqFallback ? null : buildArqBeaconBatch()
  }

  const packets = []
  const symbolIds = []
  const slots = Math.max(1, state.packetsPerFrame)
  const scheduleFrameNumber = Math.max(1, frameNumber - getSyncPorchFrameCount(state.mode))
  const sendMetadata = !!state.arqController.needsRepairMetadata ||
    (state.arqController.mode === 'pass1' && shouldSendMetadata(scheduleFrameNumber))
  const metadataSlotIndex = sendMetadata ? getMetadataSlotIndex(scheduleFrameNumber, slots) : -1
  let metadataEmitted = false
  for (let slot = 0; slot < slots; slot++) {
    if (slot === metadataSlotIndex) {
      packets.push(state.encoder.generateSymbol(0))
      symbolIds.push(0)
      metadataEmitted = true
      continue
    }
    const next = nextFrameSymbolId(state.arqController.workList, state.arqCursor)
    if (next.symbolId === null) {
      if (sendMetadata && !metadataEmitted && slot < metadataSlotIndex) continue
      break
    }
    state.arqCursor = next.cursor
    packets.push(state.encoder.generateSymbol(next.symbolId))
    symbolIds.push(next.symbolId)
  }

  if (symbolIds.length === 0 || state.arqCursor >= state.arqController.workList.length) {
    state.arqController.onPassExhausted(performance.now())
    state.arqCursor = 0
    debugLog(`ARQ pass exhausted at frame ${frameNumber}; beaconing for receiver NACK/COMPLETE`)
  }

  if (symbolIds.length === 0) return buildArqBeaconBatch()

  if (metadataEmitted) state.arqController.needsRepairMetadata = false

  return createPacketBatch({
    packets,
    symbolIds,
    metadataEmitted
  })
}

export function buildFramePacketBatch(frameNumber) {
  if (isSyncPorchFrame(frameNumber)) {
    return {
      payload: new Uint8Array(0),
      symbolIds: [],
      outerSymbolId: 0,
      sendMetadata: false,
      syncPorch: true
    }
  }

  const arqBatch = buildArqPacketBatch(frameNumber)
  if (arqBatch) return arqBatch

  const scheduleFrameNumber = Math.max(1, frameNumber - getSyncPorchFrameCount(state.mode))
  const sendMetadata = shouldSendMetadata(scheduleFrameNumber)
  const packets = []
  const symbolIds = []
  const slots = Math.max(1, state.packetsPerFrame)
  const metadataSlotIndex = sendMetadata ? getMetadataSlotIndex(scheduleFrameNumber, slots) : -1
  const tailSystematicBurst = isTailSystematicBurstFrame(frameNumber)
  const dataSlots = Math.max(0, slots - (sendMetadata ? 1 : 0))
  const slotMixPattern = state.yolo
    ? null
    : getActiveSlotMixPatternForFrame(state.systematicPass, {
        paritySweepsInPass: state.paritySweepsInPass,
        slots: dataSlots
      })

  // After an ARQ fallback the back-channel stays open; flag the regular
  // metadata as repair-idle so the receiver still treats it as a beacon and
  // can re-engage repair with a NACK (or stop the sender with COMPLETE).
  const fallbackBeacon = !!(state.arqFallback && state.arqTransport)
  let dataSlotsBuilt = 0
  for (let slot = 0; slot < slots; slot++) {
    if (slot === metadataSlotIndex) {
      packets.push(state.encoder.generateSymbol(0, { repairIdle: fallbackBeacon }))
      symbolIds.push(0)
      continue
    }

    let strategy = tailSystematicBurst ? 'systematic' : 'auto'
    if (state.yolo) {
      strategy = 'source'
    } else if (slotMixPattern) {
      strategy = slotMixPattern[Math.min(dataSlotsBuilt, slotMixPattern.length - 1)] || 'source'
    }
    const symbolId = nextDataSymbolId(frameNumber, strategy)
    packets.push(state.encoder.generateSymbol(symbolId))
    symbolIds.push(symbolId)
    dataSlotsBuilt++
  }

  return createPacketBatch({
    packets,
    symbolIds,
    metadataEmitted: sendMetadata
  })
}

// Exposed for hdmi-uvc-sender-schedule.tests.js only — not part of the runtime API.
export const _internals = {
  getDenseBinaryBatchingProfile,
  shouldSendMetadata,
  getSlotMixPatternForPass,
  describeSlotMixPattern,
  getSystematicPassIndexOffset,
  buildArqPacketBatch
}
