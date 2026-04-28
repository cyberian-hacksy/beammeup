// HDMI-UVC transfer mode constants

export const HDMI_UVC_MAX_FILE_SIZE = 1024 * 1024 * 1024 // 1GB

// Magic number for frame header: alternating full bytes [255, 0, 255, 0]
// Full 8-block runs (all-white or all-black) survive MJPEG without isolated-bit smearing
export const FRAME_MAGIC = 0xFF00FF00

// Frame layout constants
// Payload cells remain 4x4 for COMPAT_4. Anchors/margins are trimmed from the
// original 32px layout, but 24px is the smallest robust size found so far.
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
  LUMA_2: 3,
  CODEBOOK_3: 5,
  GLYPH_5: 6,
  CIMBAR: 7
}

export const HDMI_MODE_NAMES = {
  [HDMI_MODE.RAW_RGB]: 'Color4',
  [HDMI_MODE.RAW_GRAY]: 'Gray2',
  [HDMI_MODE.COMPAT_4]: '4x4',
  [HDMI_MODE.LUMA_2]: 'Luma2',
  [HDMI_MODE.CODEBOOK_3]: 'Tile3',
  [HDMI_MODE.GLYPH_5]: 'Glyph5',
  [HDMI_MODE.CIMBAR]: 'CIMBAR'
}

export function getModeDataBlockSize(mode) {
  switch (mode) {
    case HDMI_MODE.RAW_RGB:
    case HDMI_MODE.RAW_GRAY:
    case HDMI_MODE.LUMA_2:
    case HDMI_MODE.CODEBOOK_3:
      return 4
    case HDMI_MODE.GLYPH_5:
      return 8
    case HDMI_MODE.COMPAT_4:
      return 4
    default:
      return null
  }
}

export function getModeBitsPerBlock(mode) {
  switch (mode) {
    case HDMI_MODE.RAW_RGB:
    case HDMI_MODE.RAW_GRAY:
    case HDMI_MODE.LUMA_2:
      return 2
    case HDMI_MODE.CODEBOOK_3:
      return 3
    case HDMI_MODE.GLYPH_5:
      return 5
    case HDMI_MODE.COMPAT_4:
      return 1
    default:
      return null
  }
}

// Header block size: the cell pitch used to encode the 22-byte frame header.
// Current modes match getModeDataBlockSize; BINARY_3 will keep this at 4 while
// shrinking only the payload cells.
export function getModeHeaderBlockSize(mode) {
  return getModeDataBlockSize(mode)
}

// Payload block size: the cell pitch used to encode file payload bits. Current
// modes match getModeDataBlockSize; BINARY_3 will return 3 here.
export function getModePayloadBlockSize(mode) {
  return getModeDataBlockSize(mode)
}

// Frame rate presets
export const FPS_PRESETS = [
  { name: '30 fps', fps: 30, interval: 33 },
  { name: '60 fps', fps: 60, interval: 16 }
]
export const DEFAULT_FPS_PRESET = 0

export const RENDER_SIZE_PRESETS = [
  { id: 'viewport', name: 'Viewport', width: 0, height: 0 },
  { id: '720p', name: '720p', width: 1280, height: 720 },
  { id: '1080p', name: '1080p', width: 1920, height: 1080 }
]
export const DEFAULT_RENDER_SIZE_PRESET = RENDER_SIZE_PRESETS[0].id

// LocalStorage key for device persistence
export const DEVICE_STORAGE_KEY = 'hdmiUvcDevice'
