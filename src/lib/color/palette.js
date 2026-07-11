// Canonical 8-color palette shared by the color-QR sender and classifiers.
//
// The same eight colors (white, black, and the six RGB/CMY primaries) appear
// in two different index orders, which previously lived as independently
// hardcoded tables that could drift:
//
//  - PALETTE_RGB: Palette-mode symbol order. Index encodes inverted RGB bits
//    (bit2=R, bit1=G, bit0=B), so index 0 = white and 7 = black. This is the
//    on-screen encoding order used by the sender (and formerly the receiver's
//    legacy classifier).
//
//  - EXPECTED_RGB_BY_COLOR_INDEX: classifier color-index order
//    (White, Cyan, Magenta, Yellow, Blue, Green, Red, Black) — singles first,
//    then CMY pairs, then black. Used by the Lab classifier.
//
// COLOR_INDEX_TO_PALETTE_INDEX maps between them; a suite test asserts the
// two views agree color-for-color.

export const PALETTE_RGB = [
  [255, 255, 255], // 0: White (000)
  [255, 255, 0],   // 1: Yellow (001)
  [255, 0, 255],   // 2: Magenta (010)
  [255, 0, 0],     // 3: Red (011)
  [0, 255, 255],   // 4: Cyan (100)
  [0, 255, 0],     // 5: Green (101)
  [0, 0, 255],     // 6: Blue (110)
  [0, 0, 0]        // 7: Black (111)
]

// CMY ink pattern per classifier color index: [cyan, magenta, yellow].
// Cyan ink removes R, magenta removes G, yellow removes B.
export const CMY_BY_COLOR_INDEX = [
  [0, 0, 0], // 0: White
  [1, 0, 0], // 1: Cyan
  [0, 1, 0], // 2: Magenta
  [0, 0, 1], // 3: Yellow
  [1, 1, 0], // 4: Blue (C+M)
  [1, 0, 1], // 5: Green (C+Y)
  [0, 1, 1], // 6: Red (M+Y)
  [1, 1, 1]  // 7: Black (C+M+Y)
]

export const EXPECTED_RGB_BY_COLOR_INDEX = CMY_BY_COLOR_INDEX.map(
  ([c, m, y]) => [c ? 0 : 255, m ? 0 : 255, y ? 0 : 255]
)

// colorIndex → PALETTE_RGB index for the same color.
export const COLOR_INDEX_TO_PALETTE_INDEX = [0, 4, 2, 1, 6, 5, 3, 7]
