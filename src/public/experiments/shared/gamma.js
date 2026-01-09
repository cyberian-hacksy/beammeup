// src/public/experiments/shared/gamma.js

/**
 * sRGB gamma decode - converts gamma-encoded [0,255] to linear [0,1]
 * Camera firmware applies gamma for "pleasing" images, this reverses it
 */
export function gammaDecodeChannel(value) {
  const normalized = value / 255;
  if (normalized <= 0.04045) {
    return normalized / 12.92;
  }
  return Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/**
 * sRGB gamma encode - converts linear [0,1] to gamma-encoded [0,255]
 */
export function gammaEncodeChannel(linear) {
  if (linear <= 0.0031308) {
    return Math.round(linear * 12.92 * 255);
  }
  return Math.round((1.055 * Math.pow(linear, 1 / 2.4) - 0.055) * 255);
}

/**
 * Decode RGB from gamma space to linear space
 * @param {number} r - Red [0,255]
 * @param {number} g - Green [0,255]
 * @param {number} b - Blue [0,255]
 * @returns {[number, number, number]} Linear RGB [0,1]
 */
export function gammaDecode(r, g, b) {
  return [
    gammaDecodeChannel(r),
    gammaDecodeChannel(g),
    gammaDecodeChannel(b)
  ];
}

/**
 * Encode RGB from linear space to gamma space
 * @param {number} r - Red [0,1]
 * @param {number} g - Green [0,1]
 * @param {number} b - Blue [0,1]
 * @returns {[number, number, number]} Gamma RGB [0,255]
 */
export function gammaEncode(r, g, b) {
  return [
    gammaEncodeChannel(r),
    gammaEncodeChannel(g),
    gammaEncodeChannel(b)
  ];
}
