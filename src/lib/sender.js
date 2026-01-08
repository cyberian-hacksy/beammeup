// Sender module - handles file encoding and QR display
import qrcode from 'qrcode-generator'
import { MAX_FILE_SIZE, METADATA_INTERVAL, DATA_PRESETS, SIZE_PRESETS, SPEED_PRESETS } from './constants.js'
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
  frameCount: 0
}

// DOM elements (initialized on setup)
let elements = null

// Utility: format bytes to human readable
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
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

// Render a symbol as QR code on canvas
function renderSymbol(symbolId) {
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

// Single tick of the sender loop
function senderTick() {
  if (state.isPaused) return

  state.frameCount++

  // Every METADATA_INTERVAL frames, send metadata
  if (state.frameCount % METADATA_INTERVAL === 0) {
    renderSymbol(0)
    elements.statSymbol.textContent = '#META'
  } else {
    renderSymbol(state.symbolId)
    elements.statSymbol.textContent = '#' + state.symbolId
    state.symbolId++
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

  // Disable data and size sliders during transmission
  elements.dataSlider.disabled = true
  elements.sizeSlider.disabled = true

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

  // Re-enable sliders
  elements.dataSlider.disabled = false
  elements.sizeSlider.disabled = false

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
    state.encoder = createEncoder(buffer, file.name, state.mimeType, hash, blockSize)
    state.symbolId = 1
    state.frameCount = 0
    state.isPaused = false
    state.isSending = false

    const K = state.encoder.K
    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ', ' + K + ' blocks)'

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
      preset.blockSize
    )
    state.symbolId = 1
    state.frameCount = 0
    elements.fileInfo.textContent = state.fileName + ' (' + formatBytes(state.fileBuffer.byteLength) + ', ' + state.encoder.K + ' blocks)'
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
    statSymbol: document.getElementById('stat-symbol')
  }

  // Set initial state
  updateDropZoneState()
  updateActionButton()

  // Bind event handlers
  elements.fileInput.onchange = handleFileSelect
  elements.dataSlider.oninput = handleDataPresetChange
  elements.sizeSlider.oninput = handleSizePresetChange
  elements.speedSlider.oninput = handleSpeedPresetChange
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending

  // Drop zone handlers
  elements.qrContainer.onclick = handleDropZoneClick
  elements.qrContainer.ondragover = handleDragOver
  elements.qrContainer.ondragleave = handleDragLeave
  elements.qrContainer.ondrop = handleDrop
}
