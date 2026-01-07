// Sender module - handles file encoding and QR display
import qrcode from 'qrcode-generator'
import { MAX_FILE_SIZE, METADATA_INTERVAL } from './constants.js'
import { createEncoder } from './encoder.js'

// Sender state
const state = {
  encoder: null,
  intervalId: null,
  symbolId: 1,
  isPaused: false,
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

// Render a symbol as QR code on canvas
function renderSymbol(symbolId) {
  const packet = state.encoder.generateSymbol(symbolId)
  const base64 = btoa(String.fromCharCode.apply(null, packet))

  // Use qrcode library to render to canvas
  const qr = qrcode(0, 'M')
  qr.addData(base64)
  qr.make()

  const moduleCount = qr.getModuleCount()
  const cellSize = 8
  const size = moduleCount * cellSize

  const canvas = elements.qrCanvas
  canvas.width = size
  canvas.height = size
  canvas.style.display = 'block'
  elements.qrPlaceholder.style.display = 'none'

  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, size, size)

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
    elements.statSymbol.textContent = 'META'
  } else {
    renderSymbol(state.symbolId)
    elements.statSymbol.textContent = '#' + state.symbolId
    state.symbolId++
    // Loop back after K symbols
    if (state.encoder && state.symbolId > state.encoder.k) {
      state.symbolId = 1
    }
  }
}

// Start sending
function startSending() {
  if (!state.encoder) return

  state.isPaused = false
  elements.btnStart.disabled = true
  elements.btnPause.disabled = false
  elements.statStatus.textContent = 'Sending...'

  // Initial tick
  senderTick()

  // Start interval
  state.intervalId = setInterval(senderTick, parseInt(elements.speedSlider.value))
}

// Pause sending
function pauseSending() {
  state.isPaused = true
  clearInterval(state.intervalId)
  state.intervalId = null
  elements.btnStart.disabled = false
  elements.btnPause.disabled = true
  elements.statStatus.textContent = 'Paused'
}

// Handle file selection
async function handleFileSelect(e) {
  const file = e.target.files[0]
  if (!file) return

  if (file.size > MAX_FILE_SIZE) {
    showError('File too large. Limit: 5MB.')
    return
  }

  try {
    const buffer = await file.arrayBuffer()
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))

    state.encoder = createEncoder(buffer, file.name, file.type || 'application/octet-stream', hash)
    state.symbolId = 1
    state.frameCount = 0

    const k = state.encoder.k
    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ', ' + k + ' blocks)'
    elements.btnStart.disabled = false
    elements.statStatus.textContent = 'Ready'

    // Show first QR (metadata)
    renderSymbol(0)
  } catch (err) {
    console.error('File read error:', err)
    showError('Failed to read file. Please try again.')
  }
}

// Handle speed slider change
function handleSpeedChange() {
  const speed = parseInt(elements.speedSlider.value)
  elements.speedDisplay.textContent = speed + 'ms'

  // If currently sending, restart interval with new speed
  if (state.intervalId && !state.isPaused) {
    clearInterval(state.intervalId)
    state.intervalId = setInterval(senderTick, speed)
  }
}

// Error display (will be connected to global error banner)
let showError = (msg) => console.error(msg)

// Reset sender state
export function resetSender() {
  if (state.intervalId) {
    clearInterval(state.intervalId)
    state.intervalId = null
  }
  state.encoder = null
  state.isPaused = false
  state.symbolId = 1
  state.frameCount = 0

  if (elements) {
    elements.btnStart.disabled = true
    elements.btnPause.disabled = true
    elements.qrCanvas.style.display = 'none'
    elements.qrPlaceholder.style.display = 'block'
    elements.fileInfo.textContent = 'No file selected'
    elements.statSymbol.textContent = '-'
    elements.statStatus.textContent = 'Ready'
    elements.fileInput.value = ''
  }
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
    speedSlider: document.getElementById('speed-slider'),
    speedDisplay: document.getElementById('speed-display'),
    btnStart: document.getElementById('btn-start-send'),
    btnPause: document.getElementById('btn-pause-send'),
    statSymbol: document.getElementById('stat-symbol'),
    statStatus: document.getElementById('stat-send-status')
  }

  // Bind event handlers
  elements.fileInput.onchange = handleFileSelect
  elements.speedSlider.oninput = handleSpeedChange
  elements.btnStart.onclick = startSending
  elements.btnPause.onclick = pauseSending
}
