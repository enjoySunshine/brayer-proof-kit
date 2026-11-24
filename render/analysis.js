'use strict';

// Brightness analysis of the ground patch used for the acceptance check.
//
// The patch is a region of the image whose pixel-center rays hit the matte
// ground plane and which lies far away from the reflective sphere. The mask
// is computed from primary rays, not from per-pixel noise, so it is stable
// across repeated deliveries and exposure changes.

// Relative bounds of the candidate region: a flat strip near the top of the
// frame, i.e. far away on the ground.
const PATCH_BOUNDS = {
  x0: 0.2,
  x1: 0.8,
  y0: 0.08,
  y1: 0.16
};

function buildGroundMask (scene, camera, width, height) {
  const mask = new Uint8Array(width * height);
  const x0 = Math.floor(PATCH_BOUNDS.x0 * width);
  const x1 = Math.floor(PATCH_BOUNDS.x1 * width);
  const y0 = Math.floor(PATCH_BOUNDS.y0 * height);
  const y1 = Math.floor(PATCH_BOUNDS.y1 * height);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (scene.hitsGround(camera, x, y, width, height)) {
        mask[y * width + x] = 1;
      }
    }
  }
  return { mask, bounds: { x0, x1, y0, y1 } };
}

// Average Rec.709 luminance, plus the per-channel means, over masked pixels
// of an exposure-scaled linear RGB image.
function averagePatch (linearImage, mask, width, height) {
  let count = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (!mask[idx]) continue;
      const p = idx * 3;
      r += linearImage[p];
      g += linearImage[p + 1];
      b += linearImage[p + 2];
      count += 1;
    }
  }
  if (count === 0) {
    throw new Error('ground patch contains no pixels');
  }
  const meanR = r / count;
  const meanG = g / count;
  const meanB = b / count;
  return {
    count,
    meanR,
    meanG,
    meanB,
    luminance: 0.2126 * meanR + 0.7152 * meanG + 0.0722 * meanB
  };
}

module.exports = { buildGroundMask, averagePatch, PATCH_BOUNDS };
