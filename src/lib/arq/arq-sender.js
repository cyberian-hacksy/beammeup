import { decodeArqMessage, decodeMissingSet, encodeComplete, encodeNack, ARQ_MSG } from './arq-protocol.js'

export function testArqSenderConsumesNackIntoWorkList() {
  const c = new ArqSenderController({ K: 10, fileId: 1, fallbackMs: 5000 })
  c.onMessage(encodeNack(1, 1, [3, 6, 9]), 1000)
  const pass = c.mode === 'repair' && c.workList.join(',') === '3,6,9'
  console.log('arq sender consumes nack:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testArqSenderUsesInitialWorkList() {
  const c = new ArqSenderController({ K: 5, fileId: 1, fallbackMs: 5000, initialWorkList: [1, 3, 5, 2, 4] })
  const pass = c.workList.join(',') === '1,3,5,2,4'
  console.log('arq sender initial work-list:', pass ? 'PASS' : 'FAIL', c.workList)
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

function isNewerSeq(seq, lastSeq) {
  if (lastSeq < 0) return true
  const diff = (seq - lastSeq) & 0xFFFF
  return diff !== 0 && diff < 0x8000
}

function missingSignature(ids) {
  return ids.join(',')
}

function buildWorkList(K, initialWorkList = null) {
  const seen = new Set()
  const list = []
  if (Array.isArray(initialWorkList)) {
    for (const raw of initialWorkList) {
      const id = raw | 0
      if (id < 1 || id > K || seen.has(id)) continue
      seen.add(id)
      list.push(id)
    }
  }
  for (let id = 1; id <= K; id++) {
    if (seen.has(id)) continue
    seen.add(id)
    list.push(id)
  }
  return list
}

export class ArqSenderController {
  constructor({ K, fileId, fallbackMs = 8000, initialWorkList = null }) {
    this.K = K
    this.fileId = fileId
    this.fallbackMs = fallbackMs
    this.workList = buildWorkList(K, initialWorkList)
    this.lastSeq = -1
    this.mode = 'pass1'
    this.lastActivity = 0
    this.beaconSince = null
    this.lastMissingSignature = null
    this.needsRepairMetadata = false
  }

  startPass(now) {
    this.lastActivity = now
    this.beaconSince = null
    this.lastMissingSignature = null
    this.needsRepairMetadata = false
  }

  onPassExhausted(now) {
    if (this.mode !== 'done') {
      this.mode = 'beacon'
      if (this.beaconSince === null) this.beaconSince = now
      this.lastActivity = now
    }
  }

  onMessage(bytes, now) {
    const msg = decodeArqMessage(bytes)
    if (!msg || msg.fileId !== this.fileId) return null
    if (this.mode === 'done') return null

    if (msg.type === ARQ_MSG.COMPLETE) {
      if (!isNewerSeq(msg.seq, this.lastSeq)) return null
      this.lastSeq = msg.seq
      this.lastActivity = now
      this.mode = 'done'
      return msg
    }

    if (msg.type === ARQ_MSG.NACK) {
      if (!isNewerSeq(msg.seq, this.lastSeq)) return null
      this.lastSeq = msg.seq
      this.lastActivity = now
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
