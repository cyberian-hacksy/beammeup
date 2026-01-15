// HDMI-UVC transfer mode constants

export const HDMI_UVC_MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB

// Magic number for frame header: "BEAM" in ASCII
export const FRAME_MAGIC = 0x4245414D

// Encoding modes
export const HDMI_MODE = {
  RAW_RGB: 0,      // 24 bits per pixel (3 bytes)
  RAW_GRAY: 1,     // 8 bits per pixel (1 byte)
  COMPAT_4: 2,     // 4x4 super-pixel per byte
  COMPAT_8: 3,     // 8x8 super-pixel per byte
  COMPAT_16: 4     // 16x16 super-pixel per byte
}

// Mode names for debug logging
export const HDMI_MODE_NAMES = {
  [HDMI_MODE.RAW_RGB]: 'RGB',
  [HDMI_MODE.RAW_GRAY]: 'Gray',
  [HDMI_MODE.COMPAT_4]: '4x4',
  [HDMI_MODE.COMPAT_8]: '8x8',
  [HDMI_MODE.COMPAT_16]: '16x16'
}

// Resolution presets
export const RESOLUTION_PRESETS = [
  { name: '1K', width: 1024, height: 768 },
  { name: '2K', width: 1920, height: 1080 },
  { name: '4K', width: 3840, height: 2160 }
]
export const DEFAULT_RESOLUTION_PRESET = 1 // 2K

// Frame rate presets
export const FPS_PRESETS = [
  { name: '30 fps', fps: 30, interval: 33 },
  { name: '60 fps', fps: 60, interval: 16 }
]
export const DEFAULT_FPS_PRESET = 0 // 30 fps

// Header structure (22 bytes in first 2 rows)
export const HEADER_SIZE = 22
// Header layout:
// Bytes 0-3:   Magic (0x4245414D)
// Byte 4:     Mode (HDMI_MODE enum)
// Bytes 5-6:  Width (uint16)
// Bytes 7-8:  Height (uint16)
// Byte 9:     FPS
// Bytes 10-13: Symbol ID (uint32)
// Bytes 14-17: Payload length (uint32)
// Bytes 18-21: Payload CRC32 (uint32)

// Super-pixel block sizes for compatible modes
export const BLOCK_SIZES = {
  [HDMI_MODE.COMPAT_4]: 4,
  [HDMI_MODE.COMPAT_8]: 8,
  [HDMI_MODE.COMPAT_16]: 16
}

// LocalStorage key for device persistence
export const DEVICE_STORAGE_KEY = 'hdmiUvcDevice'
