// Pure frame-ingest helper shared between the worker's capture pump and unit
// tests. No DOM, no timers, no module state — all dependencies are injected
// so tests can drive the logic without booting a worker or camera. The worker
// feeds real decodeDataRegion/extract functions and the shadow decoder; tests
// feed fakes.

export function ingestCapturedFrame({
  pixelBuffer,
  width,
  region,
  expectedPacketSize,
  decoder,
  decodeDataRegionFn,
  extractFn
}) {
  const decodeResult = decodeDataRegionFn(pixelBuffer, width, region)
  if (!decodeResult || !decodeResult.crcValid) {
    return {
      decodeResult,
      innovations: 0,
      accepted: 0,
      newSession: false
    }
  }
  const extract = extractFn(decodeResult.payload, expectedPacketSize)
  let innovations = 0
  let newSession = false
  for (const parsed of extract.packets) {
    if (!parsed) continue
    let r = decoder.receiveParsed(parsed)
    if (r === 'new_session') {
      newSession = true
      if (typeof decoder.reset === 'function') decoder.reset()
      r = decoder.receiveParsed(parsed)
    }
    if (r === true) innovations++
  }
  return {
    decodeResult,
    innovations,
    accepted: extract.packets.length,
    newSession
  }
}

export async function testIngestCapturedFrame() {
  const { createDecoder } = await import('../decoder.js')
  const { createEncoder } = await import('../encoder.js')
  const { parsePacket } = await import('../packet.js')

  const data = new Uint8Array(400)
  for (let i = 0; i < data.length; i++) data[i] = (i * 13) & 0xff
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  const enc = createEncoder(data.buffer, 't.bin', 'application/octet-stream', hash)
  const dec = createDecoder()

  const metaPacket = enc.generateSymbol(0)
  const firstPacket = enc.generateSymbol(1)
  if (metaPacket.byteLength !== firstPacket.byteLength) {
    console.log('FAIL ingestCapturedFrame setup: packet sizes differ',
      metaPacket.byteLength, firstPacket.byteLength)
    return false
  }
  const packetSize = metaPacket.byteLength
  const combined = new Uint8Array(packetSize * 2)
  combined.set(metaPacket, 0)
  combined.set(firstPacket, packetSize)

  const fakeDecodeDataRegion = () => ({
    crcValid: true,
    header: { symbolId: 0 },
    payload: combined,
    _diag: null
  })
  const fakeExtract = (payload) => {
    const out = []
    for (let off = 0; off < payload.length; off += packetSize) {
      const parsed = parsePacket(payload.subarray(off, off + packetSize))
      if (parsed) out.push(parsed)
    }
    return { packets: out, slotCount: out.length }
  }

  const result = ingestCapturedFrame({
    pixelBuffer: new Uint8ClampedArray(16),
    width: 4,
    region: null,
    expectedPacketSize: packetSize,
    decoder: dec,
    decodeDataRegionFn: fakeDecodeDataRegion,
    extractFn: fakeExtract
  })

  const pass = result.innovations >= 1 &&
    result.accepted === 2 &&
    result.newSession === false
  console.log('ingestCapturedFrame test:', pass ? 'PASS' : 'FAIL', result)
  return pass
}
