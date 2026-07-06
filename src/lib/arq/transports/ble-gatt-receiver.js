import {
  DEFAULT_FRAGMENT_MTU,
  DEFAULT_WS_URL
} from '../backchannel.js'
import { fragment } from '../arq-fragment.js'

export class BleGattReceiverTransport {
  constructor({ url = DEFAULT_WS_URL, mtu = DEFAULT_FRAGMENT_MTU } = {}) {
    this.url = url
    this.mtu = mtu
    this.socket = null
    // Random start so a reconnected transport's msgIds don't collide with
    // stale partial entries in the sender-side Reassembler.
    this.msgId = (Math.random() * 0x10000) & 0xFFFF
    this.onStatus = null
  }

  async init(session = {}) {
    this.onStatus = session.onStatus || null
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(this.url)
      socket.binaryType = 'arraybuffer'
      socket.onopen = () => {
        this.socket = socket
        this.onStatus?.('connected')
        resolve()
      }
      socket.onerror = () => reject(new Error(`Unable to connect to ARQ helper at ${this.url}`))
      socket.onclose = () => {
        // A replaced socket's late close must not clobber the current
        // connection's status.
        if (this.socket !== socket) return
        this.socket = null
        this.onStatus?.('disconnected')
      }
    })
  }

  onMessage() {
    // Receiver-side transport is an emitter only.
  }

  async send(bytes) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('ARQ helper WebSocket is not connected')
    }
    const frags = fragment(bytes, this.msgId++ & 0xFFFF, this.mtu)
    for (const frag of frags) {
      this.socket.send(frag)
    }
  }

  close() {
    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onopen = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
    }
  }
}
