'use strict';

const { clamp01 } = require('./math.js');

// Narkowicz ACES filmic approximation, the tone mapper currently configured
// on the renderer. The same code path produces the PNG deliverable and the
// display frames shown in the preview window.
function acesFilmic (x) {
  const a = 2.51;
  const b = 0.03;
  const c = 2.43;
  const d = 0.59;
  const e = 0.14;
  return clamp01((x * (a * x + b)) / (x * (c * x + d) + e));
}

function linearToSrgb (c) {
  c = clamp01(c);
  return c <= 0.0031308
    ? c * 12.92
    : 1.055 * c ** (1 / 2.4) - 0.055;
}

// Convert one linear, exposure-scaled color to a displayable sRGB value.
function toneMapColor (color, out = new Array(3)) {
  for (let i = 0; i < 3; i++) {
    out[i] = linearToSrgb(acesFilmic(color[i]));
  }
  return out;
}

// Convert a whole linear float buffer (RGB interleaved) to 8-bit sRGB bytes.
function toneMapBuffer (linearBuffer) {
  const bytes = new Uint8ClampedArray(linearBuffer.length);
  const color = [0, 0, 0];
  for (let i = 0; i < linearBuffer.length; i += 3) {
    color[0] = linearBuffer[i];
    color[1] = linearBuffer[i + 1];
    color[2] = linearBuffer[i + 2];
    toneMapColor(color, color);
    bytes[i] = color[0] * 255 + 0.5;
    bytes[i + 1] = color[1] * 255 + 0.5;
    bytes[i + 2] = color[2] * 255 + 0.5;
  }
  return bytes;
}

module.exports = { acesFilmic, linearToSrgb, toneMapColor, toneMapBuffer };
