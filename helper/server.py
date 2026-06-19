import asyncio

import websockets
from bless import BlessServer, GATTAttributePermissions, GATTCharacteristicProperties


SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC_UUID = "0000fff1-0000-1000-8000-00805f9b34fb"
DEVICE_NAME = "BeamMeUp-ARQ"
WS_HOST = "127.0.0.1"
WS_PORT = 8787


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
            self.server.update_value(SERVICE_UUID, CHARACTERISTIC_UUID)
            self.notifications += 1
            print(f"notify bytes={len(payload)} count={self.notifications}")


async def main():
    bridge = ArqGattBridge()
    await bridge.start()

    async def handle_ws(websocket):
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
