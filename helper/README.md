# Beam Me Up ARQ Helper

This helper runs on the receiver machine. It exposes a local WebSocket for the
receiver browser and advertises a BLE GATT notify characteristic for the sender
browser.

## Install

```bash
python -m pip install -r helper/requirements.txt
```

## Run

```bash
python helper/server.py
```

Expected output includes:

```text
Advertising BeamMeUp-ARQ
WebSocket bridge listening on ws://127.0.0.1:8787
```

The receiver browser sends already-fragmented ARQ messages to the WebSocket.
The helper forwards each binary WebSocket message unchanged as one BLE
notification on service `0000fff0-0000-1000-8000-00805f9b34fb`,
characteristic `0000fff1-0000-1000-8000-00805f9b34fb`.

Chrome Web Bluetooth does not expose the negotiated MTU. Keep the browser-side
fragment MTU conservative until the Phase-0 spike confirms the largest reliable
notification size on the target rig.
