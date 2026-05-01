import { ANCHOR_SIZE, BLOCK_SIZE, MARGIN_SIZE } from './hdmi-uvc-constants.js'
import {
  CODEBOOK3_PATTERNS,
  GLYPH5_CODEBOOK,
  LUMA2_PATTERNS,
  dataRegionFromAnchors,
  decodeCodebook3,
  decodeGlyph5,
  decodeLuma2,
  detectAnchors,
  renderAnchor,
  renderCodebook3Block,
  renderGlyph5Block,
  renderLuma2Block,
  sampleBlockAt,
  sampleCodebook3At,
  sampleGlyph5At
} from './hdmi-uvc-frame.js'

// HDMI-UVC calibration-card lab: pure card builders and measurement helpers.
// The sender and receiver both derive cards locally from these descriptors; no
// calibration data is transmitted back over the HDMI/UVC channel.

export const CARD_KIND = {
  BINARY_4: 'binary4',
  BINARY_3: 'binary3',
  BINARY_2: 'binary2',
  LUMA_2: 'luma2',
  CODEBOOK_3: 'codebook3',
  GLYPH_5: 'glyph5',
  CANDIDATE: 'candidate'
}

const CELL_SIZE = {
  [CARD_KIND.BINARY_4]: 4,
  [CARD_KIND.BINARY_3]: 3,
  [CARD_KIND.BINARY_2]: 2,
  [CARD_KIND.LUMA_2]: 4,
  [CARD_KIND.CODEBOOK_3]: 4,
  [CARD_KIND.GLYPH_5]: 8,
  [CARD_KIND.CANDIDATE]: 6
}

const SYMBOL_COUNT = {
  [CARD_KIND.BINARY_4]: 2,
  [CARD_KIND.BINARY_3]: 2,
  [CARD_KIND.BINARY_2]: 2,
  [CARD_KIND.LUMA_2]: 4,
  [CARD_KIND.CODEBOOK_3]: 8,
  [CARD_KIND.GLYPH_5]: 32,
  [CARD_KIND.CANDIDATE]: 4
}

const CANDIDATE_6X6 = [
  [
    1,1,1,0,0,0,
    1,1,1,0,0,0,
    1,1,1,0,0,0,
    1,1,1,0,0,0,
    1,1,1,0,0,0,
    1,1,1,0,0,0
  ],
  [
    1,1,1,1,1,1,
    1,1,1,1,1,1,
    1,1,1,1,1,1,
    0,0,0,0,0,0,
    0,0,0,0,0,0,
    0,0,0,0,0,0
  ],
  [
    1,1,1,0,0,0,
    1,1,1,0,0,0,
    1,1,1,0,0,0,
    0,0,0,1,1,1,
    0,0,0,1,1,1,
    0,0,0,1,1,1
  ],
  [
    0,0,0,1,1,1,
    0,0,0,1,1,1,
    0,0,0,1,1,1,
    1,1,1,0,0,0,
    1,1,1,0,0,0,
    1,1,1,0,0,0
  ]
]

function fillImageBackground(imageData) {
  imageData.fill(0)
  for (let i = 3; i < imageData.length; i += 4) imageData[i] = 255
}

function drawCardAnchors(imageData, width, height) {
  renderAnchor(imageData, width, 0, 0)
  renderAnchor(imageData, width, width - ANCHOR_SIZE, 0)
  renderAnchor(imageData, width, 0, height - ANCHOR_SIZE)
  renderAnchor(imageData, width, width - ANCHOR_SIZE, height - ANCHOR_SIZE)
}

function nextLcg(state) {
  return (state * 1103515245 + 12345) >>> 0
}

function generateBinaryGroundTruth(cellsX, cellsY, seed = 0xDEADBEEF) {
  const truth = new Uint8Array(cellsX * cellsY)
  let state = seed >>> 0
  for (let i = 0; i < truth.length; i++) {
    state = nextLcg(state)
    truth[i] = (state >>> 24) & 1
  }
  return truth
}

function generateSymbolGroundTruth(cellsX, cellsY, symbolCount, seed = 0xCAFEF00D) {
  const total = cellsX * cellsY
  const truth = new Uint8Array(total)
  const baseCount = Math.floor(total / symbolCount)
  let i = 0
  for (let sym = 0; sym < symbolCount && i < total; sym++) {
    for (let k = 0; k < baseCount && i < total; k++) truth[i++] = sym
  }
  for (let sym = 0; i < total; sym = (sym + 1) % symbolCount) truth[i++] = sym

  let state = seed >>> 0
  for (let j = total - 1; j > 0; j--) {
    state = nextLcg(state)
    const r = state % (j + 1)
    const tmp = truth[j]
    truth[j] = truth[r]
    truth[r] = tmp
  }
  return truth
}

function paintBinaryCard(imageData, width, layout, groundTruth) {
  const { x, y, cellsX, cellsY, cellSize } = layout
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const val = groundTruth[cy * cellsX + cx] ? 255 : 0
      const sx = x + cx * cellSize
      const sy = y + cy * cellSize
      for (let dy = 0; dy < cellSize; dy++) {
        for (let dx = 0; dx < cellSize; dx++) {
          const i = ((sy + dy) * width + (sx + dx)) * 4
          imageData[i] = val
          imageData[i + 1] = val
          imageData[i + 2] = val
        }
      }
    }
  }
}

function paintMultiSymbolCard(imageData, width, layout, groundTruth, kind) {
  const { x, y, cellsX, cellsY, cellSize } = layout
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const symbol = groundTruth[cy * cellsX + cx]
      const sx = x + cx * cellSize
      const sy = y + cy * cellSize
      if (kind === CARD_KIND.LUMA_2) {
        renderLuma2Block(imageData, width, sx, sy, cellSize, symbol)
      } else if (kind === CARD_KIND.CODEBOOK_3) {
        renderCodebook3Block(imageData, width, sx, sy, cellSize, symbol)
      } else if (kind === CARD_KIND.GLYPH_5) {
        renderGlyph5Block(imageData, width, sx, sy, cellSize, symbol)
      }
    }
  }
}

function paintCandidateCard(imageData, width, layout, groundTruth, patterns) {
  const { x, y, cellsX, cellsY, cellSize } = layout
  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const symbol = groundTruth[cy * cellsX + cx]
      const pattern = patterns[symbol]
      const sx = x + cx * cellSize
      const sy = y + cy * cellSize
      for (let py = 0; py < cellSize; py++) {
        for (let px = 0; px < cellSize; px++) {
          const val = pattern[py * cellSize + px] ? 255 : 0
          const i = ((sy + py) * width + (sx + px)) * 4
          imageData[i] = val
          imageData[i + 1] = val
          imageData[i + 2] = val
        }
      }
    }
  }
}

export function buildCard(kind, width, height) {
  const cellSize = CELL_SIZE[kind]
  const symbolCount = SYMBOL_COUNT[kind]
  if (!cellSize || !symbolCount) throw new Error(`Unknown card kind: ${kind}`)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 2 * MARGIN_SIZE || height <= 2 * MARGIN_SIZE) {
    throw new Error(`Invalid card dimensions: ${width}x${height}`)
  }

  const dataW = width - 2 * MARGIN_SIZE
  const dataH = height - 2 * MARGIN_SIZE
  const cellsX = Math.floor(dataW / cellSize)
  const cellsY = Math.floor(dataH / cellSize)
  const layout = { x: MARGIN_SIZE, y: MARGIN_SIZE, cellsX, cellsY, cellSize, kind }
  const groundTruth = symbolCount === 2
    ? generateBinaryGroundTruth(cellsX, cellsY)
    : generateSymbolGroundTruth(cellsX, cellsY, symbolCount)
  const imageData = new Uint8ClampedArray(width * height * 4)
  fillImageBackground(imageData)
  drawCardAnchors(imageData, width, height)

  if (kind === CARD_KIND.CANDIDATE) {
    paintCandidateCard(imageData, width, layout, groundTruth, CANDIDATE_6X6)
  } else if (symbolCount === 2) {
    paintBinaryCard(imageData, width, layout, groundTruth)
  } else {
    paintMultiSymbolCard(imageData, width, layout, groundTruth, kind)
  }

  return {
    imageData,
    groundTruth,
    layout,
    width,
    height,
    symbolCount,
    candidatePatterns: kind === CARD_KIND.CANDIDATE ? CANDIDATE_6X6.map((p) => p.slice()) : undefined
  }
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function clampConfidence(value) {
  return Math.max(0, Math.min(128, value))
}

function normalizeBinarySample(sample, blackLevel = 0, whiteLevel = 255) {
  const span = Math.max(48, Math.abs(whiteLevel - blackLevel))
  const polarity = whiteLevel >= blackLevel ? 1 : -1
  const normalized = (polarity * (sample - blackLevel)) / span
  return Math.max(0, Math.min(1, normalized))
}

function getPatternSet(card) {
  switch (card.layout.kind) {
    case CARD_KIND.LUMA_2:
      return LUMA2_PATTERNS
    case CARD_KIND.CODEBOOK_3:
      return CODEBOOK3_PATTERNS
    case CARD_KIND.GLYPH_5:
      return GLYPH5_CODEBOOK
    case CARD_KIND.CANDIDATE:
      return card.candidatePatterns || CANDIDATE_6X6
    default:
      return null
  }
}

function sampleCandidateAt(imageData, width, px, py, bs) {
  const imgHeight = imageData.length / (width * 4)
  const grid = 6
  const samples = new Array(grid * grid)
  for (let row = 0; row < grid; row++) {
    const y0 = Math.max(0, Math.round(py + (row * bs) / grid))
    const y1 = Math.min(imgHeight, Math.max(y0 + 1, Math.round(py + ((row + 1) * bs) / grid)))
    for (let col = 0; col < grid; col++) {
      const x0 = Math.max(0, Math.round(px + (col * bs) / grid))
      const x1 = Math.min(width, Math.max(x0 + 1, Math.round(px + ((col + 1) * bs) / grid)))
      let sum = 0
      let count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += imageData[(y * width + x) * 4]
          count++
        }
      }
      samples[row * grid + col] = count > 0 ? sum / count : 0
    }
  }
  return samples
}

function averageSamples(samples) {
  if (!samples || samples.length === 0) return 0
  return samples.reduce((sum, value) => sum + value, 0) / samples.length
}

function decodePatternByDistance(samples, patterns, blackLevel, whiteLevel) {
  const normalized = samples.map((sample) => normalizeBinarySample(sample, blackLevel, whiteLevel))
  let bestSymbol = 0
  let bestError = Infinity
  let secondError = Infinity
  for (let symbol = 0; symbol < patterns.length; symbol++) {
    const pattern = patterns[symbol]
    let error = 0
    for (let i = 0; i < pattern.length; i++) {
      const delta = normalized[i] - pattern[i]
      error += delta * delta
    }
    if (error < bestError) {
      secondError = bestError
      bestError = error
      bestSymbol = symbol
    } else if (error < secondError) {
      secondError = error
    }
  }
  const margin = Number.isFinite(secondError) ? (secondError - bestError) * 128 : 128
  return { symbol: bestSymbol, confidence: clampConfidence(margin) }
}

function estimateCardLevels(captured, capturedWidth, capturedHeight, card, region, stepX, stepY, bs) {
  const { groundTruth, layout } = card
  const { cellsX, cellsY, kind } = layout
  let blackSum = 0
  let blackCount = 0
  let whiteSum = 0
  let whiteCount = 0
  const strideY = Math.max(1, Math.floor(cellsY / 64))
  const strideX = Math.max(1, Math.floor(cellsX / 64))
  const patterns = getPatternSet(card)

  for (let cy = 0; cy < cellsY; cy += strideY) {
    for (let cx = 0; cx < cellsX; cx += strideX) {
      const px = Math.round(region.x + cx * stepX)
      const py = Math.round(region.y + cy * stepY)
      if (px < 0 || px >= capturedWidth || py < 0 || py >= capturedHeight) continue
      const truth = groundTruth[cy * cellsX + cx]

      if (kind === CARD_KIND.BINARY_4 || kind === CARD_KIND.BINARY_3 || kind === CARD_KIND.BINARY_2) {
        const val = sampleBlockAt(captured, capturedWidth, px, py, bs)
        if (truth) {
          whiteSum += val
          whiteCount++
        } else {
          blackSum += val
          blackCount++
        }
        continue
      }

      let samples = null
      if (kind === CARD_KIND.LUMA_2 || kind === CARD_KIND.CODEBOOK_3) {
        samples = sampleCodebook3At(captured, capturedWidth, px, py, bs)
      } else if (kind === CARD_KIND.GLYPH_5) {
        samples = sampleGlyph5At(captured, capturedWidth, px, py, bs)
      } else if (kind === CARD_KIND.CANDIDATE) {
        samples = sampleCandidateAt(captured, capturedWidth, px, py, bs)
      }
      const pattern = patterns?.[truth]
      if (!samples || !pattern) continue
      for (let i = 0; i < Math.min(samples.length, pattern.length); i++) {
        if (pattern[i]) {
          whiteSum += samples[i]
          whiteCount++
        } else {
          blackSum += samples[i]
          blackCount++
        }
      }
    }
  }

  const blackLevel = blackCount > 0 ? blackSum / blackCount : 0
  const whiteLevel = whiteCount > 0 ? whiteSum / whiteCount : 255
  return {
    blackLevel,
    whiteLevel,
    threshold: (blackLevel + whiteLevel) * 0.5
  }
}

function decodeCardCell(captured, capturedWidth, px, py, bs, card, levels) {
  const kind = card.layout.kind
  if (kind === CARD_KIND.BINARY_4 || kind === CARD_KIND.BINARY_3 || kind === CARD_KIND.BINARY_2) {
    const val = sampleBlockAt(captured, capturedWidth, px, py, bs)
    return {
      decoded: val >= levels.threshold ? 1 : 0,
      luma: val,
      confidence: clampConfidence(Math.abs(val - levels.threshold))
    }
  }

  if (kind === CARD_KIND.LUMA_2) {
    const samples = sampleCodebook3At(captured, capturedWidth, px, py, bs)
    const decoded = decodeLuma2(samples, levels.blackLevel, levels.whiteLevel)
    const distance = decodePatternByDistance(samples, LUMA2_PATTERNS, levels.blackLevel, levels.whiteLevel)
    return { decoded, luma: averageSamples(samples), confidence: distance.confidence }
  }

  if (kind === CARD_KIND.CODEBOOK_3) {
    const samples = sampleCodebook3At(captured, capturedWidth, px, py, bs)
    const decoded = decodeCodebook3(samples, levels.blackLevel, levels.whiteLevel)
    const distance = decodePatternByDistance(samples, CODEBOOK3_PATTERNS, levels.blackLevel, levels.whiteLevel)
    return { decoded, luma: averageSamples(samples), confidence: distance.confidence }
  }

  if (kind === CARD_KIND.GLYPH_5) {
    const samples = sampleGlyph5At(captured, capturedWidth, px, py, bs)
    const decoded = decodeGlyph5(samples, levels.blackLevel, levels.whiteLevel)
    const distance = decodePatternByDistance(samples, GLYPH5_CODEBOOK, levels.blackLevel, levels.whiteLevel)
    return { decoded, luma: averageSamples(samples), confidence: distance.confidence }
  }

  const samples = sampleCandidateAt(captured, capturedWidth, px, py, bs)
  const distance = decodePatternByDistance(samples, card.candidatePatterns || CANDIDATE_6X6, levels.blackLevel, levels.whiteLevel)
  return { decoded: distance.symbol, luma: averageSamples(samples), confidence: distance.confidence }
}

function computeLumaStats(lumaHistograms) {
  const lumaStats = {}
  for (const [truth, hist] of Object.entries(lumaHistograms || {})) {
    let n = 0
    let sum = 0
    let sumSq = 0
    for (let v = 0; v < 256; v++) {
      n += hist[v]
      sum += v * hist[v]
      sumSq += v * v * hist[v]
    }
    const mean = n > 0 ? sum / n : 0
    const variance = n > 0 ? Math.max(0, sumSq / n - mean * mean) : 0
    const target5 = n * 0.05
    const target95 = n * 0.95
    let p5 = 0
    let p95 = 255
    let cum = 0
    let foundP5 = false
    for (let v = 0; v < 256; v++) {
      cum += hist[v]
      if (!foundP5 && cum >= target5) {
        p5 = v
        foundP5 = true
      }
      if (cum >= target95) {
        p95 = v
        break
      }
    }
    lumaStats[truth] = { n, mean, stdDev: Math.sqrt(variance), p5, p95 }
  }
  return lumaStats
}

function packetSurvivalFromSer(ser) {
  const survivalAtPacketBits = (bits) => ser === null ? null : Math.pow(1 - ser, bits)
  return {
    p256: survivalAtPacketBits(256 * 8),
    p512: survivalAtPacketBits(512 * 8),
    p1024: survivalAtPacketBits(1024 * 8),
    p2200: survivalAtPacketBits(2200 * 8)
  }
}

function buildConfusionObject(confusionMatrix, symbolCount) {
  const confusion = {}
  for (let truth = 0; truth < symbolCount; truth++) {
    for (let decoded = 0; decoded < symbolCount; decoded++) {
      confusion[`${truth}->${decoded}`] = confusionMatrix[truth * symbolCount + decoded] || 0
    }
  }
  return confusion
}

function summarizeWorstTile(tileErrors, tileSamples, tileCols) {
  let worstTileIdx = -1
  let worstTileErrors = 0
  let worstTileSamples = 0
  let worstTileSer = 0
  for (let i = 0; i < tileSamples.length; i++) {
    const samples = tileSamples[i] || 0
    const errors = tileErrors[i] || 0
    const ser = samples > 0 ? errors / samples : 0
    if (samples > 0 && (worstTileIdx < 0 || ser > worstTileSer || (ser === worstTileSer && errors > worstTileErrors))) {
      worstTileIdx = i
      worstTileErrors = errors
      worstTileSamples = samples
      worstTileSer = ser
    }
  }
  return {
    worstTileIdx,
    worstTileX: worstTileIdx >= 0 ? worstTileIdx % tileCols : -1,
    worstTileY: worstTileIdx >= 0 ? Math.floor(worstTileIdx / tileCols) : -1,
    worstTileErrors,
    worstTileSamples,
    worstTileSer
  }
}

function fallbackSourceRegion(card) {
  return {
    x: card.layout.x,
    y: card.layout.y,
    w: card.layout.cellsX * card.layout.cellSize,
    h: card.layout.cellsY * card.layout.cellSize,
    frameW: card.layout.x * 2 + card.layout.cellsX * card.layout.cellSize,
    frameH: card.layout.y * 2 + card.layout.cellsY * card.layout.cellSize,
    blockSize: BLOCK_SIZE,
    stepX: BLOCK_SIZE,
    stepY: BLOCK_SIZE
  }
}

function chooseCardRegion(region, anchors, capturedWidth, capturedHeight, card) {
  if (!region) return null
  const sourceExact = card.width === capturedWidth && card.height === capturedHeight
  const usedEstimatedAnchor = anchors.some((anchor) => anchor.estimated)
  if (!sourceExact || !usedEstimatedAnchor) return region

  const frameMatchesCard = Math.abs((region.frameW || 0) - card.width) <= 2 &&
    Math.abs((region.frameH || 0) - card.height) <= 2
  return frameMatchesCard ? region : fallbackSourceRegion(card)
}

function resolveCardRegion(pixels, capturedWidth, capturedHeight, card) {
  const anchors = detectAnchors(pixels, capturedWidth, capturedHeight)
  const region = dataRegionFromAnchors(anchors)
  return chooseCardRegion(region, anchors, capturedWidth, capturedHeight, card)
}

export function measureCardSer(captured, capturedWidth, capturedHeight, card, options = {}) {
  const pixels = captured?.data || captured
  if (!pixels || !card?.groundTruth || !card?.layout) return null
  const region = resolveCardRegion(pixels, capturedWidth, capturedHeight, card)
  if (!region) return null

  const { groundTruth, layout, symbolCount = 2 } = card
  const { cellsX, cellsY, cellSize } = layout
  const expectedCells = cellsX * cellsY
  const captureCellStepX = region.stepX * (cellSize / BLOCK_SIZE)
  const captureCellStepY = region.stepY * (cellSize / BLOCK_SIZE)
  const captureCellBs = Math.max(1, Math.min(captureCellStepX, captureCellStepY))
  const levels = estimateCardLevels(pixels, capturedWidth, capturedHeight, card, region, captureCellStepX, captureCellStepY, captureCellBs)
  const confusionMatrix = new Uint32Array(symbolCount * symbolCount)
  const errorPositions = []
  const confidence = options.collectConfidence ? [] : null
  const lumaHistograms = {}
  const chromaResidual = { gMinusRSum: 0, bMinusRSum: 0, count: 0 }
  const rowErrors = new Uint32Array(cellsY)
  const colErrors = new Uint32Array(cellsX)
  const rowDriftSum = new Float64Array(cellsY)
  const colDriftSum = new Float64Array(cellsX)
  const rowDriftCount = new Uint32Array(cellsY)
  const colDriftCount = new Uint32Array(cellsX)
  const tileSize = 8
  const tileCols = Math.ceil(cellsX / tileSize)
  const tileRows = Math.ceil(cellsY / tileSize)
  const tileErrors = new Uint32Array(tileCols * tileRows)
  const tileSamples = new Uint32Array(tileCols * tileRows)
  let sampledCells = 0
  let errors = 0

  for (let cy = 0; cy < cellsY; cy++) {
    for (let cx = 0; cx < cellsX; cx++) {
      const px = Math.round(region.x + cx * captureCellStepX)
      const py = Math.round(region.y + cy * captureCellStepY)
      if (px < 0 || px >= capturedWidth || py < 0 || py >= capturedHeight) continue
      const { decoded, luma, confidence: cellConfidence } = decodeCardCell(
        pixels,
        capturedWidth,
        px,
        py,
        captureCellBs,
        card,
        levels
      )
      const truth = groundTruth[cy * cellsX + cx]
      sampledCells++
      if (truth < symbolCount && decoded < symbolCount) confusionMatrix[truth * symbolCount + decoded]++
      if (confidence) confidence.push(cellConfidence)
      const tileIdx = Math.floor(cy / tileSize) * tileCols + Math.floor(cx / tileSize)
      tileSamples[tileIdx]++

      if (decoded !== truth) {
        errors++
        rowErrors[cy]++
        colErrors[cx]++
        tileErrors[tileIdx]++
        if (errorPositions.length < 32) {
          errorPositions.push({ cx, cy, val: luma, truth, decoded, confidence: cellConfidence })
        }
      }

      const lumaBin = clampByte(luma)
      if (!lumaHistograms[truth]) lumaHistograms[truth] = new Uint32Array(256)
      lumaHistograms[truth][lumaBin]++

      const centerX = Math.max(0, Math.min(capturedWidth - 1, Math.round(px + captureCellBs / 2)))
      const centerY = Math.max(0, Math.min(capturedHeight - 1, Math.round(py + captureCellBs / 2)))
      const centerIdx = (centerY * capturedWidth + centerX) * 4
      const r = pixels[centerIdx]
      const g = pixels[centerIdx + 1]
      const b = pixels[centerIdx + 2]
      chromaResidual.gMinusRSum += (g - r)
      chromaResidual.bMinusRSum += (b - r)
      chromaResidual.count++

      const driftRadiusX = Math.max(1, Math.round(captureCellStepX))
      const driftRadiusY = Math.max(1, Math.round(captureCellStepY))
      let bestXVal = luma
      let bestDx = 0
      for (let dx = -driftRadiusX; dx <= driftRadiusX; dx++) {
        const sx = px + dx
        if (sx < 0 || sx >= capturedWidth) continue
        const v = pixels[(centerY * capturedWidth + sx) * 4]
        if (Math.abs(v - levels.threshold) > Math.abs(bestXVal - levels.threshold)) {
          bestXVal = v
          bestDx = dx
        }
      }
      let bestYVal = luma
      let bestDy = 0
      for (let dy = -driftRadiusY; dy <= driftRadiusY; dy++) {
        const sy = py + dy
        if (sy < 0 || sy >= capturedHeight) continue
        const v = pixels[(sy * capturedWidth + centerX) * 4]
        if (Math.abs(v - levels.threshold) > Math.abs(bestYVal - levels.threshold)) {
          bestYVal = v
          bestDy = dy
        }
      }
      rowDriftSum[cy] += bestDy
      rowDriftCount[cy]++
      colDriftSum[cx] += bestDx
      colDriftCount[cx]++
    }
  }

  const rowDriftPx = new Float32Array(cellsY)
  const colDriftPx = new Float32Array(cellsX)
  let worstRowDriftPx = 0
  let worstRowDriftIdx = -1
  let worstColDriftPx = 0
  let worstColDriftIdx = -1
  for (let i = 0; i < cellsY; i++) {
    rowDriftPx[i] = rowDriftCount[i] > 0 ? rowDriftSum[i] / rowDriftCount[i] : 0
    const abs = Math.abs(rowDriftPx[i])
    if (abs > worstRowDriftPx) {
      worstRowDriftPx = abs
      worstRowDriftIdx = i
    }
  }
  for (let i = 0; i < cellsX; i++) {
    colDriftPx[i] = colDriftCount[i] > 0 ? colDriftSum[i] / colDriftCount[i] : 0
    const abs = Math.abs(colDriftPx[i])
    if (abs > worstColDriftPx) {
      worstColDriftPx = abs
      worstColDriftIdx = i
    }
  }

  let worstRow = -1
  let worstRowCount = 0
  for (let i = 0; i < rowErrors.length; i++) {
    if (rowErrors[i] > worstRowCount) {
      worstRowCount = rowErrors[i]
      worstRow = i
    }
  }
  let worstCol = -1
  let worstColCount = 0
  for (let i = 0; i < colErrors.length; i++) {
    if (colErrors[i] > worstColCount) {
      worstColCount = colErrors[i]
      worstCol = i
    }
  }

  const ser = sampledCells > 0 ? errors / sampledCells : null
  const skippedCells = Math.max(0, expectedCells - sampledCells)
  const coverage = expectedCells > 0 ? sampledCells / expectedCells : null
  const worstTile = summarizeWorstTile(tileErrors, tileSamples, tileCols)
  const lumaStats = computeLumaStats(lumaHistograms)
  const confusion = buildConfusionObject(confusionMatrix, symbolCount)
  return {
    ser,
    confusion,
    confusionMatrix,
    symbolCount,
    expectedCells,
    sampledCells,
    skippedCells,
    coverage,
    errors,
    errorPositions,
    rowErrors,
    colErrors,
    tileSize,
    tileCols,
    tileRows,
    tileErrors,
    tileSamples,
    ...worstTile,
    worstRow,
    worstRowCount,
    worstCol,
    worstColCount,
    rowDriftPx,
    colDriftPx,
    rowDriftCount,
    colDriftCount,
    worstRowDriftPx,
    worstRowDriftIdx,
    worstColDriftPx,
    worstColDriftIdx,
    packetSurvival: packetSurvivalFromSer(ser),
    lumaStats,
    lumaHistograms,
    chromaResidual: chromaResidual.count > 0
      ? {
          gMinusRMean: chromaResidual.gMinusRSum / chromaResidual.count,
          bMinusRMean: chromaResidual.bMinusRSum / chromaResidual.count,
          sampleCount: chromaResidual.count
        }
      : null,
    threshold: levels.threshold,
    levels,
    confidence: confidence || undefined
  }
}

function mergeUint32Arrays(a, b) {
  const len = Math.max(a?.length || 0, b?.length || 0)
  const merged = new Uint32Array(len)
  for (let i = 0; i < len; i++) merged[i] = (a?.[i] || 0) + (b?.[i] || 0)
  return merged
}

function mergeFloatAverages(aValues, aCounts, bValues, bCounts) {
  const len = Math.max(aValues?.length || 0, bValues?.length || 0)
  const values = new Float32Array(len)
  const counts = new Uint32Array(len)
  for (let i = 0; i < len; i++) {
    const ac = aCounts?.[i] || 0
    const bc = bCounts?.[i] || 0
    const total = ac + bc
    counts[i] = total
    values[i] = total > 0 ? (((aValues?.[i] || 0) * ac) + ((bValues?.[i] || 0) * bc)) / total : 0
  }
  return { values, counts }
}

function mergeHistograms(a = {}, b = {}) {
  const merged = {}
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    merged[key] = mergeUint32Arrays(a[key], b[key])
  }
  return merged
}

function weightedMean(aMean, aCount, bMean, bCount) {
  const total = (aCount || 0) + (bCount || 0)
  return total > 0 ? (((aMean || 0) * (aCount || 0)) + ((bMean || 0) * (bCount || 0))) / total : 0
}

export function mergeMeasureResults(a, b) {
  if (!a) return b
  if (!b) return a
  const symbolCount = Math.max(a.symbolCount || 2, b.symbolCount || 2)
  const expectedCells = (a.expectedCells ?? a.sampledCells ?? 0) + (b.expectedCells ?? b.sampledCells ?? 0)
  const sampledCells = (a.sampledCells || 0) + (b.sampledCells || 0)
  const skippedCells = (a.skippedCells || 0) + (b.skippedCells || 0)
  const errors = (a.errors || 0) + (b.errors || 0)
  const ser = sampledCells > 0 ? errors / sampledCells : null
  const coverage = expectedCells > 0 ? sampledCells / expectedCells : null
  const rowErrors = mergeUint32Arrays(a.rowErrors, b.rowErrors)
  const colErrors = mergeUint32Arrays(a.colErrors, b.colErrors)
  const tileErrors = mergeUint32Arrays(a.tileErrors, b.tileErrors)
  const tileSamples = mergeUint32Arrays(a.tileSamples, b.tileSamples)
  const tileSize = a.tileSize || b.tileSize || 8
  const tileCols = Math.max(a.tileCols || 0, b.tileCols || 0)
  const tileRows = Math.max(a.tileRows || 0, b.tileRows || 0)
  const worstTile = summarizeWorstTile(tileErrors, tileSamples, tileCols || 1)
  const rowDrift = mergeFloatAverages(a.rowDriftPx, a.rowDriftCount, b.rowDriftPx, b.rowDriftCount)
  const colDrift = mergeFloatAverages(a.colDriftPx, a.colDriftCount, b.colDriftPx, b.colDriftCount)
  const lumaHistograms = mergeHistograms(a.lumaHistograms, b.lumaHistograms)
  const lumaStats = computeLumaStats(lumaHistograms)

  let worstRow = -1
  let worstRowCount = 0
  for (let i = 0; i < rowErrors.length; i++) {
    if (rowErrors[i] > worstRowCount) {
      worstRowCount = rowErrors[i]
      worstRow = i
    }
  }
  let worstCol = -1
  let worstColCount = 0
  for (let i = 0; i < colErrors.length; i++) {
    if (colErrors[i] > worstColCount) {
      worstColCount = colErrors[i]
      worstCol = i
    }
  }
  let worstRowDriftPx = 0
  let worstRowDriftIdx = -1
  for (let i = 0; i < rowDrift.values.length; i++) {
    const abs = Math.abs(rowDrift.values[i])
    if (abs > worstRowDriftPx) {
      worstRowDriftPx = abs
      worstRowDriftIdx = i
    }
  }
  let worstColDriftPx = 0
  let worstColDriftIdx = -1
  for (let i = 0; i < colDrift.values.length; i++) {
    const abs = Math.abs(colDrift.values[i])
    if (abs > worstColDriftPx) {
      worstColDriftPx = abs
      worstColDriftIdx = i
    }
  }

  const confusionMatrix = mergeUint32Arrays(a.confusionMatrix, b.confusionMatrix)
  const aChroma = a.chromaResidual
  const bChroma = b.chromaResidual
  const chromaCount = (aChroma?.sampleCount || 0) + (bChroma?.sampleCount || 0)

  return {
    ser,
    confusion: buildConfusionObject(confusionMatrix, symbolCount),
    confusionMatrix,
    symbolCount,
    expectedCells,
    sampledCells,
    skippedCells,
    coverage,
    errors,
    errorPositions: [...(a.errorPositions || []), ...(b.errorPositions || [])].slice(0, 32),
    rowErrors,
    colErrors,
    tileSize,
    tileCols,
    tileRows,
    tileErrors,
    tileSamples,
    ...worstTile,
    worstRow,
    worstRowCount,
    worstCol,
    worstColCount,
    rowDriftPx: rowDrift.values,
    colDriftPx: colDrift.values,
    rowDriftCount: rowDrift.counts,
    colDriftCount: colDrift.counts,
    worstRowDriftPx,
    worstRowDriftIdx,
    worstColDriftPx,
    worstColDriftIdx,
    packetSurvival: packetSurvivalFromSer(ser),
    lumaStats,
    lumaHistograms,
    chromaResidual: chromaCount > 0
      ? {
          gMinusRMean: weightedMean(aChroma?.gMinusRMean, aChroma?.sampleCount, bChroma?.gMinusRMean, bChroma?.sampleCount),
          bMinusRMean: weightedMean(aChroma?.bMinusRMean, aChroma?.sampleCount, bChroma?.bMinusRMean, bChroma?.sampleCount),
          sampleCount: chromaCount
        }
      : null
  }
}

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
