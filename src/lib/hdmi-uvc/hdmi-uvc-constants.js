// HDMI-UVC transfer mode constants

export const HDMI_UVC_MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB

// Magic number for frame header: alternating full bytes [255, 0, 255, 0]
// Full 8-block runs (all-white or all-black) survive MJPEG without isolated-bit smearing
export const FRAME_MAGIC = 0xFF00FF00

// Frame layout constants
// Payload cells remain 4x4 for COMPAT_4. Only anchors/margins are reduced to
// reclaim frame area while preserving the same 8x8 concentric anchor pattern.
export const BLOCK_SIZE = 3      // Anchor block: 3×3 pixels
export const ANCHOR_SIZE = BLOCK_SIZE * 8 // Anchor pattern: 24×24 pixels (8×8 grid)
export const MARGIN_SIZE = ANCHOR_SIZE    // Black margin on all sides
export const DATA_BLOCK_SIZE = 8 // Legacy/default data block size for binary compatibility mode
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
  COMPAT_16: 4,
  CODEBOOK_3: 5,
  GLYPH_5: 6
}

export const HDMI_MODE_NAMES = {
  [HDMI_MODE.RAW_RGB]: 'RGB3',
  [HDMI_MODE.RAW_GRAY]: 'Gray2',
  [HDMI_MODE.COMPAT_4]: '4x4',
  [HDMI_MODE.COMPAT_8]: '8x8',
  [HDMI_MODE.COMPAT_16]: '16x16',
  [HDMI_MODE.CODEBOOK_3]: 'Tile3',
  [HDMI_MODE.GLYPH_5]: 'Glyph5'
}

export function getModeDataBlockSize(mode) {
  switch (mode) {
    case HDMI_MODE.RAW_RGB:
    case HDMI_MODE.RAW_GRAY:
    case HDMI_MODE.CODEBOOK_3:
      return 4
    case HDMI_MODE.GLYPH_5:
      return 8
    case HDMI_MODE.COMPAT_4:
      return 4
    case HDMI_MODE.COMPAT_8:
      return 8
    case HDMI_MODE.COMPAT_16:
      return 16
    default:
      return null
  }
}

export function getModeBitsPerBlock(mode) {
  switch (mode) {
    case HDMI_MODE.RAW_RGB:
      return 3
    case HDMI_MODE.CODEBOOK_3:
      return 3
    case HDMI_MODE.GLYPH_5:
      return 5
    case HDMI_MODE.RAW_GRAY:
      return 2
    case HDMI_MODE.COMPAT_4:
    case HDMI_MODE.COMPAT_8:
    case HDMI_MODE.COMPAT_16:
      return 1
    default:
      return null
  }
}

// Frame rate presets
export const FPS_PRESETS = [
  { name: '30 fps', fps: 30, interval: 33 },
  { name: '60 fps', fps: 60, interval: 16 }
]
export const DEFAULT_FPS_PRESET = 0

// LocalStorage key for device persistence
export const DEVICE_STORAGE_KEY = 'hdmiUvcDevice'
