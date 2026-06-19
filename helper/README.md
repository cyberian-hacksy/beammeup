# Beam Me Up ARQ Helper

This helper runs on the receiver machine. It exposes a local WebSocket for the
receiver browser and advertises a BLE GATT notify characteristic for the sender
browser.

## Install

For normal use, run a packaged helper executable built for the receiver
machine's operating system. The helper still listens only on localhost and
advertises the same BLE GATT service.

## Build a packaged helper

Build on the same platform you want to run on; PyInstaller does not
cross-compile.

macOS/Linux:

```bash
python3 -m venv .venv
./.venv/bin/python -m pip install --upgrade pip
./.venv/bin/python -m pip install -r helper/requirements-build.txt
./.venv/bin/python helper/build.py
```

Windows PowerShell:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r .\helper\requirements-build.txt
.\.venv\Scripts\python.exe .\helper\build.py
```

On Windows, `bless` depends on a GitHub-hosted SetupAPI wrapper. Install
Git for Windows first if pip reports that `git` is not available. Running the
helper may also require an Administrator PowerShell because the WinRT backend
can update the local Bluetooth adapter name.

If `helper/build.py` reports that `PyInstaller` is missing, install the build
requirements into the same virtual environment:

```powershell
.\.venv\Scripts\python.exe -m pip install -r .\helper\requirements-build.txt
```

## Run

Packaged helper:

```text
helper/dist/BeamMeUp-Helper
helper/dist/BeamMeUp-Helper.exe
```

Development mode:

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

When the HDMI-UVC receiver screen opens, the browser checks the localhost
helper automatically. If the helper is running, it connects and shows
`Helper connected`. If it is not running, it shows `Start BeamMeUp Helper`;
start the packaged helper and press `Retry helper`.

The receiver browser sends already-fragmented ARQ messages to the WebSocket.
The helper forwards each binary WebSocket message unchanged as one BLE
notification on service `0000fff0-0000-1000-8000-00805f9b34fb`,
characteristic `0000fff1-0000-1000-8000-00805f9b34fb`.

Chrome Web Bluetooth does not expose the negotiated MTU. Keep the browser-side
fragment MTU conservative until the Phase-0 spike confirms the largest reliable
notification size on the target rig.
