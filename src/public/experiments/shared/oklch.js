// src/public/experiments/shared/oklch.js

/**
 * Convert linear RGB to OKLab
 * Based on https://bottosson.github.io/posts/oklab/
 */
export function linearRgbToOklab(r, g, b) {
  // M1: Linear RGB to LMS
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  // Cube root nonlinearity (LMS to LMS')
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  // M2: LMS' to OKLab
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  ];
}

/**
 * Convert OKLab to OKLCH
 * @returns {[number, number, number]} [L, C, H] where L in [0,1], C >= 0, H in [0,360]
 */
export function oklabToOklch(L, a, b) {
  const C = Math.sqrt(a * a + b * b);
  let H = Math.atan2(b, a) * 180 / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

/**
 * Convert linear RGB [0,1] to OKLCH
 * @returns {[number, number, number]} [L, C, H]
 */
export function linearRgbToOklch(r, g, b) {
  const [L, a, b_] = linearRgbToOklab(r, g, b);
  return oklabToOklch(L, a, b_);
}

/**
 * Calculate Euclidean distance in OKLCH space
 * Weights can be adjusted to prioritize L, C, or H
 *
 * IMPORTANT: Hue is weighted by chroma to handle low-chroma colors properly.
 * For achromatic colors (black, white, grays), hue is undefined/unreliable,
 * so we reduce its contribution when either color has low chroma.
 */
export function oklchDistance(lch1, lch2, weights = [1, 1, 1]) {
  const [L1, C1, H1] = lch1;
  const [L2, C2, H2] = lch2;

  // Handle hue wrap-around (circular distance)
  let dH = Math.abs(H1 - H2);
  if (dH > 180) dH = 360 - dH;

  // Normalize hue difference to roughly same scale as L and C
  const dHNorm = dH / 180; // [0, 1]

  // Weight hue by minimum chroma of the two colors
  // This makes hue irrelevant for achromatic colors (C ≈ 0)
  // and gradually more important as both colors become saturated
  // Using min ensures that comparing any color to black/white ignores hue
  const chromaWeight = Math.min(C1, C2);
  // Scale chromaWeight: typical saturated OKLCH chroma is ~0.15-0.4
  // Normalize so that chromaWeight ≈ 1 for saturated colors
  const normalizedChromaWeight = Math.min(1, chromaWeight / 0.15);

  return Math.sqrt(
    weights[0] * (L1 - L2) ** 2 +
    weights[1] * (C1 - C2) ** 2 +
    weights[2] * (dHNorm * normalizedChromaWeight) ** 2
  );
}
