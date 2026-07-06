export function testFragmentReassembleRoundtrip() {
  const msg = new Uint8Array(500).map((_, i) => i & 0xFF)
  const frags = fragment(msg, 0, 64)
  const r = new Reassembler()
  let out = null
  for (const f of frags) out = r.ingest(f) || out
  const pass = out && out.length === 500 && out.every((v, i) => v === (i & 0xFF))
  console.log('fragment roundtrip:', pass ? 'PASS' : 'FAIL')
  return !!pass
}

export function testFragmentOutOfOrderAndDup() {
  const msg = new Uint8Array(200).map((_, i) => (i * 3) & 0xFF)
  const frags = fragment(msg, 5, 64)
  const r = new Reassembler()
  const order = [2, 0, 2, 1, 3].filter(i => i < frags.length)
  let out = null
  for (const i of order) out = r.ingest(frags[i]) || out
  const pass = out && out.length === 200 && out.every((v, i) => v === ((i * 3) & 0xFF))
  console.log('fragment out-of-order+dup:', pass ? 'PASS' : 'FAIL')
  return !!pass
}

export function testFragmentMissingDrops() {
  const msg = new Uint8Array(200)
  const frags = fragment(msg, 9, 64)
  const r = new Reassembler()
  let out = null
  for (let i = 0; i < frags.length - 1; i++) out = r.ingest(frags[i]) || out
  console.log('fragment missing drops:', out === null ? 'PASS' : 'FAIL')
  return out === null
}

export function testFragmentSupportsLargeCounts() {
  const msg = new Uint8Array(6000).map((_, i) => i & 0xFF)
  const frags = fragment(msg, 17, 20)
  const r = new Reassembler()
  let out = null
  for (const f of frags) out = r.ingest(f) || out
  const pass = frags.length > 255 &&
    out &&
    out.length === msg.length &&
    out.every((v, i) => v === (i & 0xFF))
  console.log('fragment large-count:', pass ? 'PASS' : 'FAIL', { fragments: frags.length })
  return !!pass
}

export function testFragmentReusedIdResetsStaleEntry() {
  const stale = fragment(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 44, 8)
  const freshMsg = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16])
  const fresh = fragment(freshMsg, 44, 8)
  const r = new Reassembler({ maxCompletedAge: 0 })
  r.ingest(stale[1])
  for (const f of fragment(new Uint8Array([20, 21, 22]), 45, 8)) r.ingest(f)
  r.ingest(fresh[0])
  let out = null
  for (let i = 1; i < fresh.length; i++) out = r.ingest(fresh[i]) || out
  const pass = out &&
    out.length === freshMsg.length &&
    out.every((v, i) => v === freshMsg[i])
  console.log('fragment reused-id reset:', pass ? 'PASS' : 'FAIL')
  return !!pass
}

export function testFragmentReusedIdConflictResetsStaleEntry() {
  // A stale partial that lost fragment 0 must not merge with a new message
  // reusing the same msgId and fragment count.
  const staleMsg = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  const freshMsg = new Uint8Array([9, 10, 11, 12, 13, 14, 15, 16])
  const stale = fragment(staleMsg, 7, 8)
  const fresh = fragment(freshMsg, 7, 8)
  const r = new Reassembler()
  r.ingest(stale[1])
  let out = null
  out = r.ingest(fresh[1]) || out
  out = r.ingest(fresh[0]) || out
  out = r.ingest(fresh[2]) || out
  out = r.ingest(fresh[3]) || out
  const pass = out &&
    out.length === freshMsg.length &&
    out.every((v, i) => v === freshMsg[i])
  console.log('fragment reused-id conflict reset:', pass ? 'PASS' : 'FAIL')
  return !!pass
}

const FRAGMENT_HEADER_SIZE = 6

// Fragment header: [ msgId(2 BE) | fragIdx(2 BE) | fragCount(2 BE) | data... ]
export function fragment(bytes, msgId, mtu) {
  const dataPerFrag = Math.max(1, mtu - FRAGMENT_HEADER_SIZE)
  const count = Math.max(1, Math.ceil(bytes.length / dataPerFrag))
  if (count > 0xFFFF) throw new Error(`ARQ message needs ${count} fragments; 16-bit fragment count supports 65535`)

  const out = []
  for (let i = 0; i < count; i++) {
    const slice = bytes.subarray(i * dataPerFrag, (i + 1) * dataPerFrag)
    const f = new Uint8Array(FRAGMENT_HEADER_SIZE + slice.length)
    const view = new DataView(f.buffer)
    view.setUint16(0, msgId & 0xFFFF, false)
    view.setUint16(2, i, false)
    view.setUint16(4, count, false)
    f.set(slice, FRAGMENT_HEADER_SIZE)
    out.push(f)
  }
  return out
}

export class Reassembler {
  constructor({ maxEntries = 256, maxCompletedAge = 256 } = {}) {
    this.buf = new Map()
    this.order = []
    this.maxEntries = maxEntries
    this.maxCompletedAge = maxCompletedAge
    this.completedSerial = 0
  }

  touch(msgId) {
    const idx = this.order.indexOf(msgId)
    if (idx >= 0) this.order.splice(idx, 1)
    this.order.push(msgId)
    while (this.order.length > this.maxEntries) {
      const old = this.order.shift()
      this.buf.delete(old)
    }
  }

  forget(msgId) {
    this.buf.delete(msgId)
    const idx = this.order.indexOf(msgId)
    if (idx >= 0) this.order.splice(idx, 1)
  }

  evictStale() {
    for (const [msgId, entry] of this.buf) {
      if ((this.completedSerial - entry.createdSerial) > this.maxCompletedAge) {
        this.forget(msgId)
      }
    }
  }

  sameBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false
    }
    return true
  }

  ingest(frag) {
    if (frag.length < FRAGMENT_HEADER_SIZE) return null
    const view = new DataView(frag.buffer, frag.byteOffset, frag.byteLength)
    const msgId = view.getUint16(0, false)
    const idx = view.getUint16(2, false)
    const count = view.getUint16(4, false)
    if (count < 1 || idx >= count) return null

    this.evictStale()
    const body = frag.slice(FRAGMENT_HEADER_SIZE)
    let entry = this.buf.get(msgId)
    // A differing byte at any already-held index means the msgId was reused
    // for a different message (e.g. transport restart) — the stale partial
    // must not merge with the new fragments.
    const held = entry?.parts.get(idx)
    if (held && !this.sameBytes(held, body)) {
      this.forget(msgId)
      entry = null
    }
    if (!entry || entry.count !== count) {
      entry = { count, parts: new Map(), createdSerial: this.completedSerial }
      this.buf.set(msgId, entry)
    }
    this.touch(msgId)
    if (!entry.parts.has(idx)) entry.parts.set(idx, body)
    if (entry.parts.size !== entry.count) return null

    let total = 0
    for (const p of entry.parts.values()) total += p.length
    const out = new Uint8Array(total)
    let off = 0
    for (let i = 0; i < entry.count; i++) {
      const p = entry.parts.get(i)
      out.set(p, off)
      off += p.length
    }
    this.forget(msgId)
    this.completedSerial++
    return out
  }
}
