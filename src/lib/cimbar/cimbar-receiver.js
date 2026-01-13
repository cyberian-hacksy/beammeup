// CIMBAR Receiver module - handles camera capture and decoding
import { loadCimbarWasm, getModule } from './cimbar-loader.js'

// Receiver state
const state = {
  stream: null,
  isScanning: false,
  frameCount: 0,
  recentDecode: -1,
  recentExtract: -1,
  fileId: null,
  fileName: null,
  fileSize: 0,
  startTime: 0,
  cameras: [],
  currentCameraIndex: 0,
  wasmLoaded: false,
  // WASM buffers
  imgBuff: null,
  fountainBuff: null,
  reportBuff: null,
  // Mode cycling for auto-detect
  currentMode: 0,
  modeValues: [67, 68, 4] // Bm, B, 4C
}

let elements = null
let showError = (msg) => console.error(msg)

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function updateCrosshairs() {
  const ch = elements.crosshairs
  if (state.recentDecode > 0 && state.recentDecode + 30 > state.frameCount) {
    ch.className = 'cimbar-crosshairs active'
  } else if (state.recentExtract > 0 && state.recentExtract + 30 > state.frameCount) {
    ch.className = 'cimbar-crosshairs scanning'
  } else {
    ch.className = 'cimbar-crosshairs'
  }
}

function showStatus(statusId) {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.add('hidden')

  if (statusId === 'scanning') {
    elements.statusScanning.classList.remove('hidden')
  } else if (statusId === 'receiving') {
    elements.statusReceiving.classList.remove('hidden')
  } else if (statusId === 'complete') {
    elements.statusComplete.classList.remove('hidden')
  }
}

function updateProgress(progress) {
  if (!Array.isArray(progress) || progress.length === 0) return

  const pct = Math.round(progress[0] * 100)
  elements.progressFill.style.width = pct + '%'
  elements.statProgress.textContent = pct + '%'

  const elapsed = (performance.now() - state.startTime) / 1000
  if (elapsed > 0.5 && state.fileSize > 0) {
    const bps = (state.fileSize * progress[0]) / elapsed
    elements.statRate.textContent = formatBytes(bps) + '/s'
  }
}

// Allocate WASM buffers
function allocateBuffers(Module, imgSize) {
  // Image buffer
  if (!state.imgBuff || state.imgBuff.length < imgSize) {
    if (state.imgBuff) {
      Module._free(state.imgBuff.byteOffset)
    }
    const imgPtr = Module._malloc(imgSize)
    state.imgBuff = new Uint8Array(Module.HEAPU8.buffer, imgPtr, imgSize)
  }

  // Fountain buffer
  const bufSize = Module._cimbard_get_bufsize()
  if (!state.fountainBuff || state.fountainBuff.length < bufSize) {
    if (state.fountainBuff) {
      Module._free(state.fountainBuff.byteOffset)
    }
    const fountainPtr = Module._malloc(bufSize)
    state.fountainBuff = new Uint8Array(Module.HEAPU8.buffer, fountainPtr, bufSize)
  }

  // Report buffer
  if (!state.reportBuff) {
    const reportPtr = Module._malloc(1024)
    state.reportBuff = new Uint8Array(Module.HEAPU8.buffer, reportPtr, 1024)
  }
}

async function initCamera() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    state.cameras = devices.filter(d => d.kind === 'videoinput')

    const constraints = {
      audio: false,
      video: {
        width: { min: 720, ideal: 1280 },
        height: { min: 720, ideal: 720 },
        facingMode: 'environment',
        frameRate: { ideal: 15 }
      }
    }

    if (state.cameras.length > 1 && state.currentCameraIndex > 0) {
      constraints.video.deviceId = { exact: state.cameras[state.currentCameraIndex].deviceId }
    }

    state.stream = await navigator.mediaDevices.getUserMedia(constraints)
    elements.video.srcObject = state.stream
    await elements.video.play()

    return true
  } catch (err) {
    console.error('Camera init error:', err)
    showError('Failed to access camera: ' + err.message)
    return false
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach(track => track.stop())
    state.stream = null
  }
}

function switchCamera() {
  if (state.cameras.length < 2) return
  state.currentCameraIndex = (state.currentCameraIndex + 1) % state.cameras.length
  stopCamera()
  initCamera()
}

// Check if we can use VideoFrame API (not available on iOS Safari)
function hasVideoFrameSupport() {
  return typeof VideoFrame !== 'undefined' &&
         typeof elements.video.requestVideoFrameCallback === 'function'
}

// Canvas-based fallback for iOS
let fallbackCanvas = null
let fallbackCtx = null

function getReport(Module) {
  const reportLen = Module._cimbard_get_report(state.reportBuff.byteOffset, 1024)
  if (reportLen > 0) {
    const reportView = new Uint8Array(Module.HEAPU8.buffer, state.reportBuff.byteOffset, reportLen)
    const text = new TextDecoder().decode(reportView)
    try {
      return JSON.parse(text)
    } catch (e) {
      return text
    }
  }
  return null
}

// Fallback frame processing using canvas (for iOS)
function processFrameFallback() {
  if (!state.isScanning || !state.wasmLoaded) return

  const Module = getModule()
  if (!Module) {
    setTimeout(processFrameFallback, 100)
    return
  }

  state.frameCount++
  elements.statFrames.textContent = state.frameCount + ' frames'
  updateCrosshairs()

  try {
    const video = elements.video
    const width = video.videoWidth
    const height = video.videoHeight

    if (width === 0 || height === 0) {
      setTimeout(processFrameFallback, 66)
      return
    }

    // Create canvas if needed
    if (!fallbackCanvas || fallbackCanvas.width !== width) {
      fallbackCanvas = document.createElement('canvas')
      fallbackCanvas.width = width
      fallbackCanvas.height = height
      fallbackCtx = fallbackCanvas.getContext('2d')
    }

    // Draw video frame to canvas
    fallbackCtx.drawImage(video, 0, 0)
    const imageData = fallbackCtx.getImageData(0, 0, width, height)
    const pixels = imageData.data

    // Allocate WASM buffers
    allocateBuffers(Module, pixels.length)

    // Copy pixels to WASM
    state.imgBuff.set(pixels)

    // Get mode for this frame (cycle if auto-detecting)
    let mode = state.currentMode
    if (mode === 0) {
      mode = state.modeValues[state.frameCount % state.modeValues.length]
    }
    Module._cimbard_configure_decode(mode)

    // Decode frame (type 4 = RGBA)
    const len = Module._cimbard_scan_extract_decode(
      state.imgBuff.byteOffset,
      width,
      height,
      4,
      state.fountainBuff.byteOffset,
      state.fountainBuff.length
    )

    if (len > 0) {
      state.recentDecode = state.frameCount

      // Lock in the detected mode
      if (state.currentMode === 0) {
        state.currentMode = mode
      }

      // Pass to fountain decoder
      const res = Module._cimbard_fountain_decode(state.fountainBuff.byteOffset, len)

      if (res > 0) {
        // File complete - handle BigInt
        const fileId = Number(BigInt(res) & BigInt(0xFFFFFFFF))
        handleFileComplete(fileId)
        return // Don't schedule next frame
      }

      // Check progress
      const report = getReport(Module)
      if (Array.isArray(report)) {
        if (!state.startTime) {
          state.startTime = performance.now()
          showStatus('receiving')
        }
        updateProgress(report)
      }
    } else if (len === 0) {
      state.recentExtract = state.frameCount
    }

  } catch (e) {
    console.error('Frame error:', e)
  }

  // Schedule next frame (~15 fps)
  setTimeout(processFrameFallback, 66)
}

async function processFrame(now, metadata) {
  if (!state.isScanning || !state.wasmLoaded) return

  const Module = getModule()
  if (!Module) {
    elements.video.requestVideoFrameCallback(processFrame)
    return
  }

  state.frameCount++
  elements.statFrames.textContent = state.frameCount + ' frames'
  updateCrosshairs()

  let vf = null
  try {
    // Use VideoFrame API for efficient frame capture
    vf = new VideoFrame(elements.video, { timestamp: now })
    const width = vf.displayWidth
    const height = vf.displayHeight

    // Determine format and type
    let vfParams = {}
    const supportedFormats = ['NV12', 'I420']
    if (!supportedFormats.includes(vf.format)) {
      vfParams.format = 'RGBA'
    }

    const size = vf.allocationSize(vfParams)
    const pixels = new Uint8Array(size)
    await vf.copyTo(pixels, vfParams) // copyTo is async

    let format = vfParams.format || vf.format
    let type = 4 // RGBA
    if (format === 'NV12') type = 12
    else if (format === 'I420') type = 420

    vf.close()
    vf = null

    // Allocate WASM buffers
    allocateBuffers(Module, pixels.length)

    // Copy pixels to WASM
    state.imgBuff.set(pixels)

    // Get mode for this frame (cycle if auto-detecting)
    let mode = state.currentMode
    if (mode === 0) {
      mode = state.modeValues[state.frameCount % state.modeValues.length]
    }
    Module._cimbard_configure_decode(mode)

    // Decode frame
    const len = Module._cimbard_scan_extract_decode(
      state.imgBuff.byteOffset,
      width,
      height,
      type,
      state.fountainBuff.byteOffset,
      state.fountainBuff.length
    )

    if (len > 0) {
      state.recentDecode = state.frameCount

      // Lock in the detected mode
      if (state.currentMode === 0) {
        state.currentMode = mode
      }

      // Pass to fountain decoder
      const res = Module._cimbard_fountain_decode(state.fountainBuff.byteOffset, len)

      if (res > 0) {
        // File complete - handle BigInt
        const fileId = Number(res & BigInt(0xFFFFFFFF))
        handleFileComplete(fileId)
        return // Don't schedule next frame
      }

      // Check progress
      const report = getReport(Module)
      if (Array.isArray(report)) {
        if (!state.startTime) {
          state.startTime = performance.now()
          showStatus('receiving')
        }
        updateProgress(report)
      }
    } else if (len === 0) {
      state.recentExtract = state.frameCount
    }

  } catch (e) {
    console.error('Frame error:', e)
    if (vf) vf.close()
  }

  // Schedule next frame
  elements.video.requestVideoFrameCallback(processFrame)
}

function handleFileComplete(fileId) {
  const Module = getModule()
  if (!Module) return

  state.isScanning = false
  state.fileId = fileId
  state.fileSize = Module._cimbard_get_filesize(fileId)

  // Get filename
  const fnLen = Module._cimbard_get_filename(fileId, state.reportBuff.byteOffset, 1024)
  if (fnLen > 0) {
    const fnView = new Uint8Array(Module.HEAPU8.buffer, state.reportBuff.byteOffset, fnLen)
    state.fileName = new TextDecoder().decode(fnView)
  } else {
    state.fileName = 'download'
  }

  elements.completeName.textContent = state.fileName + ' (' + formatBytes(state.fileSize) + ')'

  const elapsed = (performance.now() - state.startTime) / 1000
  if (elapsed > 0) {
    elements.completeRate.textContent = formatBytes(state.fileSize / elapsed) + '/s'
  }

  showStatus('complete')
}

function downloadFile() {
  const Module = getModule()
  if (!Module || state.fileId === null) return

  const bufSize = Module._cimbard_get_decompress_bufsize()
  const decompBuff = Module._malloc(bufSize)
  const chunks = []

  let bytesRead
  do {
    bytesRead = Module._cimbard_decompress_read(state.fileId, decompBuff, bufSize)
    if (bytesRead > 0) {
      // Must slice to copy from WASM memory
      chunks.push(new Uint8Array(Module.HEAPU8.buffer, decompBuff, bytesRead).slice())
    }
  } while (bytesRead > 0)

  Module._free(decompBuff)

  const blob = new Blob(chunks, { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = state.fileName || 'download'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function startScanning() {
  state.isScanning = true
  state.frameCount = 0
  state.recentDecode = -1
  state.recentExtract = -1
  state.startTime = 0
  state.fileId = null
  state.currentMode = 0 // Reset to auto-detect

  elements.statFrames.textContent = '0 frames'
  elements.progressFill.style.width = '0'
  showStatus('scanning')

  // Use VideoFrame API if available, otherwise use canvas fallback (iOS)
  if (hasVideoFrameSupport()) {
    console.log('Using VideoFrame API for frame capture')
    elements.video.requestVideoFrameCallback(processFrame)
  } else {
    console.log('Using canvas fallback for frame capture (iOS compatibility)')
    setTimeout(processFrameFallback, 100)
  }
}

function resetReceiver() {
  state.fileId = null
  state.fileName = null
  state.fileSize = 0
  state.startTime = 0
  state.currentMode = 0

  // Force WASM decoder sink to reset by toggling mode
  // The sink only resets when mode changes, so we cycle through two different modes
  const Module = getModule()
  if (Module) {
    Module._cimbard_configure_decode(4)   // Switch to 4C mode
    Module._cimbard_configure_decode(68)  // Switch back to B mode - this resets the sink
  }

  startScanning()
}

export async function autoStartCimbarReceiver() {
  // Load WASM first
  try {
    await loadCimbarWasm()
    state.wasmLoaded = true
  } catch (err) {
    showError('Failed to load CIMBAR: ' + err.message)
    return
  }

  const cameraOk = await initCamera()
  if (!cameraOk) return

  startScanning()
}

export function resetCimbarReceiver() {
  state.isScanning = false
  stopCamera()
}

export function initCimbarReceiver(errorHandler) {
  showError = errorHandler

  elements = {
    video: document.getElementById('cimbar-video'),
    crosshairs: document.getElementById('cimbar-crosshairs'),
    cameraSwitchBtn: document.getElementById('btn-cimbar-camera-switch'),
    statusScanning: document.getElementById('cimbar-status-scanning'),
    statusReceiving: document.getElementById('cimbar-status-receiving'),
    statusComplete: document.getElementById('cimbar-status-complete'),
    statFrames: document.getElementById('cimbar-stat-frames'),
    fileName: document.getElementById('cimbar-file-name'),
    statProgress: document.getElementById('cimbar-stat-progress'),
    statRate: document.getElementById('cimbar-stat-rate'),
    progressFill: document.getElementById('cimbar-progress-fill'),
    completeName: document.getElementById('cimbar-complete-name'),
    completeRate: document.getElementById('cimbar-complete-rate'),
    btnReset: document.getElementById('btn-cimbar-reset'),
    btnDownload: document.getElementById('btn-cimbar-download'),
    btnAnother: document.getElementById('btn-cimbar-another')
  }

  elements.cameraSwitchBtn.onclick = switchCamera
  elements.btnReset.onclick = resetReceiver
  elements.btnDownload.onclick = downloadFile
  elements.btnAnother.onclick = resetReceiver
}
