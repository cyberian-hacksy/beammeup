// Tests for the shared color palette tables.
import {
  PALETTE_RGB,
  EXPECTED_RGB_BY_COLOR_INDEX,
  CMY_BY_COLOR_INDEX,
  COLOR_INDEX_TO_PALETTE_INDEX
} from './palette.js'

export function testPaletteOrderingsConsistent() {
  let pass = PALETTE_RGB.length === 8 &&
    EXPECTED_RGB_BY_COLOR_INDEX.length === 8 &&
    CMY_BY_COLOR_INDEX.length === 8 &&
    COLOR_INDEX_TO_PALETTE_INDEX.length === 8

  // The mapping must be a permutation.
  pass = pass && new Set(COLOR_INDEX_TO_PALETTE_INDEX).size === 8

  // Both index orders must name the same RGB per semantic color.
  for (let colorIndex = 0; colorIndex < 8 && pass; colorIndex++) {
    const viaMap = PALETTE_RGB[COLOR_INDEX_TO_PALETTE_INDEX[colorIndex]]
    const direct = EXPECTED_RGB_BY_COLOR_INDEX[colorIndex]
    pass = viaMap[0] === direct[0] && viaMap[1] === direct[1] && viaMap[2] === direct[2]
  }

  // PALETTE_RGB index encodes inverted RGB bits: bit2=R, bit1=G, bit0=B.
  for (let i = 0; i < 8 && pass; i++) {
    const r = (~i >> 2) & 1 ? 255 : 0
    const g = (~i >> 1) & 1 ? 255 : 0
    const b = (~i) & 1 ? 255 : 0
    pass = PALETTE_RGB[i][0] === r && PALETTE_RGB[i][1] === g && PALETTE_RGB[i][2] === b
  }

  console.log('Palette orderings consistency test:', pass ? 'PASS' : 'FAIL')
  return pass
}
