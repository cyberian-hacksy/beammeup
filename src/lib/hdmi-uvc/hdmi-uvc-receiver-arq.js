// Receiver-side ARQ back-channel session: helper connection/status UI,
// controller lifecycle, received-id seeding, beacon handling, and the
// COMPLETE/full-repair paths. Operates on the shared receiver state
// singleton. The receiver registers two hooks at load time (error banner,
// worker state mirror) to avoid a circular import.

import { ArqReceiverController, getArqBeaconLogAction } from '../arq/arq-receiver.js'
import { ARQ_HELPER_STATUS, getArqHelperStatusView, shouldAutoConnectArqHelper } from '../arq/helper-status.js'
import { getTransport } from '../arq/backchannel.js'
import { getSelectedArqTransportName } from '../arq/default-transports.js'
import { isRepairIdleMetadataPayload } from '../metadata.js'
import { debugLog } from './hdmi-uvc-receiver-debug.js'
import { state } from './hdmi-uvc-receiver-state.js'

const hooks = {
  showError: (msg) => console.error(msg),
  postArqStateToWorker: () => {}
}

export function setArqReceiverHooks({ showError, postArqStateToWorker } = {}) {
  if (typeof showError === 'function') hooks.showError = showError
  if (typeof postArqStateToWorker === 'function') hooks.postArqStateToWorker = postArqStateToWorker
}

function updateArqReceiverStatus(text, connected = state.arqConnected, buttonText = null, disabled = false, hint = null) {
  const statusEl = document.getElementById('hdmi-uvc-helper-status')
  if (statusEl) {
    statusEl.textContent = text
    statusEl.classList.toggle('connected', !!connected)
  }
  const connectBtn = document.getElementById('btn-hdmi-uvc-helper-connect')
  if (connectBtn) {
    connectBtn.textContent = buttonText || (connected ? 'Reconnect helper' : 'Connect helper')
    connectBtn.disabled = !!disabled
  }
  const hintEl = document.getElementById('hdmi-uvc-helper-hint')
  if (hintEl) {
    if (hint) {
      hintEl.textContent = hint
      hintEl.classList.remove('hidden')
    } else {
      hintEl.classList.add('hidden')
    }
  }
}

export function applyArqReceiverHelperStatus(status) {
  const view = getArqHelperStatusView(status, getSelectedArqTransportName())
  updateArqReceiverStatus(view.text, view.connected, view.buttonText, view.disabled, view.hint)
}

export async function connectArqHelper(options = {}) {
  const { auto = false } = options
  if (state.arqHelperConnecting) return
  // Manual "Reconnect helper" intentionally tears down a live connection;
  // the auto path must never churn one.
  if (auto && state.arqConnected) return
  state.arqHelperConnecting = true
  try {
    state.arqTransport?.close()
    const transportName = getSelectedArqTransportName()
    const impl = getTransport(transportName)
    if (!impl?.makeReceiver) throw new Error(`ARQ receiver transport '${transportName}' is not registered`)
    state.arqTransport = impl.makeReceiver()
    applyArqReceiverHelperStatus(ARQ_HELPER_STATUS.CONNECTING)
    await state.arqTransport.init({
      onStatus: status => {
        state.arqConnected = status === 'connected'
        hooks.postArqStateToWorker()
        applyArqReceiverHelperStatus(status === 'connected'
          ? ARQ_HELPER_STATUS.CONNECTED
          : ARQ_HELPER_STATUS.DISCONNECTED)
      },
      // Auto-connect runs without a user gesture: the keyboard transport
      // then reopens an already-authorized serial port instead of showing
      // the picker. BLE-GATT ignores the flag.
      reusePort: auto
    })
    state.arqConnected = true
    hooks.postArqStateToWorker()
    applyArqReceiverHelperStatus(ARQ_HELPER_STATUS.CONNECTED)
    debugLog(`ARQ helper connected (${auto ? 'auto' : 'manual'})`)
  } catch (err) {
    state.arqTransport?.close()
    state.arqTransport = null
    state.arqConnected = false
    hooks.postArqStateToWorker()
    applyArqReceiverHelperStatus(ARQ_HELPER_STATUS.UNAVAILABLE)
    debugLog(`ARQ helper ${auto ? 'auto-detect' : 'connect'} failed: ${err.message}`)
    if (!auto) hooks.showError('ARQ helper connect failed: ' + err.message)
  } finally {
    state.arqHelperConnecting = false
  }
}

export function autoConnectArqHelper() {
  if (!shouldAutoConnectArqHelper({
    connected: state.arqConnected,
    connecting: state.arqHelperConnecting,
    attempted: state.arqHelperAutoAttempted
  })) {
    return
  }
  state.arqHelperAutoAttempted = true
  applyArqReceiverHelperStatus(ARQ_HELPER_STATUS.CHECKING)
  setTimeout(() => {
    void connectArqHelper({ auto: true })
  }, 0)
}

export function resetArqReceiverSession() {
  clearArqCompleteRetries()
  state.arqController = null
  state.arqFileId = null
  state.arqLastSeededSolved = null
  state.arqPendingSourceIds.clear()
}

function clearArqCompleteRetries() {
  if (state.arqCompleteRetryTimer) {
    clearInterval(state.arqCompleteRetryTimer)
    state.arqCompleteRetryTimer = null
  }
}

// Scanning stops at completion, so the beacon-driven COMPLETE re-sends can
// never run on this path; drive the controller from a bounded timer instead
// so a sender that missed the initial burst still learns to stop.
function scheduleArqCompleteRetries(controller) {
  clearArqCompleteRetries()
  let ticks = 0
  state.arqCompleteRetryTimer = setInterval(() => {
    ticks++
    if (ticks > 24 || controller !== state.arqController ||
        !state.completedFile || !state.arqConnected) {
      clearArqCompleteRetries()
      return
    }
    controller.onBeacon()
  }, 700)
}

function seedArqControllerFromDecoder(controller, decoder) {
  const solvedIds = decoder?.solvedSourceIds
  if (!controller || !Array.isArray(solvedIds)) return 0
  let seeded = 0
  for (const id of solvedIds) {
    const before = controller.count
    controller.markReceived(id)
    if (controller.count !== before) seeded++
  }
  return seeded
}

function addArqPendingSourceId(fileId, symbolId) {
  let ids = state.arqPendingSourceIds.get(fileId)
  if (!ids) {
    ids = new Set()
    state.arqPendingSourceIds.set(fileId, ids)
  }
  ids.add(symbolId)
}

function seedArqControllerFromPending(controller) {
  if (!controller) return 0
  // Only ids observed under the controller's fileId count; stale packets from
  // a previous session must not mask blocks as received.
  const pending = state.arqPendingSourceIds.get(controller.fileId)
  state.arqPendingSourceIds.clear()
  if (!pending) return 0
  let seeded = 0
  for (const id of pending) {
    if (id < 1 || id > controller.K) continue
    const before = controller.count
    controller.markReceived(id)
    if (controller.count !== before) seeded++
  }
  return seeded
}

function ensureArqReceiverController() {
  const decoder = state.decoder
  if (!state.arqConnected || !state.arqTransport || !decoder?.metadata || decoder.fileId == null) return null
  if (state.arqController && state.arqFileId === decoder.fileId) return state.arqController
  state.arqFileId = decoder.fileId
  state.arqController = new ArqReceiverController({
    K: decoder.metadata.K,
    fileId: decoder.fileId,
    send: bytes => {
      state.arqTransport.send(bytes).catch(err => {
        debugLog(`ARQ send failed: ${err.message}`)
        applyArqReceiverHelperStatus(ARQ_HELPER_STATUS.SEND_FAILED)
      })
    },
    verifyHash: () => !!state.completedFile,
    // Slow transports (keyboard dongle) declare a per-NACK payload budget.
    nackPayloadCapBytes: getTransport(getSelectedArqTransportName())?.nackPayloadCapBytes ?? 0
  })
  const seeded = seedArqControllerFromDecoder(state.arqController, decoder) +
    seedArqControllerFromPending(state.arqController)
  state.arqLastSeededSolved = decoder.solved ?? 0
  debugLog(`ARQ receiver session ready: fileId=${decoder.fileId} K=${decoder.metadata.K} seeded=${seeded}`)
  const connectedView = getArqHelperStatusView(ARQ_HELPER_STATUS.CONNECTED, getSelectedArqTransportName())
  updateArqReceiverStatus(`${connectedView.text} (K=${decoder.metadata.K})`, true, connectedView.buttonText)
  return state.arqController
}

export function noteArqParsedPackets(parsedList) {
  if (!state.arqConnected || !state.arqTransport) {
    state.arqPendingSourceIds.clear()
    return
  }
  const controller = ensureArqReceiverController()

  let sawRepairIdle = false
  for (const parsed of parsedList) {
    if (!parsed) continue
    if (!controller && parsed.symbolId >= 1 && parsed.fileId != null) {
      addArqPendingSourceId(parsed.fileId, parsed.symbolId)
    } else if (controller && parsed.fileId === controller.fileId &&
               parsed.symbolId >= 1 && parsed.symbolId <= controller.K) {
      controller.markReceived(parsed.symbolId)
    } else if (parsed.isMetadata && (!controller || parsed.fileId === controller.fileId)) {
      if (isRepairIdleMetadataPayload(parsed.payload)) sawRepairIdle = true
    }
  }

  if (controller && sawRepairIdle) {
    // Seeding walks O(K) solved-id arrays; decoder.solved is monotone, so
    // only re-seed when it moved or pending ids arrived.
    const solved = state.decoder?.solved ?? 0
    if (solved !== state.arqLastSeededSolved || state.arqPendingSourceIds.size > 0) {
      seedArqControllerFromDecoder(controller, state.decoder)
      seedArqControllerFromPending(controller)
      state.arqLastSeededSolved = solved
    }
    const msg = controller.onBeacon()
    const action = getArqBeaconLogAction(msg, controller.isFull(), !!state.completedFile)
    if (action) debugLog(`ARQ beacon observed: sent ${action} seq=${controller.seq}`)
  }
}

export function sendArqCompleteIfReady() {
  const controller = ensureArqReceiverController()
  if (!controller || !state.completedFile) return
  for (let id = 1; id <= controller.K; id++) controller.markReceived(id)
  const msg = controller.onBeacon()
  debugLog(`ARQ COMPLETE ${msg ? 'sent' : 'deferred'} seq=${controller.seq}`)
  scheduleArqCompleteRetries(controller)
}

export function requestArqFullRepair(reason) {
  const controller = ensureArqReceiverController()
  if (!controller || typeof controller.requestFullRepair !== 'function') return false
  controller.requestFullRepair()
  const msg = controller.onBeacon()
  debugLog(`ARQ full repair requested (${reason}) seq=${controller.seq}`)
  return !!msg
}
