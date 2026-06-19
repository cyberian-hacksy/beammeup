import { decodeArqMessage, decodeMissingSet, encodeComplete, encodeNack, ARQ_MSG } from './arq-protocol.js'

function missingSignature(ids) {
  return ids.join(',')
}

export function getArqBeaconLogAction(msg, isFull, verified) {
  if (!msg) return null
  return isFull && verified ? 'COMPLETE' : 'NACK'
}

export function testArqReceiverBuildsNackForGaps() {
  const sent = []
  const c = new ArqReceiverController({ K: 10, fileId: 1, send: b => sent.push(b), verifyHash: () => true })
  ;[1, 2, 4, 5, 7, 8, 9, 10].forEach(id => c.markReceived(id))
  c.onBeacon()
  const msg = decodeArqMessage(sent[0])
  const missing = decodeMissingSet(msg.payload)
  const pass = msg.type === ARQ_MSG.NACK && missing.join(',') === '3,6'
  console.log('arq receiver nack gaps:', pass ? 'PASS' : 'FAIL', missing)
  return pass
}

export function testArqReceiverCompleteOnlyWhenFullAndHashOk() {
  const sent = []
  let hashOk = false
  const c = new ArqReceiverController({ K: 3, fileId: 1, send: b => sent.push(b), verifyHash: () => hashOk })
  ;[1, 2, 3].forEach(id => c.markReceived(id))
  const pending = c.onBeacon()
  hashOk = true
  c.onBeacon()
  const last = decodeArqMessage(sent[sent.length - 1])
  const pass = pending === null && sent.length === 1 && last.type === ARQ_MSG.COMPLETE
  console.log('arq receiver complete gating:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqReceiverSuppressesEmptyNackWhileHashPending() {
  const sent = []
  const c = new ArqReceiverController({ K: 2, fileId: 1, send: b => sent.push(b), verifyHash: () => false })
  c.markReceived(1)
  c.markReceived(2)
  const msg = c.onBeacon()
  const pass = msg === null && sent.length === 0
  console.log('arq receiver suppresses empty nack:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqReceiverCanRequestFullRepairAfterHashMismatch() {
  const sent = []
  const c = new ArqReceiverController({ K: 3, fileId: 1, send: b => sent.push(b), verifyHash: () => false })
  ;[1, 2, 3].forEach(id => c.markReceived(id))
  if (typeof c.requestFullRepair !== 'function') {
    console.log('arq receiver full repair request: FAIL')
    return false
  }
  c.requestFullRepair()
  c.onBeacon()
  const msg = decodeArqMessage(sent[0])
  const missing = msg ? decodeMissingSet(msg.payload) : []
  const pass = msg?.type === ARQ_MSG.NACK && missing.join(',') === '1,2,3'
  console.log('arq receiver full repair request:', pass ? 'PASS' : 'FAIL', missing)
  return pass
}

export function testArqReceiverThrottlesDuplicateNacks() {
  const sent = []
  const c = new ArqReceiverController({ K: 4, fileId: 1, send: b => sent.push(b), verifyHash: () => true, nackRepeatBeacons: 3 })
  c.markReceived(1)
  c.onBeacon()
  c.onBeacon()
  c.onBeacon()
  c.onBeacon()
  const first = sent[0] ? decodeMissingSet(decodeArqMessage(sent[0]).payload).join(',') : ''
  const second = sent[1] ? decodeMissingSet(decodeArqMessage(sent[1]).payload).join(',') : ''
  const pass = sent.length === 2 && first === '2,3,4' && second === '2,3,4'
  console.log('arq receiver throttles duplicate nacks:', pass ? 'PASS' : 'FAIL', sent.length)
  return pass
}

export function testArqReceiverNacksImmediatelyWhenMissingSetChanges() {
  const sent = []
  const c = new ArqReceiverController({ K: 4, fileId: 1, send: b => sent.push(b), verifyHash: () => true, nackRepeatBeacons: 10 })
  c.markReceived(1)
  c.onBeacon()
  c.markReceived(2)
  c.onBeacon()
  const first = sent[0] ? decodeMissingSet(decodeArqMessage(sent[0]).payload).join(',') : ''
  const second = sent[1] ? decodeMissingSet(decodeArqMessage(sent[1]).payload).join(',') : ''
  const pass = sent.length === 2 && first === '2,3,4' && second === '3,4'
  console.log('arq receiver nacks changed missing set immediately:', pass ? 'PASS' : 'FAIL', sent.length)
  return pass
}

export function testArqBeaconLogActionSkipsSuppressedNack() {
  const pass = getArqBeaconLogAction(null, false, false) === null &&
    getArqBeaconLogAction(new Uint8Array([1]), false, false) === 'NACK' &&
    getArqBeaconLogAction(new Uint8Array([1]), true, true) === 'COMPLETE'
  console.log('arq beacon log action skips suppressed nack:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqReceiverCapsCompleteBursts() {
  const sent = []
  const c = new ArqReceiverController({ K: 1, fileId: 1, send: b => sent.push(b), verifyHash: () => true })
  c.markReceived(1)
  for (let i = 0; i < 5; i++) c.onBeacon()
  const pass = sent.length === 3 &&
    sent.every(bytes => decodeArqMessage(bytes)?.type === ARQ_MSG.COMPLETE)
  console.log('arq receiver caps complete bursts:', pass ? 'PASS' : 'FAIL', sent.length)
  return pass
}

export class ArqReceiverController {
  constructor({ K, fileId, send, verifyHash, nackRepeatBeacons = 12 }) {
    this.K = K
    this.fileId = fileId
    this.send = send
    this.verifyHash = verifyHash
    this.nackRepeatBeacons = Math.max(1, nackRepeatBeacons | 0)
    this.missingIds = new Set()
    for (let id = 1; id <= K; id++) this.missingIds.add(id)
    this.count = 0
    this.seq = 0
    this.completeSendsRemaining = 3
    this.lastNackSignature = null
    this.duplicateNackBeacons = 0
  }

  markReceived(id) {
    if (!this.missingIds.has(id)) return
    this.missingIds.delete(id)
    this.count++
  }

  requestFullRepair() {
    this.missingIds = new Set()
    for (let id = 1; id <= this.K; id++) this.missingIds.add(id)
    this.count = 0
    this.completeSendsRemaining = 3
    this.lastNackSignature = null
    this.duplicateNackBeacons = 0
  }

  isFull() {
    return this.count === this.K
  }

  missing() {
    return Array.from(this.missingIds)
  }

  onBeacon() {
    this.seq = (this.seq + 1) & 0xFFFF
    if (this.isFull() && this.verifyHash()) {
      if (this.completeSendsRemaining <= 0) return null
      this.completeSendsRemaining--
      const msg = encodeComplete(this.fileId, this.seq)
      this.send(msg)
      return msg
    }
    const missing = this.missing()
    if (missing.length === 0) return null
    const sig = missingSignature(missing)
    if (sig === this.lastNackSignature) {
      this.duplicateNackBeacons++
      if (this.duplicateNackBeacons < this.nackRepeatBeacons) return null
      this.duplicateNackBeacons = 0
    } else {
      this.lastNackSignature = sig
      this.duplicateNackBeacons = 0
    }
    const msg = encodeNack(this.fileId, this.seq, missing)
    this.send(msg)
    return msg
  }
}
