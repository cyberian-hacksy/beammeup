// HDMI-UVC transfer mode constants

export const HDMI_UVC_MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB

// Magic number for frame header: "BEAM" in ASCII
export const FRAME_MAGIC = 0x4245414D

// Frame layout constants
export const ANCHOR_SIZE = 32    // Anchor pattern: 32×32 pixels (8×8 grid of 4×4 blocks)
export const MARGIN_SIZE = 32    // Black margin on all sides
export const BLOCK_SIZE = 4      // Each data byte = 4×4 pixel block
export const HEADER_SIZE = 22    // Frame header: 22 bytes

// Anchor pattern as 8×8 block grid (1=white, 0=black)
// Concentric square: outer white border, black gap, white center
export const ANCHOR_PATTERN = [
  [1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1],
  [1,1,0,0,0,0,1,1],
  [1,1,0,1,1,0,1,1],
  [1,1,0,1,1,0,1,1],
  [1,1,0,0,0,0,1,1],
  [1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1],
]

// Encoding modes (kept for future extensibility, only COMPAT_4 used initially)
export const HDMI_MODE = {
  RAW_RGB: 0,
  RAW_GRAY: 1,
  COMPAT_4: 2,
  COMPAT_8: 3,
  COMPAT_16: 4
}

export const HDMI_MODE_NAMES = {
  [HDMI_MODE.RAW_RGB]: 'RGB',
  [HDMI_MODE.RAW_GRAY]: 'Gray',
  [HDMI_MODE.COMPAT_4]: '4x4',
  [HDMI_MODE.COMPAT_8]: '8x8',
  [HDMI_MODE.COMPAT_16]: '16x16'
}

// Frame rate presets
export const FPS_PRESETS = [
  { name: '30 fps', fps: 30, interval: 33 },
  { name: '60 fps', fps: 60, interval: 16 }
]
export const DEFAULT_FPS_PRESET = 0

// LocalStorage key for device persistence
export const DEVICE_STORAGE_KEY = 'hdmiUvcDevice'
