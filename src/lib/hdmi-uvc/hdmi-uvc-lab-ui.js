import { buildCard, CARD_KIND, measureCardSer, mergeMeasureResults } from './hdmi-uvc-lab.js'
import { getLastCapturedFrame, setHdmiUvcLabFrameTapEnabled } from './hdmi-uvc-receiver.js'

const TARGET_SAMPLES = 1_000_000

const KIND_BY_VALUE = {
  binary4: CARD_KIND.BINARY_4,
  binary3: CARD_KIND.BINARY_3,
  binary2: CARD_KIND.BINARY_2,
  luma2: CARD_KIND.LUMA_2,
  codebook3: CARD_KIND.CODEBOOK_3,
  glyph5: CARD_KIND.GLYPH_5,
  candidate: CARD_KIND.CANDIDATE
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve))

function formatPercent(value) {
  return value == null ? '-' : (value * 100).toFixed(4) + '%'
}

function formatProbability(value) {
  return value == null ? '-' : value.toFixed(4)
}

function formatConfusion(result) {
  if (!result?.confusionMatrix) return 'Confusion: unavailable'
  if ((result.symbolCount || 2) === 2) {
    const c = result.confusion
    return `Confusion: 0->0=${c['0->0']} 0->1=${c['0->1']} 1->0=${c['1->0']} 1->1=${c['1->1']}`
  }

  const rows = []
  const n = result.symbolCount
  for (let truth = 0; truth < n; truth++) {
    let rowTotal = 0
    let rowErrors = 0
    let topDecoded = 0
    let topCount = 0
    for (let decoded = 0; decoded < n; decoded++) {
      const count = result.confusionMatrix[truth * n + decoded] || 0
      rowTotal += count
      if (decoded !== truth) rowErrors += count
      if (count > topCount) {
        topCount = count
        topDecoded = decoded
      }
    }
    const rowSer = rowTotal ? rowErrors / rowTotal : 0
    rows.push(`  truth=${truth} n=${rowTotal} rowSER=${formatPercent(rowSer)} topDecoded=${topDecoded} (${topCount})`)
  }
  return ['Confusion matrix summary:', ...rows].join('\n')
}

function formatLumaStats(lumaStats) {
  if (!lumaStats || Object.keys(lumaStats).length === 0) return []
  const lines = ['Per-symbol luma distribution (R-channel, post-capture):']
  for (const [truth, s] of Object.entries(lumaStats)) {
    lines.push(
      `  symbol=${truth} n=${s.n} mean=${s.mean.toFixed(1)} stdDev=${s.stdDev.toFixed(1)} ` +
      `p5=${s.p5} p95=${s.p95}`
    )
  }

  const symbols = Object.keys(lumaStats).sort((a, b) => lumaStats[a].mean - lumaStats[b].mean)
  for (let i = 0; i + 1 < symbols.length; i++) {
    const loKey = symbols[i]
    const hiKey = symbols[i + 1]
    const lo = lumaStats[loKey]
    const hi = lumaStats[hiKey]
    const overlap = lo.p95 >= hi.p5
    lines.push(`  pair ${loKey}<->${hiKey}: ${overlap ? `OVERLAP (lo.p95=${lo.p95} >= hi.p5=${hi.p5})` : 'separable'}`)
  }
  return lines
}

function formatResults(result, extraLines = []) {
  if (!result) return 'No card / no anchors detected.'
  const lines = [
    `Sampled cells: ${result.sampledCells}`,
    `Coverage: ${formatPercent(result.coverage)} (${result.sampledCells}/${result.expectedCells ?? result.sampledCells}, skipped=${result.skippedCells ?? 0})`,
    `Errors: ${result.errors}`,
    `SER: ${formatPercent(result.ser)}`,
    formatConfusion(result)
  ]

  if (typeof result.worstRow === 'number' && result.worstRow >= 0) {
    lines.push(`Worst row: ${result.worstRow} (${result.worstRowCount} errs) | Worst col: ${result.worstCol} (${result.worstColCount} errs)`)
  }
  if (typeof result.worstTileSer === 'number') {
    lines.push(
      `Worst 8x8-cell tile: (${result.worstTileX},${result.worstTileY}) ` +
      `SER=${formatPercent(result.worstTileSer)} ` +
      `errs=${result.worstTileErrors}/${result.worstTileSamples}`
    )
  }
  if (typeof result.worstRowDriftPx === 'number' || typeof result.worstColDriftPx === 'number') {
    lines.push(
      `Worst drift: row=${(result.worstRowDriftPx || 0).toFixed(2)}px @${result.worstRowDriftIdx} ` +
      `col=${(result.worstColDriftPx || 0).toFixed(2)}px @${result.worstColDriftIdx}`
    )
  }

  lines.push(...formatLumaStats(result.lumaStats))

  if (result.chromaResidual) {
    lines.push(
      `Chroma residual (G-R, B-R per cell): ` +
      `gMinusR=${result.chromaResidual.gMinusRMean.toFixed(2)} ` +
      `bMinusR=${result.chromaResidual.bMinusRMean.toFixed(2)} ` +
      `(luma-only cards expect both near 0)`
    )
  }

  if (result.packetSurvival) {
    lines.push(
      `Packet CRC survival estimates (uncorrelated SER assumption):` +
      `\n  256B=${formatProbability(result.packetSurvival.p256)} ` +
      `512B=${formatProbability(result.packetSurvival.p512)} ` +
      `1024B=${formatProbability(result.packetSurvival.p1024)} ` +
      `2200B=${formatProbability(result.packetSurvival.p2200)}`
    )
  }

  if (result.errorPositions?.length) {
    lines.push('First errors:')
    for (const e of result.errorPositions.slice(0, 8)) {
      lines.push(`  cell=(${e.cx},${e.cy}) val=${Number(e.val).toFixed(1)} truth=${e.truth} decoded=${e.decoded}`)
    }
  }

  lines.push(...extraLines)
  return lines.join('\n')
}

export function initHdmiUvcLabReceiverUi() {
  const select = document.getElementById('hdmi-uvc-lab-rx-card')
  const wInput = document.getElementById('hdmi-uvc-lab-rx-sender-w')
  const hInput = document.getElementById('hdmi-uvc-lab-rx-sender-h')
  const startBtn = document.getElementById('btn-hdmi-uvc-lab-rx-start')
  const stopBtn = document.getElementById('btn-hdmi-uvc-lab-rx-stop')
  const out = document.getElementById('hdmi-uvc-lab-rx-results')
  if (!select || !startBtn || !stopBtn || !out) return

  let accumulator = null
  let lastMeasuredSeq = -1
  let running = false

  stopBtn.addEventListener('click', () => {
    stopBtn.dataset.requested = 'true'
  })

  startBtn.addEventListener('click', async () => {
    if (running) return
    const kind = KIND_BY_VALUE[select.value]
    if (!kind) {
      out.textContent = 'Pick a card.'
      return
    }

    const senderW = parseInt(wInput.value, 10) || 1920
    const senderH = parseInt(hInput.value, 10) || 1080
    const card = buildCard(kind, senderW, senderH)
    accumulator = null
    lastMeasuredSeq = -1
    stopBtn.dataset.requested = 'false'
    running = true
    startBtn.disabled = true
    stopBtn.disabled = false

    try {
      setHdmiUvcLabFrameTapEnabled(true)
      while (accumulator === null || accumulator.sampledCells < TARGET_SAMPLES) {
        const captured = getLastCapturedFrame()
        if (!captured) {
          out.textContent = 'No captured frame yet.'
          await sleep(50)
          if (stopBtn.dataset.requested === 'true') break
          continue
        }
        if (captured.seq === lastMeasuredSeq) {
          await nextFrame()
          if (stopBtn.dataset.requested === 'true') break
          continue
        }

        lastMeasuredSeq = captured.seq
        const result = measureCardSer(captured.data, captured.width, captured.height, card)
        if (result) {
          accumulator = accumulator ? mergeMeasureResults(accumulator, result) : result
          out.textContent = formatResults(accumulator, [
            '',
            `[accumulated ${accumulator.sampledCells} / ${TARGET_SAMPLES} samples]`,
            `[last frame seq=${captured.seq} ${captured.width}x${captured.height}]`
          ])
        }

        if (stopBtn.dataset.requested === 'true') break
        await nextFrame()
      }
    } finally {
      setHdmiUvcLabFrameTapEnabled(false)
      running = false
      startBtn.disabled = false
      stopBtn.disabled = true
      if (accumulator) {
        out.textContent = formatResults(accumulator, [
          '',
          `[accumulated ${accumulator.sampledCells} / ${TARGET_SAMPLES} samples]`,
          stopBtn.dataset.requested === 'true' ? '[stopped]' : '[target reached]'
        ])
      }
    }
  })

  stopBtn.disabled = true
}
