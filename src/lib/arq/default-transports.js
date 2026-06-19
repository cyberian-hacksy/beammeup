import { DEFAULT_BACKCHANNEL_TRANSPORT, registerTransport } from './backchannel.js'
import { BleGattSenderTransport } from './transports/ble-gatt-sender.js'
import { BleGattReceiverTransport } from './transports/ble-gatt-receiver.js'

registerTransport(DEFAULT_BACKCHANNEL_TRANSPORT, {
  makeSender: () => new BleGattSenderTransport(),
  makeReceiver: () => new BleGattReceiverTransport()
})

export const DEFAULT_ARQ_TRANSPORT = DEFAULT_BACKCHANNEL_TRANSPORT
