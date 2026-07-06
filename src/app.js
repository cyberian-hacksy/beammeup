import jsQR from 'jsqr'
import qrcode from 'qrcode-generator'

// Import test functions
import { testPRNG } from './lib/prng.js'
import { testPacketRoundtrip } from './lib/packet.js'
import { testXorBytesInto } from './lib/xor.js'
import { testMetadataRoundtrip, testMetadataNoRedundancyFlag, testMetadataRepairIdleFlag } from './lib/metadata.js'
import { testEncoder, testEncoderNoRedundancy } from './lib/encoder.js'
import { testFountainRippleVariant } from './lib/fountain-symbol.js'
import {
  testCodecRoundtrip,
  testCodecRoundtripWithLoss,
  testCodecRoundtripDeferredMetadata,
  testCodecRoundtripNoRedundancy,
  testNoRedundancyLoopRecovers,
  testTailSolverTriggerAllowsWiderDenseBinaryTail
} from './lib/decoder.js'
import { testParityMap, testParityRecovery, testGF2SolverSmall, testGF2SolverLarge, testSourceToParityAdjacency } from './lib/precode.js'
import { testArqMessageRoundtrip, testArqMessageRejectsCorruption, testMissingSetCodecRoundtrip, testMissingSetAdaptiveChoosesSmaller, testMissingSetCodecHighUint32Roundtrip, testMissingSetSparseLargeRangeUsesDeltaEncoding, testMissingSetBitmapDecodeBoundsToPayload } from './lib/arq/arq-protocol.js'
import { testFragmentReassembleRoundtrip, testFragmentOutOfOrderAndDup, testFragmentMissingDrops, testFragmentSupportsLargeCounts, testFragmentReusedIdResetsStaleEntry, testFragmentReusedIdConflictResetsStaleEntry } from './lib/arq/arq-fragment.js'
import { testArqReceiverBuildsNackForGaps, testArqReceiverCompleteOnlyWhenFullAndHashOk, testArqReceiverThrottlesDuplicateNacks, testArqReceiverCoalescesChangedNacksDuringProgress, testArqReceiverSendsChangedNackAfterHold, testArqBeaconLogActionSkipsSuppressedNack, testArqReceiverSuppressesEmptyNackWhileHashPending, testArqReceiverCanRequestFullRepairAfterHashMismatch, testArqReceiverCapsCompleteBursts, testArqReceiverReplenishesCompleteWhileBeaconsContinue } from './lib/arq/arq-receiver.js'
import { testArqSenderConsumesNackIntoWorkList, testArqSenderIgnoresStaleSeq, testArqSenderAcceptsWrappedSeq, testArqSenderFallbackAfterTimeout, testArqSenderFallsBackOnRepeatedUnchangedNacks, testArqSenderDoesNotFallbackWhileNacksProgress, testArqSenderIgnoresDuplicateNackDuringActiveRepair, testArqSenderRetriesDuplicateNackAfterRepairExhausted, testArqSenderCompleteStops, testArqSenderCompleteIsTerminal, testArqSenderDisplayProgressStableAcrossRepair } from './lib/arq/arq-sender.js'
import { testArqGoodputBeatsReloop } from './lib/arq/arq-sim.js'
import { testBackchannelRegistry, testBackchannelDefaultMtuIsBleSafe } from './lib/arq/backchannel.js'
import { testArqHelperStatusView, testShouldAutoConnectArqHelper } from './lib/arq/helper-status.js'
import { testBleGattSenderCopiesNotificationBuffer, testBleGattSenderUsesBroadDiscoveryWithOptionalService } from './lib/arq/transports/ble-gatt-sender.js'

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
  testBinary1RecommendedFpsIs60,
  testLabCardFullscreenExitRequiresReadyRestore,
  testDenseBinaryMixedReplayPass1SourceOnly,
  testYoloModeSourceOnlyAllPasses,
  testDenseBinaryMixedReplayPass2ChangesAfterParitySweep,
  testCompat4MixedReplayKeepsSixSlotPatterns,
  testDenseBinaryMixedReplayMetadataReducesDataSlots,
  testDenseBinaryBatchingProfile,
  testBinary2BatchingAndSchedule,
  testDenseBinaryBatchingProfileMath,
  testDenseBinaryBatchingProfileDiagnostic,
  testDenseBinaryXlargeShrinksBlockCount,
  testDenseBinaryProfileLadderShrinksK,
  testBinary2UsesDenseBatchingProfile,
  testBinary1XlargeFillsFrame,
  testBinary1DefaultsToHugeBatching,
  testBinary1Pass2ReplaysFromStart,
  testBinary1StartsDataImmediately,
  testBinary1Pass2StartsMixedReplay,
  testBinary1UsesTimerPacedRender,
  testBinary1PacingLocksTimer,
  testSenderFrameSignatureSummary,
  testSenderFrameSymbolKindSummary,
  testDenseBinaryPass2SweepMixDiagnostic,
  testDenseBinaryPass2SweepMixPatterns,
  testBinary1CadenceFpsPresets,
  testDenseBinaryLateMixDiagnostic,
  testDenseBinaryDegreeDiagnostic,
  testDenseBinaryLateMixPatterns,
  testDenseBinaryFountainTailPatterns,
  testDenseBinaryPass3MixDiagnostic,
  testDenseBinaryPass3MixPatterns,
  testDenseBinaryStrictGeometryGate,
  testDenseBinaryMetadataUsesSparseSchedule,
  testDenseBinaryMetadataSlotRotatesOnlyWhenSent,
  testSenderWorkListSchedule,
  testArqBatchEmitsClaimedMetadataAtWorkListTail,
  testArqRepairBatchCarriesMetadataWhenRequested,
  testArqBeaconBatchCarriesReplayData
} from './lib/hdmi-uvc/hdmi-uvc-sender.js'
import {
  initHdmiUvcReceiver,
  resetHdmiUvcReceiver,
  autoStartHdmiUvcReceiver,
  testReceiverFrameAcceptSignals,
  testDenseBinaryLockedLayoutOffsetsCoverBinary2,
  testLockedFastPerfBreakdownSummary,
  testReceiverFrameUseSummary,
  testReceiverFrameSignatureSummary,
  testReceiverHeaderOnlyFrameCanLock,
  testReceiverLuma1CalFrameTreatedAsSuccess,
  testReceiverWasmCaptureRoundtrip,
  testReadWorkerDecodesSyntheticFrame,
  testReceiverAnchorDiagnosticsQuietByDefault,
  testStallCounterTicksOnDuplicateFrames
} from './lib/hdmi-uvc/hdmi-uvc-receiver.js'
import {
  testBinary3RecoveredLayoutKeepsLock,
  testBinary2RecoveredLayoutKeepsLock
} from './lib/hdmi-uvc/hdmi-uvc-dense-binary-lock.js'
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
  testBinary2ConstantsRegistered,
  testBinary1ConstantsRegistered,
  testLuma1ConstantsRegistered,
  testHdmiModesExcludeRemovedMode7,
  testBinary3FrameRoundtrip,
  testBinary2FrameRoundtrip,
  testBinary1FrameRoundtrip,
  testLuma1FrameRoundtrip,
  testLuma1WarpedIntermediateLevelsDecode,
  testLuma1BlurredPayloadBandDecode,
  testLuma1LegacyNoGuardDecode,
  testLuma1OffsetLayoutSamplesStripsWithPhase,
  testLuma1FailedDecodeAttachesDebug,
  testLuma1CalibrationPayloadDetection,
  testLuma1SweepBudgetAndDebugGate,
  testLuma1CalibrationFrameAnalysis,
  testLuma1CalibrationSharpenFit,
  testLuma1SharpenCorrectionRoundtrip,
  testDecodeDataRegionPropagatesDenseBinaryLevels,
  testDenseBinaryLockedLayoutMatchesBlindSweep,
  testDenseBinaryPrecomputedOffsetsMatchUncached,
  testBinary1LockedPayloadReaderMatchesGeneric,
  testBinary1LockedPayloadReaderUsesBytePacker,
  testLuma1LockedPayloadReaderMatchesGeneric,
  testBinary2LockedPayloadReaderMatchesGeneric,
  testBinary2LockedPayloadReaderTranslatesCroppedOffsets,
  testBinary2SinglePixelLockedPayloadReader,
  testDenseBinaryPrecomputedOffsetsIgnoreMismatchedCrop,
  testReadPayloadWithLayoutAcceptsImageDataWrapper,
  testDenseBinaryLayoutReadSkipsUnusedConfidenceBuffer,
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
  testWorkerTrackTransferFallbackUsesMain,
  testWorkerTransferClockStartsOnFirstAcceptedFrame,
  testWorkerStartFailureResumesMainCapture,
  testReceiverExpectedPacketSizeWaitsForSession,
  testReceiverRoiCaptureBenchmarksWhenVideoFrameAvailable,
  testReceiverSlowRoiCaptureTriggersRebenchmark,
  testReceiverActiveTransferSuppressesSlowRoiRebenchmark,
  testReceiverHeaderOnlyFrameStartsRoiWarmupBenchmark,
  testReceiverPreSignalRoiStartsWarmupBenchmark,
  testReceiverHotPerfFrameGate,
  testReceiverCapturePathBenchmarkSuppressesChurn,
  testComputeLockedCaptureRect,
  testLabFrameTapUsesFullCaptureRect,
  testLabFrameTapBypassesLockedCaptureRegion
} from './lib/hdmi-uvc/hdmi-uvc-receiver-capture.js'
import { testIngestCapturedFrame, testIngestCapturedFrameSkipsArqWhenDisabled } from './lib/hdmi-uvc/hdmi-uvc-capture-pump.js'
import {
  testEqualChunkProbeFinds24PacketFrame,
  testEqualChunkProbeFinds59PacketFrame,
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
  testWasmPackBinary1PayloadMatchesJs,
  testWasmProbeExpectedPacketsMatchesJs,
  testWasmVsJsDetectAnchorsEquivalent,
  testWasmVsJsLuma1ReadEquivalent,
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
window.testXorBytesInto = testXorBytesInto
window.testMetadataRoundtrip = testMetadataRoundtrip
window.testMetadataNoRedundancyFlag = testMetadataNoRedundancyFlag
window.testMetadataRepairIdleFlag = testMetadataRepairIdleFlag
window.testEncoder = testEncoder
window.testEncoderNoRedundancy = testEncoderNoRedundancy
window.testFountainRippleVariant = testFountainRippleVariant
window.testCodecRoundtrip = testCodecRoundtrip
window.testCodecRoundtripWithLoss = testCodecRoundtripWithLoss
window.testCodecRoundtripDeferredMetadata = testCodecRoundtripDeferredMetadata
window.testCodecRoundtripNoRedundancy = testCodecRoundtripNoRedundancy
window.testNoRedundancyLoopRecovers = testNoRedundancyLoopRecovers
window.testTailSolverTriggerAllowsWiderDenseBinaryTail = testTailSolverTriggerAllowsWiderDenseBinaryTail
window.testParityMap = testParityMap
window.testParityRecovery = testParityRecovery
window.testGF2SolverSmall = testGF2SolverSmall
window.testGF2SolverLarge = testGF2SolverLarge
window.testSourceToParityAdjacency = testSourceToParityAdjacency
window.testArqMessageRoundtrip = testArqMessageRoundtrip
window.testArqMessageRejectsCorruption = testArqMessageRejectsCorruption
window.testMissingSetCodecRoundtrip = testMissingSetCodecRoundtrip
window.testMissingSetAdaptiveChoosesSmaller = testMissingSetAdaptiveChoosesSmaller
window.testMissingSetCodecHighUint32Roundtrip = testMissingSetCodecHighUint32Roundtrip
window.testMissingSetSparseLargeRangeUsesDeltaEncoding = testMissingSetSparseLargeRangeUsesDeltaEncoding
window.testMissingSetBitmapDecodeBoundsToPayload = testMissingSetBitmapDecodeBoundsToPayload
window.testFragmentReassembleRoundtrip = testFragmentReassembleRoundtrip
window.testFragmentOutOfOrderAndDup = testFragmentOutOfOrderAndDup
window.testFragmentMissingDrops = testFragmentMissingDrops
window.testFragmentSupportsLargeCounts = testFragmentSupportsLargeCounts
window.testFragmentReusedIdResetsStaleEntry = testFragmentReusedIdResetsStaleEntry
window.testFragmentReusedIdConflictResetsStaleEntry = testFragmentReusedIdConflictResetsStaleEntry
window.testArqReceiverBuildsNackForGaps = testArqReceiverBuildsNackForGaps
window.testArqReceiverCompleteOnlyWhenFullAndHashOk = testArqReceiverCompleteOnlyWhenFullAndHashOk
window.testArqReceiverSuppressesEmptyNackWhileHashPending = testArqReceiverSuppressesEmptyNackWhileHashPending
window.testArqReceiverCanRequestFullRepairAfterHashMismatch = testArqReceiverCanRequestFullRepairAfterHashMismatch
window.testArqReceiverThrottlesDuplicateNacks = testArqReceiverThrottlesDuplicateNacks
window.testArqReceiverCoalescesChangedNacksDuringProgress = testArqReceiverCoalescesChangedNacksDuringProgress
window.testArqReceiverSendsChangedNackAfterHold = testArqReceiverSendsChangedNackAfterHold
window.testArqBeaconLogActionSkipsSuppressedNack = testArqBeaconLogActionSkipsSuppressedNack
window.testArqReceiverCapsCompleteBursts = testArqReceiverCapsCompleteBursts
window.testArqReceiverReplenishesCompleteWhileBeaconsContinue = testArqReceiverReplenishesCompleteWhileBeaconsContinue
window.testArqSenderConsumesNackIntoWorkList = testArqSenderConsumesNackIntoWorkList
window.testArqSenderIgnoresStaleSeq = testArqSenderIgnoresStaleSeq
window.testArqSenderAcceptsWrappedSeq = testArqSenderAcceptsWrappedSeq
window.testArqSenderFallbackAfterTimeout = testArqSenderFallbackAfterTimeout
window.testArqSenderFallsBackOnRepeatedUnchangedNacks = testArqSenderFallsBackOnRepeatedUnchangedNacks
window.testArqSenderDoesNotFallbackWhileNacksProgress = testArqSenderDoesNotFallbackWhileNacksProgress
window.testArqSenderIgnoresDuplicateNackDuringActiveRepair = testArqSenderIgnoresDuplicateNackDuringActiveRepair
window.testArqSenderRetriesDuplicateNackAfterRepairExhausted = testArqSenderRetriesDuplicateNackAfterRepairExhausted
window.testArqSenderCompleteStops = testArqSenderCompleteStops
window.testArqSenderCompleteIsTerminal = testArqSenderCompleteIsTerminal
window.testArqSenderDisplayProgressStableAcrossRepair = testArqSenderDisplayProgressStableAcrossRepair
window.testArqGoodputBeatsReloop = testArqGoodputBeatsReloop
window.testBackchannelRegistry = testBackchannelRegistry
window.testBackchannelDefaultMtuIsBleSafe = testBackchannelDefaultMtuIsBleSafe
window.testArqHelperStatusView = testArqHelperStatusView
window.testShouldAutoConnectArqHelper = testShouldAutoConnectArqHelper
window.testBleGattSenderCopiesNotificationBuffer = testBleGattSenderCopiesNotificationBuffer
window.testBleGattSenderUsesBroadDiscoveryWithOptionalService = testBleGattSenderUsesBroadDiscoveryWithOptionalService

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
window.testBinary2ConstantsRegistered = testBinary2ConstantsRegistered
window.testBinary1ConstantsRegistered = testBinary1ConstantsRegistered
window.testLuma1ConstantsRegistered = testLuma1ConstantsRegistered
window.testHdmiModesExcludeRemovedMode7 = testHdmiModesExcludeRemovedMode7
window.testBinary3FrameRoundtrip = testBinary3FrameRoundtrip
window.testBinary2FrameRoundtrip = testBinary2FrameRoundtrip
window.testBinary1FrameRoundtrip = testBinary1FrameRoundtrip
window.testLuma1FrameRoundtrip = testLuma1FrameRoundtrip
window.testLuma1WarpedIntermediateLevelsDecode = testLuma1WarpedIntermediateLevelsDecode
window.testLuma1BlurredPayloadBandDecode = testLuma1BlurredPayloadBandDecode
window.testLuma1LegacyNoGuardDecode = testLuma1LegacyNoGuardDecode
window.testLuma1OffsetLayoutSamplesStripsWithPhase = testLuma1OffsetLayoutSamplesStripsWithPhase
window.testLuma1FailedDecodeAttachesDebug = testLuma1FailedDecodeAttachesDebug
window.testLuma1CalibrationPayloadDetection = testLuma1CalibrationPayloadDetection
window.testLuma1SweepBudgetAndDebugGate = testLuma1SweepBudgetAndDebugGate
window.testLuma1CalibrationFrameAnalysis = testLuma1CalibrationFrameAnalysis
window.testLuma1CalibrationSharpenFit = testLuma1CalibrationSharpenFit
window.testLuma1SharpenCorrectionRoundtrip = testLuma1SharpenCorrectionRoundtrip
window.testDecodeDataRegionPropagatesDenseBinaryLevels = testDecodeDataRegionPropagatesDenseBinaryLevels
window.testDenseBinaryLockedLayoutMatchesBlindSweep = testDenseBinaryLockedLayoutMatchesBlindSweep
window.testDenseBinaryPrecomputedOffsetsMatchUncached = testDenseBinaryPrecomputedOffsetsMatchUncached
window.testBinary1LockedPayloadReaderMatchesGeneric = testBinary1LockedPayloadReaderMatchesGeneric
window.testBinary1LockedPayloadReaderUsesBytePacker = testBinary1LockedPayloadReaderUsesBytePacker
window.testLuma1LockedPayloadReaderMatchesGeneric = testLuma1LockedPayloadReaderMatchesGeneric
window.testBinary2LockedPayloadReaderMatchesGeneric = testBinary2LockedPayloadReaderMatchesGeneric
window.testBinary2LockedPayloadReaderTranslatesCroppedOffsets = testBinary2LockedPayloadReaderTranslatesCroppedOffsets
window.testBinary2SinglePixelLockedPayloadReader = testBinary2SinglePixelLockedPayloadReader
window.testDenseBinaryPrecomputedOffsetsIgnoreMismatchedCrop = testDenseBinaryPrecomputedOffsetsIgnoreMismatchedCrop
window.testReadPayloadWithLayoutAcceptsImageDataWrapper = testReadPayloadWithLayoutAcceptsImageDataWrapper
window.testDenseBinaryLayoutReadSkipsUnusedConfidenceBuffer = testDenseBinaryLayoutReadSkipsUnusedConfidenceBuffer
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
window.testDenseBinaryLockedLayoutOffsetsCoverBinary2 = testDenseBinaryLockedLayoutOffsetsCoverBinary2
window.testLockedFastPerfBreakdownSummary = testLockedFastPerfBreakdownSummary
window.testReceiverFrameUseSummary = testReceiverFrameUseSummary
window.testReceiverFrameSignatureSummary = testReceiverFrameSignatureSummary
window.testReceiverHeaderOnlyFrameCanLock = testReceiverHeaderOnlyFrameCanLock
window.testReceiverLuma1CalFrameTreatedAsSuccess = testReceiverLuma1CalFrameTreatedAsSuccess
window.testReceiverWasmCaptureRoundtrip = testReceiverWasmCaptureRoundtrip
window.testReadWorkerDecodesSyntheticFrame = testReadWorkerDecodesSyntheticFrame
window.testReceiverAnchorDiagnosticsQuietByDefault = testReceiverAnchorDiagnosticsQuietByDefault
window.testStallCounterTicksOnDuplicateFrames = testStallCounterTicksOnDuplicateFrames
window.testBinary3RecoveredLayoutKeepsLock = testBinary3RecoveredLayoutKeepsLock
window.testBinary2RecoveredLayoutKeepsLock = testBinary2RecoveredLayoutKeepsLock
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
window.testBinary1RecommendedFpsIs60 = testBinary1RecommendedFpsIs60
window.testLabCardFullscreenExitRequiresReadyRestore = testLabCardFullscreenExitRequiresReadyRestore
window.testDenseBinaryMixedReplayPass1SourceOnly = testDenseBinaryMixedReplayPass1SourceOnly
window.testYoloModeSourceOnlyAllPasses = testYoloModeSourceOnlyAllPasses
window.testDenseBinaryMixedReplayPass2ChangesAfterParitySweep = testDenseBinaryMixedReplayPass2ChangesAfterParitySweep
window.testCompat4MixedReplayKeepsSixSlotPatterns = testCompat4MixedReplayKeepsSixSlotPatterns
window.testDenseBinaryMixedReplayMetadataReducesDataSlots = testDenseBinaryMixedReplayMetadataReducesDataSlots
window.testDenseBinaryBatchingProfile = testDenseBinaryBatchingProfile
window.testBinary2BatchingAndSchedule = testBinary2BatchingAndSchedule
window.testDenseBinaryBatchingProfileMath = testDenseBinaryBatchingProfileMath
window.testDenseBinaryBatchingProfileDiagnostic = testDenseBinaryBatchingProfileDiagnostic
window.testDenseBinaryXlargeShrinksBlockCount = testDenseBinaryXlargeShrinksBlockCount
window.testDenseBinaryProfileLadderShrinksK = testDenseBinaryProfileLadderShrinksK
window.testBinary1XlargeFillsFrame = testBinary1XlargeFillsFrame
window.testBinary1DefaultsToHugeBatching = testBinary1DefaultsToHugeBatching
window.testBinary1Pass2ReplaysFromStart = testBinary1Pass2ReplaysFromStart
window.testBinary1StartsDataImmediately = testBinary1StartsDataImmediately
window.testBinary1Pass2StartsMixedReplay = testBinary1Pass2StartsMixedReplay
window.testBinary1UsesTimerPacedRender = testBinary1UsesTimerPacedRender
window.testBinary1CadenceFpsPresets = testBinary1CadenceFpsPresets
window.testDenseBinaryLateMixDiagnostic = testDenseBinaryLateMixDiagnostic
window.testDenseBinaryLateMixPatterns = testDenseBinaryLateMixPatterns
window.testDenseBinaryFountainTailPatterns = testDenseBinaryFountainTailPatterns
window.testDenseBinaryPass3MixDiagnostic = testDenseBinaryPass3MixDiagnostic
window.testDenseBinaryPass3MixPatterns = testDenseBinaryPass3MixPatterns
window.testDenseBinaryStrictGeometryGate = testDenseBinaryStrictGeometryGate
window.testDenseBinaryMetadataUsesSparseSchedule = testDenseBinaryMetadataUsesSparseSchedule
window.testDenseBinaryMetadataSlotRotatesOnlyWhenSent = testDenseBinaryMetadataSlotRotatesOnlyWhenSent
window.testSenderWorkListSchedule = testSenderWorkListSchedule
window.testArqBatchEmitsClaimedMetadataAtWorkListTail = testArqBatchEmitsClaimedMetadataAtWorkListTail
window.testArqRepairBatchCarriesMetadataWhenRequested = testArqRepairBatchCarriesMetadataWhenRequested
window.testArqBeaconBatchCarriesReplayData = testArqBeaconBatchCarriesReplayData
window.testCaptureMethodDecision = testCaptureMethodDecision
window.testWorkerTrackTransferFallbackUsesMain = testWorkerTrackTransferFallbackUsesMain
window.testWorkerTransferClockStartsOnFirstAcceptedFrame = testWorkerTransferClockStartsOnFirstAcceptedFrame
window.testWorkerStartFailureResumesMainCapture = testWorkerStartFailureResumesMainCapture
window.testReceiverExpectedPacketSizeWaitsForSession = testReceiverExpectedPacketSizeWaitsForSession
window.testReceiverRoiCaptureBenchmarksWhenVideoFrameAvailable = testReceiverRoiCaptureBenchmarksWhenVideoFrameAvailable
window.testReceiverSlowRoiCaptureTriggersRebenchmark = testReceiverSlowRoiCaptureTriggersRebenchmark
window.testReceiverActiveTransferSuppressesSlowRoiRebenchmark = testReceiverActiveTransferSuppressesSlowRoiRebenchmark
window.testReceiverHeaderOnlyFrameStartsRoiWarmupBenchmark = testReceiverHeaderOnlyFrameStartsRoiWarmupBenchmark
window.testReceiverPreSignalRoiStartsWarmupBenchmark = testReceiverPreSignalRoiStartsWarmupBenchmark
window.testReceiverHotPerfFrameGate = testReceiverHotPerfFrameGate
window.testReceiverCapturePathBenchmarkSuppressesChurn = testReceiverCapturePathBenchmarkSuppressesChurn
window.testComputeLockedCaptureRect = testComputeLockedCaptureRect
window.testLabFrameTapUsesFullCaptureRect = testLabFrameTapUsesFullCaptureRect
window.testLabFrameTapBypassesLockedCaptureRegion = testLabFrameTapBypassesLockedCaptureRegion
window.testIngestCapturedFrame = testIngestCapturedFrame
window.testIngestCapturedFrameSkipsArqWhenDisabled = testIngestCapturedFrameSkipsArqWhenDisabled
window.testEqualChunkProbeFinds24PacketFrame = testEqualChunkProbeFinds24PacketFrame
window.testEqualChunkProbeFinds59PacketFrame = testEqualChunkProbeFinds59PacketFrame
window.testPacketProbeSalvagesLowConfidenceBit = testPacketProbeSalvagesLowConfidenceBit
window.testRankBitsByLowConfidence = testRankBitsByLowConfidence
window.testTrySalvageSingleBitFlip = testTrySalvageSingleBitFlip
window.testTrySalvageSlotHeaderBitFlip = testTrySalvageSlotHeaderBitFlip
window.testTryParseOrSalvageUsesFrameConfidenceOffset = testTryParseOrSalvageUsesFrameConfidenceOffset
window.testWasmCrc32MatchesJs = testWasmCrc32MatchesJs
window.testFrameCrcWasmIntegration = testFrameCrcWasmIntegration
window.testWasmScanBrightRunsMatchesJs = testWasmScanBrightRunsMatchesJs
window.testWasmClassifiersMatchJs = testWasmClassifiersMatchJs
window.testWasmPackBinary1PayloadMatchesJs = testWasmPackBinary1PayloadMatchesJs
window.testWasmProbeExpectedPacketsMatchesJs = testWasmProbeExpectedPacketsMatchesJs
window.testWasmVsJsDetectAnchorsEquivalent = testWasmVsJsDetectAnchorsEquivalent
window.testWasmVsJsLuma1ReadEquivalent = testWasmVsJsLuma1ReadEquivalent
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
    xorBytesInto: testXorBytesInto(),
    metadata: testMetadataRoundtrip(),
    metadataNoRedundancy: testMetadataNoRedundancyFlag(),
    metadataRepairIdle: testMetadataRepairIdleFlag(),
    parityMap: testParityMap(),
    parityRecovery: testParityRecovery(),
    srcParityAdj: testSourceToParityAdjacency(),
    gf2Small: await testGF2SolverSmall(),
    gf2Large: await testGF2SolverLarge(),
    encoder: await testEncoder(),
    encoderNoRedundancy: await testEncoderNoRedundancy(),
    fountainRippleVariant: testFountainRippleVariant(),
    codec: await testCodecRoundtrip(),
    codecWithLoss: await testCodecRoundtripWithLoss(),
    codecDeferredMetadata: await testCodecRoundtripDeferredMetadata(),
    codecNoRedundancy: await testCodecRoundtripNoRedundancy(),
    noRedundancyLoop: await testNoRedundancyLoopRecovers(),
    tailSolverWiderDenseBinaryTail: testTailSolverTriggerAllowsWiderDenseBinaryTail(),
    arqMessageRoundtrip: testArqMessageRoundtrip(),
    arqMessageRejectsCorruption: testArqMessageRejectsCorruption(),
    arqMissingSetRoundtrip: testMissingSetCodecRoundtrip(),
    arqMissingSetAdaptive: testMissingSetAdaptiveChoosesSmaller(),
    arqMissingSetHighUint32: testMissingSetCodecHighUint32Roundtrip(),
    arqMissingSetSparseRangeDelta: testMissingSetSparseLargeRangeUsesDeltaEncoding(),
    arqMissingSetBitmapDecodeBound: testMissingSetBitmapDecodeBoundsToPayload(),
    arqFragmentRoundtrip: testFragmentReassembleRoundtrip(),
    arqFragmentOutOfOrder: testFragmentOutOfOrderAndDup(),
    arqFragmentMissingDrops: testFragmentMissingDrops(),
    arqFragmentLargeCounts: testFragmentSupportsLargeCounts(),
    arqFragmentReusedIdReset: testFragmentReusedIdResetsStaleEntry(),
    arqFragmentReusedIdConflictReset: testFragmentReusedIdConflictResetsStaleEntry(),
    arqReceiverNackGaps: testArqReceiverBuildsNackForGaps(),
    arqReceiverCompleteGating: testArqReceiverCompleteOnlyWhenFullAndHashOk(),
    arqReceiverNoEmptyNack: testArqReceiverSuppressesEmptyNackWhileHashPending(),
    arqReceiverFullRepair: testArqReceiverCanRequestFullRepairAfterHashMismatch(),
    arqReceiverDuplicateNackThrottle: testArqReceiverThrottlesDuplicateNacks(),
    arqReceiverChangedNackCoalesce: testArqReceiverCoalescesChangedNacksDuringProgress(),
    arqReceiverChangedNackAfterHold: testArqReceiverSendsChangedNackAfterHold(),
    arqBeaconLogActionSkipsSuppressedNack: testArqBeaconLogActionSkipsSuppressedNack(),
    arqReceiverCompleteCap: testArqReceiverCapsCompleteBursts(),
    arqReceiverCompleteReplenish: testArqReceiverReplenishesCompleteWhileBeaconsContinue(),
    arqSenderConsumesNack: testArqSenderConsumesNackIntoWorkList(),
    arqSenderStaleSeq: testArqSenderIgnoresStaleSeq(),
    arqSenderWrappedSeq: testArqSenderAcceptsWrappedSeq(),
    arqSenderFallback: testArqSenderFallbackAfterTimeout(),
    arqSenderFallbackRepeatedNacks: testArqSenderFallsBackOnRepeatedUnchangedNacks(),
    arqSenderFallbackProgress: testArqSenderDoesNotFallbackWhileNacksProgress(),
    arqSenderIgnoresDuplicateRepairNack: testArqSenderIgnoresDuplicateNackDuringActiveRepair(),
    arqSenderRetriesDuplicateAfterExhausted: testArqSenderRetriesDuplicateNackAfterRepairExhausted(),
    arqSenderCompleteStops: testArqSenderCompleteStops(),
    arqSenderCompleteTerminal: testArqSenderCompleteIsTerminal(),
    arqSenderDisplayProgress: testArqSenderDisplayProgressStableAcrossRepair(),
    arqGoodputBeatsReloop: await testArqGoodputBeatsReloop(),
    arqBackchannelRegistry: testBackchannelRegistry(),
    arqBackchannelDefaultMtu: testBackchannelDefaultMtuIsBleSafe(),
    arqHelperStatusView: testArqHelperStatusView(),
    arqHelperAutoConnectPolicy: testShouldAutoConnectArqHelper(),
    arqBleSenderCopiesNotification: testBleGattSenderCopiesNotificationBuffer(),
    arqBleSenderDiscoveryOptions: testBleGattSenderUsesBroadDiscoveryWithOptionalService(),
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
    hdmiBinary2Constants: testBinary2ConstantsRegistered(),
    hdmiBinary1Constants: testBinary1ConstantsRegistered(),
    hdmiLuma1Constants: testLuma1ConstantsRegistered(),
    hdmiModesExcludeRemovedMode7: testHdmiModesExcludeRemovedMode7(),
    hdmiBinary3FrameRoundtrip: testBinary3FrameRoundtrip(),
    hdmiBinary2FrameRoundtrip: testBinary2FrameRoundtrip(),
    hdmiBinary1FrameRoundtrip: testBinary1FrameRoundtrip(),
    hdmiLuma1FrameRoundtrip: testLuma1FrameRoundtrip(),
    hdmiLuma1WarpedIntermediateLevelsDecode: testLuma1WarpedIntermediateLevelsDecode(),
    hdmiLuma1BlurredPayloadBandDecode: testLuma1BlurredPayloadBandDecode(),
    hdmiLuma1LegacyNoGuardDecode: testLuma1LegacyNoGuardDecode(),
    hdmiLuma1OffsetLayoutStripPhase: testLuma1OffsetLayoutSamplesStripsWithPhase(),
    hdmiLuma1FailedDecodeDebug: testLuma1FailedDecodeAttachesDebug(),
    hdmiLuma1CalibrationPayloadDetection: testLuma1CalibrationPayloadDetection(),
    hdmiLuma1SweepBudgetAndDebugGate: testLuma1SweepBudgetAndDebugGate(),
    hdmiLuma1CalibrationAnalysis: testLuma1CalibrationFrameAnalysis(),
    hdmiLuma1CalibrationSharpenFit: testLuma1CalibrationSharpenFit(),
    hdmiLuma1SharpenCorrectionRoundtrip: testLuma1SharpenCorrectionRoundtrip(),
    hdmiDenseBinaryLevelsPropagation: testDecodeDataRegionPropagatesDenseBinaryLevels(),
    hdmiDenseBinaryLockedLayout: testDenseBinaryLockedLayoutMatchesBlindSweep(),
    hdmiDenseBinaryPrecomputedOffsets: testDenseBinaryPrecomputedOffsetsMatchUncached(),
    hdmiBinary1LockedPayloadReader: testBinary1LockedPayloadReaderMatchesGeneric(),
    hdmiBinary1LockedPayloadReaderBytePacker: testBinary1LockedPayloadReaderUsesBytePacker(),
    hdmiLuma1LockedPayloadReader: testLuma1LockedPayloadReaderMatchesGeneric(),
    hdmiBinary2LockedPayloadReader: testBinary2LockedPayloadReaderMatchesGeneric(),
    hdmiBinary2CroppedLockedPayloadReader: testBinary2LockedPayloadReaderTranslatesCroppedOffsets(),
    hdmiBinary2SinglePixelLockedPayloadReader: testBinary2SinglePixelLockedPayloadReader(),
    hdmiDenseBinaryCropOffsets: testDenseBinaryPrecomputedOffsetsIgnoreMismatchedCrop(),
    hdmiLayoutImageDataWrapper: testReadPayloadWithLayoutAcceptsImageDataWrapper(),
    hdmiDenseBinaryLayoutNoConfidenceBuffer: testDenseBinaryLayoutReadSkipsUnusedConfidenceBuffer(),
    hdmiDecodeConfidenceDenseBinary: testDecodeDataRegionConfidence(),
    hdmiDecodeConfidenceCompat4: testDecodeDataRegionConfidenceCompat4(),
    hdmiFrameRefactorCompat4: testFrameRefactorPreservesCompat4Bytes(),
    hdmiFrameRefactorRawGray: testFrameRefactorPreservesRawGrayBytes(),
    hdmiFrameRefactorRawRgb: testFrameRefactorPreservesRawRgbBytes(),
    hdmiFrameRefactorLuma2: testFrameRefactorPreservesLuma2Bytes(),
    hdmiFrameRefactorCodebook3: testFrameRefactorPreservesCodebook3Bytes(),
    hdmiFrameRefactorGlyph5: testFrameRefactorPreservesGlyph5Bytes(),
    hdmiDecodeDataRegionAllModes: testDecodeDataRegionRoundtripsAllModes(),
    receiverFrameSignals: testReceiverFrameAcceptSignals(),
    denseBinaryLockedLayoutOffsets: testDenseBinaryLockedLayoutOffsetsCoverBinary2(),
    lockedFastPerfBreakdownSummary: testLockedFastPerfBreakdownSummary(),
    receiverFrameUseSummary: testReceiverFrameUseSummary(),
    receiverFrameSignatureSummary: testReceiverFrameSignatureSummary(),
    receiverHeaderOnlyFrameCanLock: testReceiverHeaderOnlyFrameCanLock(),
    receiverLuma1CalFrameSuccess: testReceiverLuma1CalFrameTreatedAsSuccess(),
    receiverAnchorDiagnosticsQuietDefault: testReceiverAnchorDiagnosticsQuietByDefault(),
    stallCounterDuplicateFrames: await testStallCounterTicksOnDuplicateFrames(),
    binary3RecoveredLayoutKeepsLock: testBinary3RecoveredLayoutKeepsLock(),
    binary2RecoveredLayoutKeepsLock: testBinary2RecoveredLayoutKeepsLock(),
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
    binary1Recommended60Fps: testBinary1RecommendedFpsIs60(),
    labCardFullscreenExitRestore: testLabCardFullscreenExitRequiresReadyRestore(),
    denseBinaryMixedReplayPass1SourceOnly: testDenseBinaryMixedReplayPass1SourceOnly(),
    yoloModeSourceOnlyAllPasses: testYoloModeSourceOnlyAllPasses(),
    denseBinaryMixedReplayPass2ParitySweepTransition: testDenseBinaryMixedReplayPass2ChangesAfterParitySweep(),
    compat4MixedReplaySixSlotPatterns: testCompat4MixedReplayKeepsSixSlotPatterns(),
    denseBinaryMixedReplayMetadataDataSlots: testDenseBinaryMixedReplayMetadataReducesDataSlots(),
    denseBinaryBatchingProfile: testDenseBinaryBatchingProfile(),
    binary2BatchingAndSchedule: testBinary2BatchingAndSchedule(),
    denseBinaryBatchingProfileMath: testDenseBinaryBatchingProfileMath(),
    denseBinaryBatchingProfileDiagnostic: testDenseBinaryBatchingProfileDiagnostic(),
    denseBinaryXlargeShrinksBlockCount: testDenseBinaryXlargeShrinksBlockCount(),
    denseBinaryProfileLadderShrinksK: testDenseBinaryProfileLadderShrinksK(),
    binary2UsesDenseBatchingProfile: testBinary2UsesDenseBatchingProfile(),
    binary1XlargeFillsFrame: testBinary1XlargeFillsFrame(),
    binary1DefaultsToHugeBatching: testBinary1DefaultsToHugeBatching(),
    binary1Pass2ReplaysFromStart: testBinary1Pass2ReplaysFromStart(),
    binary1StartsDataImmediately: testBinary1StartsDataImmediately(),
    binary1Pass2StartsMixedReplay: testBinary1Pass2StartsMixedReplay(),
    binary1TimerPacedRenderPolicy: testBinary1UsesTimerPacedRender(),
    binary1PacingLocksTimer: testBinary1PacingLocksTimer(),
    senderFrameSignatureSummary: testSenderFrameSignatureSummary(),
    senderFrameSymbolKindSummary: testSenderFrameSymbolKindSummary(),
    denseBinaryPass2SweepMixDiagnostic: testDenseBinaryPass2SweepMixDiagnostic(),
    denseBinaryPass2SweepMixPatterns: testDenseBinaryPass2SweepMixPatterns(),
    binary1CadenceFpsPresets: testBinary1CadenceFpsPresets(),
    denseBinaryLateMixDiagnostic: testDenseBinaryLateMixDiagnostic(),
    denseBinaryDegreeDiagnostic: testDenseBinaryDegreeDiagnostic(),
    denseBinaryLateMixPatterns: testDenseBinaryLateMixPatterns(),
    denseBinaryFountainTailPatterns: testDenseBinaryFountainTailPatterns(),
    denseBinaryPass3MixDiagnostic: testDenseBinaryPass3MixDiagnostic(),
    denseBinaryPass3MixPatterns: testDenseBinaryPass3MixPatterns(),
    denseBinaryStrictGeometryGate: testDenseBinaryStrictGeometryGate(),
    denseBinaryMetadataSparseSchedule: testDenseBinaryMetadataUsesSparseSchedule(),
    denseBinaryMetadataSlotRotatesOnlyWhenSent: testDenseBinaryMetadataSlotRotatesOnlyWhenSent(),
    senderWorkListSchedule: testSenderWorkListSchedule(),
    arqMetadataTailBatch: testArqBatchEmitsClaimedMetadataAtWorkListTail(),
    arqRepairMetadataBatch: testArqRepairBatchCarriesMetadataWhenRequested(),
    arqBeaconReplayDataBatch: testArqBeaconBatchCarriesReplayData(),
    captureMethodDecision: testCaptureMethodDecision(),
    workerTrackTransferFallback: testWorkerTrackTransferFallbackUsesMain(),
    workerTransferClockStartsOnAccept: testWorkerTransferClockStartsOnFirstAcceptedFrame(),
    workerStartFailureResumesMainCapture: testWorkerStartFailureResumesMainCapture(),
    receiverExpectedPacketSizeBootstrap: testReceiverExpectedPacketSizeWaitsForSession(),
    receiverRoiCaptureBenchmarkDefault: testReceiverRoiCaptureBenchmarksWhenVideoFrameAvailable(),
    receiverSlowRoiCaptureRebenchmark: testReceiverSlowRoiCaptureTriggersRebenchmark(),
    receiverActiveTransferRoiRebenchmarkSuppression: testReceiverActiveTransferSuppressesSlowRoiRebenchmark(),
    receiverHeaderOnlyRoiWarmupBenchmark: testReceiverHeaderOnlyFrameStartsRoiWarmupBenchmark(),
    receiverPreSignalRoiWarmupBenchmark: testReceiverPreSignalRoiStartsWarmupBenchmark(),
    receiverHotPerfFrameGate: testReceiverHotPerfFrameGate(),
    receiverCapturePathChurnSuppression: testReceiverCapturePathBenchmarkSuppressesChurn(),
    computeLockedCaptureRect: testComputeLockedCaptureRect(),
    labFrameTapFullCaptureRect: testLabFrameTapUsesFullCaptureRect(),
    labFrameTapBypassesLockedCapture: testLabFrameTapBypassesLockedCaptureRegion(),
    ingestCapturedFrame: await testIngestCapturedFrame(),
    ingestCapturedFrameSkipsArq: testIngestCapturedFrameSkipsArqWhenDisabled(),
    equalChunkProbe24PacketFrame: testEqualChunkProbeFinds24PacketFrame(),
    equalChunkProbe59PacketFrame: testEqualChunkProbeFinds59PacketFrame(),
    packetProbeSoftSalvage: testPacketProbeSalvagesLowConfidenceBit(),
    salvageRankBits: testRankBitsByLowConfidence(),
    salvageSingleBit: testTrySalvageSingleBitFlip(),
    salvageHeaderBit: testTrySalvageSlotHeaderBitFlip(),
    salvageFrameConfidenceOffset: testTryParseOrSalvageUsesFrameConfidenceOffset(),
    wasmCrc32: await testWasmCrc32MatchesJs(),
    frameCrcWasmIntegration: await testFrameCrcWasmIntegration(),
    wasmScanBrightRuns: await testWasmScanBrightRunsMatchesJs(),
    wasmClassifiers: await testWasmClassifiersMatchJs(),
    wasmBinary1Packer: await testWasmPackBinary1PayloadMatchesJs(),
    wasmExpectedPacketProbe: await testWasmProbeExpectedPacketsMatchesJs(),
    wasmVsJsDetectAnchors: await testWasmVsJsDetectAnchorsEquivalent(),
    wasmVsJsLuma1Read: await testWasmVsJsLuma1ReadEquivalent(),
    receiverWasmCaptureRoundtrip: await testReceiverWasmCaptureRoundtrip(),
    readWorkerSyntheticDecode: await testReadWorkerDecodesSyntheticFrame(),
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
