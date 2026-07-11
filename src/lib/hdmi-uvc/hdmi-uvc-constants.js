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
  BINARY_3: 8,
  BINARY_2: 9,
  BINARY_1: 10,
  LUMA_1: 11
}

export const HDMI_MODE_NAMES = {
  [HDMI_MODE.RAW_RGB]: 'Color4',
  [HDMI_MODE.RAW_GRAY]: 'Gray2',
  [HDMI_MODE.COMPAT_4]: '4x4',
  [HDMI_MODE.LUMA_2]: 'Luma2',
  [HDMI_MODE.CODEBOOK_3]: 'Tile3',
  [HDMI_MODE.GLYPH_5]: 'Glyph5',
  [HDMI_MODE.BINARY_3]: '3x3',
  [HDMI_MODE.BINARY_2]: '2x2',
  [HDMI_MODE.BINARY_1]: '1x1',
  [HDMI_MODE.LUMA_1]: '1x1 Luma4'
}

export const DEFAULT_HDMI_MODE = HDMI_MODE.BINARY_1

// Per-mode profile table — the single place that knows each mode's derived
// properties. Adding a mode means adding one row here (plus its codec in
// hdmi-uvc-frame.js) instead of editing parallel switches.
//   dataBlockSize:    cell pitch in pixels (legacy/default)
//   bitsPerBlock:     payload bits carried per cell
//   headerBlockSize:  cell pitch used to encode the 22-byte frame header —
//                     dense modes keep the robust 4px pitch for the header
//                     while shrinking only the payload cells
//   payloadBlockSize: cell pitch used to encode file payload bits
//   denseBinary:      uses the dense-binary frame layout + locked readers
//   denseLuma1:       dense-binary layout with 4-level luma payload cells
//   binary1Defaults:  shares BINARY_1's batching/porch/schedule defaults
export const MODE_PROFILES = {
  [HDMI_MODE.RAW_RGB]:    { dataBlockSize: 4, bitsPerBlock: 2, headerBlockSize: 4, payloadBlockSize: 4, denseBinary: false, denseLuma1: false, binary1Defaults: false },
  [HDMI_MODE.RAW_GRAY]:   { dataBlockSize: 4, bitsPerBlock: 2, headerBlockSize: 4, payloadBlockSize: 4, denseBinary: false, denseLuma1: false, binary1Defaults: false },
  [HDMI_MODE.COMPAT_4]:   { dataBlockSize: 4, bitsPerBlock: 1, headerBlockSize: 4, payloadBlockSize: 4, denseBinary: false, denseLuma1: false, binary1Defaults: false },
  [HDMI_MODE.LUMA_2]:     { dataBlockSize: 4, bitsPerBlock: 2, headerBlockSize: 4, payloadBlockSize: 4, denseBinary: false, denseLuma1: false, binary1Defaults: false },
  [HDMI_MODE.CODEBOOK_3]: { dataBlockSize: 4, bitsPerBlock: 3, headerBlockSize: 4, payloadBlockSize: 4, denseBinary: false, denseLuma1: false, binary1Defaults: false },
  [HDMI_MODE.GLYPH_5]:    { dataBlockSize: 8, bitsPerBlock: 5, headerBlockSize: 8, payloadBlockSize: 8, denseBinary: false, denseLuma1: false, binary1Defaults: false },
  [HDMI_MODE.BINARY_3]:   { dataBlockSize: 3, bitsPerBlock: 1, headerBlockSize: 4, payloadBlockSize: 3, denseBinary: true,  denseLuma1: false, binary1Defaults: false },
  [HDMI_MODE.BINARY_2]:   { dataBlockSize: 2, bitsPerBlock: 1, headerBlockSize: 4, payloadBlockSize: 2, denseBinary: true,  denseLuma1: false, binary1Defaults: false },
  [HDMI_MODE.BINARY_1]:   { dataBlockSize: 1, bitsPerBlock: 1, headerBlockSize: 4, payloadBlockSize: 1, denseBinary: true,  denseLuma1: false, binary1Defaults: true },
  [HDMI_MODE.LUMA_1]:     { dataBlockSize: 1, bitsPerBlock: 2, headerBlockSize: 4, payloadBlockSize: 1, denseBinary: true,  denseLuma1: true,  binary1Defaults: true }
}

export function getModeProfile(mode) {
  return MODE_PROFILES[mode] || null
}

export function getModeDataBlockSize(mode) {
  return MODE_PROFILES[mode]?.dataBlockSize ?? null
}

export function getModeBitsPerBlock(mode) {
  return MODE_PROFILES[mode]?.bitsPerBlock ?? null
}

export function getModeHeaderBlockSize(mode) {
  return MODE_PROFILES[mode]?.headerBlockSize ?? null
}

export function getModePayloadBlockSize(mode) {
  return MODE_PROFILES[mode]?.payloadBlockSize ?? null
}

export function isDenseBinaryMode(mode) {
  return MODE_PROFILES[mode]?.denseBinary ?? false
}

export function isDenseLuma1Mode(mode) {
  return MODE_PROFILES[mode]?.denseLuma1 ?? false
}

export function usesBinary1DenseDefaults(mode) {
  return MODE_PROFILES[mode]?.binary1Defaults ?? false
}

// Frame rate presets
export const FPS_PRESETS = [
  { name: '20 fps', fps: 20, interval: 50 },
  { name: '25 fps', fps: 25, interval: 40 },
  { name: '30 fps', fps: 30, interval: 33 },
  { name: '55 fps', fps: 55, interval: 18 },
  { name: '58 fps', fps: 58, interval: 17 },
  { name: '60 fps', fps: 60, interval: 16 }
]
export const DEFAULT_FPS_PRESET = 5

export const RENDER_SIZE_PRESETS = [
  { id: 'viewport', name: 'Viewport', width: 0, height: 0 },
  { id: '720p', name: '720p', width: 1280, height: 720 },
  { id: '1080p', name: '1080p', width: 1920, height: 1080 }
]
export const DEFAULT_RENDER_SIZE_PRESET = '1080p'

// LocalStorage key for device persistence
export const DEVICE_STORAGE_KEY = 'hdmiUvcDevice'
