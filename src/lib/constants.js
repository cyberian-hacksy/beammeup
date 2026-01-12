// Protocol and configuration constants
export const PROTOCOL_VERSION = 0x01

// QR Mode constants
export const QR_MODE = {
  BW: 0,       // Standard black/white QR
  PCCC: 1,     // Color CMY with finder calibration
  PALETTE: 2,  // Color RGB with HCC2D patch calibration
  SPATIAL: 3   // 3x B/W QR codes side-by-side
}

// Mode-specific margins as ratio of QR size
export const MODE_MARGIN_RATIOS = {
  [QR_MODE.BW]: 0.0125,      // ~1.25% quiet zone for BW (4px for 320px QR)
  [QR_MODE.PCCC]: 0.03,      // ~3% margin for CMY (10px for 320px QR)
  [QR_MODE.PALETTE]: 0.1875, // ~19% margin for patches (60px for 320px QR)
  [QR_MODE.SPATIAL]: 0.02    // ~2% margin between QRs for spatial mode
}

// Spatial mode configuration
export const SPATIAL_QR_COUNT = 3    // Number of QR codes side-by-side
export const SPATIAL_GAP_RATIO = 0.02 // Gap between QRs as ratio of canvas width

// Palette mode patch configuration as ratios of margin
// For 60px margin: patch=25px (42%), gap=5px (8%)
export const PATCH_SIZE_RATIO = 0.42   // Patch size as ratio of margin
export const PATCH_GAP_RATIO = 0.08    // Gap as ratio of margin
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
  { name: 'Small', size: 320 },
  { name: 'Medium', size: 420 },
  { name: 'Large', size: 520 }
]
export const DEFAULT_SIZE_PRESET = 2

// Speed presets (frame interval in ms)
export const SPEED_PRESETS = [
  { name: 'Slow', interval: 200 },
  { name: 'Normal', interval: 100 },
  { name: 'Fast', interval: 50 }
]
export const DEFAULT_SPEED_PRESET = 1
