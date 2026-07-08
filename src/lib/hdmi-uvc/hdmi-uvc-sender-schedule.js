// HDMI-UVC sender frame scheduler: batching profiles, metadata cadence,
// systematic/parity/fountain slot mixes, mixed-replay pass advancement, and
// per-frame packet-batch construction (including the ARQ repair/beacon
// paths). Operates on the shared sender state singleton; the sender itself
// keeps rendering, presentation, and UI. Scheduler tests and their state
// snapshot/setup helpers live here with the code they exercise.

import { PACKET_HEADER_SIZE } from '../packet.js'
import { HDMI_MODE, HDMI_MODE_NAMES } from './hdmi-uvc-constants.js'
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
import {
  state,
  isDenseBinaryMode,
  usesBinary1DenseDefaults
} from './hdmi-uvc-sender-state.js'

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

function getDenseBinaryLateMixRatios(lateMix = getDenseBinaryLateMix()) {
  if (lateMix === 'fountain') {
    // Tail recovery on a clean link is duplicate-bound: re-sent source/parity
    // blocks the receiver already holds waste bandwidth. Ship mostly fresh
    // fountain symbols, keeping a thin source trickle for any clustered misses.
    return { source: 0.10, parity: 0.0, fountain: 0.90 }
  }
  if (lateMix === 'source') {
    return { source: 0.62, parity: 0.08, fountain: 0.30 }
  }
  return { source: 0.45, parity: 0.20, fountain: 0.35 }
}

function getDenseBinaryPass3MixRatios(pass3Mix = getDenseBinaryPass3Mix()) {
  if (pass3Mix === 'source') {
    return { source: 0.77, parity: 0.08, fountain: 0.15 }
  }
  return { source: 0.65, parity: 0.15, fountain: 0.20 }
}

function getDenseBinaryPass2SweepMixRatios(pass2SweepMix = getDenseBinaryPass2SweepMix()) {
  if (pass2SweepMix === 'source8') {
    return { source: 1.0, parity: 0, fountain: 0 }
  }
  if (pass2SweepMix === 'source7') {
    return { source: 0.875, parity: 0.125, fountain: 0 }
  }
  if (pass2SweepMix === 'parity') {
    return { source: 0.625, parity: 0.375, fountain: 0 }
  }
  if (pass2SweepMix === 'even') {
    return { source: 0.50, parity: 0.50, fountain: 0 }
  }
  if (pass2SweepMix === 'fountain') {
    return { source: 0.50, parity: 0.25, fountain: 0.25 }
  }
  return { source: 0.75, parity: 0.25, fountain: 0 }
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

export function testSenderWorkListSchedule() {
  let cursor = 0
  const ids = []
  let exhausted = false
  for (let i = 0; i < 4; i++) {
    const next = nextFrameSymbolId([3, 6, 9], cursor)
    ids.push(next.symbolId)
    cursor = next.cursor
    exhausted = next.exhausted
  }
  const pass = ids.join(',') === '3,6,9,' && cursor === 3 && exhausted === true
  console.log('Sender ARQ work-list schedule test:', pass ? 'PASS' : 'FAIL', { ids, cursor, exhausted })
  return pass
}

export function testArqBatchEmitsClaimedMetadataAtWorkListTail() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({ mode: HDMI_MODE.BINARY_3, packetsPerFrame: 4 })
    state.arqController = {
      mode: 'pass1',
      workList: [1, 2],
      onPassExhausted() { this.mode = 'beacon' }
    }
    const batch = buildArqPacketBatch(4)
    const pass = batch?.sendMetadata === true &&
      batch.outerSymbolId === 0 &&
      batch.symbolIds.includes(0)
    console.log('ARQ metadata tail batch test:', pass ? 'PASS' : 'FAIL', batch?.symbolIds)
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testArqRepairBatchCarriesMetadataWhenRequested() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({ mode: HDMI_MODE.BINARY_3, packetsPerFrame: 4 })
    state.arqController = {
      mode: 'repair',
      workList: [1, 2, 3],
      needsRepairMetadata: true,
      onPassExhausted() { this.mode = 'beacon' }
    }
    const batch = buildArqPacketBatch(5)
    const pass = batch?.sendMetadata === true &&
      batch.outerSymbolId === 0 &&
      batch.symbolIds.includes(0) &&
      state.arqController.needsRepairMetadata === false
    console.log('ARQ repair metadata batch test:', pass ? 'PASS' : 'FAIL', batch?.symbolIds)
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testArqBeaconBatchCarriesReplayData() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({ mode: HDMI_MODE.BINARY_3, packetsPerFrame: 4 })
    state.arqController = {
      mode: 'beacon',
      workList: [1, 2, 3, 4, 5],
      tickFallback() { return false }
    }
    const batch = buildArqPacketBatch(10)
    const pass = batch?.repairIdleBeacon === true &&
      batch.sendMetadata === true &&
      batch.symbolIds.join(',') === '0,1,2,3' &&
      state.arqCursor === 3
    console.log('ARQ beacon replay data batch test:', pass ? 'PASS' : 'FAIL', batch?.symbolIds)
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

// Pure function tests so the two-stage pass-2 schedule and parity-sweep wrap
// counter are verifiable without spinning up the encoder/DOM. The runtime
// contract: pass 2 emits 4S/2P for sweep 0, then 4S/1P/1F for every
// subsequent sweep; paritySweepsInPass increments when paritySystematicIndex
// wraps from paritySpan-1 back to 0.
export function testPass2TwoStageSchedule() {
  const pass2Def = getDiagnosticDefinition('pass2')
  const sweep0 = getSlotMixPatternForPass(2, { mode: HDMI_MODE.COMPAT_4, paritySweepsInPass: 0 })
  const sweep1 = getSlotMixPatternForPass(2, { mode: HDMI_MODE.COMPAT_4, paritySweepsInPass: 1 })
  const sweep7 = getSlotMixPatternForPass(2, { mode: HDMI_MODE.COMPAT_4, paritySweepsInPass: 7 })

  const c0 = countSlotKinds(sweep0)
  const c1 = countSlotKinds(sweep1)
  const c7 = countSlotKinds(sweep7)

  const ok0 = c0.source === 4 && c0.parity === 2 && c0.fountain === 0
  const ok1 = c1.source === 4 && c1.parity === 1 && c1.fountain === 1
  const ok7 = c7.source === 4 && c7.parity === 1 && c7.fountain === 1

  // Pass 1 must still be source-only; pass 3+ unchanged.
  const pass1 = getSlotMixPatternForPass(1, { mode: HDMI_MODE.COMPAT_4, paritySweepsInPass: 0 })
  const pass3 = getSlotMixPatternForPass(3, { mode: HDMI_MODE.COMPAT_4, paritySweepsInPass: 0 })
  const c1Pass = countSlotKinds(pass1)
  const c3Pass = countSlotKinds(pass3)
  const okPass1 = c1Pass.source === 6 && c1Pass.parity === 0 && c1Pass.fountain === 0
  const okPass3 = c3Pass.source === 4 && c3Pass.parity === 1 && c3Pass.fountain === 1

  const pass2Locked = pass2Def?.default === 'p2' &&
    pass2Def.allowed?.length === 1 &&
    pass2Def.allowed[0] === 'p2'
  const pass = ok0 && ok1 && ok7 && okPass1 && okPass3 && pass2Locked
  console.log('Two-stage pass-2 schedule test:', pass ? 'PASS' : 'FAIL',
    { c0, c1, c7, c1Pass, c3Pass, pass2Def })
  return pass
}

export function testParitySweepCounter() {
  // Simulate the wrap-counter logic in isolation. Produces the sequence a
  // sender would see: 0,0,...,0,1,1,...,1,2,... where the boundary is at
  // paritySpan-1 -> 0. This is the contract buildFramePacketBatch relies on.
  const paritySpan = 4
  let idx = 0
  let sweeps = 0
  const observed = []
  for (let i = 0; i < 12; i++) {
    observed.push(sweeps)
    const nextIdx = (idx + 1) % paritySpan
    if (nextIdx === 0) sweeps++
    idx = nextIdx
  }
  // Expected: 0,0,0,0,1,1,1,1,2,2,2,2
  const expected = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]
  const pass = observed.length === expected.length &&
    observed.every((v, i) => v === expected[i])
  console.log('Parity sweep counter test:', pass ? 'PASS' : 'FAIL',
    { observed, expected })
  return pass
}

function snapshotSchedulerState() {
  return {
    mode: state.mode,
    yolo: state.yolo,
    encoder: state.encoder,
    packetsPerFrame: state.packetsPerFrame,
    systematicIndex: state.systematicIndex,
    systematicStride: state.systematicStride,
    intermediateSystematicStride: state.intermediateSystematicStride,
    paritySystematicIndex: state.paritySystematicIndex,
    paritySystematicStride: state.paritySystematicStride,
    paritySweepsInPass: state.paritySweepsInPass,
    fountainSymbolId: state.fountainSymbolId,
    dataPacketCount: state.dataPacketCount,
    systematicPass: state.systematicPass,
    tailStartFrame: state.tailStartFrame,
    metadataIntervalFrames: state.metadataIntervalFrames,
    arqController: state.arqController,
    arqCursor: state.arqCursor,
    arqFallback: state.arqFallback
  }
}

function setupSchedulerTestState({
  mode = HDMI_MODE.BINARY_3,
  K = 100,
  KPrime = 112,
  packetsPerFrame = 24,
  systematicPass = 1,
  paritySweepsInPass = 0,
  yolo = false
} = {}) {
  state.mode = mode
  state.yolo = yolo
  state.encoder = {
    K,
    K_prime: KPrime,
    generateSymbol: symbolId => new Uint8Array([symbolId & 0xff])
  }
  state.packetsPerFrame = packetsPerFrame
  state.systematicIndex = 0
  state.systematicStride = 1
  state.intermediateSystematicStride = 1
  state.paritySystematicIndex = 0
  state.paritySystematicStride = 1
  state.paritySweepsInPass = paritySweepsInPass
  state.fountainSymbolId = KPrime + 1
  state.dataPacketCount = 0
  state.systematicPass = systematicPass
  state.tailStartFrame = 0
  state.metadataIntervalFrames = 90
  state.arqController = null
  state.arqCursor = 0
  state.arqFallback = false
}

function countSlotKinds(pattern) {
  const counts = { source: 0, parity: 0, fountain: 0 }
  for (const slot of pattern || []) {
    if (counts[slot] !== undefined) counts[slot]++
  }
  return counts
}

function countSymbolKinds(symbolIds, encoder) {
  const counts = { metadata: 0, source: 0, parity: 0, fountain: 0 }
  for (const symbolId of symbolIds) {
    if (symbolId === 0) counts.metadata++
    else if (symbolId <= encoder.K) counts.source++
    else if (symbolId <= encoder.K_prime) counts.parity++
    else counts.fountain++
  }
  return counts
}

export function testDenseBinaryMixedReplayPass1SourceOnly() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({ systematicPass: 1 })
    const batch = buildFramePacketBatch(5)
    const counts = countSymbolKinds(batch.symbolIds, state.encoder)
    const pass = batch.symbolIds.length === 24 &&
      counts.metadata === 0 &&
      counts.source === 24 &&
      counts.parity === 0 &&
      counts.fountain === 0
    console.log('dense-binary mixed replay pass 1 source-only test:', pass ? 'PASS' : 'FAIL', {
      symbolIds: batch.symbolIds,
      counts
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

// With YOLO on, every data slot in every pass must be a source symbol — never
// parity or fountain — including late passes where normal mode would mix them in.
export function testYoloModeSourceOnlyAllPasses() {
  const snapshot = snapshotSchedulerState()
  try {
    let allSource = true
    let sawSource = false
    const detail = []
    for (const passNum of [1, 2, 5]) {
      setupSchedulerTestState({ mode: HDMI_MODE.LUMA_1, systematicPass: passNum, yolo: true })
      for (let f = 1; f <= 12; f++) {
        const batch = buildFramePacketBatch(f)
        const counts = countSymbolKinds(batch.symbolIds, state.encoder)
        if (counts.source > 0) sawSource = true
        if (counts.parity !== 0 || counts.fountain !== 0) {
          allSource = false
          detail.push({ passNum, f, counts })
        }
      }
    }
    const pass = allSource && sawSource
    console.log('YOLO source-only all-passes test:', pass ? 'PASS' : 'FAIL', { sawSource, detail })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testDenseBinaryMixedReplayPass2ChangesAfterParitySweep() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({ systematicPass: 2, paritySweepsInPass: 0 })
    const sweep0 = countSymbolKinds(buildFramePacketBatch(5).symbolIds, state.encoder)

    Object.assign(state, snapshot)
    setupSchedulerTestState({ systematicPass: 2, paritySweepsInPass: 1 })
    const sweep1 = countSymbolKinds(buildFramePacketBatch(5).symbolIds, state.encoder)

    const pass = sweep0.metadata === 0 &&
      sweep0.source === 21 &&
      sweep0.parity === 3 &&
      sweep0.fountain === 0 &&
      sweep1.metadata === 0 &&
      sweep1.source === 4 &&
      sweep1.parity === 1 &&
      sweep1.fountain === 19
    console.log('dense-binary mixed replay pass 2 parity-sweep transition test:', pass ? 'PASS' : 'FAIL', {
      sweep0,
      sweep1
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testCompat4MixedReplayKeepsSixSlotPatterns() {
  const snapshot = snapshotSchedulerState()
  try {
    state.mode = HDMI_MODE.COMPAT_4
    const expected = [
      ['source', 'source', 'source', 'source', 'source', 'source'],
      ['source', 'source', 'source', 'source', 'parity', 'parity'],
      ['source', 'source', 'source', 'source', 'parity', 'fountain'],
      ['source', 'source', 'source', 'source', 'parity', 'fountain'],
      ['source', 'source', 'source', 'parity', 'fountain', 'fountain'],
      ['source', 'parity', 'parity', 'fountain', 'fountain', 'fountain']
    ]
    const observed = [
      getSlotMixPatternForPass(1, { paritySweepsInPass: 0 }),
      getSlotMixPatternForPass(2, { paritySweepsInPass: 0 }),
      getSlotMixPatternForPass(2, { paritySweepsInPass: 1 }),
      getSlotMixPatternForPass(3, { paritySweepsInPass: 0 }),
      getSlotMixPatternForPass(4, { paritySweepsInPass: 0 }),
      getSlotMixPatternForPass(5, { paritySweepsInPass: 0 })
    ]
    const pass = observed.every((pattern, i) =>
      pattern.length === expected[i].length &&
      pattern.every((slot, j) => slot === expected[i][j])
    )
    console.log('COMPAT_4 mixed replay six-slot compatibility test:', pass ? 'PASS' : 'FAIL', {
      observed,
      expected
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testDenseBinaryMixedReplayMetadataReducesDataSlots() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({ systematicPass: 2, paritySweepsInPass: 0 })
    const batch = buildFramePacketBatch(12)
    const counts = countSymbolKinds(batch.symbolIds, state.encoder)
    const pass = batch.symbolIds.length === 24 &&
      batch.symbolIds[11] === 0 &&
      counts.metadata === 1 &&
      counts.source === 17 &&
      counts.parity === 6 &&
      counts.fountain === 0
    console.log('dense-binary mixed replay metadata data-slot test:', pass ? 'PASS' : 'FAIL', {
      symbolIds: batch.symbolIds,
      counts
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testBinary1Pass2ReplaysFromStart() {
  const snapshot = snapshotSchedulerState()
  try {
    state.mode = HDMI_MODE.BINARY_1
    const binary1Offset = getSystematicPassIndexOffset(849, 2)
    state.mode = HDMI_MODE.BINARY_2
    const binary2Offset = getSystematicPassIndexOffset(849, 2)
    const pass = binary1Offset === 0 && binary2Offset === Math.floor(849 / 2)
    console.log('BINARY_1 pass-2 replay offset test:', pass ? 'PASS' : 'FAIL', {
      binary1Offset,
      binary2Offset
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testBinary1StartsDataImmediately() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({
      mode: HDMI_MODE.BINARY_1,
      K: 849,
      KPrime: 934,
      packetsPerFrame: 8,
      systematicPass: 1
    })
    const first = buildFramePacketBatch(1)
    const second = buildFramePacketBatch(2)
    const pass = first.payload.length > 0 &&
      first.syncPorch !== true &&
      first.outerSymbolId === 0 &&
      first.symbolIds[0] === 0 &&
      first.symbolIds[1] === 1 &&
      second.payload.length > 0 &&
      second.syncPorch !== true
    console.log('BINARY_1 immediate data start test:', pass ? 'PASS' : 'FAIL', {
      first,
      secondSymbolIds: second.symbolIds
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testBinary1Pass2StartsMixedReplay() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({
      mode: HDMI_MODE.BINARY_1,
      K: 849,
      KPrime: 934,
      packetsPerFrame: 8,
      systematicPass: 2,
      paritySweepsInPass: 0
    })
    const firstPass2Counts = countSymbolKinds(buildFramePacketBatch(13).symbolIds, state.encoder)
    const pass = firstPass2Counts.source === 6 &&
      firstPass2Counts.parity === 2 &&
      firstPass2Counts.fountain === 0
    console.log('BINARY_1 pass-2 mixed replay start test:', pass ? 'PASS' : 'FAIL', {
      firstPass2Counts
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}

export function testDenseBinaryPass2SweepMixDiagnostic() {
  const def = getDiagnosticDefinition('denseBinaryPass2SweepMix')
  const pass = def?.default === 'source7' &&
    def.allowed?.length === 1 &&
    def.allowed[0] === 'source7'
  console.log('dense-binary pass-2 sweep mix diagnostic test:', pass ? 'PASS' : 'FAIL', {
    definition: def
  })
  return pass
}

export function testDenseBinaryPass2SweepMixPatterns() {
  const balanced = countSlotKinds(getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_1,
    slots: 8,
    paritySweepsInPass: 0,
    pass2SweepMix: 'balanced'
  }))
  const source7 = countSlotKinds(getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_1,
    slots: 8,
    paritySweepsInPass: 0,
    pass2SweepMix: 'source7'
  }))
  const source8 = countSlotKinds(getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_1,
    slots: 8,
    paritySweepsInPass: 0,
    pass2SweepMix: 'source8'
  }))
  const parity = countSlotKinds(getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_1,
    slots: 8,
    paritySweepsInPass: 0,
    pass2SweepMix: 'parity'
  }))
  const even = countSlotKinds(getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_1,
    slots: 8,
    paritySweepsInPass: 0,
    pass2SweepMix: 'even'
  }))
  const fountain = countSlotKinds(getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_1,
    slots: 8,
    paritySweepsInPass: 0,
    pass2SweepMix: 'fountain'
  }))

  const pass = balanced.source === 6 && balanced.parity === 2 && balanced.fountain === 0 &&
    source7.source === 7 && source7.parity === 1 && source7.fountain === 0 &&
    source8.source === 8 && source8.parity === 0 && source8.fountain === 0 &&
    parity.source === 5 && parity.parity === 3 && parity.fountain === 0 &&
    even.source === 4 && even.parity === 4 && even.fountain === 0 &&
    fountain.source === 4 && fountain.parity === 2 && fountain.fountain === 2
  console.log('dense-binary pass-2 sweep mix pattern test:', pass ? 'PASS' : 'FAIL', {
    balanced,
    source7,
    source8,
    parity,
    even,
    fountain
  })
  return pass
}

export function testDenseBinaryBatchingProfile() {
  const profile = typeof getDenseBinaryBatchingProfile === 'function'
    ? getDenseBinaryBatchingProfile('safe')
    : getBatchingProfile(HDMI_MODE.BINARY_3)
  const pass = profile.maxBlockSize <= 1024 &&
    profile.minPacketsPerFrame >= 4 &&
    profile.maxPacketsPerFrame >= profile.minPacketsPerFrame &&
    profile.targetFrameFill >= 0.85
  console.log('dense-binary batching profile test:', pass ? 'PASS' : `FAIL ${JSON.stringify(profile)}`)
  return pass
}

export function testBinary2BatchingAndSchedule() {
  const profile = getDenseBinaryBatchingProfile('large', HDMI_MODE.BINARY_2, { useModeDefault: false })
  const pass2 = getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_2,
    slots: 29,
    paritySweepsInPass: 1,
    lateMix: 'source'
  })
  const pass3 = getSlotMixPatternForPass(3, {
    mode: HDMI_MODE.BINARY_2,
    slots: 29,
    lateMix: 'source'
  })
  const pass4 = getSlotMixPatternForPass(4, {
    mode: HDMI_MODE.BINARY_2,
    slots: 29,
    lateMix: 'source'
  })
  const selected = selectFrameBatching({
    capacity: getPayloadCapacity(1920, 1080, HDMI_MODE.BINARY_2),
    fileSize: 5.5 * 1024 * 1024,
    profile
  })
  const c2 = countSlotKinds(pass2)
  const c3 = countSlotKinds(pass3)
  const c4 = countSlotKinds(pass4)
  const pass = HDMI_MODE.BINARY_2 === 9 &&
    profile.id === 'large' &&
    profile.minPacketsPerFrame === 4 &&
    profile.maxPacketsPerFrame === 32 &&
    profile.targetFrameFill === 0.99 &&
    profile.maxBlockSize === 2048 &&
    selected.packetsPerFrame === 29 &&
    selected.blockSize === 2028 &&
    selected.usedBytes === 59247 &&
    selected.payloadPerFrame === 58812 &&
    c2.source === 22 &&
    c2.parity === 4 &&
    c2.fountain === 3 &&
    c3.source === 19 &&
    c3.parity === 4 &&
    c3.fountain === 6 &&
    c4.source === 18 &&
    c4.parity === 2 &&
    c4.fountain === 9
  console.log('BINARY_2 batching/schedule test:', pass ? 'PASS' : 'FAIL', {
    profile,
    selected,
    pass2: describeSlotMixPattern(pass2),
    pass3: describeSlotMixPattern(pass3),
    pass4: describeSlotMixPattern(pass4)
  })
  return pass
}

export function testDenseBinaryBatchingProfileMath() {
  const helperExists = typeof getDenseBinaryBatchingProfile === 'function' &&
    typeof selectFrameBatching === 'function'
  const capacity = 26547
  const fileSize = 5.5 * 1024 * 1024
  const expected = {
    safe: { packetsPerFrame: 24, blockSize: 980, usedBytes: 23880 },
    fill99: { packetsPerFrame: 27, blockSize: 956, usedBytes: 26217 },
    medium: { packetsPerFrame: 18, blockSize: 1444, usedBytes: 26262 },
    large: { packetsPerFrame: 13, blockSize: 2004, usedBytes: 26247 }
  }
  const observed = {}
  if (helperExists) {
    for (const id of Object.keys(expected)) {
      const selected = selectFrameBatching({
        capacity,
        fileSize,
        profile: getDenseBinaryBatchingProfile(id)
      })
      observed[id] = {
        packetsPerFrame: selected.packetsPerFrame,
        blockSize: selected.blockSize,
        usedBytes: selected.usedBytes
      }
    }
  }

  const pass = helperExists &&
    Object.keys(expected).every((id) =>
      observed[id]?.packetsPerFrame === expected[id].packetsPerFrame &&
      observed[id]?.blockSize === expected[id].blockSize &&
      observed[id]?.usedBytes === expected[id].usedBytes
    )
  console.log('dense-binary batching profile math test:', pass ? 'PASS' : 'FAIL', {
    helperExists,
    observed,
    expected
  })
  return pass
}

export function testDenseBinaryXlargeShrinksBlockCount() {
  const capacity = getPayloadCapacity(1920, 1080, HDMI_MODE.BINARY_2)
  const fileSize = 10 * 1024 * 1024
  const large = selectFrameBatching({ capacity, fileSize, profile: getDenseBinaryBatchingProfile('large') })
  const xlarge = selectFrameBatching({ capacity, fileSize, profile: getDenseBinaryBatchingProfile('xlarge') })
  const kLarge = Math.ceil(fileSize / large.blockSize)
  const kXlarge = Math.ceil(fileSize / xlarge.blockSize)
  // xlarge exists to shrink K: bigger blocks (fewer packets/frame) → materially
  // fewer source blocks → shorter fountain endgame. Raising maxBlockSize alone
  // does NOT do this (the batcher maximizes frame payload, which favours ~2KB
  // blocks); the profile must also cap packets-per-frame.
  const pass = xlarge.blockSize > large.blockSize &&
    xlarge.packetsPerFrame < large.packetsPerFrame &&
    kXlarge < kLarge * 0.7
  console.log('dense-binary xlarge shrinks block count test:', pass ? 'PASS' : 'FAIL', {
    large: { blockSize: large.blockSize, packets: large.packetsPerFrame, K: kLarge },
    xlarge: { blockSize: xlarge.blockSize, packets: xlarge.packetsPerFrame, K: kXlarge }
  })
  return pass
}

export function testBinary2UsesDenseBatchingProfile() {
  const originalProfile = getDenseBinaryProfile()
  setDiagnostic('denseBinaryProfile', 'xlarge')
  try {
    const capacity = getPayloadCapacity(1920, 1080, HDMI_MODE.BINARY_2)
    const fileSize = 10 * 1024 * 1024
    const selectedProfile = getBatchingProfile(HDMI_MODE.BINARY_2)
    const large = selectFrameBatching({ capacity, fileSize, profile: getDenseBinaryBatchingProfile('large') })
    const selected = selectFrameBatching({ capacity, fileSize, profile: selectedProfile })
    const pass = selectedProfile.id === 'xlarge' &&
      selected.blockSize > large.blockSize &&
      selected.packetsPerFrame < large.packetsPerFrame
    console.log('BINARY_2 dense batching profile test:', pass ? 'PASS' : 'FAIL', {
      selectedProfile,
      large: { blockSize: large.blockSize, packets: large.packetsPerFrame },
      selected: { blockSize: selected.blockSize, packets: selected.packetsPerFrame }
    })
    return pass
  } finally {
    setDiagnostic('denseBinaryProfile', originalProfile)
  }
}

export function testDenseBinaryProfileLadderShrinksK() {
  const capacity = getPayloadCapacity(1920, 1080, HDMI_MODE.BINARY_2)
  const fileSize = 10 * 1024 * 1024
  const measure = (id) => {
    const profile = getDenseBinaryBatchingProfile(id, HDMI_MODE.BINARY_2, { useModeDefault: false })
    const batched = selectFrameBatching({ capacity, fileSize, profile })
    return { id: profile.id, packets: batched.packetsPerFrame, K: Math.ceil(fileSize / batched.blockSize) }
  }
  const r = {
    large: measure('large'),
    xlarge: measure('xlarge'),
    xxlarge: measure('xxlarge'),
    huge: measure('huge')
  }
  const pass =
    r.large.id === 'large' && r.xlarge.id === 'xlarge' &&
    r.xxlarge.id === 'xxlarge' && r.huge.id === 'huge' &&
    r.huge.K < r.xxlarge.K && r.xxlarge.K < r.xlarge.K && r.xlarge.K < r.large.K &&
    r.huge.packets >= 4
  console.log('dense-binary profile ladder test:', pass ? 'PASS' : 'FAIL', r)
  return pass
}

export function testBinary1XlargeFillsFrame() {
  const originalProfile = getDenseBinaryProfile()
  setDiagnostic('denseBinaryProfile', 'xlarge')
  try {
    const capacity = getPayloadCapacity(1920, 1080, HDMI_MODE.BINARY_1)
    const selected = selectFrameBatching({
      capacity,
      fileSize: 10 * 1024 * 1024,
      profile: getDenseBinaryBatchingProfile('xlarge', HDMI_MODE.BINARY_1, { useModeDefault: false })
    })
    const fill = selected.usedBytes / capacity
    const pass = selected.packetsPerFrame > 32 &&
      fill >= 0.98 &&
      fill <= 0.99
    console.log('BINARY_1 xlarge frame-fill test:', pass ? 'PASS' : 'FAIL', {
      capacity,
      selected,
      fill
    })
    return pass
  } finally {
    setDiagnostic('denseBinaryProfile', originalProfile)
  }
}

export function testBinary1DefaultsToHugeBatching() {
  const originalProfile = getDenseBinaryProfile()
  setDiagnostic('denseBinaryProfile', 'xlarge')
  try {
    const capacity = getPayloadCapacity(1920, 1080, HDMI_MODE.BINARY_1)
    const profile = getBatchingProfile(HDMI_MODE.BINARY_1)
    const selected = selectFrameBatching({
      capacity,
      fileSize: 24 * 1024 * 1024,
      profile
    })
    const sourceBlocks = Math.ceil((24 * 1024 * 1024) / selected.blockSize)
    const pass = profile.id === 'huge' &&
      selected.packetsPerFrame <= 8 &&
      sourceBlocks < 900
    console.log('BINARY_1 huge default batching test:', pass ? 'PASS' : 'FAIL', {
      profile,
      selected,
      sourceBlocks
    })
    return pass
  } finally {
    setDiagnostic('denseBinaryProfile', originalProfile)
  }
}

export function testDenseBinaryBatchingProfileDiagnostic() {
  const helperExists = typeof getDenseBinaryBatchingProfile === 'function'
  const diagGetterExists = typeof getDenseBinaryProfile === 'function'
  const defExists = typeof getDiagnosticDefinition === 'function'
  const def = defExists ? getDiagnosticDefinition('denseBinaryProfile') : null
  const profileById = helperExists
    ? {
        safe: getDenseBinaryBatchingProfile('safe'),
        fill99: getDenseBinaryBatchingProfile('fill99'),
        medium: getDenseBinaryBatchingProfile('medium'),
        large: getDenseBinaryBatchingProfile('large'),
        xlarge: getDenseBinaryBatchingProfile('xlarge'),
        xxlarge: getDenseBinaryBatchingProfile('xxlarge'),
        huge: getDenseBinaryBatchingProfile('huge')
      }
    : {}
  const fallbackProfile = helperExists ? getDenseBinaryBatchingProfile('not-a-profile') : null
  const pass = helperExists &&
    diagGetterExists &&
    def?.default === 'xlarge' &&
    def.allowed?.length === 1 &&
    def.allowed[0] === 'xlarge' &&
    profileById.safe?.maxBlockSize === 1024 &&
    profileById.safe?.targetFrameFill === 0.90 &&
    profileById.fill99?.maxBlockSize === 1024 &&
    profileById.fill99?.targetFrameFill === 0.99 &&
    profileById.medium?.maxBlockSize === 1536 &&
    profileById.medium?.targetFrameFill === 0.99 &&
    profileById.large?.maxBlockSize === 2048 &&
    profileById.large?.targetFrameFill === 0.99 &&
    profileById.xlarge?.maxBlockSize === 4096 &&
    profileById.xlarge?.targetFrameFill === 0.99 &&
    profileById.xxlarge?.maxBlockSize === 8192 &&
    profileById.huge?.maxBlockSize === 16384 &&
    fallbackProfile?.id === 'xlarge'
  console.log('dense-binary batching profile diagnostic test:', pass ? 'PASS' : 'FAIL', {
    helperExists,
    diagGetterExists,
    definition: def,
    profileById,
    fallbackProfile
  })
  return pass
}

export function testDenseBinaryLateMixDiagnostic() {
  const diagGetterExists = typeof getDenseBinaryLateMix === 'function'
  const def = getDiagnosticDefinition('denseBinaryLateMix')
  const pass = diagGetterExists &&
    def?.default === 'fountain' &&
    def.allowed?.length === 1 &&
    def.allowed[0] === 'fountain'
  console.log('dense-binary late mix diagnostic test:', pass ? 'PASS' : 'FAIL', {
    diagGetterExists,
    definition: def
  })
  return pass
}

export function testDenseBinaryDegreeDiagnostic() {
  const diagGetterExists = typeof getDenseBinaryDegree === 'function'
  const def = getDiagnosticDefinition('denseBinaryDegree')
  const pass = diagGetterExists &&
    def?.default === 'classic' &&
    def.allowed?.length === 1 &&
    def.allowed[0] === 'classic'
  console.log('dense-binary degree diagnostic test:', pass ? 'PASS' : 'FAIL', {
    diagGetterExists,
    definition: def
  })
  return pass
}

export function testDenseBinaryLateMixPatterns() {
  const balanced = countSlotKinds(getSlotMixPatternForPass(4, {
    mode: HDMI_MODE.BINARY_3,
    slots: 13,
    lateMix: 'balanced'
  }))
  const source = countSlotKinds(getSlotMixPatternForPass(4, {
    mode: HDMI_MODE.BINARY_3,
    slots: 13,
    lateMix: 'source'
  }))

  const pass = balanced.source === 6 &&
    balanced.parity === 3 &&
    balanced.fountain === 4 &&
    source.source === 8 &&
    source.parity === 1 &&
    source.fountain === 4
  console.log('dense-binary late mix pattern test:', pass ? 'PASS' : 'FAIL', {
    balanced,
    source
  })
  return pass
}

export function testDenseBinaryPass3MixDiagnostic() {
  const def = getDiagnosticDefinition('denseBinaryPass3Mix')
  const pass = def?.default === 'balanced' &&
    def.allowed?.length === 1 &&
    def.allowed[0] === 'balanced'
  console.log('dense-binary pass-3 mix diagnostic test:', pass ? 'PASS' : 'FAIL', {
    definition: def
  })
  return pass
}

export function testDenseBinaryPass3MixPatterns() {
  const balanced = countSlotKinds(getSlotMixPatternForPass(3, {
    mode: HDMI_MODE.BINARY_3,
    slots: 13,
    lateMix: 'balanced',
    pass3Mix: 'balanced'
  }))
  const source = countSlotKinds(getSlotMixPatternForPass(3, {
    mode: HDMI_MODE.BINARY_3,
    slots: 13,
    lateMix: 'balanced',
    pass3Mix: 'source'
  }))
  const pass4 = countSlotKinds(getSlotMixPatternForPass(4, {
    mode: HDMI_MODE.BINARY_3,
    slots: 13,
    pass3Mix: 'source',
    lateMix: 'balanced'
  }))

  const pass = balanced.source === 8 &&
    balanced.parity === 2 &&
    balanced.fountain === 3 &&
    source.source === 10 &&
    source.parity === 1 &&
    source.fountain === 2 &&
    pass4.source === 6 &&
    pass4.parity === 3 &&
    pass4.fountain === 4
  console.log('dense-binary pass-3 mix pattern test:', pass ? 'PASS' : 'FAIL', {
    balanced,
    source,
    pass4
  })
  return pass
}

export function testDenseBinaryFountainTailPatterns() {
  // Pass 1 must stay pure source even when the fountain-heavy tail is selected:
  // the first systematic pass is the optimal way to deliver every block once.
  const pass1 = countSlotKinds(getSlotMixPatternForPass(1, {
    mode: HDMI_MODE.BINARY_2, slots: 13, lateMix: 'fountain'
  }))

  // Pass 2's first sweep must still deliver every parity row once (no fountain
  // yet) so the decoder's structured parity recovery has its equations.
  const pass2Sweep0 = countSlotKinds(getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_2, slots: 13, lateMix: 'fountain', paritySweepsInPass: 0
  }))

  // After the parity sweep, pass 2 goes fountain-heavy instead of re-sending
  // already-delivered source blocks. This is the whole point of the variant:
  // the tail recovery (which on a fast link happens during pass 2) stops
  // wasting bandwidth on duplicates and ships fresh fountain symbols.
  const pass2PostSweep = countSlotKinds(getSlotMixPatternForPass(2, {
    mode: HDMI_MODE.BINARY_2, slots: 13, lateMix: 'fountain', paritySweepsInPass: 1
  }))

  // Pass 3 and pass 4+ are predominantly fountain under 'fountain'.
  const pass3 = countSlotKinds(getSlotMixPatternForPass(3, {
    mode: HDMI_MODE.BINARY_2, slots: 13, lateMix: 'fountain'
  }))
  const pass4 = countSlotKinds(getSlotMixPatternForPass(4, {
    mode: HDMI_MODE.BINARY_2, slots: 13, lateMix: 'fountain'
  }))

  const pass = pass1.source === 13 && pass1.parity === 0 && pass1.fountain === 0 &&
    pass2Sweep0.fountain === 0 && pass2Sweep0.parity > 0 &&
    pass2PostSweep.source === 2 && pass2PostSweep.parity === 1 && pass2PostSweep.fountain === 10 &&
    pass3.source === 1 && pass3.parity === 1 && pass3.fountain === 11 &&
    pass4.source === 1 && pass4.parity === 0 && pass4.fountain === 12
  console.log('dense-binary fountain tail pattern test:', pass ? 'PASS' : 'FAIL', {
    pass1, pass2Sweep0, pass2PostSweep, pass3, pass4
  })
  return pass
}

export function testDenseBinaryMetadataUsesSparseSchedule() {
  const oldMode = state.mode
  const oldInterval = state.metadataIntervalFrames
  try {
    state.mode = HDMI_MODE.BINARY_3
    state.metadataIntervalFrames = 90

    const frames = [1, 2, 3, 4, 5, 12, 13, 24, 180, 181, 270, 360]
    const expected = [true, true, true, true, false, true, false, true, true, false, true, true]
    const denseBinaryObserved = frames.map(frame => shouldSendMetadata(frame))

    state.mode = HDMI_MODE.COMPAT_4
    const compat4Observed = frames.map(frame => shouldSendMetadata(frame))

    const pass = denseBinaryObserved.every((value, i) => value === expected[i]) &&
      compat4Observed.every((value, i) => value === expected[i])
    console.log('dense-binary sparse metadata schedule test:', pass ? 'PASS' : 'FAIL', {
      frames,
      expected,
      denseBinaryObserved,
      compat4Observed
    })
    return pass
  } finally {
    state.mode = oldMode
    state.metadataIntervalFrames = oldInterval
  }
}

export function testDenseBinaryMetadataSlotRotatesOnlyWhenSent() {
  const snapshot = snapshotSchedulerState()
  try {
    setupSchedulerTestState({ K: 100, KPrime: 120, packetsPerFrame: 4 })
    const frame1 = buildFramePacketBatch(1).symbolIds
    const frame2 = buildFramePacketBatch(2).symbolIds
    const frame3 = buildFramePacketBatch(3).symbolIds
    const frame4 = buildFramePacketBatch(4).symbolIds
    const frame5 = buildFramePacketBatch(5).symbolIds
    const frame12 = buildFramePacketBatch(12).symbolIds
    const frame13 = buildFramePacketBatch(13).symbolIds
    const pass =
      frame1[0] === 0 &&
      frame2[1] === 0 &&
      frame3[2] === 0 &&
      frame4[3] === 0 &&
      frame5.every(id => id !== 0) &&
      frame12[3] === 0 &&
      frame13.every(id => id !== 0) &&
      frame1.filter(id => id === 0).length === 1 &&
      frame2.filter(id => id === 0).length === 1 &&
      frame3.filter(id => id === 0).length === 1 &&
      frame4.filter(id => id === 0).length === 1 &&
      frame12.filter(id => id === 0).length === 1

    console.log('dense-binary sparse metadata slot rotation test:', pass ? 'PASS' : 'FAIL', {
      frame1,
      frame2,
      frame3,
      frame4,
      frame5,
      frame12,
      frame13
    })
    return pass
  } finally {
    Object.assign(state, snapshot)
  }
}
