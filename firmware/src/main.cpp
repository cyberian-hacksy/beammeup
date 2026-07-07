// BeamMeUp keyboard-dongle firmware (design doc 2026-07-06).
//
// The dongle sits on the RECEIVER's USB as a CDC serial device and pairs to
// the SENDER as a BLE HID keyboard (HID-over-GATT). The receiver browser
// writes base32 lines over Web Serial; each byte becomes one keystroke
// (press + release, modifier always 0), '\n' becomes Enter. Integrity and
// retries live entirely in the ARQ layer — this firmware is a dumb pipe.

#include <Arduino.h>
#include <NimBLEDevice.h>
#include <NimBLEHIDDevice.h>

#include "keymap.h"

static const char* DEVICE_NAME = "BeamMeUp-Kbd"; // ARQ_KEYBOARD_DEVICE_NAME

static NimBLEHIDDevice* hid = nullptr;
static NimBLECharacteristic* keyboardInput = nullptr;
static volatile bool hostConnected = false;

class DongleServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server) override {
    hostConnected = true;
    Serial.println("[ble] host connected");
  }

  void onDisconnect(NimBLEServer* server) override {
    hostConnected = false;
    Serial.println("[ble] host disconnected - advertising again");
    NimBLEDevice::startAdvertising();
  }
};

// Standard boot-style keyboard: 8-byte input report (modifier, reserved,
// 6 key slots), Report ID 1. Input-only — no LED output report needed.
static const uint8_t REPORT_MAP[] = {
  0x05, 0x01,  // Usage Page (Generic Desktop)
  0x09, 0x06,  // Usage (Keyboard)
  0xA1, 0x01,  // Collection (Application)
  0x85, 0x01,  //   Report ID (1)
  0x05, 0x07,  //   Usage Page (Keyboard/Keypad)
  0x19, 0xE0,  //   Usage Minimum (LeftControl)
  0x29, 0xE7,  //   Usage Maximum (Right GUI)
  0x15, 0x00,  //   Logical Minimum (0)
  0x25, 0x01,  //   Logical Maximum (1)
  0x75, 0x01,  //   Report Size (1)
  0x95, 0x08,  //   Report Count (8)
  0x81, 0x02,  //   Input (Data, Variable, Absolute) — modifier bits
  0x95, 0x01,  //   Report Count (1)
  0x75, 0x08,  //   Report Size (8)
  0x81, 0x01,  //   Input (Constant) — reserved byte
  0x95, 0x06,  //   Report Count (6)
  0x75, 0x08,  //   Report Size (8)
  0x15, 0x00,  //   Logical Minimum (0)
  0x25, 0x65,  //   Logical Maximum (101)
  0x05, 0x07,  //   Usage Page (Keyboard/Keypad)
  0x19, 0x00,  //   Usage Minimum (0)
  0x29, 0x65,  //   Usage Maximum (101)
  0x81, 0x00,  //   Input (Data, Array) — 6 key slots
  0xC0         // End Collection
};

static void sendKey(uint8_t usage) {
  // Modifier byte stays 0 always: the sender decodes event.code (physical
  // key), so no layout or Shift state can remap a symbol (design §2.4).
  uint8_t report[8] = {0};
  report[2] = usage;
  keyboardInput->setValue(report, sizeof(report));
  keyboardInput->notify();
  delay(KEY_DELAY_MS);
  report[2] = 0;
  keyboardInput->setValue(report, sizeof(report));
  keyboardInput->notify();
  delay(KEY_DELAY_MS);
}

void setup() {
  Serial.begin(115200); // baud is cosmetic on native USB CDC

  NimBLEDevice::init(DEVICE_NAME);
  // Just-Works pairing: bond, no MITM, secure connections, no IO caps.
  // If the sender OS insists on a passkey, see firmware/README.md for the
  // DISPLAY_ONLY fallback (design §9).
  NimBLEDevice::setSecurityAuth(true, false, true);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_NO_INPUT_OUTPUT);

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new DongleServerCallbacks());

  hid = new NimBLEHIDDevice(server);
  hid->manufacturer()->setValue("BeamMeUp");
  hid->pnp(0x02, 0xE502, 0xA111, 0x0210);
  hid->hidInfo(0x00, 0x01);
  hid->reportMap((uint8_t*)REPORT_MAP, sizeof(REPORT_MAP));
  keyboardInput = hid->inputReport(1);
  hid->startServices();
  hid->setBatteryLevel(100);

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->setAppearance(0x03C1); // HID keyboard
  advertising->addServiceUUID(hid->hidService()->getUUID());
  advertising->setScanResponse(true);
  advertising->start();

  Serial.println("BeamMeUp-Kbd ready: advertising as a BLE HID keyboard");
}

void loop() {
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c < 0) break;
    const uint8_t usage = serialCharToUsage((char)c);
    if (usage == 0) continue; // outside the shared alphabet
    if (!hostConnected) continue; // drop: the receiver re-NACKs (design §8)
    sendKey(usage);
  }
  delay(1);
}
