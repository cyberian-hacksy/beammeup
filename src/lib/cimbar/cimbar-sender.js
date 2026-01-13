// CIMBAR Sender module - handles file encoding and CIMBAR display
import { loadCimbarWasm, getModule } from './cimbar-loader.js'

const MAX_FILE_SIZE = 33 * 1024 * 1024 // 33MB (CIMBAR limit)

const SIZE_PRESETS = [
  { name: 'Medium', size: 720 },
  { name: 'Large', size: 1024 },
  { name: 'Full', size: 0 } // 0 = match screen
]

const SPEED_PRESETS = [
  { name: 'Slow', fps: 10, interval: 100 },
  { name: 'Normal', fps: 15, interval: 66 },
  { name: 'Fast', fps: 20, interval: 50 }
]

// Sender state
const state = {
  fileData: null,
  fileName: null,
  fileSize: 0,
  timerId: null,
  isSending: false,
  isPaused: false,
  frameCount: 0,
  wasmLoaded: false,
  idealRatio: 1
}

let elements = null
let showError = (msg) => console.error(msg)

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function getTargetInterval() {
  const index = parseInt(elements.speedSlider.value)
  return SPEED_PRESETS[index].interval
}

function getTargetSize() {
  const index = parseInt(elements.sizeSlider.value)
  const preset = SIZE_PRESETS[index]
  if (preset.size === 0) {
    return Math.min(window.innerWidth - 20, window.innerHeight - 250)
  }
  return preset.size
}

function estimateTime() {
  if (!state.fileSize) return ''
  const bytesPerFrame = 7500
  const fps = SPEED_PRESETS[parseInt(elements.speedSlider.value)].fps
  const totalFrames = Math.ceil(state.fileSize / bytesPerFrame)
  const seconds = totalFrames / fps
  if (seconds < 60) return '~' + Math.ceil(seconds) + 's'
  return '~' + (seconds / 60).toFixed(1) + 'm'
}

function updateDropZoneState() {
  const container = elements.container
  if (!state.fileData) {
    container.classList.add('empty')
    container.classList.remove('has-file')
  } else {
    container.classList.remove('empty')
    container.classList.add('has-file')
  }
}

function updateActionButton() {
  const btn = elements.btnAction
  if (!state.fileData || !state.wasmLoaded) {
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
  elements.btnStop.disabled = !state.fileData
}

// Scale canvas using CSS (WASM renders at fixed internal size)
function scaleCanvas() {
  const canvas = elements.canvas
  const size = getTargetSize()

  // Calculate dimensions maintaining aspect ratio
  let width = size
  let height = Math.floor(size / state.idealRatio)

  // Apply as CSS dimensions (not canvas dimensions)
  canvas.style.width = width + 'px'
  canvas.style.height = height + 'px'
}

function renderFrame() {
  if (!state.isSending || state.isPaused) return

  const Module = getModule()
  if (!Module) return

  Module._cimbare_render()
  Module._cimbare_next_frame(false) // false = no color balance

  state.frameCount++

  // Schedule next frame
  state.timerId = setTimeout(renderFrame, getTargetInterval())
}

// Copy data to WASM heap
function copyToWasmHeap(Module, data) {
  const ptr = Module._malloc(data.length)
  const wasmData = new Uint8Array(Module.HEAPU8.buffer, ptr, data.length)
  wasmData.set(data)
  return { ptr, view: wasmData }
}

async function startSending() {
  if (!state.fileData) return

  const Module = getModule()
  if (!Module) {
    showError('CIMBAR not loaded')
    return
  }

  try {
    const canvas = elements.canvas

    // Set canvas on Module for WASM rendering
    Module.canvas = canvas

    // Configure mode first (68 = mode B, -1 = use defaults)
    Module._cimbare_configure(68, -1)
    state.idealRatio = Module._cimbare_get_aspect_ratio()

    // Show canvas
    canvas.style.display = 'block'
    elements.placeholder.style.display = 'none'

    // Scale canvas via CSS
    scaleCanvas()

    // Initialize encoder with filename
    const fnBytes = new TextEncoder().encode(state.fileName)
    const fnAlloc = copyToWasmHeap(Module, fnBytes)
    Module._cimbare_init_encode(fnAlloc.ptr, fnBytes.length, -1)
    Module._free(fnAlloc.ptr)

    // Encode file data in chunks
    const chunkSize = Module._cimbare_encode_bufsize()
    const fileBytes = new Uint8Array(state.fileData)

    for (let offset = 0; offset < fileBytes.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, fileBytes.length)
      const chunk = fileBytes.subarray(offset, end)
      const chunkAlloc = copyToWasmHeap(Module, chunk)
      Module._cimbare_encode(chunkAlloc.ptr, chunk.length)
      Module._free(chunkAlloc.ptr)
    }

    // Final flush with empty buffer
    const emptyAlloc = copyToWasmHeap(Module, new Uint8Array(0))
    Module._cimbare_encode(emptyAlloc.ptr, 0)
    Module._free(emptyAlloc.ptr)

    state.isSending = true
    state.isPaused = false
    state.frameCount = 0

    elements.sizeSlider.disabled = true
    elements.speedSlider.disabled = true

    updateActionButton()
    renderFrame()

  } catch (err) {
    console.error('CIMBAR start error:', err)
    showError('Failed to start: ' + err.message)
  }
}

function pauseSending() {
  state.isPaused = true
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
  }
  updateActionButton()
}

function resumeSending() {
  state.isPaused = false
  updateActionButton()
  renderFrame()
}

function stopSending() {
  if (state.timerId) {
    clearTimeout(state.timerId)
    state.timerId = null
  }

  state.fileData = null
  state.fileName = null
  state.fileSize = 0
  state.isSending = false
  state.isPaused = false
  state.frameCount = 0

  elements.sizeSlider.disabled = false
  elements.speedSlider.disabled = false

  elements.canvas.style.display = 'none'
  elements.placeholder.style.display = 'flex'
  elements.fileInfo.textContent = 'No file'
  elements.estimate.textContent = ''
  elements.fileInput.value = ''

  updateDropZoneState()
  updateActionButton()
}

function handleActionClick() {
  if (!state.fileData) return

  if (state.isSending && !state.isPaused) {
    pauseSending()
  } else if (state.isPaused) {
    resumeSending()
  } else {
    startSending()
  }
}

async function processFile(file) {
  if (!file) return

  if (file.size > MAX_FILE_SIZE) {
    showError('File too large. CIMBAR limit: 33MB.')
    return
  }

  try {
    // Show loading if WASM not ready
    if (!state.wasmLoaded) {
      elements.loading.classList.remove('hidden')
      await loadCimbarWasm()
      state.wasmLoaded = true
      elements.loading.classList.add('hidden')
    }

    const buffer = await file.arrayBuffer()

    state.fileData = buffer
    state.fileName = file.name
    state.fileSize = file.size
    state.isSending = false
    state.isPaused = false

    elements.fileInfo.textContent = file.name + ' (' + formatBytes(file.size) + ')'
    elements.estimate.textContent = estimateTime()

    updateDropZoneState()
    updateActionButton()

  } catch (err) {
    console.error('File read error:', err)
    elements.loading.classList.add('hidden')
    showError('Failed to read file: ' + err.message)
  }
}

function handleFileSelect(e) {
  processFile(e.target.files[0])
}

function handleDropZoneClick() {
  if (!state.fileData) {
    elements.fileInput.click()
  }
}

function handleDragOver(e) {
  e.preventDefault()
  e.stopPropagation()
  if (!state.fileData) {
    elements.container.classList.add('dragover')
  }
}

function handleDragLeave(e) {
  e.preventDefault()
  e.stopPropagation()
  elements.container.classList.remove('dragover')
}

async function handleDrop(e) {
  e.preventDefault()
  e.stopPropagation()
  elements.container.classList.remove('dragover')

  if (state.fileData) return

  const files = e.dataTransfer.files
  if (files.length > 0) {
    await processFile(files[0])
  }
}

function handleSizeChange() {
  const index = parseInt(elements.sizeSlider.value)
  const preset = SIZE_PRESETS[index]
  const displaySize = preset.size === 0 ? 'screen' : preset.size + 'px'
  elements.sizeDisplay.textContent = preset.name + ' (' + displaySize + ')'

  // If sending, update canvas size
  if (state.isSending) {
    scaleCanvas()
  }
}

function handleSpeedChange() {
  const index = parseInt(elements.speedSlider.value)
  const preset = SPEED_PRESETS[index]
  elements.speedDisplay.textContent = preset.name + ' (' + preset.fps + ' FPS)'
  elements.estimate.textContent = estimateTime()
}

export function resetCimbarSender() {
  stopSending()
}

export function initCimbarSender(errorHandler) {
  showError = errorHandler

  elements = {
    fileInput: document.getElementById('cimbar-file-input'),
    container: document.getElementById('cimbar-container'),
    placeholder: document.getElementById('cimbar-placeholder'),
    canvas: document.getElementById('cimbar-canvas'),
    loading: document.getElementById('cimbar-loading'),
    sizeSlider: document.getElementById('cimbar-size-slider'),
    sizeDisplay: document.getElementById('cimbar-size-display'),
    speedSlider: document.getElementById('cimbar-speed-slider'),
    speedDisplay: document.getElementById('cimbar-speed-display'),
    fileInfo: document.getElementById('cimbar-file-info'),
    estimate: document.getElementById('cimbar-estimate'),
    btnAction: document.getElementById('btn-cimbar-action'),
    btnStop: document.getElementById('btn-cimbar-stop')
  }

  updateDropZoneState()
  updateActionButton()
  handleSizeChange()
  handleSpeedChange()

  elements.fileInput.onchange = handleFileSelect
  elements.sizeSlider.oninput = handleSizeChange
  elements.speedSlider.oninput = handleSpeedChange
  elements.btnAction.onclick = handleActionClick
  elements.btnStop.onclick = stopSending

  elements.container.onclick = handleDropZoneClick
  elements.container.ondragover = handleDragOver
  elements.container.ondragleave = handleDragLeave
  elements.container.ondrop = handleDrop
}
