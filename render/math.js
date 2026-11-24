'use strict';

// Small, allocation-light 3D vector and sampling helpers. Vectors are plain
// [x, y, z] arrays; hot-path scratch vectors live in the tracer instead of
// being allocated per ray.

const v3 = {
  add (a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  },
  sub (a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  },
  scale (a, s) {
    return [a[0] * s, a[1] * s, a[2] * s];
  },
  mul (a, b) {
    return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
  },
  dot (a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  },
  cross (a, b) {
    return [
      a[1] * b[2] - a[2] * b[1],
      a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]
    ];
  },
  length (a) {
    return Math.hypot(a[0], a[1], a[2]);
  },
  normalize (a) {
    const len = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / len, a[1] / len, a[2] / len];
  },
  reflect (d, n) {
    const k = 2 * v3.dot(d, n);
    return [d[0] - k * n[0], d[1] - k * n[1], d[2] - k * n[2]];
  },
  copy (a) {
    return [a[0], a[1], a[2]];
  }
};

function clamp (x, min, max) {
  return Math.min(max, Math.max(min, x));
}

function clamp01 (x) {
  return clamp(x, 0, 1);
}

// Build an orthonormal basis around unit vector n: t, b, n.
function basis (n) {
  const helper = Math.abs(n[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const t = v3.normalize(v3.cross(helper, n));
  const b = v3.cross(n, t);
  return [t, b];
}

// Uniform sample inside a unit disk (for the thin-lens aperture).
function sampleDisk (rng) {
  const r = Math.sqrt(rng.next());
  const theta = 2 * Math.PI * rng.next();
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

// Sample a GGX microfacet normal around n in local shading space.
function sampleGGX (n, roughness, rng) {
  const a = roughness * roughness;
  const r1 = rng.next();
  const r2 = rng.next();
  const phi = 2 * Math.PI * r1;
  const cosTheta = Math.sqrt((1 - r2) / (1 + (a * a - 1) * r2));
  const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
  const [t, b] = basis(n);
  return v3.normalize([
    t[0] * (Math.cos(phi) * sinTheta) +
      b[0] * (Math.sin(phi) * sinTheta) +
      n[0] * cosTheta,
    t[1] * (Math.cos(phi) * sinTheta) +
      b[1] * (Math.sin(phi) * sinTheta) +
      n[1] * cosTheta,
    t[2] * (Math.cos(phi) * sinTheta) +
      b[2] * (Math.sin(phi) * sinTheta) +
      n[2] * cosTheta
  ]);
}

module.exports = {
  v3,
  clamp,
  clamp01,
  sampleDisk,
  sampleGGX
};
