// Test functions for hdmi-uvc-lab.js, extracted from the production module.
// Registered via src/test-suite.js (?test).
import { buildCard, measureCardSer, mergeMeasureResults, CARD_KIND, _internals } from './hdmi-uvc-lab.js'

const { fallbackSourceRegion, chooseCardRegion } = _internals

export function testBuildCardBinary4Geometry() {
  const { layout, groundTruth, symbolCount } = buildCard(CARD_KIND.BINARY_4, 640, 480)
  const expectedCellsX = Math.floor((640 - 2 * 24) / 4)
  const expectedCellsY = Math.floor((480 - 2 * 24) / 4)
  const pass = layout.cellSize === 4 &&
    layout.cellsX === expectedCellsX &&
    layout.cellsY === expectedCellsY &&
    groundTruth.length === expectedCellsX * expectedCellsY &&
    symbolCount === 2
  console.log('Card binary4 geometry test:', pass ? 'PASS' : `FAIL got ${JSON.stringify(layout)}`)
  return pass
}

export function testCardSelfDecode() {
  const card = buildCard(CARD_KIND.BINARY_4, 640, 480)
  const result = measureCardSer(card.imageData, 640, 480, card)
  const pass = result?.ser === 0 && result.errors === 0
  console.log('Card self-decode test:', pass ? 'PASS' : `FAIL ${JSON.stringify(result)}`)
  return pass
}

export function testMeasureCardSerOnUnmodifiedCapture() {
  const card = buildCard(CARD_KIND.BINARY_4, 640, 480)
  const result = measureCardSer(card.imageData, 640, 480, card)
  const pass = result?.ser === 0 &&
    result.confusion?.['0->0'] + result.confusion?.['1->1'] === result.sampledCells &&
    result.confusion?.['0->1'] === 0 &&
    result.confusion?.['1->0'] === 0
  console.log('Card SER on unmodified capture test:', pass ? 'PASS' : `FAIL ${JSON.stringify(result)}`)
  return pass
}

export function testMeasureCardSerWithNoise() {
  const card = buildCard(CARD_KIND.BINARY_4, 640, 480)
  const noisy = new Uint8ClampedArray(card.imageData)
  const { x, y, cellsX, cellsY, cellSize } = card.layout
  for (let cy = 0; cy < cellsY; cy += 20) {
    for (let cx = 0; cx < cellsX; cx++) {
      const sx = x + cx * cellSize
      const sy = y + cy * cellSize
      const old = noisy[(sy * 640 + sx) * 4]
      const val = 255 - old
      for (let dy = 0; dy < cellSize; dy++) {
        for (let dx = 0; dx < cellSize; dx++) {
          const i = ((sy + dy) * 640 + (sx + dx)) * 4
          noisy[i] = val
          noisy[i + 1] = val
          noisy[i + 2] = val
        }
      }
    }
  }
  const result = measureCardSer(noisy, 640, 480, card)
  const survivalSane = result?.packetSurvival?.p256 < 1 &&
    result.packetSurvival.p2200 <= result.packetSurvival.p1024 &&
    result.packetSurvival.p1024 <= result.packetSurvival.p512
  const driftSane = result?.worstRow >= 0 &&
    result.worstRowCount > 0 &&
    result.rowErrors instanceof Uint32Array
  const pass = result?.ser > 0 && result.ser < 0.10 && result.errors > 0 && survivalSane && driftSane
  console.log('Card SER with noise test:', pass ? `PASS (ser=${result.ser.toFixed(4)})` : `FAIL ${JSON.stringify(result)}`)
  return pass
}

export function testMeasureCardSerExposesConfidence() {
  const card = buildCard(CARD_KIND.BINARY_4, 640, 480)
  const result = measureCardSer(card.imageData, 640, 480, card, { collectConfidence: true })
  const pass = Array.isArray(result?.confidence) &&
    result.confidence.length === result.sampledCells &&
    result.confidence.every((c) => typeof c === 'number' && c >= 0 && c <= 128)
  console.log('Card SER confidence test:', pass ? 'PASS' : `FAIL ${result?.confidence?.slice(0, 8)}`)
  return pass
}

export function testBuildCardLuma2Geometry() {
  const { layout, groundTruth, symbolCount } = buildCard(CARD_KIND.LUMA_2, 640, 480)
  const expectedCellsX = Math.floor((640 - 2 * 24) / 4)
  const expectedCellsY = Math.floor((480 - 2 * 24) / 4)
  const pass = layout.cellSize === 4 &&
    layout.cellsX === expectedCellsX &&
    layout.cellsY === expectedCellsY &&
    symbolCount === 4 &&
    groundTruth.every((s) => s >= 0 && s < 4)
  console.log('Card luma2 geometry test:', pass ? 'PASS' : `FAIL ${JSON.stringify(layout)}`)
  return pass
}

export function testBuildCardCodebook3Geometry() {
  const { layout, groundTruth, symbolCount } = buildCard(CARD_KIND.CODEBOOK_3, 640, 480)
  const pass = layout.cellSize === 4 &&
    symbolCount === 8 &&
    groundTruth.every((s) => s >= 0 && s < 8)
  console.log('Card codebook3 geometry test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBuildCardGlyph5Geometry() {
  const { layout, groundTruth, symbolCount } = buildCard(CARD_KIND.GLYPH_5, 640, 480)
  const pass = layout.cellSize === 8 &&
    symbolCount === 32 &&
    groundTruth.every((s) => s >= 0 && s < 32)
  console.log('Card glyph5 geometry test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testCardSelfDecodeAllKinds() {
  const kinds = [
    CARD_KIND.BINARY_4,
    CARD_KIND.BINARY_3,
    CARD_KIND.BINARY_2,
    CARD_KIND.BINARY_1,
    CARD_KIND.LUMA_2,
    CARD_KIND.CODEBOOK_3,
    CARD_KIND.GLYPH_5,
    CARD_KIND.CANDIDATE
  ]
  const failures = []
  for (const kind of kinds) {
    const card = buildCard(kind, 640, 480)
    const result = measureCardSer(card.imageData, 640, 480, card)
    if (!result || result.ser > 0) failures.push(`${kind}: ser=${result?.ser}`)
  }
  const pass = failures.length === 0
  console.log('Card self-decode all kinds test:', pass ? 'PASS' : `FAIL ${failures.join(' | ')}`)
  return pass
}

export function testBuildCardCandidateSeed() {
  const { layout, groundTruth, symbolCount, candidatePatterns } = buildCard(CARD_KIND.CANDIDATE, 640, 480)
  const pass = layout.cellSize === 6 &&
    groundTruth.every((s) => s >= 0 && s < symbolCount) &&
    symbolCount >= 4 &&
    symbolCount <= 8 &&
    Array.isArray(candidatePatterns) &&
    candidatePatterns.length === symbolCount &&
    candidatePatterns.every((p) => p.length === 36)
  console.log('Card candidate seed test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testMergeMeasureResults() {
  const card = buildCard(CARD_KIND.BINARY_4, 640, 480)
  const r1 = measureCardSer(card.imageData, 640, 480, card)
  const r2 = measureCardSer(card.imageData, 640, 480, card)
  const merged = mergeMeasureResults(r1, r2)
  const mean = r1.lumaStats[0].mean | 0
  const pass = merged.sampledCells === r1.sampledCells * 2 &&
    merged.expectedCells === r1.expectedCells * 2 &&
    merged.skippedCells === 0 &&
    merged.coverage === 1 &&
    merged.errors === 0 &&
    merged.confusion['0->0'] === r1.confusion['0->0'] * 2 &&
    merged.tileSamples[0] === r1.tileSamples[0] * 2 &&
    merged.worstTileSamples > 0 &&
    merged.lumaHistograms[0][mean] >= r1.lumaHistograms[0][mean] * 2 - 5
  console.log('mergeMeasureResults test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testMeasureCardSerReportsCoverageAndWorstTile() {
  const card = buildCard(CARD_KIND.BINARY_4, 640, 480)
  const result = measureCardSer(card.imageData, 640, 480, card)
  const pass = result?.expectedCells === card.groundTruth.length &&
    result.skippedCells === 0 &&
    result.coverage === 1 &&
    result.tileSize === 8 &&
    result.tileErrors instanceof Uint32Array &&
    result.tileSamples instanceof Uint32Array &&
    Number.isFinite(result.worstTileSer) &&
    result.worstTileSamples > 0
  console.log('Card SER coverage/worst-tile test:', pass ? 'PASS' : `FAIL ${JSON.stringify({
    expectedCells: result?.expectedCells,
    skippedCells: result?.skippedCells,
    coverage: result?.coverage,
    tileSize: result?.tileSize,
    worstTileSer: result?.worstTileSer
  })}`)
  return pass
}

export function testEstimatedAnchorsKeepMatchingNativeRegion() {
  const card = buildCard(CARD_KIND.BINARY_4, 1920, 1080)
  const estimatedAnchors = [{ estimated: true }]
  const matchingRegion = { x: 25, y: 24, w: 1870, h: 1032, frameW: 1920, frameH: 1080, stepX: 3.01, stepY: 3.01 }
  const mismatchedRegion = { ...matchingRegion, y: 96, frameH: 1008 }
  const chosenMatching = chooseCardRegion(matchingRegion, estimatedAnchors, 1920, 1080, card)
  const chosenMismatched = chooseCardRegion(mismatchedRegion, estimatedAnchors, 1920, 1080, card)
  const fallback = fallbackSourceRegion(card)
  const pass = chosenMatching === matchingRegion &&
    chosenMismatched.x === fallback.x &&
    chosenMismatched.y === fallback.y &&
    chosenMismatched.stepX === fallback.stepX
  console.log('estimated-anchor native region choice test:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testMeasureCardSerReturnsNullWithoutAnchors() {
  const card = buildCard(CARD_KIND.BINARY_4, 640, 480)
  const blank = new Uint8ClampedArray(card.imageData.length)
  for (let i = 3; i < blank.length; i += 4) blank[i] = 255
  const result = measureCardSer(blank, 640, 480, card)
  const pass = result === null
  console.log('Card SER without anchors test:', pass ? 'PASS' : `FAIL ${JSON.stringify(result)}`)
  return pass
}
