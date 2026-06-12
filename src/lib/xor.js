// In-place XOR of src into dst: dst[i] ^= src[i] over the overlapping length.
// This is the hot loop of fountain decoding — blocks are tens of kilobytes
// and every degree-3 symbol elimination XORs several of them — so it runs
// word-at-a-time (~4-8x the byte loop). The u32 views need 4-byte alignment,
// which whole-buffer blocks always have; unaligned views and the tail fall
// back to bytes. Matches the original `dst[i] ^= src[i]` loops exactly,
// including their behavior when src is shorter (those bytes stay unchanged).
export function xorBytesInto(dst, src) {
  const len = Math.min(dst.length, src.length)
  let i = 0
  if (len >= 16 && (dst.byteOffset & 3) === 0 && (src.byteOffset & 3) === 0) {
    const words = len >> 2
    const d32 = new Uint32Array(dst.buffer, dst.byteOffset, words)
    const s32 = new Uint32Array(src.buffer, src.byteOffset, words)
    for (let w = 0; w < words; w++) d32[w] ^= s32[w]
    i = words << 2
  }
  for (; i < len; i++) dst[i] ^= src[i]
}

export function testXorBytesInto() {
  const mk = (n, seed) => {
    const a = new Uint8Array(n)
    for (let i = 0; i < n; i++) a[i] = (i * seed + 13) & 0xff
    return a
  }
  const cases = [
    { n: 0 }, { n: 1 }, { n: 15 }, { n: 16 }, { n: 17 }, { n: 1000 }, { n: 30096 }
  ]
  for (const { n } of cases) {
    const dst = mk(n, 7)
    const src = mk(n, 31)
    const expected = mk(n, 7).map((v, i) => v ^ src[i])
    xorBytesInto(dst, src)
    for (let i = 0; i < n; i++) {
      if (dst[i] !== expected[i]) {
        console.log('xorBytesInto test: FAIL', { n, i })
        return false
      }
    }
  }
  // Unaligned subarray view falls back to the byte loop and stays correct.
  const buf = new Uint8Array(64)
  for (let i = 0; i < 64; i++) buf[i] = i
  const dst = buf.subarray(1, 33)
  const src = mk(32, 11)
  const expected = new Uint8Array(32).map((_, i) => (i + 1) ^ src[i])
  xorBytesInto(dst, src)
  for (let i = 0; i < 32; i++) {
    if (dst[i] !== expected[i]) {
      console.log('xorBytesInto test: FAIL (unaligned)', { i })
      return false
    }
  }
  // Shorter src leaves the dst tail untouched (mirrors the old loops'
  // `^= undefined` no-op behavior).
  const dTail = mk(20, 7)
  const sShort = mk(10, 31)
  const before = dTail.slice()
  xorBytesInto(dTail, sShort)
  for (let i = 10; i < 20; i++) {
    if (dTail[i] !== before[i]) {
      console.log('xorBytesInto test: FAIL (short src tail)', { i })
      return false
    }
  }
  console.log('xorBytesInto test: PASS')
  return true
}
