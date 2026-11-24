'use strict';

// Deterministic, seedable random number generation.
//
// Every random number used by the path tracer is derived from a 32-bit key
// computed from the pixel coordinates and the sample index. Two consecutive
// deliveries of the same image therefore draw exactly the same sequence of
// random numbers and the noise pattern lands on the same pixels. The key does
// NOT include the exposure settings, so changing aperture or shutter restarts
// accumulation without re-scrambling the noise pattern.

function imul32 (a, b) {
  return Math.imul(a | 0, b | 0) | 0;
}

// splitmix32-style finalizer: well distributed avalanche mixing on 32 bits.
function mix32 (z) {
  z = (z + 0x9e3779b9) | 0;
  z = imul32(z ^ (z >>> 16), 0x85ebca6b);
  z = imul32(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

// Combine several integer inputs into one 32-bit key.
function hashKey (...parts) {
  let h = 0x2545f491;
  for (const part of parts) {
    h = imul32(h ^ mix32(part | 0), 0x9e3779b1);
  }
  return h >>> 0;
}

class Rng {
  constructor (key) {
    this.state = key | 0;
  }

  // PCG-XSH-RR style step, implemented with 32-bit integer math.
  nextU32 () {
    const old = this.state | 0;
    this.state = (imul32(old, 747796405) + 2891336453) | 0;
    const word = (((old >>> ((old >>> 28) + 4)) ^ old) * 277803737) | 0;
    return (word ^ (word >>> 22)) >>> 0;
  }

  // Uniform float in [0, 1).
  next () {
    return this.nextU32() / 4294967296;
  }

  // Uniform float in [min, max).
  range (min, max) {
    return min + (max - min) * this.next();
  }
}

// A random number stream for one pixel sample. `width` is part of the key so
// pixels with identical (x, y, s) in different resolutions do not share a
// stream; within one resolution the streams are perfectly reproducible.
function pixelRng (width, x, y, sampleIndex) {
  return new Rng(hashKey(width, x, y, sampleIndex));
}

module.exports = { Rng, pixelRng, hashKey, mix32 };
