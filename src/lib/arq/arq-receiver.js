import { decodeArqMessage, decodeMissingSet, encodeComplete, encodeNack, ARQ_MSG } from './arq-protocol.js'

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

export function testArqReceiverReNacksEachBeacon() {
  const sent = []
  const c = new ArqReceiverController({ K: 4, fileId: 1, send: b => sent.push(b), verifyHash: () => true })
  c.markReceived(1)
  c.onBeacon()
  c.onBeacon()
  const a = decodeMissingSet(decodeArqMessage(sent[0]).payload).join(',')
  const b = decodeMissingSet(decodeArqMessage(sent[1]).payload).join(',')
  const pass = a === '2,3,4' && b === '2,3,4' && decodeArqMessage(sent[1]).seq > decodeArqMessage(sent[0]).seq
  console.log('arq receiver re-nack:', pass ? 'PASS' : 'FAIL')
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
  constructor({ K, fileId, send, verifyHash }) {
    this.K = K
    this.fileId = fileId
    this.send = send
    this.verifyHash = verifyHash
    this.missingIds = new Set()
    for (let id = 1; id <= K; id++) this.missingIds.add(id)
    this.count = 0
    this.seq = 0
    this.completeSendsRemaining = 3
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
    const msg = encodeNack(this.fileId, this.seq, missing)
    this.send(msg)
    return msg
  }
}
