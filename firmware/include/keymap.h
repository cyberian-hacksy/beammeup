#pragma once

#include <stdint.h>

// Serial char -> HID usage code. Mirrors the alphabet table in
// src/lib/arq/transports/keyboard-codec.js byte-for-byte — keep in sync.
//
//   'a'..'z' -> 0x04..0x1D
//   '0'      -> 0x27
//   '1'..'5' -> 0x1E..0x22
//   '\n'     -> 0x28 (Enter, the line delimiter)
//
// Everything else returns 0 and is dropped by the caller: the wire alphabet
// is exactly 32 base32 symbols plus Enter.
inline uint8_t serialCharToUsage(char c) {
  if (c >= 'a' && c <= 'z') return 0x04 + (c - 'a');
  if (c == '0') return 0x27;
  if (c >= '1' && c <= '5') return 0x1E + (c - '1');
  if (c == '\n') return 0x28;
  return 0;
}

// Pacing between HID reports. ~6 ms per press/release edge keeps the
// sustained rate near 80 symbols/s — ample for capped ARQ NACK lines
// (design §2.5/§9). Tune via build_flags once real hardware exists.
#ifndef KEY_DELAY_MS
#define KEY_DELAY_MS 6
#endif
