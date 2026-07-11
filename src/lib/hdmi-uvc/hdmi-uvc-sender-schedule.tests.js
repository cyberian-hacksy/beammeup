// Test functions for hdmi-uvc-sender-schedule.js, extracted from the
// production module so the scheduler ships without its test suite.
// Registered via src/test-suite.js (?test). The *Diagnostic tests exercise
// non-default knob values through setDiagnostic — they are the reason the
// diagnostics experiment harness keeps its widened-value code paths tested.
import {
  selectFrameBatching,
  getBatchingProfile,
  nextFrameSymbolId,
  buildFramePacketBatch,
  _internals
} from './hdmi-uvc-sender-schedule.js'
import { HDMI_MODE } from './hdmi-uvc-constants.js'
import { getPayloadCapacity } from './hdmi-uvc-frame.js'
import {
  getDenseBinaryDegree,
  getDenseBinaryLateMix,
  getDenseBinaryProfile,
  getDiagnosticDefinition,
  setDiagnostic
} from './hdmi-uvc-diagnostics.js'
import { state } from './hdmi-uvc-sender-state.js'

const {
  getDenseBinaryBatchingProfile,
  shouldSendMetadata,
  getSlotMixPatternForPass,
  describeSlotMixPattern,
  getSystematicPassIndexOffset,
  buildArqPacketBatch
} = _internals

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
