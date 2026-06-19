import { encodeNack } from './arq-protocol.js'
import { ArqReceiverController } from './arq-receiver.js'
import { ArqSenderController } from './arq-sender.js'
import { createPRNG } from '../prng.js'

function seededUnitRandom(seed) {
  const rng = createPRNG(seed)
  return () => rng.next() / 4294967296
}

export async function testArqGoodputBeatsReloop() {
  const K = 2000
  const loss = 0.05
  const rnd = seededUnitRandom(42)
  const rx = new ArqReceiverController({ K, fileId: 1, send: () => {}, verifyHash: () => true })
  const tx = new ArqSenderController({ K, fileId: 1, fallbackMs: 1e9 })
  let arqBlocksSent = 0
  let rounds = 0
  let work = tx.workList.slice()

  while (!rx.isFull() && rounds < 20) {
    for (const id of work) {
      arqBlocksSent++
      if (rnd() > loss) rx.markReceived(id)
    }
    rounds++
    if (rx.isFull()) break
    tx.onMessage(encodeNack(1, rounds, rx.missing()), rounds)
    work = tx.workList.slice()
  }

  const rnd2 = seededUnitRandom(42)
  const got = new Uint8Array(K + 1)
  let have = 0
  let reloopSent = 0
  let reloops = 0
  while (have < K && reloops < 200) {
    for (let id = 1; id <= K; id++) {
      reloopSent++
      if (!got[id] && rnd2() > loss) {
        got[id] = 1
        have++
      }
    }
    reloops++
  }

  const pass = rx.isFull() && rounds <= 6 && arqBlocksSent < reloopSent
  console.log('arq goodput beats reloop:', pass ? 'PASS' : 'FAIL',
    { rounds, arqBlocksSent, reloopSent })
  return pass
}
