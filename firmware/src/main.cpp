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

// --- macOS Keyboard Setup Assistant (KSA) auto-answer ---------------------
// macOS launches the KSA on every *fresh* pairing of a BLE HID keyboard and
// blocks until you press the key right of left-Shift (it can't be dismissed
// without a keystroke, and the dongle is headless). We answer it ourselves.
//
// Getting the trigger right is subtle (verified against real hardware
// 2026-07-18):
//   * "fresh pair" can't be detected by a getNumBonds() delta at
//     onAuthenticationComplete — the count isn't incremented synchronously
//     there. Instead we ARM on an explicit bond wipe or a boot with zero
//     bonds (both mean the next successful bond must be a first-time pair).
//   * macOS pairs then immediately drops and reconnects, so the answer must
//     survive a disconnect: we latch "answer owed" on the fresh bond and
//     (re)schedule the keystroke on each input-report subscribe until we
//     actually deliver it on a stable connection.
// Gated this way, a normal reconnect never injects a stray keystroke into the
// focused sender window. A manual receiver-side button (keyboard-receiver.js)
// covers the case where this single shot still mistimes. -DKSA_AUTOANSWER=0
// compiles it all out.
#ifndef KSA_AUTOANSWER
#define KSA_AUTOANSWER 1
#endif
// Key right of left-Shift on US ANSI = 'z' (usage 0x1D); pressing it tells
// the KSA the layout is ANSI.
#ifndef KSA_ANSI_USAGE
#define KSA_ANSI_USAGE 0x1D
#endif
// Delay from the input-report subscribe to the keystroke; gives the dialog
// time to be frontmost. Tune via build_flags if it mistimes.
#ifndef KSA_ANSWER_DELAY_MS
#define KSA_ANSWER_DELAY_MS 2500
#endif

#if KSA_AUTOANSWER
static volatile bool freshPairArmed = false;   // next bond will be a first-time pair
static volatile bool ksaAnswerOwed = false;    // fresh pair seen; answer not yet delivered (survives reconnects)
static volatile bool ksaAnswerPending = false; // answer timer armed for the current connection
static volatile uint32_t ksaAnswerAt = 0;
#endif

class DongleServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server) override {
    hostConnected = true;
    Serial.println("[ble] host connected");
  }

  void onDisconnect(NimBLEServer* server) override {
    hostConnected = false;
#if KSA_AUTOANSWER
    // Can't type while disconnected; cancel this connection's timer but keep
    // the "owed" latch so the next reconnect's subscribe reschedules it.
    ksaAnswerPending = false;
#endif
    Serial.println("[ble] host disconnected - advertising again");
    NimBLEDevice::startAdvertising();
  }

  // Bring-up diagnostics (design §10): pairing stalls are invisible from the
  // host side, so log how far SMP got.
  void onAuthenticationComplete(ble_gap_conn_desc* desc) override {
    Serial.printf("[ble] auth complete: encrypted=%d authenticated=%d bonded=%d\n",
                  desc->sec_state.encrypted, desc->sec_state.authenticated,
                  desc->sec_state.bonded);
#if KSA_AUTOANSWER
    // A bond completing while armed is a genuine first-time pair → latch that
    // we owe the KSA answer. Consume the arm so a later reconnect can't re-owe.
    if (freshPairArmed && desc->sec_state.bonded) {
      freshPairArmed = false;
      ksaAnswerOwed = true;
      Serial.println("[ble] fresh pair - KSA answer owed");
    }
#endif
  }
};

// Logs whether the host actually subscribed to the input report — the last
// step of HID bring-up; keystrokes only land after this fires.
class InputReportCallbacks : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic* characteristic,
                   ble_gap_conn_desc* desc, uint16_t subValue) override {
    Serial.printf("[ble] input report subscribe=%u\n", subValue);
#if KSA_AUTOANSWER
    // Subscribe = macOS has the keyboard fully up (and the KSA showing). If we
    // still owe an answer, (re)arm the timer against *this* connection; loop()
    // fires it once we've stayed connected long enough.
    if (subValue != 0 && ksaAnswerOwed) {
      ksaAnswerAt = millis() + KSA_ANSWER_DELAY_MS;
      ksaAnswerPending = true;
      Serial.println("[ble] scheduling KSA auto-answer");
    }
#endif
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

#if KSA_AUTOANSWER
  // Booting with no stored bonds means the next successful pairing must be a
  // first-time pair (nothing to reconnect to) → arm the KSA auto-answer.
  freshPairArmed = (NimBLEDevice::getNumBonds() == 0);
  Serial.printf("[ble] fresh-pair auto-answer armed=%d (bonds=%d)\n",
                (int)freshPairArmed, NimBLEDevice::getNumBonds());
#endif

  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new DongleServerCallbacks());

  hid = new NimBLEHIDDevice(server);
  hid->manufacturer()->setValue("BeamMeUp");
  hid->pnp(0x02, 0xE502, 0xA111, 0x0210);
  // Country code 33 (0x21) = US ANSI — the descriptor-correct value for this
  // keymap. NOTE: verified 2026-07-18 that this does NOT suppress the macOS
  // Keyboard Setup Assistant on BLE HID (macOS runs it on every fresh
  // pairing regardless of country code); kept anyway as it's the honest
  // layout and the app decodes event.code so it never affects key meaning.
  hid->hidInfo(0x21, 0x01);
  hid->reportMap((uint8_t*)REPORT_MAP, sizeof(REPORT_MAP));
  keyboardInput = hid->inputReport(1);
  keyboardInput->setCallbacks(new InputReportCallbacks());
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
#if KSA_AUTOANSWER
  // Signed compare handles millis() rollover. Fire once, only while still
  // connected (onDisconnect clears pending otherwise); clearing the owed latch
  // means later reconnects won't re-answer.
  if (ksaAnswerPending && hostConnected &&
      (int32_t)(millis() - ksaAnswerAt) >= 0) {
    ksaAnswerPending = false;
    ksaAnswerOwed = false;
    Serial.println("[ble] auto-answering Keyboard Setup Assistant");
    sendKey(KSA_ANSI_USAGE);
  }
#endif

  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c < 0) break;
    if (c == '!') { // debug escape, outside the base32 alphabet (design §10):
      NimBLEDevice::deleteAllBonds(); // recover from a stale half-pairing
#if KSA_AUTOANSWER
      // A wipe means the next pairing is fresh → arm the KSA auto-answer.
      freshPairArmed = true;
      ksaAnswerOwed = false;
      ksaAnswerPending = false;
#endif
      Serial.println("[ble] bonds cleared");
      continue;
    }
    const uint8_t usage = serialCharToUsage((char)c);
    if (usage == 0) continue; // outside the shared alphabet
    if (!hostConnected) continue; // drop: the receiver re-NACKs (design §8)
    sendKey(usage);
  }
  delay(1);
}
