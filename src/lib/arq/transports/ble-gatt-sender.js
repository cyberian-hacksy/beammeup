import {
  ARQ_NOTIFY_CHARACTERISTIC_UUID,
  SERVICE_UUID
} from '../backchannel.js'
import { fragment, Reassembler } from '../arq-fragment.js'

export const ARQ_DEVICE_NAME = 'BeamMeUp-ARQ'

export function getBleGattRequestOptions() {
  return {
    acceptAllDevices: true,
    optionalServices: [SERVICE_UUID]
  }
}

export function testBleGattSenderUsesBroadDiscoveryWithOptionalService() {
  const opts = getBleGattRequestOptions()
  const pass = opts.acceptAllDevices === true &&
    opts.optionalServices?.[0] === SERVICE_UUID &&
    !opts.filters
  console.log('ble gatt sender discovery options:', pass ? 'PASS' : 'FAIL')
  return pass
}

export function testBleGattSenderCopiesNotificationBuffer() {
  const msg = new Uint8Array(80).map((_, i) => (i * 11) & 0xFF)
  const frags = fragment(msg, 7, 20)
  const shared = new Uint8Array(Math.max(...frags.map(f => f.length)))
  const transport = new BleGattSenderTransport()
  let out = null
  transport.onMessage(bytes => { out = bytes })

  for (const frag of frags) {
    shared.fill(0)
    shared.set(frag)
    transport.handleNotification({ target: { value: new DataView(shared.buffer, 0, frag.length) } })
  }

  const pass = out &&
    out.length === msg.length &&
    out.every((v, i) => v === msg[i])
  console.log('ble gatt sender copies notification buffer:', pass ? 'PASS' : 'FAIL')
  return !!pass
}

export class BleGattSenderTransport {
  constructor() {
    this.device = null
    this.server = null
    this.characteristic = null
    this.cb = null
    this.reassembler = new Reassembler()
    this.onStatus = null
    this.onDisconnect = null
    this.handleNotification = this.handleNotification.bind(this)
    this.handleDisconnected = this.handleDisconnected.bind(this)
  }

  async init(session = {}) {
    this.onStatus = session.onStatus || null
    this.onDisconnect = session.onDisconnect || null
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser')
    }

    this.onStatus?.('select-device')
    this.device = await navigator.bluetooth.requestDevice(getBleGattRequestOptions())
    this.device.addEventListener('gattserverdisconnected', this.handleDisconnected)

    this.onStatus?.('connecting')
    this.server = await this.device.gatt.connect()
    const service = await this.server.getPrimaryService(SERVICE_UUID)
    this.characteristic = await service.getCharacteristic(ARQ_NOTIFY_CHARACTERISTIC_UUID)
    this.characteristic.addEventListener('characteristicvaluechanged', this.handleNotification)
    await this.characteristic.startNotifications()
    this.onStatus?.('connected')
  }

  onMessage(cb) {
    this.cb = cb
  }

  handleNotification(event) {
    const view = event.target.value
    const frag = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice()
    const msg = this.reassembler.ingest(frag)
    if (msg && this.cb) this.cb(msg)
  }

  handleDisconnected() {
    this.onStatus?.('disconnected')
    this.onDisconnect?.()
  }

  close() {
    if (this.characteristic) {
      this.characteristic.removeEventListener('characteristicvaluechanged', this.handleNotification)
    }
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnected)
    }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect()
    this.characteristic = null
    this.server = null
    this.device = null
    this.reassembler = new Reassembler()
  }
}
