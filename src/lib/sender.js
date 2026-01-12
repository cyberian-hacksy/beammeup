// Sender module - handles file encoding and QR display
import qrcode from 'qrcode-generator'
import { MAX_FILE_SIZE, METADATA_INTERVAL, DATA_PRESETS, SIZE_PRESETS, SPEED_PRESETS, QR_MODE, MODE_MARGIN_RATIOS, PATCH_SIZE_RATIO, PATCH_GAP_RATIO } from './constants.js'
import { createEncoder } from './encoder.js'

// Sender state
const state = {
  encoder: null,
  fileBuffer: null,
  fileName: null,
  mimeType: null,
  fileHash: null,
  intervalId: null,
  symbolId: 1,
  isPaused: false,
  isSending: false,
  frameCount: 0,
  mode: QR_MODE.BW
}

// DOM elements (initialized on setup)
let elements = null

// Utility: format bytes to human readable
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

// ============ Color Mode Helpers ============

// CMY to RGB conversion for PCCC mode
function cmyToRgb(c, m, y) {
  return [
    Math.round(255 * (1 - c)),
    Math.round(255 * (1 - m)),
    Math.round(255 * (1 - y))
  ]
}

// Fixed 8-color RGB palette for Palette mode
// Index encodes: bit2=R, bit1=G, bit0=B (inverted for QR: high index = dark)
const PALETTE_RGB = [
  [255, 255, 255], // 0: White (000)
  [255, 255, 0],   // 1: Yellow (001)
  [255, 0, 255],   // 2: Magenta (010)
  [255, 0, 0],     // 3: Red (011)
  [0, 255, 255],   // 4: Cyan (100)
  [0, 255, 0],     // 5: Green (101)
  [0, 0, 255],     // 6: Blue (110)
  [0, 0, 0]        // 7: Black (111)
]

// Palette patch configuration for HCC2D calibration
// Each corner has 2 patches arranged to show all 8 palette colors
const PALETTE_PATCH_CONFIG = [
  { corner: 'TL', offset: 0, paletteIndex: 0 },  // White
  { corner: 'TL', offset: 1, paletteIndex: 3 },  // Red
  { corner: 'TR', offset: 0, paletteIndex: 5 },  // Green
  { corner: 'TR', offset: 1, paletteIndex: 4 },  // Cyan
  { corner: 'BL', offset: 0, paletteIndex: 6 },  // Blue
  { corner: 'BL', offset: 1, paletteIndex: 2 },  // Magenta
  { corner: 'BR', offset: 0, paletteIndex: 1 },  // Yellow
  { corner: 'BR', offset: 1, paletteIndex: 7 },  // Black
]

// Check if position is finder or timing pattern (must stay B/W for detection)
function isFinderOrTiming(row, col, size) {
  // Top-left finder (includes separator)
  if (row < 8 && col < 8) return true
  // Top-right finder
  if (row < 8 && col >= size - 8) return true
  // Bottom-left finder
  if (row >= size - 8 && col < 8) return true
  // Timing patterns
  if (row === 6 || col === 6) return true
  // Alignment pattern for larger QR codes
  if (size > 25) {
    const alignPos = size - 7
    if (row >= alignPos - 2 && row <= alignPos + 2 &&
        col >= alignPos - 2 && col <= alignPos + 2) return true
  }
  return false
}

// Get QR modules from base64 data
function getQRModules(base64Data, eccLevel) {
  const qr = qrcode(0, eccLevel)
  qr.addData(base64Data)
  qr.make()
  const count = qr.getModuleCount()
  const modules = []
  for (let r = 0; r < count; r++) {
    modules[r] = []
    for (let c = 0; c < count; c++) {
      modules[r][c] = qr.isDark(r, c) ? 1 : 0
    }
  }
  return { modules, count }
}

// Get patch position for Palette mode calibration (proportional to margin)
function getPatchPosition(corner, offset, canvasSize, patchSize, patchGap) {
  switch (corner) {
    case 'TL':
      return {
        x: patchGap + offset * (patchSize + patchGap),
        y: patchGap
      }
    case 'TR':
      return {
        x: canvasSize - patchGap - patchSize - offset * (patchSize + patchGap),
        y: patchGap
      }
    case 'BL':
      return {
        x: patchGap + offset * (patchSize + patchGap),
        y: canvasSize - patchGap - patchSize
      }
    case 'BR':
      return {
        x: canvasSize - patchGap - patchSize - offset * (patchSize + patchGap),
        y: canvasSize - patchGap - patchSize
      }
  }
}

// Draw calibration patches for Palette mode
function drawCalibrationPatches(ctx, canvasSize, margin) {
  // Calculate patch size and gap from margin (proportional sizing)
  const patchSize = Math.round(margin * PATCH_SIZE_RATIO)
  const patchGap = Math.round(margin * PATCH_GAP_RATIO)

  for (const patch of PALETTE_PATCH_CONFIG) {
    const pos = getPatchPosition(patch.corner, patch.offset, canvasSize, patchSize, patchGap)
    const color = PALETTE_RGB[patch.paletteIndex]
    ctx.fillStyle = 'rgb(' + color.join(',') + ')'
    ctx.fillRect(pos.x, pos.y, patchSize, patchSize)

    // Add thin border for visibility
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 1
    ctx.strokeRect(pos.x, pos.y, patchSize, patchSize)
  }
}

// Update drop zone appearance based on state
function updateDropZoneState() {
  const container = elements.qrContainer
  if (!state.encoder) {
    container.classList.add('empty')
    container.classList.remove('has-file')
  } else {
    container.classList.remove('empty')
    container.classList.add('has-file')
  }
}

// Update action button label based on state
function updateActionButton() {
  const btn = elements.btnAction
  if (!state.encoder) {
    btn.textContent = 'Start'
    btn.disabled = true
  } else if (state.isSending && !state.isPaused) {
    btn.textContent = 'Pause'
    btn.disabled = false
  } else if (state.isPaused) {
    btn.textContent = 'Resume'
    btn.disabled = false
  } else {
    btn.textContent = 'Start'
    btn.disabled = false
  }

  elements.btnStop.disabled = !state.encoder
}

// Render a symbol as QR code on canvas (BW mode)
function renderSymbolBW(symbolId) {
  const dataPreset = DATA_PRESETS[parseInt(elements.dataSlider.value)]
  const sizePreset = SIZE_PRESETS[parseInt(elements.sizeSlider.value)]

  const packet = state.encoder.generateSymbol(symbolId)
  const base64 = btoa(String.fromCharCode.apply(null, packet))

  // Use dynamic ECC from preset
  const qr = qrcode(0, dataPreset.ecc)
  qr.addData(base64)
  qr.make()

  const moduleCount = qr.getModuleCount()
  // Scale to fit within preset size
  const cellSize = Math.floor(sizePreset.size / moduleCount)
  const actualSize = moduleCount * cellSize

  const canvas = elements.qrCanvas
  canvas.width = actualSize
  canvas.height = actualSize
  canvas.style.display = 'block'
  elements.qrPlaceholder.style.display = 'none'

  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, actualSize, actualSize)

  ctx.fillStyle = '#000000'
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize)
      }
    }
  }
}

// Render 3 symbols as color QR (PCCC or Palette mode)
function renderSymbolsColor(symbolIds) {
  const dataPreset = DATA_PRESETS[parseInt(elements.dataSlider.value)]
  const sizePreset = SIZE_PRESETS[parseInt(elements.sizeSlider.value)]

  // Size preset is canvas size, QR shrinks to fit margins
  const canvasSize = sizePreset.size
  const marginRatio = MODE_MARGIN_RATIOS[state.mode]
  // Solve: canvasSize = qrSize + 2*margin, margin = qrSize * marginRatio
  // canvasSize = qrSize * (1 + 2*marginRatio)
  const qrSize = Math.round(canvasSize / (1 + 2 * marginRatio))
  const margin = Math.round((canvasSize - qrSize) / 2)

  // Generate packets for all 3 channels
  const packets = symbolIds.map(id => state.encoder.generateSymbol(id))
  const base64s = packets.map(p => btoa(String.fromCharCode.apply(null, p)))

  // Get QR modules for each channel
  const qrModules = base64s.map(b64 => getQRModules(b64, dataPreset.ecc))
  const moduleCount = qrModules[0].count
  const cellSize = qrSize / moduleCount

  const canvas = elements.qrCanvas
  canvas.width = canvasSize
  canvas.height = canvasSize
  canvas.style.display = 'block'
  elements.qrPlaceholder.style.display = 'none'

  const ctx = canvas.getContext('2d')

  // White background
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvasSize, canvasSize)

  // Draw QR code with color encoding
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      const ch0 = qrModules[0].modules[row][col]
      const ch1 = qrModules[1].modules[row][col]
      const ch2 = qrModules[2].modules[row][col]

      let rgb
      if (isFinderOrTiming(row, col, moduleCount)) {
        // Keep finder patterns black/white for detection
        rgb = ch0 ? [0, 0, 0] : [255, 255, 255]
      } else if (state.mode === QR_MODE.PCCC) {
        // PCCC: CMY encoding (ch0=C, ch1=M, ch2=Y)
        rgb = cmyToRgb(ch0, ch1, ch2)
      } else {
        // Palette: RGB encoding (ch0=R bit, ch1=G bit, ch2=B bit)
        const paletteIndex = ch0 * 4 + ch1 * 2 + ch2
        rgb = PALETTE_RGB[paletteIndex]
      }

      const x = margin + col * cellSize
      const y = margin + row * cellSize

      ctx.fillStyle = 'rgb(' + rgb.join(',') + ')'
      ctx.fillRect(x, y, cellSize + 0.5, cellSize + 0.5)
    }
  }

  // Draw calibration patches for Palette mode
  if (state.mode === QR_MODE.PALETTE) {
    drawCalibrationPatches(ctx, canvasSize, margin)
  }

  // Draw visible border for positioning guide (color modes only)
  // This helps the receiver know to keep the entire frame visible
  const borderWidth = 3
  ctx.strokeStyle = '#00d4ff'  // Cyan border
  ctx.lineWidth = borderWidth
  ctx.strokeRect(borderWidth / 2, borderWidth / 2, canvasSize - borderWidth, canvasSize - borderWidth)
}

// Render symbol(s) based on current mode
function renderSymbol(symbolId) {
  if (state.mode === QR_MODE.BW) {
    renderSymbolBW(symbolId)
  } else {
    // Color modes: symbolId is actually the first of 3 symbol IDs
    // or for metadata, all 3 channels carry the same symbolId (0)
    if (symbolId === 0) {
      renderSymbolsColor([0, 0, 0])
    } else {
      renderSymbolsColor([symbolId, symbolId + 1, symbolId + 2])
    }
  }
}

// Single tick of the sender loop
function senderTick() {
  if (state.isPaused) return

  state.frameCount++

  // Symbols per frame: 1 for BW, 3 for color modes
  const symbolsPerFrame = state.mode === QR_MODE.BW ? 1 : 3

  // Every METADATA_INTERVAL frames, send metadata
  if (state.frameCount % METADATA_INTERVAL === 0) {
    renderSymbol(0)
    elements.statSymbol.textContent = '#META'
  } else {
    renderSymbol(state.symbolId)
    if (state.mode === QR_MODE.BW) {
      elements.statSymbol.textContent = '#' + state.symbolId
    } else {
      elements.statSymbol.textContent = '#' + state.symbolId + '-' + (state.symbolId + 2)
    }
    state.symbolId += symbolsPerFrame
    // Loop back after K_prime symbols (includes parity blocks)
    if (state.encoder && state.symbolId > state.encoder.K_prime) {
      state.symbolId = 1
    }
  }
}

// Start sending
function startSending() {
  if (!state.encoder) return

  state.isPaused = false
  state.isSending = true
  updateActionButton()

  // Disable data, size sliders, and mode selector during transmission
  elements.dataSlider.disabled = true
  elements.sizeSlider.disabled = true
  elements.modeButtons.forEach(btn => btn.disabled = true)

  // Initial tick
  senderTick()

  // Start interval using speed preset
  const speedIndex = parseInt(elements.speedSlider.value)
  state.intervalId = setInterval(senderTick, SPEED_PRESETS[speedIndex].interval)
}

// Pause sending
function pauseSending() {
  state.isPaused = true
  clearInterval(state.intervalId)
  state.intervalId = null
  updateActionButton()
}

// Resume sending
function resumeSending() {
  state.isPaused = false
  updateActionButton()

  // Resume interval using speed preset
  const speedIndex = parseInt(elements.speedSlider.value)
  state.intervalId = setInterval(senderTick, SPEED_PRESETS[speedIndex].interval)
}

// Stop sending and reset
function stopSending() {
  if (state.intervalId) {
    clearInterval(state.intervalId)
    state.intervalId = null
  }
  state.encoder = null
  state.fileBuffer = null
  state.fileName = null
  state.mimeType = null
  state.fileHash = null
  state.isPaused = false
  state.isSending = false
  state.symbolId = 1
  state.frameCount = 0

  // Re-enable sliders and mode selector
  elements.dataSlider.disabled = false
  elements.sizeSlider.disabled = false
  elements.modeButtons.forEach(btn => btn.disabled = false)

  elements.qrCanvas.style.display = 'none'
  elements.qrPlaceholder.style.display = 'flex'
  elements.fileInfo.textContent = 'No file'
  elements.statSymbol.textContent = ''
  elements.fileInput.value = ''

  updateDropZoneState()
  updateActionButton()
}

// Handle action button click (Start/Pause/Resume)
function handleActionClick() {
  if (!state.encoder) return

  if (state.isSending && !state.isPaused) {
    pauseSending()
  } else if (state.isPaused) {
    resumeSending()
  } else {
    startSending()
  }
}

// Process a file (from input or drop)
async function processFile(file) {
  if (!file) return

  if (file.size > MAX_FILE_SIZE) {
    showError('File too large. Limit: 20MB.')
    return
  }

  try {
    const buffer = await file.arrayBuffer()
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))

    // Store file data for re-encoding on preset change
    state.fileBuffer = buffer
    state.fileName = file.name
    state.mimeType = file.type || 'application/octet-stream'
    state.fileHash = hash

    const dataIndex = parseInt(elements.dataSlider.value)
    const blockSize = DATA_PRESETS[dataIndex].blockSize
    state.encoder = createEncoder(buffer, file.name, state.mimeType, hash, blockSize, state.mode)
    state.symbolId = 1
    state.frameCount = 0
    state.isPaused = false
    state.isSending = false

    const K = state.encoder.K
    const modeLabel = state.mode === QR_MODE.BW ? '' : (state.mode === QR_MODE.PCCC ? ' CMY' : ' RGB')
    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ', ' + K + ' blocks' + modeLabel + ')'

    updateDropZoneState()
    updateActionButton()

    // Show first QR (metadata)
    renderSymbol(0)
  } catch (err) {
    console.error('File read error:', err)
    showError('Failed to read file. Please try again.')
  }
}

// Handle file selection
async function handleFileSelect(e) {
  await processFile(e.target.files[0])
}

// Handle drop zone click
function handleDropZoneClick() {
  // Only trigger file picker if no file is loaded
  if (!state.encoder) {
    elements.fileInput.click()
  }
}

// Handle drag over
function handleDragOver(e) {
  e.preventDefault()
  e.stopPropagation()
  if (!state.encoder) {
    elements.qrContainer.classList.add('dragover')
  }
}

// Handle drag leave
function handleDragLeave(e) {
  e.preventDefault()
  e.stopPropagation()
  elements.qrContainer.classList.remove('dragover')
}

// Handle drop
async function handleDrop(e) {
  e.preventDefault()
  e.stopPropagation()
  elements.qrContainer.classList.remove('dragover')

  // Only accept drop if no file is loaded
  if (state.encoder) return

  const files = e.dataTransfer.files
  if (files.length > 0) {
    await processFile(files[0])
  }
}

// Handle data preset change
function handleDataPresetChange() {
  const index = parseInt(elements.dataSlider.value)
  const preset = DATA_PRESETS[index]
  elements.dataDisplay.textContent = preset.name + ' (' + preset.blockSize + 'B)'

  // Re-encode if file is loaded but not sending
  if (state.fileBuffer && !state.isSending) {
    state.encoder = createEncoder(
      state.fileBuffer,
      state.fileName,
      state.mimeType,
      state.fileHash,
      preset.blockSize,
      state.mode
    )
    state.symbolId = 1
    state.frameCount = 0
    const modeLabel = state.mode === QR_MODE.BW ? '' : (state.mode === QR_MODE.PCCC ? ' CMY' : ' RGB')
    elements.fileInfo.textContent = state.fileName + ' (' + formatBytes(state.fileBuffer.byteLength) + ', ' + state.encoder.K + ' blocks' + modeLabel + ')'
    renderSymbol(0)
  }
}

// Apply mode-specific default settings
function applyModeDefaults(mode) {
  if (mode === QR_MODE.BW) {
    // BW: max dense, largest, fastest
    elements.dataSlider.value = 3
    elements.sizeSlider.value = 2
    elements.speedSlider.value = 2
  } else {
    // Color modes: least dense, largest, slowest
    elements.dataSlider.value = 0
    elements.sizeSlider.value = 2
    elements.speedSlider.value = 0
  }
  // Update displays
  handleDataPresetChange()
  handleSizePresetChange()
  handleSpeedPresetChange()
}

// Handle mode change
function handleModeChange(newMode) {
  if (state.isSending) return // Don't change mode while sending

  state.mode = newMode

  // Update button states
  elements.modeButtons.forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.mode) === newMode)
  })

  // Apply mode-specific defaults
  applyModeDefaults(newMode)

  // Re-encode if file is loaded
  if (state.fileBuffer) {
    const dataIndex = parseInt(elements.dataSlider.value)
    const blockSize = DATA_PRESETS[dataIndex].blockSize
    state.encoder = createEncoder(
      state.fileBuffer,
      state.fileName,
      state.mimeType,
      state.fileHash,
      blockSize,
      state.mode
    )
    state.symbolId = 1
    state.frameCount = 0
    const modeLabel = state.mode === QR_MODE.BW ? '' : (state.mode === QR_MODE.PCCC ? ' CMY' : ' RGB')
    elements.fileInfo.textContent = state.fileName + ' (' + formatBytes(state.fileBuffer.byteLength) + ', ' + state.encoder.K + ' blocks' + modeLabel + ')'
    renderSymbol(0)
  }
}

// Handle size preset change
function handleSizePresetChange() {
  const index = parseInt(elements.sizeSlider.value)
  const preset = SIZE_PRESETS[index]
  elements.sizeDisplay.textContent = preset.name + ' (' + preset.size + 'px)'

  // Re-render if QR is visible
  if (state.encoder) {
    renderSymbol(state.isSending ? state.symbolId : 0)
  }
}

// Handle speed preset change
function handleSpeedPresetChange() {
  const index = parseInt(elements.speedSlider.value)
  const preset = SPEED_PRESETS[index]
  elements.speedDisplay.textContent = preset.name + ' (' + preset.interval + 'ms)'

  // Update interval if currently sending
  if (state.intervalId && !state.isPaused) {
    clearInterval(state.intervalId)
    state.intervalId = setInterval(senderTick, preset.interval)
  }
}

// Error display (will be connected to global error banner)
let showError = (msg) => console.error(msg)

// Reset sender state
export function resetSender() {
  stopSending()
}

// Initialize sender module
export function initSender(errorHandler) {
  showError = errorHandler

  elements = {
    fileInput: document.getElementById('file-input'),
    fileInfo: document.getElementById('file-info'),
    qrContainer: document.getElementById('qr-container'),
    qrPlaceholder: document.getElementById('qr-placeholder'),
    qrCanvas: document.getElementById('qr-canvas'),
    dataSlider: document.getElementById('data-slider'),
    dataDisplay: document.getElementById('data-display'),
    sizeSlider: document.getElementById('size-slider'),
    sizeDisplay: document.getElementById('size-display'),
    speedSlider: document.getElementById('speed-slider'),
    speedDisplay: document.getElementById('speed-display'),
    btnAction: document.getElementById('btn-action-send'),
    btnStop: document.getElementById('btn-stop-send'),
    statSymbol: document.getElementById('stat-symbol'),
    modeSelector: document.getElementById('qr-mode-selector'),
    modeButtons: document.querySelectorAll('#qr-mode-selector .mode-btn')
  }

  // Set initial state
  updateDropZoneState()
  updateActionButton()

  // Apply mode-specific defaults for initial mode (BW)
  applyModeDefaults(state.mode)

  // Bind event handlers
  elements.fileInput.onchange = handleFileSelect
  elements.dataSlider.oninput = handleDataPresetChange
  elements.sizeSlider.oninput = handleSizePresetChange
  elements.speedSlider.oninput = handleSpeedPresetChange
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending

  // Mode selector handlers
  elements.modeButtons.forEach(btn => {
    btn.onclick = () => handleModeChange(parseInt(btn.dataset.mode))
  })

  // Drop zone handlers
  elements.qrContainer.onclick = handleDropZoneClick
  elements.qrContainer.ondragover = handleDragOver
  elements.qrContainer.ondragleave = handleDragLeave
  elements.qrContainer.ondrop = handleDrop
}
