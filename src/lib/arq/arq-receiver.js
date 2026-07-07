import { decodeArqMessage, decodeMissingSet, encodeComplete, encodeNack, ARQ_MSG } from './arq-protocol.js'

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

export function testArqReceiverCoalescesChangedNacksDuringProgress() {
  const sent = []
  const c = new ArqReceiverController({ K: 4, fileId: 1, send: b => sent.push(b), verifyHash: () => true, nackChangeHoldBeacons: 3 })
  c.markReceived(1)
  c.onBeacon()
  c.markReceived(2)
  c.onBeacon()
  const first = sent[0] ? decodeMissingSet(decodeArqMessage(sent[0]).payload).join(',') : ''
  const pass = sent.length === 1 && first === '2,3,4'
  console.log('arq receiver coalesces changed nacks:', pass ? 'PASS' : 'FAIL', sent.length)
  return pass
}

export function testArqReceiverSendsChangedNackAfterHold() {
  const sent = []
  const c = new ArqReceiverController({ K: 5, fileId: 1, send: b => sent.push(b), verifyHash: () => true, nackChangeHoldBeacons: 2 })
  c.markReceived(1)
  c.onBeacon()
  c.markReceived(2)
  c.onBeacon()
  c.markReceived(3)
  c.onBeacon()
  const first = sent[0] ? decodeMissingSet(decodeArqMessage(sent[0]).payload).join(',') : ''
  const second = sent[1] ? decodeMissingSet(decodeArqMessage(sent[1]).payload).join(',') : ''
  const pass = sent.length === 2 && first === '2,3,4,5' && second === '4,5'
  console.log('arq receiver sends changed nack after hold:', pass ? 'PASS' : 'FAIL', sent.length)
  return pass
}

export function testArqReceiverCapsNackPayload() {
  const sent = []
  const c = new ArqReceiverController({
    K: 200, fileId: 1, send: b => sent.push(b), verifyHash: () => true,
    nackPayloadCapBytes: 12
  })
  // Leave every odd id missing: alternating ids defeat run collapsing, so
  // only the cap keeps the payload small.
  for (let id = 2; id <= 200; id += 2) c.markReceived(id)
  c.onBeacon()
  const msg = decodeArqMessage(sent[0])
  const missing = decodeMissingSet(msg.payload)
  const odds = Array.from({ length: 100 }, (_, i) => 1 + i * 2)
  const pass = msg.type === ARQ_MSG.NACK &&
    msg.payload.length <= 12 &&
    missing.length >= 1 && missing.length < odds.length &&
    missing.every((v, i) => v === odds[i])
  console.log('arq receiver caps nack payload:', pass ? 'PASS' : 'FAIL', { bytes: msg.payload.length, ids: missing.length })
  return pass
}

export function testArqReceiverCappedNacksConverge() {
  const sent = []
  const c = new ArqReceiverController({
    K: 120, fileId: 1, send: b => sent.push(b), verifyHash: () => true,
    nackPayloadCapBytes: 10, nackRepeatBeacons: 1, nackChangeHoldBeacons: 1
  })
  for (let id = 2; id <= 120; id += 2) c.markReceived(id)
  let rounds = 0
  let nacks = 0
  while (!c.isFull() && rounds < 300) {
    rounds++
    const before = sent.length
    c.onBeacon()
    if (sent.length === before) continue
    const msg = decodeArqMessage(sent[sent.length - 1])
    if (msg.type !== ARQ_MSG.NACK) continue
    nacks++
    // Sender repairs exactly what the capped NACK asked for.
    for (const id of decodeMissingSet(msg.payload)) c.markReceived(id)
  }
  c.onBeacon()
  const last = decodeArqMessage(sent[sent.length - 1])
  // The cap must force several short NACK rounds (an uncapped NACK would
  // finish in one), and the loop must still drain to COMPLETE.
  const pass = c.isFull() && rounds < 300 && nacks >= 3 && last.type === ARQ_MSG.COMPLETE
  console.log('arq receiver capped nacks converge:', pass ? 'PASS' : 'FAIL', { rounds, nacks })
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

export function testArqReceiverReplenishesCompleteWhileBeaconsContinue() {
  const sent = []
  const c = new ArqReceiverController({ K: 1, fileId: 1, send: b => sent.push(b), verifyHash: () => true, nackRepeatBeacons: 4 })
  c.markReceived(1)
  for (let i = 0; i < 11; i++) c.onBeacon()
  const pass = sent.length === 5 &&
    sent.every(bytes => decodeArqMessage(bytes)?.type === ARQ_MSG.COMPLETE)
  console.log('arq receiver replenishes complete:', pass ? 'PASS' : 'FAIL', sent.length)
  return pass
}

export class ArqReceiverController {
  constructor({ K, fileId, send, verifyHash, nackRepeatBeacons = 12, nackChangeHoldBeacons = 12, nackPayloadCapBytes = 0 }) {
    this.K = K
    this.fileId = fileId
    this.send = send
    this.verifyHash = verifyHash
    this.nackRepeatBeacons = Math.max(1, nackRepeatBeacons | 0)
    this.nackChangeHoldBeacons = Math.max(1, nackChangeHoldBeacons | 0)
    // Slow transports (keyboard dongle) bound each NACK to a short line;
    // 0 means uncapped. Capped NACKs carry the lowest missing ids and rely
    // on idempotent re-NACK to drain the rest.
    this.nackPayloadCapBytes = Math.max(0, nackPayloadCapBytes | 0)
    this.missingIds = new Set()
    for (let id = 1; id <= K; id++) this.missingIds.add(id)
    this.count = 0
    this.seq = 0
    this.completeSendsRemaining = 3
    this.completeRefreshBeacons = 0
    // Monotone mutation counter: markReceived only ever deletes ids, so
    // "mutations unchanged since the last NACK" is exactly "missing set
    // unchanged" — no need to materialize the O(K) id list per beacon.
    this.mutations = 0
    this.lastNackMutations = -1
    this.duplicateNackBeacons = 0
    this.changedNackBeacons = 0
  }

  markReceived(id) {
    if (!this.missingIds.has(id)) return
    this.missingIds.delete(id)
    this.count++
    this.mutations++
  }

  requestFullRepair() {
    this.missingIds = new Set()
    for (let id = 1; id <= this.K; id++) this.missingIds.add(id)
    this.count = 0
    this.completeSendsRemaining = 3
    this.completeRefreshBeacons = 0
    this.mutations++
    this.lastNackMutations = -1
    this.duplicateNackBeacons = 0
    this.changedNackBeacons = 0
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
      // Beacons still arriving after the burst mean the sender missed the
      // COMPLETE; keep re-sending at the duplicate-NACK cadence.
      if (this.completeSendsRemaining <= 0) {
        this.completeRefreshBeacons++
        if (this.completeRefreshBeacons < this.nackRepeatBeacons) return null
        this.completeRefreshBeacons = 0
      } else {
        this.completeSendsRemaining--
      }
      const msg = encodeComplete(this.fileId, this.seq)
      this.send(msg)
      return msg
    }
    if (this.missingIds.size === 0) return null
    if (this.mutations === this.lastNackMutations) {
      this.duplicateNackBeacons++
      if (this.duplicateNackBeacons < this.nackRepeatBeacons) return null
      this.duplicateNackBeacons = 0
    } else {
      if (this.lastNackMutations !== -1) {
        this.changedNackBeacons++
        if (this.changedNackBeacons < this.nackChangeHoldBeacons) return null
      }
      this.lastNackMutations = this.mutations
      this.duplicateNackBeacons = 0
      this.changedNackBeacons = 0
    }
    const msg = encodeNack(this.fileId, this.seq, this.missing(), this.nackPayloadCapBytes)
    this.send(msg)
    return msg
  }
}
