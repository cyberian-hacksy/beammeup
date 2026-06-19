# Beam Me Up ARQ Helper

This helper runs on the receiver machine. It exposes a local WebSocket for the
receiver browser and advertises a BLE GATT notify characteristic for the sender
browser.

## Install

macOS/Linux:

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r helper/requirements.txt
```

Windows PowerShell:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r .\helper\requirements.txt
```

On Windows, `bless` depends on a GitHub-hosted SetupAPI wrapper. Install
Git for Windows first if pip reports that `git` is not available. Running the
helper may also require an Administrator PowerShell because the WinRT backend
can update the local Bluetooth adapter name.

## Run

macOS/Linux:

```bash
./.venv/bin/python helper/server.py
```

Windows PowerShell:

```powershell
.\.venv\Scripts\python.exe .\helper\server.py
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
