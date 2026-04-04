// HDMI-UVC Receiver module - captures from UVC device and decodes frames

import { createDecoder } from '../decoder.js'
import { PACKET_HEADER_SIZE, parsePacket } from '../packet.js'
import { loadCimbarWasm, getModule as getCimbarModule } from '../cimbar/cimbar-loader.js'
import {
  BLOCK_SIZE,
  DEVICE_STORAGE_KEY,
  HDMI_MODE,
  HDMI_MODE_NAMES,
  HEADER_SIZE,
  getModeDataBlockSize
} from './hdmi-uvc-constants.js'
import { detectAnchors, dataRegionFromAnchors, decodeDataRegion, readPayloadWithLayout } from './hdmi-uvc-frame.js'

// Debug mode - always on while diagnosing HDMI-UVC issues
const DEBUG_MODE = true
const MAX_DEBUG_LINES = 500
const debugLines = []

function renderDebugLog() {
  const el = document.getElementById('hdmi-uvc-receiver-debug-log')
  if (!el) return
  el.textContent = debugLines.join('\n')
  el.scrollTop = el.scrollHeight
}

function debugLog(text) {
  if (!DEBUG_MODE) return

  const timestamp = new Date().toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3
  })
  debugLines.push(timestamp + ' ' + text)
  if (debugLines.length > MAX_DEBUG_LINES) {
    debugLines.splice(0, debugLines.length - MAX_DEBUG_LINES)
  }
  renderDebugLog()
  console.log('[HDMI-RX]', text)
}

function debugCurrent(text) {
  if (!DEBUG_MODE) return
  const el = document.getElementById('hdmi-uvc-receiver-debug-current')
  if (el) el.textContent = text
}

function formatMaybeNumber(value, digits = 2) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
}

function formatMaybeInt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(Math.round(value)) : 'n/a'
}

function formatDecisionCandidate(candidate) {
  if (!candidate) return 'n/a'
  const name = `${candidate.hypothesis}${candidate.refined ? '*' : ''}`
  return (
    `${name}(score=${formatMaybeInt(candidate.score)} crc=${candidate.crcValid ? 1 : 0} ` +
    `${candidate.width}x${candidate.height}@${candidate.fps} len=${candidate.payloadLength} ` +
    `off=(${formatMaybeInt(candidate.xOff)},${formatMaybeInt(candidate.yOff)}) ` +
    `step=${formatMaybeNumber(candidate.stepX)}/${formatMaybeNumber(candidate.stepY)} ` +
    `grid=${formatMaybeInt(candidate.blocksX)}x${formatMaybeInt(candidate.blocksY)})`
  )
}

function formatDecisionScale(diag) {
  if (!diag) return null
  return (
    `Scale: measured=${formatMaybeInt(diag.measuredFrameW)}x${formatMaybeInt(diag.measuredFrameH)} ` +
    `decoded=${formatMaybeInt(diag.decodedFrameW)}x${formatMaybeInt(diag.decodedFrameH)} ` +
    `ratio=${formatMaybeNumber(diag.decodedToMeasuredX)}/${formatMaybeNumber(diag.decodedToMeasuredY)} ` +
    `geom=${diag.geometryClass || 'n/a'} winner=${diag.decision?.winner?.hypothesis || diag.hypothesis || 'base'}${diag.decision?.winner?.refined ? '*' : ''} ` +
    `score=${formatMaybeInt(diag.decision?.winner?.score ?? diag.score)} ` +
    `reason=${diag.decision?.reason || 'n/a'}`
  )
}

function formatDecisionCandidates(diag) {
  const candidates = diag?.decision?.candidates || []
  if (candidates.length === 0) return null
  return `Tried: ${candidates.map(formatDecisionCandidate).join('; ')}`
}

function formatRecoveryState(expectedPacketSize, totalFramePackets, salvagedCount, fixedCount, salvageStrategy = null, salvagePacketSize = null) {
  return (
    `Recovery: expectedPkt=${formatMaybeInt(expectedPacketSize)} ` +
    `slots=${formatMaybeInt(totalFramePackets)} salvage=${formatMaybeInt(salvagedCount)} ` +
    `fixed=${formatMaybeInt(fixedCount)} expectedSlots=${formatMaybeInt(state.expectedPacketCount)} ` +
    `salvageMode=${salvageStrategy || 'n/a'}@${formatMaybeInt(salvagePacketSize)}`
  )
}

function getProgressBytes() {
  if (!state.decoder?.metadata) return null
  return state.decoder.progress * state.decoder.metadata.fileSize
}

function recordProgressSample() {
  const bytes = getProgressBytes()
  if (bytes === null) return

  const now = Date.now()
  state.progressSamples.push({ time: now, bytes })

  const cutoff = now - 10000
  while (state.progressSamples.length > 0 && state.progressSamples[0].time < cutoff) {
    state.progressSamples.shift()
  }
}

function getThroughputStats() {
  const bytes = getProgressBytes()
  if (bytes === null || !state.startTime) return null

  const now = Date.now()
  const elapsed = (now - state.startTime) / 1000
  const average = elapsed > 0 ? bytes / elapsed : 0

  let recent = null
  if (state.progressSamples.length >= 2) {
    const first = state.progressSamples[0]
    const last = state.progressSamples[state.progressSamples.length - 1]
    const recentElapsed = (last.time - first.time) / 1000
    if (recentElapsed > 0) {
      recent = (last.bytes - first.bytes) / recentElapsed
    }
  }

  return { average, recent }
}

function tryVariableFramePackets(framePayload) {
  // HDMI-UVC batching uses equal-sized packets inside each frame payload.
  // Keep the variable-path disabled so bootstrap salvage relies on the more
  // reliable equal-chunk probe instead of stale block-size header offsets.
  return []
}

function tryEqualChunkFramePackets(framePayload, maxPackets = 16) {
  let best = null

  for (let slotCount = 2; slotCount <= maxPackets; slotCount++) {
    if (framePayload.length % slotCount !== 0) continue

    const packetSize = framePayload.length / slotCount
    if (packetSize < PACKET_HEADER_SIZE) continue

    const packets = []
    for (let offset = 0; offset < framePayload.length; offset += packetSize) {
      const packet = framePayload.slice(offset, offset + packetSize)
      if (parsePacket(packet)) packets.push(packet)
    }

    if (packets.length === 0) continue

    const validBytes = packets.length * packetSize
    if (
      !best ||
      packets.length > best.packets.length ||
      (packets.length === best.packets.length && validBytes > best.validBytes) ||
      (packets.length === best.packets.length && validBytes === best.validBytes && slotCount > best.slotCount)
    ) {
      best = { packets, slotCount, packetSize, validBytes }
    }
  }

  return best
}

function probeFramePackets(framePayload, expectedPacketSize = null) {
  if (expectedPacketSize && expectedPacketSize >= PACKET_HEADER_SIZE) {
    if (framePayload.length % expectedPacketSize !== 0) {
      return { packets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'expected' }
    }

    const packets = []
    for (let offset = 0; offset < framePayload.length; offset += expectedPacketSize) {
      const packet = framePayload.slice(offset, offset + expectedPacketSize)
      if (parsePacket(packet)) {
        packets.push(packet)
      }
    }
    return {
      packets,
      slotCount: Math.floor(framePayload.length / expectedPacketSize),
      packetSize: expectedPacketSize,
      strategy: 'expected'
    }
  }

  const variablePackets = tryVariableFramePackets(framePayload)
  if (variablePackets.length > 0) {
    return {
      packets: variablePackets,
      slotCount: variablePackets.length,
      packetSize: variablePackets[0]?.length ?? null,
      strategy: 'variable'
    }
  }

  const equalChunk = tryEqualChunkFramePackets(framePayload)
  if (equalChunk) {
    return {
      packets: equalChunk.packets,
      slotCount: equalChunk.slotCount,
      packetSize: equalChunk.packetSize,
      strategy: 'equal'
    }
  }

  return { packets: [], slotCount: null, packetSize: expectedPacketSize, strategy: 'none' }
}

function extractFramePackets(framePayload, expectedPacketSize = null) {
  return probeFramePackets(framePayload, expectedPacketSize).packets
}

function getFramePacketSlotCount(framePayload, expectedPacketSize = null) {
  return probeFramePackets(framePayload, expectedPacketSize).slotCount
}

function ensureDecoder() {
  if (!state.decoder) {
    state.decoder = createDecoder()
    state.startTime = Date.now()
    showReceivingStatus()
    debugLog('Decoder created')
  }
}

function getExpectedPacketSize() {
  return state.decoder ? state.decoder.blockSize + PACKET_HEADER_SIZE : null
}

function tryFixedLayoutPackets(imageData, width, region) {
  const expectedPacketSize = getExpectedPacketSize()
  if (!expectedPacketSize || !state.fixedLayout || state.expectedPacketCount < 1) return []

  const payloadLength = expectedPacketSize * state.expectedPacketCount
  const payload = readPayloadWithLayout(imageData, width, region, state.fixedLayout, payloadLength)
  if (!payload) return []

  return extractFramePackets(payload, expectedPacketSize)
}

function acceptPackets(packets, fallbackSymbolId, countAsValidFrame = true, expectedFramePacketCount = packets.length) {
  if (packets.length === 0) return false

  ensureDecoder()

  let lastParsed = null
  for (const packet of packets) {
    const parsed = parsePacket(packet)
    if (!parsed) continue
    lastParsed = parsed
    state.decoder.receive(packet)
  }

  if (!lastParsed) return false

  if (countAsValidFrame) {
    state.validFrames++
    state.decodeFailCount = 0
    elements.statFrames.textContent = state.validFrames + ' valid frames'
  }

  state.expectedPacketCount = Math.max(packets.length, expectedFramePacketCount || 0)
  recordProgressSample()

  if (state.validFrames % 10 === 0) {
    const throughput = getThroughputStats()
    const rateSuffix = throughput
      ? ` rate=${formatBytes(throughput.average)}/s recent=${formatBytes(throughput.recent ?? throughput.average)}/s`
      : ''
    debugLog(
      `Progress: ${Math.round(state.decoder.progress * 100)}% ` +
      `solved=${state.decoder.solved}/${state.decoder.K || '?'} ` +
      `unique=${state.decoder.uniqueSymbols} ` +
      `sym=${lastParsed.symbolId ?? fallbackSymbolId} pkts=${packets.length}` +
      rateSuffix
    )
  }

  debugCurrent(
    `#${state.validFrames} sym=${lastParsed.symbolId ?? fallbackSymbolId} ` +
    `${Math.round((state.decoder.progress || 0) * 100)}% x${packets.length}`
  )
  updateProgress()

  if (state.decoder.isComplete()) {
    debugLog('=== TRANSFER COMPLETE ===')
    handleComplete()
  }

  return true
}

const state = {
  decoder: null,
  cimbarCurrentMode: 0,
  cimbarLoaded: false,
  cimbarRecentDecode: -1,
  cimbarRecentExtract: -1,
  cimbarImgBuff: null,
  cimbarFountainBuff: null,
  cimbarReportBuff: null,
  stream: null,
  canvas: null,
  ctx: null,
  animationId: null,
  callbackId: null,
  isScanning: false,
  frameCount: 0,
  validFrames: 0,
  startTime: null,
  detectedMode: null,
  detectedResolution: null,
  completedFile: null,
  anchorBounds: null,  // Cached data region from detected anchors
  decodeFailCount: 0,  // Consecutive decode failures (triggers relock when too many)
  activeCaptureMethod: null,
  fixedLayout: null,
  expectedPacketCount: 0,
  preferredLayout: null,
  progressSamples: []
}

const CIMBAR_MODE_VALUES = [67, 68, 4]

// Check if requestVideoFrameCallback is available (better sync than requestAnimationFrame)
const hasVideoFrameCallback = typeof HTMLVideoElement !== 'undefined' &&
  'requestVideoFrameCallback' in HTMLVideoElement.prototype

// Check if VideoFrame API is available (direct frame access)
const hasVideoFrame = typeof VideoFrame !== 'undefined'

// Check if ImageCapture API is available (better for UVC devices)
const hasImageCapture = typeof ImageCapture !== 'undefined'

let elements = null
let imageCapture = null
let showError = (msg) => console.error(msg)

function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
}

function saveDevicePreference(deviceId) {
  try {
    localStorage.setItem(DEVICE_STORAGE_KEY, deviceId)
  } catch (e) {
    // Ignore storage errors
  }
}

function loadDevicePreference() {
  try {
    return localStorage.getItem(DEVICE_STORAGE_KEY)
  } catch (e) {
    return null
  }
}

function ensureCimbarBuffers(Module, imgSize) {
  if (!state.cimbarImgBuff || state.cimbarImgBuff.length < imgSize) {
    if (state.cimbarImgBuff) Module._free(state.cimbarImgBuff.byteOffset)
    const imgPtr = Module._malloc(imgSize)
    state.cimbarImgBuff = new Uint8Array(Module.HEAPU8.buffer, imgPtr, imgSize)
  }

  const bufSize = Module._cimbard_get_bufsize()
  if (!state.cimbarFountainBuff || state.cimbarFountainBuff.length < bufSize) {
    if (state.cimbarFountainBuff) Module._free(state.cimbarFountainBuff.byteOffset)
    const ptr = Module._malloc(bufSize)
    state.cimbarFountainBuff = new Uint8Array(Module.HEAPU8.buffer, ptr, bufSize)
  }

  if (!state.cimbarReportBuff) {
    const ptr = Module._malloc(1024)
    state.cimbarReportBuff = new Uint8Array(Module.HEAPU8.buffer, ptr, 1024)
  }
}

function getCimbarReport(Module) {
  if (!state.cimbarReportBuff) return null
  const reportLen = Module._cimbard_get_report(state.cimbarReportBuff.byteOffset, 1024)
  if (reportLen <= 0) return null

  const reportView = new Uint8Array(Module.HEAPU8.buffer, state.cimbarReportBuff.byteOffset, reportLen)
  const text = new TextDecoder().decode(reportView)
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function resetCimbarSink() {
  const Module = getCimbarModule()
  if (!Module) return
  Module._cimbard_configure_decode(4)
  Module._cimbard_configure_decode(68)
  state.cimbarCurrentMode = 0
  state.cimbarRecentDecode = -1
  state.cimbarRecentExtract = -1
}

async function ensureCimbarLoaded() {
  if (state.cimbarLoaded) return true
  try {
    await loadCimbarWasm()
    state.cimbarLoaded = true
    resetCimbarSink()
    debugLog('CIMBAR decoder ready')
    return true
  } catch (err) {
    debugLog(`CIMBAR load failed: ${err.message}`)
    return false
  }
}

async function handleCimbarComplete(fileId) {
  const Module = getCimbarModule()
  if (!Module) return false

  state.isScanning = false
  cancelNextFrame()

  const fileSize = Module._cimbard_get_filesize(fileId)
  const fnLen = Module._cimbard_get_filename(fileId, state.cimbarReportBuff.byteOffset, 1024)
  const fileName = fnLen > 0
    ? new TextDecoder().decode(new Uint8Array(Module.HEAPU8.buffer, state.cimbarReportBuff.byteOffset, fnLen))
    : 'download'

  const bufSize = Module._cimbard_get_decompress_bufsize()
  const decompBuff = Module._malloc(bufSize)
  const chunks = []
  let bytesRead
  do {
    bytesRead = Module._cimbard_decompress_read(fileId, decompBuff, bufSize)
    if (bytesRead > 0) {
      chunks.push(new Uint8Array(Module.HEAPU8.buffer, decompBuff, bytesRead).slice())
    }
  } while (bytesRead > 0)
  Module._free(decompBuff)

  const fileData = new Blob(chunks, { type: 'application/octet-stream' })
  const arrayBuffer = await fileData.arrayBuffer()
  const elapsed = (Date.now() - state.startTime) / 1000
  const rate = fileSize / Math.max(elapsed, 0.001)

  state.completedFile = {
    data: arrayBuffer,
    name: fileName,
    type: 'application/octet-stream'
  }
  elements.completeName.textContent = `${fileName} (${formatBytes(fileSize)})`
  elements.completeRate.textContent = `${formatBytes(rate)}/s`
  debugLog('=== TRANSFER COMPLETE ===')
  debugLog(`Complete: ${formatBytes(fileSize)} in ${elapsed.toFixed(1)}s (${formatBytes(rate)}/s)`)
  showCompleteStatus()
  return true
}

async function tryCimbarDecode(imageData, width, height) {
  if (!(await ensureCimbarLoaded())) return false

  const Module = getCimbarModule()
  if (!Module) return false

  ensureCimbarBuffers(Module, imageData.data.length)
  state.cimbarImgBuff.set(imageData.data)

  let mode = state.cimbarCurrentMode
  if (mode === 0) {
    mode = CIMBAR_MODE_VALUES[state.frameCount % CIMBAR_MODE_VALUES.length]
  }
  Module._cimbard_configure_decode(mode)

  const len = Module._cimbard_scan_extract_decode(
    state.cimbarImgBuff.byteOffset,
    width,
    height,
    4,
    state.cimbarFountainBuff.byteOffset,
    state.cimbarFountainBuff.length
  )

  if (len > 0) {
    state.cimbarRecentDecode = state.frameCount
    if (state.cimbarCurrentMode === 0) state.cimbarCurrentMode = mode
    if (state.detectedMode !== HDMI_MODE.CIMBAR) {
      state.detectedMode = HDMI_MODE.CIMBAR
      elements.signalStatus.textContent = 'Detected: CIMBAR'
      debugLog('=== SIGNAL DETECTED ===')
      debugLog(`Mode: ${HDMI_MODE_NAMES[HDMI_MODE.CIMBAR]}`)
    }

    const res = Module._cimbard_fountain_decode(state.cimbarFountainBuff.byteOffset, len)
    const report = getCimbarReport(Module)
    if (Array.isArray(report)) {
      if (!state.startTime) {
        state.startTime = Date.now()
        showReceivingStatus()
      }
      const pct = Math.round(report[0] * 100)
      elements.fileName.textContent = 'CIMBAR transfer'
      elements.statProgress.textContent = `${pct}%`
      elements.progressFill.style.width = `${pct}%`
      elements.statRate.textContent = '-'
      if (state.frameCount % 10 === 0) {
        debugLog(`CIMBAR Progress: ${pct}% len=${len} mode=${mode}`)
      }
    }

    if (res > 0) {
      const fileId = Number(res & BigInt(0xFFFFFFFF))
      await handleCimbarComplete(fileId)
    } else {
      debugCurrent(`#${state.frameCount} CIMBAR len=${len}`)
    }
    return true
  }

  if (len === 0) {
    state.cimbarRecentExtract = state.frameCount
  }
  return false
}

async function enumerateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices()
  const videoDevices = devices.filter(d => d.kind === 'videoinput')

  const dropdown = elements.deviceDropdown
  while (dropdown.firstChild) {
    dropdown.removeChild(dropdown.firstChild)
  }

  const savedDevice = loadDevicePreference()

  videoDevices.forEach((device, i) => {
    const option = document.createElement('option')
    option.value = device.deviceId
    option.textContent = device.label || `Camera ${i + 1}`

    if (device.label && /capture|hdmi|uvc|cam link/i.test(device.label)) {
      option.textContent += ' (Capture)'
    }

    if (device.deviceId === savedDevice) {
      option.selected = true
    }

    dropdown.appendChild(option)
  })

  return videoDevices
}

async function startCapture(deviceId) {
  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
  }

  try {
    debugLog(`Starting capture, deviceId: ${deviceId || '(default)'}`)

    const constraints = {
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      }
    }

    state.stream = await navigator.mediaDevices.getUserMedia(constraints)
    elements.video.srcObject = state.stream

    await new Promise(resolve => {
      elements.video.onloadedmetadata = resolve
    })

    // Log actual video track settings
    const track = state.stream.getVideoTracks()[0]
    if (track) {
      const settings = track.getSettings()
      debugLog(`Track: ${track.label}`)
      debugLog(`Actual: ${settings.width}x${settings.height} @ ${settings.frameRate || '?'}fps`)
    }

    // Log frame callback method
    debugLog(`Frame capture method: ${hasVideoFrameCallback ? 'requestVideoFrameCallback' : 'requestAnimationFrame'}`)

    // Set up ImageCapture if available
    if (hasImageCapture && track) {
      try {
        imageCapture = new ImageCapture(track)
        debugLog('ImageCapture API: initialized')
      } catch (e) {
        debugLog(`ImageCapture API: failed to initialize (${e.message})`)
        imageCapture = null
      }
    } else {
      debugLog('ImageCapture API: not available')
    }

    state.canvas = document.createElement('canvas')
    state.ctx = state.canvas.getContext('2d', {
      willReadFrequently: true,
      alpha: false,  // Might help with consistent color handling
      colorSpace: 'srgb'
    })

    saveDevicePreference(deviceId)

    elements.signalStatus.textContent = 'Connected - scanning...'
    elements.signalStatus.classList.add('connected')

    return true

  } catch (err) {
    console.error('Camera error:', err)
    debugLog(`ERROR: ${err.message}`)
    showError('Failed to access capture device: ' + err.message)
    return false
  }
}

function scheduleNextFrame() {
  if (!state.isScanning || !state.stream) return

  const video = elements.video

  if (hasVideoFrameCallback) {
    // Use requestVideoFrameCallback for accurate frame timing
    state.callbackId = video.requestVideoFrameCallback(processFrame)
  } else {
    // Fallback to requestAnimationFrame
    state.animationId = requestAnimationFrame(processFrame)
  }
}

async function processFrame(now, metadata) {
  if (!state.isScanning || !state.stream) return

  const video = elements.video
  if (video.videoWidth === 0) {
    scheduleNextFrame()
    return
  }

  const width = video.videoWidth
  const height = video.videoHeight
  state.canvas.width = width
  state.canvas.height = height

  let imageData
  let captureMethod = 'video'

  // ImageCapture is useful for initial acquisition, but it is noticeably
  // slower than drawing the video element directly. Once we have anchor lock,
  // prioritize raw video frames for throughput.
  const useImageCapture = imageCapture && !state.anchorBounds

  // Try ImageCapture API first while scanning for initial lock
  if (useImageCapture) {
    try {
      const bitmap = await imageCapture.grabFrame()
      state.ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      imageData = state.ctx.getImageData(0, 0, width, height)
      captureMethod = 'ImageCapture'
    } catch (e) {
      // Fall through to other methods
    }
  }

  // Try VideoFrame API for direct frame access
  if (!imageData && hasVideoFrame && metadata) {
    try {
      const frame = new VideoFrame(video, { timestamp: metadata.mediaTime * 1000000 || 0 })
      state.ctx.drawImage(frame, 0, 0)
      frame.close()
      imageData = state.ctx.getImageData(0, 0, width, height)
      captureMethod = 'VideoFrame'
    } catch (e) {
      // Fall through to default method
    }
  }

  // Default: draw video directly to canvas
  if (!imageData) {
    state.ctx.drawImage(video, 0, 0)
    imageData = state.ctx.getImageData(0, 0, width, height)
  }

  if (captureMethod !== state.activeCaptureMethod) {
    state.activeCaptureMethod = captureMethod
    debugLog(`Capture path: ${captureMethod}`)
  }

  state.frameCount++
  const isDiagFrame = state.frameCount <= 5 || state.frameCount % 30 === 0

  if (state.detectedMode === HDMI_MODE.CIMBAR) {
    await tryCimbarDecode(imageData, width, height)
    if (state.isScanning) scheduleNextFrame()
    return
  }

  if (!state.anchorBounds) {
    const cimbarDetected = await tryCimbarDecode(imageData, width, height)
    if (cimbarDetected) {
      if (state.isScanning) scheduleNextFrame()
      return
    }
  }

  // Diagnostic: find canvas bounds and scan for anchors
  if (!state.anchorBounds && isDiagFrame) {
    const p = imageData.data

    // Step 1: Find chrome bottom (transition from bright to dark at center x)
    const midX = Math.floor(width / 2)
    let chromeBottom = 0
    for (let y = 0; y < Math.min(200, height - 1); y++) {
      if (p[(y * width + midX) * 4] > 100 && p[((y + 1) * width + midX) * 4] < 30) {
        chromeBottom = y + 1
        break
      }
    }

    // Step 2: Find canvas left edge — scan right from x=0 at chromeBottom+16
    // (skip MJPEG ringing zone, probe mid-margin area)
    const probeY = chromeBottom + 16
    let canvasLeft = 0
    // The canvas margin is black (≤5). Find where values go from HDMI-black to canvas-black.
    // They look the same, so instead scan for first pixel >20 (data region)
    // then subtract margin width to estimate canvas left.
    let firstData = -1
    for (let x = 0; x < width; x++) {
      if (p[(probeY * width + x) * 4] > 20) { firstData = x; break }
    }

    debugLog(`Chrome bottom: ${chromeBottom}, probeY: ${probeY}, firstData@probeY: ${firstData}`)

    // Step 3: Scan for ANY bright pixel below chrome, skipping the chrome area
    // Search in top-left quadrant below chrome
    let tlX = -1, tlY = -1
    outer_tl:
    for (let y = chromeBottom; y < Math.min(chromeBottom + 200, height); y++) {
      for (let x = 0; x < Math.min(300, width); x++) {
        if (p[(y * width + x) * 4] > 150) { tlX = x; tlY = y; break outer_tl }
      }
    }
    debugLog(`TL first bright(>150) below chrome: (${tlX},${tlY})`)

    if (tlX >= 0 && tlY >= 0) {
      // Dump horizontal and vertical strips around the find
      const hstrip = []
      for (let x = Math.max(0, tlX - 5); x < Math.min(width, tlX + 45); x++) {
        hstrip.push(p[(tlY * width + x) * 4])
      }
      debugLog(`  Row${tlY} R[${Math.max(0,tlX-5)}..+50]: ${hstrip.join(',')}`)

      const vstrip = []
      for (let y = Math.max(0, tlY - 5); y < Math.min(height, tlY + 40); y++) {
        vstrip.push(p[(y * width + tlX) * 4])
      }
      debugLog(`  Col${tlX} R[${Math.max(0,tlY-5)}..+45]: ${vstrip.join(',')}`)
    } else {
      // No bright pixel found! Dump raw values in the expected anchor zone
      debugLog(`NO bright pixel found below chrome! Dumping rows ${chromeBottom}..${chromeBottom+5} x=0..60:`)
      for (let y = chromeBottom; y < Math.min(chromeBottom + 6, height); y++) {
        const row = []
        for (let x = 0; x < Math.min(60, width); x++) row.push(p[(y * width + x) * 4])
        debugLog(`  Row${y}: ${row.join(',')}`)
      }
    }

    // Bottom-right scan (skip last few rows which might be chrome/dock)
    let brX = -1, brY = -1
    outer_br:
    for (let y = height - 1; y >= Math.max(0, height - 200); y--) {
      for (let x = width - 1; x >= Math.max(0, width - 300); x--) {
        if (p[(y * width + x) * 4] > 150) { brX = x; brY = y; break outer_br }
      }
    }
    debugLog(`BR last bright(>150): (${brX},${brY})`)
    if (brX >= 0) {
      const hstrip = []
      for (let x = Math.max(0, brX - 40); x < Math.min(width, brX + 10); x++) {
        hstrip.push(p[(brY * width + x) * 4])
      }
      debugLog(`  Row${brY} R[${Math.max(0,brX-40)}..+50]: ${hstrip.join(',')}`)
    }

    // Center
    const cx = Math.floor(width / 2), cy = Math.floor(height / 2)
    const center = []
    for (let x = cx - 5; x <= cx + 5; x++) center.push(p[(cy * width + x) * 4])
    debugLog(`Center[${cx},${cy}]: ${center.join(',')}`)
  }

  // === ANCHOR DETECTION ===
  let region = state.anchorBounds

  if (!region) {
    const anchors = detectAnchors(imageData.data, width, height)
    if (anchors.length >= 2) {
      region = dataRegionFromAnchors(anchors)
      if (region) {
        state.anchorBounds = region
        const pos = anchors.map(a => `${a.corner}(${a.x},${a.y} bs=${a.blockSize.toFixed(1)})`).join(' ')
        debugLog(`*** ANCHORS LOCKED: ${anchors.length} found, region (${region.x},${region.y}) ${region.w}x${region.h} step=${region.stepX.toFixed(1)}/${region.stepY.toFixed(1)} ***`)
        debugLog(`  Anchors: ${pos}`)
      } else if (isDiagFrame) {
        // Anchors found but region invalid (e.g. all at same y = false positives)
        const pos = anchors.map(a => `(${a.x},${a.y} ${a.corner})`).join(' ')
        debugLog(`Frame ${state.frameCount}: ${anchors.length} anchors but invalid region: ${pos}`)
        debugCurrent(`#${state.frameCount} bad anchors`)
      }
    } else if (isDiagFrame) {
      debugLog(`Frame ${state.frameCount}: ${anchors.length} anchors found (need ≥2)`)
      debugCurrent(`#${state.frameCount} scanning...`)
    }
  }

  if (!region) {
    scheduleNextFrame()
    return
  }

  // === DECODE DATA REGION ===
  region.preferredLayout = state.preferredLayout
  const result = decodeDataRegion(imageData.data, width, region)

  if (result && result.crcValid) {
    if (!state.detectedMode) {
      state.detectedMode = result.header.mode
      state.detectedResolution = { width: result.header.width, height: result.header.height }
      elements.signalStatus.textContent = `Detected: ${result.header.width}x${result.header.height}`
      debugLog(`=== SIGNAL DETECTED ===`)
      debugLog(`Mode: ${HDMI_MODE_NAMES[result.header.mode]}, ${result.header.width}x${result.header.height}`)
    }

    const expectedPacketSize = getExpectedPacketSize()
    const totalFramePackets = getFramePacketSlotCount(result.payload, expectedPacketSize)
    const packets = extractFramePackets(result.payload, expectedPacketSize)

    if (acceptPackets(packets, result.header.symbolId, true, totalFramePackets)) {
      if (result._diag) state.fixedLayout = { ...result._diag }
      if (result._diag) state.preferredLayout = { ...result._diag }
      if (state.decoder?.isComplete()) return
    }
  } else if (result && !result.crcValid) {
    if (result._diag) state.preferredLayout = { ...result._diag }
    const expectedPacketSize = getExpectedPacketSize()
    const salvageProbe = probeFramePackets(result.payload, expectedPacketSize)
    const totalFramePackets = salvageProbe.slotCount
    const salvagedPackets = salvageProbe.packets
    const fixedPackets = tryFixedLayoutPackets(imageData.data, width, region)
    if (acceptPackets(salvagedPackets, result.header.symbolId, true, totalFramePackets)) {
      if (result._diag) state.fixedLayout = { ...result._diag }
      debugLog(`Frame ${state.frameCount}: salvaged ${salvagedPackets.length} packet(s) from CRC-fail frame`)
      if (state.decoder?.isComplete()) return
      scheduleNextFrame()
      return
    }
    if (acceptPackets(fixedPackets, result.header.symbolId, true, state.expectedPacketCount)) {
      debugLog(`Frame ${state.frameCount}: recovered ${fixedPackets.length} packet(s) via fixed layout`)
      if (state.decoder?.isComplete()) return
      scheduleNextFrame()
      return
    }

    state.decodeFailCount++
    if (isDiagFrame) {
      // Dump full header for diagnosis
      const h = result.header
      const hBytes = `magic=${h.magic.toString(16)} mode=${h.mode} ${h.width}x${h.height} fps=${h.fps} sym=${h.symbolId} len=${h.payloadLength} crc=${h.payloadCrc.toString(16)}`
      const diag = result._diag || {}
      debugLog(`Frame ${state.frameCount}: CRC fail — ${hBytes}`)
      const scaleLine = formatDecisionScale(diag)
      if (scaleLine) debugLog(`  ${scaleLine}`)
      const triedLine = formatDecisionCandidates(diag)
      if (triedLine) debugLog(`  ${triedLine}`)
      debugLog(`  ${formatRecoveryState(expectedPacketSize, totalFramePackets, salvagedPackets.length, fixedPackets.length, salvageProbe.strategy, salvageProbe.packetSize)}`)
    }
    debugCurrent(`#${state.frameCount} CRC fail`)
  } else {
    const fixedPackets = tryFixedLayoutPackets(imageData.data, width, region)
    if (acceptPackets(fixedPackets, state.frameCount, true, state.expectedPacketCount)) {
      debugLog(`Frame ${state.frameCount}: recovered ${fixedPackets.length} packet(s) without outer header`)
      if (state.decoder?.isComplete()) return
      scheduleNextFrame()
      return
    }

    state.decodeFailCount++
    if (isDiagFrame) {
      debugLog(`Frame ${state.frameCount}: decode failed`)
      debugLog(
        `  Recovery: expectedPkt=${formatMaybeInt(getExpectedPacketSize())} ` +
        `fixedLayout=${state.fixedLayout ? 'yes' : 'no'} ` +
        `expectedSlots=${formatMaybeInt(state.expectedPacketCount)} fixed=${fixedPackets.length}`
      )
      // Sample first data block values for diagnosis using the actual mode's
      // payload block size instead of assuming a fixed anchor-to-data ratio.
      const anchorBs = region.blockSize || BLOCK_SIZE
      const modeBlockSize = getModeDataBlockSize(state.detectedMode ?? HDMI_MODE.COMPAT_4) || 4
      const dataScale = modeBlockSize / BLOCK_SIZE
      const bs = anchorBs * dataScale
      const stepX = (region.stepX || anchorBs) * dataScale
      const rx = region.x
      const ry = region.y
      const blocksX = Math.floor(region.w / stepX)
      const probeCount = Math.min(176, blocksX) // 22 bytes × 8 bits
      const rawValues = []
      for (let i = 0; i < Math.min(24, probeCount); i++) {
        const px = rx + Math.round(i * stepX)
        const py = ry
        if (px >= 0 && px < width && py >= 0 && py < height) {
          const cx = Math.round(px + bs / 2) - 1
          const cy = Math.round(py + bs / 2) - 1
          let sum = 0
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              sum += imageData.data[((cy + dy) * width + (cx + dx)) * 4]
            }
          }
          rawValues.push(Math.round(sum / 4))
        }
      }
      debugLog(`First 24 block values: [${rawValues.join(',')}]`)
      // Decode as binary: show what bytes they produce
      const decodedBytes = []
      for (let b = 0; b < Math.min(3, Math.floor(rawValues.length / 8)); b++) {
        let byte = 0
        for (let bit = 0; bit < 8; bit++) {
          if (rawValues[b * 8 + bit] > 128) byte |= (1 << (7 - bit))
        }
        decodedBytes.push(byte)
      }
      debugLog(`Decoded bytes: [${decodedBytes.join(',')}] (expect magic: 255,0,255,0)`)
    }
    debugCurrent(`#${state.frameCount} no data`)
  }

  // Relock anchors after too many consecutive failures (CRC or decode)
  if (state.decodeFailCount > 30) {
    debugLog(`Relock: ${state.decodeFailCount} consecutive failures`)
    state.anchorBounds = null
    state.preferredLayout = null
    state.decodeFailCount = 0
  }

  // Update debug canvas
  if (isDiagFrame) {
    const debugCanvas = document.getElementById('hdmi-uvc-receiver-debug-canvas')
    if (debugCanvas) {
      debugCanvas.width = Math.min(width, 640)
      debugCanvas.height = Math.min(height, 360)
      debugCanvas.getContext('2d').drawImage(state.canvas, 0, 0, debugCanvas.width, debugCanvas.height)
    }
  }

  scheduleNextFrame()
}

function showReceivingStatus() {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.remove('hidden')
  elements.statusComplete.classList.add('hidden')
}

function showCompleteStatus() {
  elements.statusScanning.classList.add('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.remove('hidden')
}

function updateProgress() {
  if (!state.decoder || !state.decoder.metadata) return

  const meta = state.decoder.metadata
  const progress = state.decoder.progress

  elements.fileName.textContent = meta.filename
  elements.statProgress.textContent = Math.round(progress * 100) + '%'
  elements.progressFill.style.width = (progress * 100) + '%'

  const elapsed = (Date.now() - state.startTime) / 1000
  if (elapsed > 0) {
    const bytesReceived = progress * meta.fileSize
    const rate = bytesReceived / elapsed
    elements.statRate.textContent = formatBytes(rate) + '/s'
  }
}

async function handleComplete() {
  state.isScanning = false

  cancelNextFrame()

  const decoder = state.decoder
  const meta = decoder.metadata

  const fileData = decoder.reconstruct()

  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', fileData))
  const hashMatch = hash.every((b, i) => b === meta.hash[i])

  if (!hashMatch) {
    showError('File hash mismatch - transfer may be corrupted')
  }

  const elapsed = (Date.now() - state.startTime) / 1000
  const rate = fileData.byteLength / elapsed

  state.completedFile = {
    data: fileData,
    name: meta.filename,
    type: meta.mimeType || 'application/octet-stream'
  }

  elements.completeName.textContent = meta.filename + ' (' + formatBytes(fileData.byteLength) + ')'
  elements.completeRate.textContent = formatBytes(rate) + '/s'
  debugLog(`Complete: ${formatBytes(fileData.byteLength)} in ${elapsed.toFixed(1)}s (${formatBytes(rate)}/s)`)

  showCompleteStatus()
}

function downloadFile() {
  if (!state.completedFile) return

  const blob = new Blob([state.completedFile.data], { type: state.completedFile.type })
  const url = URL.createObjectURL(blob)

  const a = document.createElement('a')
  a.href = url
  a.download = state.completedFile.name
  a.click()

  URL.revokeObjectURL(url)
}

function cancelNextFrame() {
  if (state.animationId) {
    cancelAnimationFrame(state.animationId)
    state.animationId = null
  }
  if (state.callbackId && hasVideoFrameCallback && elements.video) {
    elements.video.cancelVideoFrameCallback(state.callbackId)
    state.callbackId = null
  }
}

function resetReceiver() {
  state.isScanning = false

  cancelNextFrame()

  state.decoder = null
  state.cimbarCurrentMode = 0
  state.cimbarRecentDecode = -1
  state.cimbarRecentExtract = -1
  state.frameCount = 0
  state.validFrames = 0
  state.startTime = null
  state.detectedMode = null
  state.detectedResolution = null
  state.completedFile = null
  state.anchorBounds = null
  state.decodeFailCount = 0
  state.activeCaptureMethod = null
  state.fixedLayout = null
  state.preferredLayout = null
  state.expectedPacketCount = 0
  state.progressSamples = []
  resetCimbarSink()

  elements.statFrames.textContent = '0 frames'
  elements.statusScanning.classList.remove('hidden')
  elements.statusReceiving.classList.add('hidden')
  elements.statusComplete.classList.add('hidden')
  elements.progressFill.style.width = '0'

  if (state.stream) {
    elements.signalStatus.textContent = 'Connected - scanning...'
  }
}

function startScanning() {
  state.isScanning = true
  scheduleNextFrame()
}

async function handleDeviceChange() {
  const deviceId = elements.deviceDropdown.value
  resetReceiver()

  if (await startCapture(deviceId)) {
    startScanning()
  }
}

function handleReceiveAnother() {
  resetReceiver()
  startScanning()
}

export async function autoStartHdmiUvcReceiver() {
  void ensureCimbarLoaded()
  await enumerateDevices()

  const savedDevice = loadDevicePreference()
  const deviceId = savedDevice || elements.deviceDropdown.value

  if (await startCapture(deviceId)) {
    startScanning()
  }
}

export function resetHdmiUvcReceiver() {
  resetReceiver()

  if (state.stream) {
    state.stream.getTracks().forEach(t => t.stop())
    state.stream = null
  }

  imageCapture = null

  elements.signalStatus.textContent = 'Waiting for signal...'
  elements.signalStatus.classList.remove('connected')
}

export function initHdmiUvcReceiver(errorHandler) {
  showError = errorHandler

  elements = {
    video: document.getElementById('hdmi-uvc-video'),
    signalStatus: document.getElementById('hdmi-uvc-signal-status'),
    deviceDropdown: document.getElementById('hdmi-uvc-device-dropdown'),
    statusScanning: document.getElementById('hdmi-uvc-status-scanning'),
    statusReceiving: document.getElementById('hdmi-uvc-status-receiving'),
    statusComplete: document.getElementById('hdmi-uvc-status-complete'),
    statFrames: document.getElementById('hdmi-uvc-stat-frames'),
    fileName: document.getElementById('hdmi-uvc-file-name'),
    statProgress: document.getElementById('hdmi-uvc-stat-progress'),
    statRate: document.getElementById('hdmi-uvc-stat-rate'),
    progressFill: document.getElementById('hdmi-uvc-progress-fill'),
    completeName: document.getElementById('hdmi-uvc-complete-name'),
    completeRate: document.getElementById('hdmi-uvc-complete-rate'),
    btnReset: document.getElementById('btn-hdmi-uvc-reset'),
    btnDownload: document.getElementById('btn-hdmi-uvc-download'),
    btnAnother: document.getElementById('btn-hdmi-uvc-another')
  }

  elements.deviceDropdown.onchange = handleDeviceChange
  elements.btnReset.onclick = () => {
    resetReceiver()
    startScanning()
  }
  elements.btnDownload.onclick = downloadFile
  elements.btnAnother.onclick = handleReceiveAnother

  // Debug panel buttons
  const copyBtn = document.getElementById('btn-hdmi-uvc-receiver-copy-log')
  if (copyBtn) {
    copyBtn.onclick = async () => {
      if (debugLines.length > 0) {
        try {
          await navigator.clipboard.writeText(debugLines.join('\n'))
          copyBtn.textContent = 'Copied!'
          setTimeout(() => copyBtn.textContent = 'Copy Log', 1500)
        } catch (e) {
          console.error('Copy failed:', e)
        }
      }
    }
  }
  const clearBtn = document.getElementById('btn-hdmi-uvc-receiver-clear-log')
  if (clearBtn) {
    clearBtn.onclick = () => {
      debugLines.length = 0
      renderDebugLog()
      debugLog('=== LOG CLEARED ===')
      debugLog(`Frame count at clear: ${state.frameCount}`)
    }
  }
  debugLog('HDMI-UVC Receiver initialized')
}
