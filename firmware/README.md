# BeamMeUp Keyboard Dongle (ESP32-S3)

Firmware for the "HID keyboard" ARQ back-channel transport (design doc
`docs/plans/2026-07-06-esp32-keyboard-dongle-design.md`). The dongle plugs
into the **receiver's** USB as a CDC serial device and pairs with the
**sender** as a BLE HID keyboard named `BeamMeUp-Kbd`. Bytes written to the
serial port become keystrokes; `\n` becomes Enter. The alphabet is mirrored
in `src/lib/arq/transports/keyboard-codec.js` — keep `include/keymap.h` in
sync with it.

Target board: **ESP32-S3-DevKitC-1 (N32R16V)**. The S3 is BLE-only (no
Bluetooth Classic), which is why this is a HID-over-GATT keyboard.

## Build & flash

Requires the [PlatformIO CLI](https://platformio.org/install/cli) (`pio`).

```bash
cd firmware
pio run                 # build
pio run -t upload       # flash via the port labeled "USB" (native USB)
pio device monitor      # watch the startup banner / connection logs
```

If the board will not enter the bootloader, hold **BOOT**, tap **RESET**,
release BOOT, then retry the upload.

## Bring-up checklist (design §10)

1. Flash; confirm the board enumerates as a USB CDC serial port and the
   monitor shows `BeamMeUp-Kbd ready: advertising as a BLE HID keyboard`.
2. On the **sender** machine, pair the Bluetooth device `BeamMeUp-Kbd`;
   confirm the OS lists it as a keyboard.
3. Focus a text editor on the sender, then from the **receiver** send a test
   line to the dongle's serial port, e.g.:
   ```bash
   printf 'abc012\n' > /dev/ttyACM0   # adjust the port name
   ```
   The characters `abc012` + newline should appear. A non-US layout may
   mangle the *characters* — that is expected and harmless: the app decodes
   `event.code` (physical keys), which layout cannot touch.
4. In the app: open the sender with `?arq-transport=keyboard` and keep the
   page focused; open the receiver with `?arq-transport=keyboard` and
   connect the dongle via the helper connect button (first time needs the
   click — Web Serial authorization; afterwards auto-connect reuses the
   port). Run a transfer and confirm the NACK/COMPLETE round-trip.
5. On a lossy run, confirm NACK lines stay short (§2.5 cap) and repair
   converges over successive beacons.

## Pairing fallback: passkey instead of Just-Works (design §9)

Whether Windows accepts Just-Works pairing for a keyboard is unverified
until real hardware. If pairing fails or demands a code, switch the firmware
to a displayed passkey — in `src/main.cpp` replace the security setup with:

```cpp
NimBLEDevice::setSecurityAuth(true, true, true);          // bond, MITM, sc
NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
NimBLEDevice::setSecurityPasskey(834271);                 // any 6 digits
Serial.println("BLE pairing passkey: 834271");
```

Enter the printed passkey on the sender when prompted, then update the
design doc with which mode the rig actually needed.

## Tuning

- `KEY_DELAY_MS` (default 6) paces press/release reports (~80 symbols/s).
  Lower it via `build_flags = -DKEY_DELAY_MS=4` in `platformio.ini` and
  re-run bring-up step 5; raise it if the sender OS drops keystrokes.
- Keystrokes are dropped while no BLE host is connected — that is by
  design; the ARQ layer re-NACKs (§8).

## Security note

Anything paired to this dongle types into the focused window of the sender.
Keep the sender page focused during transfers (§8), and unpair the dongle
from machines that no longer use it.
