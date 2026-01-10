// Protocol and configuration constants
export const PROTOCOL_VERSION = 0x01

// QR Mode constants
export const QR_MODE = {
  BW: 0,       // Standard black/white QR
  PCCC: 1,     // Color CMY with finder calibration
  PALETTE: 2   // Color RGB with HCC2D patch calibration
}

// Mode-specific margins (as ratio of canvas size)
export const MODE_MARGINS = {
  [QR_MODE.BW]: 0.02,      // ~2% quiet zone
  [QR_MODE.PCCC]: 0.025,   // ~2.5% margin
  [QR_MODE.PALETTE]: 0.15  // ~15% for scaled patches
}

// Palette mode patch configuration (as ratio of margin)
export const PATCH_SIZE_RATIO = 0.4  // Patch is 40% of margin width
export const PATCH_GAP_RATIO = 0.08  // Gap is 8% of margin width
export const BLOCK_SIZE = 200
export const MAX_FILE_SIZE = 20 * 1024 * 1024 // 20MB
export const METADATA_INTERVAL = 10
export const FOUNTAIN_DEGREE = 3
export const DEGREE_ONE_PROBABILITY = 0.15

// Raptor-Lite pre-coding constants
export const PARITY_LAYERS = 3 // Number of parity layers (consecutive, offset, strided)

// Data density presets (block size + ECC level)
export const DATA_PRESETS = [
  { name: 'Light', blockSize: 150, ecc: 'M' },
  { name: 'Normal', blockSize: 200, ecc: 'M' },
  { name: 'Dense', blockSize: 300, ecc: 'L' },
  { name: 'Max', blockSize: 400, ecc: 'L' }
]
export const DEFAULT_DATA_PRESET = 1

// Display size presets (QR container size in pixels)
export const SIZE_PRESETS = [
  { name: 'Small', size: 240 },
  { name: 'Medium', size: 320 },
  { name: 'Large', size: 400 }
]
export const DEFAULT_SIZE_PRESET = 1

// Speed presets (frame interval in ms)
export const SPEED_PRESETS = [
  { name: 'Slow', interval: 200 },
  { name: 'Normal', interval: 100 },
  { name: 'Fast', interval: 50 }
]
export const DEFAULT_SPEED_PRESET = 1
