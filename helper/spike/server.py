import asyncio
import struct

from bless import BlessServer, GATTAttributePermissions, GATTCharacteristicProperties


SERVICE_UUID = "0000fff0-0000-1000-8000-00805f9b34fb"
CHARACTERISTIC_UUID = "0000fff1-0000-1000-8000-00805f9b34fb"
DEVICE_NAME = "BeamMeUp-ARQ"


async def main():
    server = BlessServer(name=DEVICE_NAME)

    await server.add_new_service(SERVICE_UUID)
    await server.add_new_characteristic(
        SERVICE_UUID,
        CHARACTERISTIC_UUID,
        GATTCharacteristicProperties.notify,
        None,
        GATTAttributePermissions.readable,
    )

    await server.start()
    print(f"Advertising {DEVICE_NAME} service={SERVICE_UUID} characteristic={CHARACTERISTIC_UUID}")

    counter = 0
    try:
        while True:
            payload = struct.pack(">I", counter)
            server.get_characteristic(CHARACTERISTIC_UUID).value = payload
            server.update_value(SERVICE_UUID, CHARACTERISTIC_UUID)
            print(f"notify counter={counter}")
            counter = (counter + 1) & 0xFFFFFFFF
            await asyncio.sleep(2)
    finally:
        await server.stop()


if __name__ == "__main__":
    asyncio.run(main())
