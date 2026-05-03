import jsQR from 'jsqr'
import qrcode from 'qrcode-generator'

// Import test functions
import { testPRNG } from './lib/prng.js'
import { testPacketRoundtrip } from './lib/packet.js'
import { testMetadataRoundtrip } from './lib/metadata.js'
import { testEncoder } from './lib/encoder.js'
import {
  testCodecRoundtrip,
  testCodecRoundtripWithLoss,
  testCodecRoundtripDeferredMetadata,
  testTailSolverTriggerAllowsWiderBinary3Tail
} from './lib/decoder.js'
import { testParityMap, testParityRecovery, testGF2SolverSmall, testGF2SolverLarge, testSourceToParityAdjacency } from './lib/precode.js'

// Import UI modules
import { initSender, resetSender } from './lib/sender.js'
import { initReceiver, resetReceiver, autoStartReceiver } from './lib/receiver.js'

// Import CIMBAR modules
import { initCimbarSender, resetCimbarSender } from './lib/cimbar/cimbar-sender.js'
import { initCimbarReceiver, resetCimbarReceiver, autoStartCimbarReceiver } from './lib/cimbar/cimbar-receiver.js'
import { checkCompatibility } from './lib/cimbar/cimbar-loader.js'

// Import HDMI-UVC modules
import {
  initHdmiUvcSender,
  resetHdmiUvcSender,
  testPass2TwoStageSchedule,
  testParitySweepCounter,
  testPresentationScreenSelection,
  testPresentationWindowFeatures,
  testExternalDisplayReadiness,
  testExternalPresentationNativeMetrics,
  testExternalFullscreenUsesSelectedScreen,
  testExternalFullscreenFailureStopsBeforeMainFallback,
  testExternalPreparedStartUsesManualGate,
  testHdmiUvcSenderDefaults,
  testLabCardFullscreenExitRequiresReadyRestore,
  testBinary3MixedReplayPass1SourceOnly,
  testBinary3MixedReplayPass2ChangesAfterParitySweep,
  testCompat4MixedReplayKeepsSixSlotPatterns,
  testBinary3MixedReplayMetadataReducesDataSlots,
  testBinary3BatchingProfile,
  testBinary3BatchingProfileMath,
  testBinary3BatchingProfileDiagnostic,
  testBinary3LateMixDiagnostic,
  testBinary3LateMixPatterns,
  testBinary3Pass3MixDiagnostic,
  testBinary3Pass3MixPatterns,
  testBinary3StrictGeometryGate,
  testBinary3MetadataUsesSparseSchedule,
  testBinary3MetadataSlotRotatesOnlyWhenSent
} from './lib/hdmi-uvc/hdmi-uvc-sender.js'
import {
  initHdmiUvcReceiver,
  resetHdmiUvcReceiver,
  autoStartHdmiUvcReceiver,
  testReceiverFrameAcceptSignals,
  testStallCounterTicksOnDuplicateFrames
} from './lib/hdmi-uvc/hdmi-uvc-receiver.js'
import { testBinary3RecoveredLayoutKeepsLock } from './lib/hdmi-uvc/hdmi-uvc-binary3-lock.js'
import { initHdmiUvcLabReceiverUi } from './lib/hdmi-uvc/hdmi-uvc-lab-ui.js'
import { testCrc32 } from './lib/hdmi-uvc/crc32.js'
import {
  testHeaderRoundtrip,
  testAnchorRoundtrip,
  testFrameRoundtrip,
  testAnchorDetectionWithOffset,
  testNativeGeometryGuidance,
  testNative1080pGeometryCheck,
  testEffectiveOneToOnePresentationCheck,
  testClassifyStep,
  testHeaderAndPayloadBlockSizesMatchForExistingModes,
  testBinary3ConstantsRegistered,
  testBinary3FrameRoundtrip,
  testDecodeDataRegionPropagatesBinary3Levels,
  testBinary3LockedLayoutMatchesBlindSweep,
  testBinary3PrecomputedOffsetsMatchUncached,
  testDecodeDataRegionConfidence,
  testDecodeDataRegionConfidenceCompat4,
  testFrameRefactorPreservesCompat4Bytes,
  testFrameRefactorPreservesRawGrayBytes,
  testFrameRefactorPreservesRawRgbBytes,
  testFrameRefactorPreservesLuma2Bytes,
  testFrameRefactorPreservesCodebook3Bytes,
  testFrameRefactorPreservesGlyph5Bytes,
  testDecodeDataRegionRoundtripsAllModes
} from './lib/hdmi-uvc/hdmi-uvc-frame.js'
import {
  testCaptureMethodDecision,
  testReceiverRoiCaptureDefaultsToVideo,
  testComputeLockedCaptureRect,
  testLabFrameTapUsesFullCaptureRect,
  testLabFrameTapBypassesLockedCaptureRegion
} from './lib/hdmi-uvc/hdmi-uvc-receiver-capture.js'
import { testIngestCapturedFrame } from './lib/hdmi-uvc/hdmi-uvc-capture-pump.js'
import {
  testEqualChunkProbeFinds24PacketFrame,
  testPacketProbeSalvagesLowConfidenceBit
} from './lib/hdmi-uvc/hdmi-uvc-packet-probe.js'
import {
  testRankBitsByLowConfidence,
  testTrySalvageSingleBitFlip,
  testTrySalvageSlotHeaderBitFlip,
  testTryParseOrSalvageUsesFrameConfidenceOffset
} from './lib/hdmi-uvc/hdmi-uvc-salvage.js'
import {
  testWasmCrc32MatchesJs,
  testFrameCrcWasmIntegration,
  testWasmScanBrightRunsMatchesJs,
  testWasmClassifiersMatchJs,
  testWasmVsJsDetectAnchorsEquivalent,
  testWasmVsJsDecodeDataRegionEquivalent
} from './lib/hdmi-uvc/hdmi-uvc-wasm.js'
import {
  testBuildCardBinary4Geometry,
  testCardSelfDecode,
  testMeasureCardSerOnUnmodifiedCapture,
  testMeasureCardSerWithNoise,
  testMeasureCardSerExposesConfidence,
  testBuildCardLuma2Geometry,
  testBuildCardCodebook3Geometry,
  testBuildCardGlyph5Geometry,
  testCardSelfDecodeAllKinds,
  testBuildCardCandidateSeed,
  testMergeMeasureResults,
  testMeasureCardSerReportsCoverageAndWorstTile,
  testEstimatedAnchorsKeepMatchingNativeRegion,
  testMeasureCardSerReturnsNullWithoutAnchors
} from './lib/hdmi-uvc/hdmi-uvc-lab.js'

// Make libraries available globally
window.jsQR = jsQR
window['qrcode'] = qrcode

// Expose tests globally for console verification
window.testPRNG = testPRNG
window.testPacketRoundtrip = testPacketRoundtrip
window.testMetadataRoundtrip = testMetadataRoundtrip
window.testEncoder = testEncoder
window.testCodecRoundtrip = testCodecRoundtrip
window.testCodecRoundtripWithLoss = testCodecRoundtripWithLoss
window.testCodecRoundtripDeferredMetadata = testCodecRoundtripDeferredMetadata
window.testTailSolverTriggerAllowsWiderBinary3Tail = testTailSolverTriggerAllowsWiderBinary3Tail
window.testParityMap = testParityMap
window.testParityRecovery = testParityRecovery
window.testGF2SolverSmall = testGF2SolverSmall
window.testGF2SolverLarge = testGF2SolverLarge
window.testSourceToParityAdjacency = testSourceToParityAdjacency

// HDMI-UVC tests
window.testCrc32 = testCrc32
window.testHdmiHeaderRoundtrip = testHeaderRoundtrip
window.testHdmiAnchorRoundtrip = testAnchorRoundtrip
window.testHdmiFrameRoundtrip = testFrameRoundtrip
window.testHdmiAnchorOffset = testAnchorDetectionWithOffset
window.testNativeGeometryGuidance = testNativeGeometryGuidance
window.testNative1080pGeometryCheck = testNative1080pGeometryCheck
window.testEffectiveOneToOnePresentationCheck = testEffectiveOneToOnePresentationCheck
window.testClassifyStep = testClassifyStep
window.testHeaderAndPayloadBlockSizesMatchForExistingModes = testHeaderAndPayloadBlockSizesMatchForExistingModes
window.testBinary3ConstantsRegistered = testBinary3ConstantsRegistered
window.testBinary3FrameRoundtrip = testBinary3FrameRoundtrip
window.testDecodeDataRegionPropagatesBinary3Levels = testDecodeDataRegionPropagatesBinary3Levels
window.testBinary3LockedLayoutMatchesBlindSweep = testBinary3LockedLayoutMatchesBlindSweep
window.testBinary3PrecomputedOffsetsMatchUncached = testBinary3PrecomputedOffsetsMatchUncached
window.testDecodeDataRegionConfidence = testDecodeDataRegionConfidence
window.testDecodeDataRegionConfidenceCompat4 = testDecodeDataRegionConfidenceCompat4
window.testFrameRefactorPreservesCompat4Bytes = testFrameRefactorPreservesCompat4Bytes
window.testFrameRefactorPreservesRawGrayBytes = testFrameRefactorPreservesRawGrayBytes
window.testFrameRefactorPreservesRawRgbBytes = testFrameRefactorPreservesRawRgbBytes
window.testFrameRefactorPreservesLuma2Bytes = testFrameRefactorPreservesLuma2Bytes
window.testFrameRefactorPreservesCodebook3Bytes = testFrameRefactorPreservesCodebook3Bytes
window.testFrameRefactorPreservesGlyph5Bytes = testFrameRefactorPreservesGlyph5Bytes
window.testDecodeDataRegionRoundtripsAllModes = testDecodeDataRegionRoundtripsAllModes
window.testReceiverFrameAcceptSignals = testReceiverFrameAcceptSignals
window.testStallCounterTicksOnDuplicateFrames = testStallCounterTicksOnDuplicateFrames
window.testBinary3RecoveredLayoutKeepsLock = testBinary3RecoveredLayoutKeepsLock
window.testPass2TwoStageSchedule = testPass2TwoStageSchedule
window.testParitySweepCounter = testParitySweepCounter
window.testPresentationScreenSelection = testPresentationScreenSelection
window.testPresentationWindowFeatures = testPresentationWindowFeatures
window.testExternalDisplayReadiness = testExternalDisplayReadiness
window.testExternalPresentationNativeMetrics = testExternalPresentationNativeMetrics
window.testExternalFullscreenUsesSelectedScreen = testExternalFullscreenUsesSelectedScreen
window.testExternalFullscreenFailureStopsBeforeMainFallback = testExternalFullscreenFailureStopsBeforeMainFallback
window.testExternalPreparedStartUsesManualGate = testExternalPreparedStartUsesManualGate
window.testHdmiUvcSenderDefaults = testHdmiUvcSenderDefaults
window.testLabCardFullscreenExitRequiresReadyRestore = testLabCardFullscreenExitRequiresReadyRestore
window.testBinary3MixedReplayPass1SourceOnly = testBinary3MixedReplayPass1SourceOnly
window.testBinary3MixedReplayPass2ChangesAfterParitySweep = testBinary3MixedReplayPass2ChangesAfterParitySweep
window.testCompat4MixedReplayKeepsSixSlotPatterns = testCompat4MixedReplayKeepsSixSlotPatterns
window.testBinary3MixedReplayMetadataReducesDataSlots = testBinary3MixedReplayMetadataReducesDataSlots
window.testBinary3BatchingProfile = testBinary3BatchingProfile
window.testBinary3BatchingProfileMath = testBinary3BatchingProfileMath
window.testBinary3BatchingProfileDiagnostic = testBinary3BatchingProfileDiagnostic
window.testBinary3LateMixDiagnostic = testBinary3LateMixDiagnostic
window.testBinary3LateMixPatterns = testBinary3LateMixPatterns
window.testBinary3Pass3MixDiagnostic = testBinary3Pass3MixDiagnostic
window.testBinary3Pass3MixPatterns = testBinary3Pass3MixPatterns
window.testBinary3StrictGeometryGate = testBinary3StrictGeometryGate
window.testBinary3MetadataUsesSparseSchedule = testBinary3MetadataUsesSparseSchedule
window.testBinary3MetadataSlotRotatesOnlyWhenSent = testBinary3MetadataSlotRotatesOnlyWhenSent
window.testCaptureMethodDecision = testCaptureMethodDecision
window.testReceiverRoiCaptureDefaultsToVideo = testReceiverRoiCaptureDefaultsToVideo
window.testComputeLockedCaptureRect = testComputeLockedCaptureRect
window.testLabFrameTapUsesFullCaptureRect = testLabFrameTapUsesFullCaptureRect
window.testLabFrameTapBypassesLockedCaptureRegion = testLabFrameTapBypassesLockedCaptureRegion
window.testIngestCapturedFrame = testIngestCapturedFrame
window.testEqualChunkProbeFinds24PacketFrame = testEqualChunkProbeFinds24PacketFrame
window.testPacketProbeSalvagesLowConfidenceBit = testPacketProbeSalvagesLowConfidenceBit
window.testRankBitsByLowConfidence = testRankBitsByLowConfidence
window.testTrySalvageSingleBitFlip = testTrySalvageSingleBitFlip
window.testTrySalvageSlotHeaderBitFlip = testTrySalvageSlotHeaderBitFlip
window.testTryParseOrSalvageUsesFrameConfidenceOffset = testTryParseOrSalvageUsesFrameConfidenceOffset
window.testWasmCrc32MatchesJs = testWasmCrc32MatchesJs
window.testFrameCrcWasmIntegration = testFrameCrcWasmIntegration
window.testWasmScanBrightRunsMatchesJs = testWasmScanBrightRunsMatchesJs
window.testWasmClassifiersMatchJs = testWasmClassifiersMatchJs
window.testWasmVsJsDetectAnchorsEquivalent = testWasmVsJsDetectAnchorsEquivalent
window.testWasmVsJsDecodeDataRegionEquivalent = testWasmVsJsDecodeDataRegionEquivalent
window.testBuildCardBinary4Geometry = testBuildCardBinary4Geometry
window.testCardSelfDecode = testCardSelfDecode
window.testMeasureCardSerOnUnmodifiedCapture = testMeasureCardSerOnUnmodifiedCapture
window.testMeasureCardSerWithNoise = testMeasureCardSerWithNoise
window.testMeasureCardSerExposesConfidence = testMeasureCardSerExposesConfidence
window.testBuildCardLuma2Geometry = testBuildCardLuma2Geometry
window.testBuildCardCodebook3Geometry = testBuildCardCodebook3Geometry
window.testBuildCardGlyph5Geometry = testBuildCardGlyph5Geometry
window.testCardSelfDecodeAllKinds = testCardSelfDecodeAllKinds
window.testBuildCardCandidateSeed = testBuildCardCandidateSeed
window.testMergeMeasureResults = testMergeMeasureResults
window.testMeasureCardSerReportsCoverageAndWorstTile = testMeasureCardSerReportsCoverageAndWorstTile
window.testEstimatedAnchorsKeepMatchingNativeRegion = testEstimatedAnchorsKeepMatchingNativeRegion
window.testMeasureCardSerReturnsNullWithoutAnchors = testMeasureCardSerReturnsNullWithoutAnchors

// ============ ERROR HANDLING ============
function showError(message) {
  const banner = document.getElementById('error-banner')
  const messageEl = document.getElementById('error-message')
  messageEl.textContent = message
  banner.classList.remove('hidden')
  setTimeout(hideError, 10000)
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden')
}

document.getElementById('error-dismiss').onclick = hideError

// ============ SCREEN NAVIGATION ============
const screens = {
  modeSelect: document.getElementById('mode-select'),
  sender: document.getElementById('sender'),
  receiver: document.getElementById('receiver'),
  cimbarSender: document.getElementById('cimbar-sender'),
  cimbarReceiver: document.getElementById('cimbar-receiver'),
  hdmiUvcSender: document.getElementById('hdmi-uvc-sender'),
  hdmiUvcReceiver: document.getElementById('hdmi-uvc-receiver')
}

function showScreen(screenId) {
  Object.values(screens).forEach(s => s.classList.remove('active'))
  screens[screenId].classList.add('active')
}

// Mode selection buttons
document.getElementById('btn-send').onclick = () => showScreen('sender')
document.getElementById('btn-receive').onclick = () => {
  showScreen('receiver')
  autoStartReceiver()
}

// CIMBAR mode selection buttons
document.getElementById('btn-cimbar-send').onclick = () => {
  showScreen('cimbarSender')
}

document.getElementById('btn-cimbar-receive').onclick = () => {
  showScreen('cimbarReceiver')
  autoStartCimbarReceiver()
}

// HDMI-UVC mode selection buttons
document.getElementById('btn-hdmi-uvc-send').onclick = () => {
  showScreen('hdmiUvcSender')
}

document.getElementById('btn-hdmi-uvc-receive').onclick = () => {
  showScreen('hdmiUvcReceiver')
  autoStartHdmiUvcReceiver()
}

// Back buttons with cleanup
document.querySelectorAll('.back-btn').forEach(btn => {
  btn.onclick = async () => {
    // Clean up QR state
    resetSender()
    resetReceiver()

    // Clean up CIMBAR state
    resetCimbarSender()
    resetCimbarReceiver()

    // Clean up HDMI-UVC state
    await resetHdmiUvcSender()
    resetHdmiUvcReceiver()

    // Return to mode selection
    showScreen('modeSelect')
  }
})

// ============ INITIALIZE MODULES ============
initSender(showError)
initReceiver(showError)

// Initialize CIMBAR modules
initCimbarSender(showError)
initCimbarReceiver(showError)

// Initialize HDMI-UVC modules
initHdmiUvcSender(showError)
initHdmiUvcReceiver(showError)
initHdmiUvcLabReceiverUi()

// Check CIMBAR compatibility and disable buttons if not supported
const compat = checkCompatibility()
if (!compat.compatible) {
  const cimbarBtns = [
    document.getElementById('btn-cimbar-send'),
    document.getElementById('btn-cimbar-receive')
  ]
  cimbarBtns.forEach(btn => {
    btn.disabled = true
    btn.title = 'Not supported: ' + compat.issues.join(', ')
  })
}

// ============ TEST SUITE ============
async function runAllTests() {
  console.log('=== BEAM ME UP TEST SUITE ===')

  const results = {
    prng: testPRNG(),
    packet: testPacketRoundtrip(),
    metadata: testMetadataRoundtrip(),
    parityMap: testParityMap(),
    parityRecovery: testParityRecovery(),
    srcParityAdj: testSourceToParityAdjacency(),
    gf2Small: await testGF2SolverSmall(),
    gf2Large: await testGF2SolverLarge(),
    encoder: await testEncoder(),
    codec: await testCodecRoundtrip(),
    codecWithLoss: await testCodecRoundtripWithLoss(),
    codecDeferredMetadata: await testCodecRoundtripDeferredMetadata(),
    tailSolverWiderBinary3Tail: testTailSolverTriggerAllowsWiderBinary3Tail(),
    // HDMI-UVC tests
    crc32: testCrc32(),
    hdmiHeader: testHeaderRoundtrip(),
    hdmiAnchor: testAnchorRoundtrip(),
    hdmiFrame: testFrameRoundtrip(),
    hdmiAnchorOffset: testAnchorDetectionWithOffset(),
    hdmiNativeGeometryGuidance: testNativeGeometryGuidance(),
    hdmiNative1080pGeometryCheck: testNative1080pGeometryCheck(),
    hdmiEffectiveOneToOnePresentation: testEffectiveOneToOnePresentationCheck(),
    hdmiClassifyStep: testClassifyStep(),
    hdmiHeaderPayloadBlockSizes: testHeaderAndPayloadBlockSizesMatchForExistingModes(),
    hdmiBinary3Constants: testBinary3ConstantsRegistered(),
    hdmiBinary3FrameRoundtrip: testBinary3FrameRoundtrip(),
    hdmiBinary3LevelsPropagation: testDecodeDataRegionPropagatesBinary3Levels(),
    hdmiBinary3LockedLayout: testBinary3LockedLayoutMatchesBlindSweep(),
    hdmiBinary3PrecomputedOffsets: testBinary3PrecomputedOffsetsMatchUncached(),
    hdmiDecodeConfidenceBinary3: testDecodeDataRegionConfidence(),
    hdmiDecodeConfidenceCompat4: testDecodeDataRegionConfidenceCompat4(),
    hdmiFrameRefactorCompat4: testFrameRefactorPreservesCompat4Bytes(),
    hdmiFrameRefactorRawGray: testFrameRefactorPreservesRawGrayBytes(),
    hdmiFrameRefactorRawRgb: testFrameRefactorPreservesRawRgbBytes(),
    hdmiFrameRefactorLuma2: testFrameRefactorPreservesLuma2Bytes(),
    hdmiFrameRefactorCodebook3: testFrameRefactorPreservesCodebook3Bytes(),
    hdmiFrameRefactorGlyph5: testFrameRefactorPreservesGlyph5Bytes(),
    hdmiDecodeDataRegionAllModes: testDecodeDataRegionRoundtripsAllModes(),
    receiverFrameSignals: testReceiverFrameAcceptSignals(),
    stallCounterDuplicateFrames: await testStallCounterTicksOnDuplicateFrames(),
    binary3RecoveredLayoutKeepsLock: testBinary3RecoveredLayoutKeepsLock(),
    twoStagePass2Schedule: testPass2TwoStageSchedule(),
    paritySweepCounter: testParitySweepCounter(),
    presentationScreenSelection: testPresentationScreenSelection(),
    presentationWindowFeatures: testPresentationWindowFeatures(),
    externalDisplayReadiness: testExternalDisplayReadiness(),
    externalPresentationNativeMetrics: testExternalPresentationNativeMetrics(),
    externalFullscreenUsesSelectedScreen: testExternalFullscreenUsesSelectedScreen(),
    externalFullscreenFailureStopsBeforeMainFallback: await testExternalFullscreenFailureStopsBeforeMainFallback(),
    externalPreparedStartManualGate: testExternalPreparedStartUsesManualGate(),
    hdmiUvcSenderDefaults: testHdmiUvcSenderDefaults(),
    labCardFullscreenExitRestore: testLabCardFullscreenExitRequiresReadyRestore(),
    binary3MixedReplayPass1SourceOnly: testBinary3MixedReplayPass1SourceOnly(),
    binary3MixedReplayPass2ParitySweepTransition: testBinary3MixedReplayPass2ChangesAfterParitySweep(),
    compat4MixedReplaySixSlotPatterns: testCompat4MixedReplayKeepsSixSlotPatterns(),
    binary3MixedReplayMetadataDataSlots: testBinary3MixedReplayMetadataReducesDataSlots(),
    binary3BatchingProfile: testBinary3BatchingProfile(),
    binary3BatchingProfileMath: testBinary3BatchingProfileMath(),
    binary3BatchingProfileDiagnostic: testBinary3BatchingProfileDiagnostic(),
    binary3LateMixDiagnostic: testBinary3LateMixDiagnostic(),
    binary3LateMixPatterns: testBinary3LateMixPatterns(),
    binary3Pass3MixDiagnostic: testBinary3Pass3MixDiagnostic(),
    binary3Pass3MixPatterns: testBinary3Pass3MixPatterns(),
    binary3StrictGeometryGate: testBinary3StrictGeometryGate(),
    binary3MetadataSparseSchedule: testBinary3MetadataUsesSparseSchedule(),
    binary3MetadataSlotRotatesOnlyWhenSent: testBinary3MetadataSlotRotatesOnlyWhenSent(),
    captureMethodDecision: testCaptureMethodDecision(),
    receiverRoiCaptureDefault: testReceiverRoiCaptureDefaultsToVideo(),
    computeLockedCaptureRect: testComputeLockedCaptureRect(),
    labFrameTapFullCaptureRect: testLabFrameTapUsesFullCaptureRect(),
    labFrameTapBypassesLockedCapture: testLabFrameTapBypassesLockedCaptureRegion(),
    ingestCapturedFrame: await testIngestCapturedFrame(),
    equalChunkProbe24PacketFrame: testEqualChunkProbeFinds24PacketFrame(),
    packetProbeSoftSalvage: testPacketProbeSalvagesLowConfidenceBit(),
    salvageRankBits: testRankBitsByLowConfidence(),
    salvageSingleBit: testTrySalvageSingleBitFlip(),
    salvageHeaderBit: testTrySalvageSlotHeaderBitFlip(),
    salvageFrameConfidenceOffset: testTryParseOrSalvageUsesFrameConfidenceOffset(),
    wasmCrc32: await testWasmCrc32MatchesJs(),
    frameCrcWasmIntegration: await testFrameCrcWasmIntegration(),
    wasmScanBrightRuns: await testWasmScanBrightRunsMatchesJs(),
    wasmClassifiers: await testWasmClassifiersMatchJs(),
    wasmVsJsDetectAnchors: await testWasmVsJsDetectAnchorsEquivalent(),
    wasmVsJsDecodeDataRegion: await testWasmVsJsDecodeDataRegionEquivalent(),
    labBinary4Geometry: testBuildCardBinary4Geometry(),
    labCardSelfDecode: testCardSelfDecode(),
    labSerUnmodified: testMeasureCardSerOnUnmodifiedCapture(),
    labSerNoise: testMeasureCardSerWithNoise(),
    labConfidence: testMeasureCardSerExposesConfidence(),
    labLuma2Geometry: testBuildCardLuma2Geometry(),
    labCodebook3Geometry: testBuildCardCodebook3Geometry(),
    labGlyph5Geometry: testBuildCardGlyph5Geometry(),
    labCandidateSeed: testBuildCardCandidateSeed(),
    labSelfDecodeAllKinds: testCardSelfDecodeAllKinds(),
    labMergeResults: testMergeMeasureResults(),
    labCoverageWorstTile: testMeasureCardSerReportsCoverageAndWorstTile(),
    labEstimatedAnchorRegion: testEstimatedAnchorsKeepMatchingNativeRegion(),
    labNoAnchorsNull: testMeasureCardSerReturnsNullWithoutAnchors()
  }

  const passed = Object.values(results).every(r => r)
  console.log('=== RESULTS ===')
  console.table(results)
  console.log(passed ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED')

  return passed
}

// Expose test runner globally
window.runAllTests = runAllTests

// Auto-run tests if ?test query param present
if (location.search.includes('test')) {
  runAllTests()
}
