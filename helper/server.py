import asyncio

import websockets
from bless import BlessServer, GATTAttributePermissions, GATTCharacteristicProperties

try:
    from .origin_policy import OriginPolicy
    from .bt_hints import gatt_failure_hint
except ImportError:
    from origin_policy import OriginPolicy
    from bt_hints import gatt_failure_hint


SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC_UUID = "0000fff1-0000-1000-8000-00805f9b34fb"
DEVICE_NAME = "BeamMeUp-ARQ"
WS_HOST = "127.0.0.1"
WS_PORT = 8787

# One dropped notification kills the whole ARQ message (the reassembler needs
# every fragment), so pace to the BLE connection interval instead of flooding
# the peripheral's notification queue, and retry when the stack reports the
# queue full (update_value returning False).
NOTIFY_PACING_S = 0.01
NOTIFY_RETRY_DELAY_S = 0.05
NOTIFY_RETRY_LIMIT = 40
NOTIFY_LOG_INTERVAL = 100


class ArqGattBridge:
    def __init__(self):
        self.server = BlessServer(name=DEVICE_NAME)
        self.started = False
        self.notifications = 0
        self.notify_lock = asyncio.Lock()

    async def start(self):
        await self.server.add_new_service(SERVICE_UUID)
        await self.server.add_new_characteristic(
            SERVICE_UUID,
            CHARACTERISTIC_UUID,
            GATTCharacteristicProperties.notify,
            None,
            GATTAttributePermissions.readable,
        )
        await self.server.start()
        self.started = True
        print(f"Advertising {DEVICE_NAME} service={SERVICE_UUID} characteristic={CHARACTERISTIC_UUID}")

    async def stop(self):
        async with self.notify_lock:
            if self.started:
                await self.server.stop()
                self.started = False

    async def notify(self, payload):
        async with self.notify_lock:
            if not self.started:
                return
            characteristic = self.server.get_characteristic(CHARACTERISTIC_UUID)
            characteristic.value = bytes(payload)
            sent = self.server.update_value(SERVICE_UUID, CHARACTERISTIC_UUID)
            retries = 0
            while not sent and retries < NOTIFY_RETRY_LIMIT:
                retries += 1
                await asyncio.sleep(NOTIFY_RETRY_DELAY_S)
                if not self.started:
                    return
                sent = self.server.update_value(SERVICE_UUID, CHARACTERISTIC_UUID)
            self.notifications += 1
            if not sent:
                print(f"notify DROPPED bytes={len(payload)} after {retries} retries")
            elif self.notifications % NOTIFY_LOG_INTERVAL == 0:
                print(f"notify count={self.notifications}")
            await asyncio.sleep(NOTIFY_PACING_S)


async def probe_bluetooth():
    """Best-effort Windows probe of (has_adapter, peripheral_role, radio_state).

    Returns Nones wherever the answer is unknown (non-Windows, winrt missing,
    or the query itself failing) — never raises.
    """
    try:
        try:
            from winrt.windows.devices.bluetooth import BluetoothAdapter
        except ImportError:
            from bleak_winrt.windows.devices.bluetooth import BluetoothAdapter
    except ImportError:
        return None, None, None
    try:
        adapter = await BluetoothAdapter.get_default_async()
    except Exception:
        return None, None, None
    if adapter is None:
        return False, None, None
    role = None
    state = None
    try:
        role = bool(adapter.is_peripheral_role_supported)
    except Exception:
        pass
    try:
        state = int((await adapter.get_radio_async()).state)
    except Exception:
        pass
    return True, role, state


def _request_origin(websocket):
    request = getattr(websocket, "request", None)
    headers = getattr(request, "headers", None)
    if headers is None:
        headers = getattr(websocket, "request_headers", None)
    try:
        return headers.get("Origin") if headers is not None else None
    except AttributeError:
        return None


async def main():
    bridge = ArqGattBridge()
    policy = OriginPolicy()
    try:
        await bridge.start()
    except RuntimeError as err:
        # bless (PyPI) swallows the WinRT BluetoothError code, so decode the
        # situation ourselves instead of dying with a bare traceback.
        print(f"Failed to start the BLE GATT service: {err}")
        print(gatt_failure_hint(*await probe_bluetooth()))
        raise SystemExit(1)

    async def handle_ws(websocket):
        origin = _request_origin(websocket)
        if not await policy.allow(origin):
            print(f"rejecting WebSocket client from origin {origin}")
            await websocket.close(code=1008, reason="origin not allowed")
            return
        print("WebSocket client connected")
        try:
            async for message in websocket:
                if isinstance(message, str):
                    print("ignoring text WebSocket message")
                    continue
                await bridge.notify(message)
        finally:
            print("WebSocket client disconnected")

    async with websockets.serve(handle_ws, WS_HOST, WS_PORT):
        print(f"WebSocket bridge listening on ws://{WS_HOST}:{WS_PORT}")
        try:
            await asyncio.Future()
        finally:
            await bridge.stop()


if __name__ == "__main__":
    asyncio.run(main())
