// UI helper for choosing the ARQ back-channel transport without a URL param.
// Writes localStorage['arq-transport'], which resolveArqTransportName() reads
// as the fallback after any ?arq-transport= override (the query param still
// wins when present). Selection is per browser, so the sender and receiver
// machines are chosen independently — they MUST match for the back-channel to
// work, which is why this control lives on both screens.

import { getTransport } from './backchannel.js'
import { getSelectedArqTransportName } from './default-transports.js'

export const ARQ_TRANSPORT_STORAGE_KEY = 'arq-transport'

// Human labels for the registered transports, in display order. Only options
// whose transport is actually registered are shown.
export const ARQ_TRANSPORT_OPTIONS = [
  { value: 'ble-gatt', label: 'Bluetooth helper (BLE GATT)' },
  { value: 'keyboard', label: 'Keyboard dongle' }
]

export function setArqTransportPreference(name, storage = globalThis.localStorage) {
  if (!getTransport(name)) return false
  try {
    storage?.setItem(ARQ_TRANSPORT_STORAGE_KEY, name)
  } catch {
    // Private-mode / disabled storage: the URL param still works as a fallback.
  }
  return true
}

// Fill a <select> with the registered transports, reflect the effective
// choice, and persist + notify on change. onChange(name) fires after the new
// pick is stored so callers can tear down and reconnect on the new transport.
export function initArqTransportSelect(selectEl, { onChange } = {}) {
  if (!selectEl) return
  selectEl.replaceChildren()
  for (const opt of ARQ_TRANSPORT_OPTIONS) {
    if (!getTransport(opt.value)) continue
    const el = document.createElement('option')
    el.value = opt.value
    el.textContent = opt.label
    selectEl.appendChild(el)
  }
  selectEl.value = getSelectedArqTransportName()
  selectEl.onchange = () => {
    setArqTransportPreference(selectEl.value)
    onChange?.(selectEl.value)
  }
}

export function testArqTransportPreferencePersistsValidNamesOnly() {
  const store = new Map()
  const fake = { setItem: (k, v) => store.set(k, v), getItem: k => store.get(k) ?? null }
  const okKeyboard = setArqTransportPreference('keyboard', fake)
  const okBogus = setArqTransportPreference('bogus', fake)
  const pass = okKeyboard === true &&
    okBogus === false &&
    store.get(ARQ_TRANSPORT_STORAGE_KEY) === 'keyboard' &&
    ARQ_TRANSPORT_OPTIONS.length >= 2 &&
    ARQ_TRANSPORT_OPTIONS.every(o => !!getTransport(o.value))
  console.log('arq transport preference persists valid only:', pass ? 'PASS' : 'FAIL')
  return pass
}
