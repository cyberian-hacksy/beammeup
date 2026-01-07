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
    elements.statSymbol.textContent = '#META'
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
  state.isSending = true
  updateActionButton()

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
  updateActionButton()
}

// Resume sending
function resumeSending() {
  state.isPaused = false
  updateActionButton()

  // Resume interval
  state.intervalId = setInterval(senderTick, parseInt(elements.speedSlider.value))
}

// Stop sending and reset
function stopSending() {
  if (state.intervalId) {
    clearInterval(state.intervalId)
    state.intervalId = null
  }
  state.encoder = null
  state.isPaused = false
  state.isSending = false
  state.symbolId = 1
  state.frameCount = 0

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
    showError('File too large. Limit: 5MB.')
    return
  }

  try {
    const buffer = await file.arrayBuffer()
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))

    state.encoder = createEncoder(buffer, file.name, file.type || 'application/octet-stream', hash)
    state.symbolId = 1
    state.frameCount = 0
    state.isPaused = false
    state.isSending = false

    const k = state.encoder.k
    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ', ' + k + ' blocks)'

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
  elements.speedSlider.oninput = handleSpeedChange
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending

  // Drop zone handlers
  elements.qrContainer.onclick = handleDropZoneClick
  elements.qrContainer.ondragover = handleDragOver
  elements.qrContainer.ondragleave = handleDragLeave
  elements.qrContainer.ondrop = handleDrop
}
