import { decodeArqMessage, decodeMissingSet, encodeComplete, encodeNack, ARQ_MSG } from './arq-protocol.js'

export function testArqSenderConsumesNackIntoWorkList() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  c.onMessage(encodeNack(1, 1, [3, 6, 9]), 1000)
  const pass = c.mode === 'repair' && c.workList.join(',') === '3,6,9'
  console.log('arq sender consumes nack:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderIgnoresStaleSeq() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  c.onMessage(encodeNack(1, 5, [3, 6]), 1000)
  c.onMessage(encodeNack(1, 4, [1, 2, 7, 8]), 1100)
  const pass = c.workList.join(',') === '3,6'
  console.log('arq sender ignores stale seq:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderAcceptsWrappedSeq() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  c.onMessage(encodeNack(1, 0xFFFF, [3, 6]), 1000)
  c.onMessage(encodeNack(1, 0, [1, 2]), 1100)
  const pass = c.workList.join(',') === '1,2' && c.lastSeq === 0
  console.log('arq sender accepts wrapped seq:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderFallbackAfterTimeout() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  c.startPass(0)
  c.onPassExhausted(100)
  const before = c.tickFallback(4000)
  const after = c.tickFallback(5200)
  const pass = before === false && after === true && c.mode === 'fallback'
  console.log('arq sender fallback:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderFallsBackOnRepeatedUnchangedNacks() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  c.startPass(0)
  c.onPassExhausted(100)
  c.onMessage(encodeNack(1, 1, [3]), 1000)
  c.onPassExhausted(1100)
  c.onMessage(encodeNack(1, 2, [3]), 4000)
  c.onPassExhausted(4100)
  const before = c.tickFallback(5200)
  const after = c.tickFallback(6200)
  const pass = before === false && after === true && c.mode === 'fallback'
  console.log('arq sender fallback on unchanged nacks:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderDoesNotFallbackWhileNacksProgress() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  c.startPass(0)
  c.onPassExhausted(100)
  c.onMessage(encodeNack(1, 1, [3, 6, 9]), 1000)
  c.onPassExhausted(1100)
  c.onMessage(encodeNack(1, 2, [3, 6]), 4000)
  c.onPassExhausted(4100)
  const pass = c.tickFallback(6500) === false && c.mode === 'beacon'
  console.log('arq sender keeps repairing with progress:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderIgnoresDuplicateNackDuringActiveRepair() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  const first = c.onMessage(encodeNack(1, 1, [3, 6, 9]), 1000)
  const duplicate = c.onMessage(encodeNack(1, 2, [3, 6, 9]), 1100)
  const pass = first !== null &&
    duplicate === null &&
    c.mode === 'repair' &&
    c.workList.join(',') === '3,6,9' &&
    c.lastSeq === 2
  console.log('arq sender ignores duplicate nack during repair:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderRetriesDuplicateNackAfterRepairExhausted() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  c.onMessage(encodeNack(1, 1, [3, 6, 9]), 1000)
  c.onPassExhausted(1200)
  const retry = c.onMessage(encodeNack(1, 2, [3, 6, 9]), 1300)
  const pass = retry !== null &&
    c.mode === 'repair' &&
    c.workList.join(',') === '3,6,9'
  console.log('arq sender retries duplicate nack after exhausted repair:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderCompleteStops() {
  const c = new ArqSenderController({ K: 5, fileId: 1, fallbackMs: 5000 })
  c.onMessage(encodeComplete(1, 1), 1000)
  const pass = c.mode === 'done'
  console.log('arq sender complete stops:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderCompleteIsTerminal() {
  const c = new ArqSenderController({ K: 5, fileId: 1, fallbackMs: 5000 })
  c.onMessage(encodeComplete(1, 10), 1000)
  c.onMessage(encodeNack(1, 11, [1, 2]), 1100)
  const pass = c.mode === 'done'
  console.log('arq sender complete terminal:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderDisplayProgressStableAcrossRepair() {
  const c = new ArqSenderController({ K: 100, fileId: 1, fallbackMs: 5000 })
  const p1 = getArqSenderDisplayProgress(c, 50)
  c.onPassExhausted(100)
  const p2 = getArqSenderDisplayProgress(c, 0)
  c.onMessage(encodeNack(1, 1, [3, 6, 9, 12]), 1000)
  const p3 = getArqSenderDisplayProgress(c, 2)
  c.onPassExhausted(1100)
  const p4 = getArqSenderDisplayProgress(c, 0)
  c.onMessage(encodeComplete(1, 2), 2000)
  const p5 = getArqSenderDisplayProgress(c, 0)
  const pass = p1 === 50 && p2 === 100 && p3 === 96 && p4 === 96 && p5 === 100
  console.log('arq sender display progress:', pass ? 'PASS' : 'FAIL', [p1, p2, p3, p4, p5])
  return pass
}

// Progress for the sender UI. The raw replay cursor wraps every beacon cycle
// and resets on every NACK, so it reads as 0->100->0 churn on screen. Instead:
// pass1 shows cursor position through the one full pass; after that the work
// list is the receiver-reported missing set, so show the delivered fraction
// of source blocks (100 until the first NACK arrives).
export function getArqSenderDisplayProgress(controller, cursor) {
  if (!controller) return 0
  if (controller.mode === 'done') return 100
  if (controller.mode === 'pass1') {
    const span = Math.max(1, controller.workList.length)
    return Math.min(100, Math.round((cursor / span) * 100))
  }
  if (controller.lastMissingSignature === null) return 100
  const K = Math.max(1, controller.K)
  return Math.min(100, Math.round(((K - controller.workList.length) / K) * 100))
}

function isNewerSeq(seq, lastSeq) {
  if (lastSeq < 0) return true
  const diff = (seq - lastSeq) & 0xFFFF
  return diff !== 0 && diff < 0x8000
}

function missingSignature(ids) {
  return ids.join(',')
}

export class ArqSenderController {
  constructor({ K, fileId, fallbackMs = 8000 }) {
    this.K = K
    this.fileId = fileId
    this.fallbackMs = fallbackMs
    this.workList = []
    for (let id = 1; id <= K; id++) this.workList.push(id)
    this.lastSeq = -1
    this.mode = 'pass1'
    this.beaconSince = null
    this.lastMissingSignature = null
    this.needsRepairMetadata = false
  }

  startPass(now) {
    this.beaconSince = null
    this.lastMissingSignature = null
    this.needsRepairMetadata = false
  }

  onPassExhausted(now) {
    if (this.mode !== 'done') {
      this.mode = 'beacon'
      if (this.beaconSince === null) this.beaconSince = now
    }
  }

  onMessage(bytes, now) {
    const msg = decodeArqMessage(bytes)
    if (!msg || msg.fileId !== this.fileId) return null
    if (this.mode === 'done') return null

    if (msg.type === ARQ_MSG.COMPLETE) {
      if (!isNewerSeq(msg.seq, this.lastSeq)) return null
      this.lastSeq = msg.seq
      this.mode = 'done'
      return msg
    }

    if (msg.type === ARQ_MSG.NACK) {
      if (!isNewerSeq(msg.seq, this.lastSeq)) return null
      this.lastSeq = msg.seq
      const missing = decodeMissingSet(msg.payload)
      const sig = missingSignature(missing)
      if (this.mode === 'repair' && sig === this.lastMissingSignature) return null
      if (sig !== this.lastMissingSignature) {
        this.beaconSince = null
        this.lastMissingSignature = sig
      }
      this.workList = missing
      this.needsRepairMetadata = true
      this.mode = 'repair'
      return msg
    }

    return null
  }

  tickFallback(now) {
    if (this.mode === 'done') return false
    if (this.mode === 'beacon' &&
        this.beaconSince !== null &&
        (now - this.beaconSince) >= this.fallbackMs) {
      this.mode = 'fallback'
      return true
    }
    return false
  }
}
