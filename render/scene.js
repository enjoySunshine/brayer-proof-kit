'use strict';

const { v3 } = require('./math.js');

const EPS = 1e-4;
const MAX_T = 1e6;

// Procedurally placed studio scene: a matte ground plane and one reflective
// metal sphere. Nothing is loaded from the network.
class Scene {
  constructor () {
    this.groundY = 0;
    this.groundAlbedo = [0.72, 0.72, 0.7];

    this.sphereCenter = [0, 0.5, 0];
    this.sphereRadius = 0.5;
    this.sphereF0 = [0.95, 0.94, 0.9];
    this.sphereRoughness = 0.15;

    // Directional sun: the vector points from the surface toward the light.
    this.sunDir = v3.normalize([-0.45, 0.8, -0.35]);
    this.sunColor = [1.0, 0.96, 0.88];
    this.sunIrradiance = 2.1;
    // Small angular radius of the sun disk, in radians.
    this.sunRadius = 0.035;

    this.ambientIrradiance = 0.18;
    this.skyZenith = [0.18, 0.32, 0.55];
    this.skyHorizon = [0.78, 0.8, 0.82];

    // Multiplier for the metal's mirror reflection of the environment.
    this.envReflectionGain = 1.6;
  }

  // Intersect a ray with the ground plane. Returns t or Infinity.
  intersectGround (origin, dir) {
    if (Math.abs(dir[1]) < 1e-9) return Infinity;
    const t = (this.groundY - origin[1]) / dir[1];
    return t > EPS ? t : Infinity;
  }

  intersectSphere (origin, dir) {
    const oc = v3.sub(origin, this.sphereCenter);
    const b = v3.dot(oc, dir);
    const c = v3.dot(oc, oc) - this.sphereRadius * this.sphereRadius;
    const disc = b * b - c;
    if (disc < 0) return Infinity;
    const root = Math.sqrt(disc);
    const t1 = -b - root;
    if (t1 > EPS) return t1;
    const t2 = -b + root;
    return t2 > EPS ? t2 : Infinity;
  }

  intersect (origin, dir) {
    const tGround = this.intersectGround(origin, dir);
    const tSphere = this.intersectSphere(origin, dir);
    if (tSphere < tGround) {
      const point = v3.add(origin, v3.scale(dir, tSphere));
      const normal = v3.normalize(v3.sub(point, this.sphereCenter));
      return { t: tSphere, material: 'metal', point, normal };
    }
    if (tGround < Infinity) {
      const point = v3.add(origin, v3.scale(dir, tGround));
      return {
        t: tGround,
        material: 'ground',
        point,
        normal: [0, 1, 0]
      };
    }
    return null;
  }

  // Whether anything blocks the ray segment between origin and a surface at
  // distance tMax along dir.
  occluded (origin, dir, tMax) {
    const tGround = this.intersectGround(origin, dir);
    if (tGround < tMax) return true;
    const tSphere = this.intersectSphere(origin, dir);
    return tSphere < tMax;
  }

  // Sky radiance seen along a ray that escapes the scene.
  environment (dir) {
    const t = (dir[1] + 1) / 2;
    const sky = [
      this.skyHorizon[0] + (this.skyZenith[0] - this.skyHorizon[0]) * t,
      this.skyHorizon[1] + (this.skyZenith[1] - this.skyHorizon[1]) * t,
      this.skyHorizon[2] + (this.skyZenith[2] - this.skyHorizon[2]) * t
    ];
    // Crisp sun disk for rays that look directly at the sun.
    const sunDot = v3.dot(dir, this.sunDir);
    const cosLimit = Math.cos(this.sunRadius);
    if (sunDot > cosLimit) {
      const edge = clamp01((sunDot - cosLimit) / (1 - cosLimit));
      const strength = this.sunIrradiance * (0.6 + 0.4 * edge);
      return v3.mul(this.sunColor, [strength, strength, strength]);
    }
    return sky;
  }

  // Direct sun contribution for a shading point with outward normal n.
  sampleSun (point, normal) {
    const origin = v3.add(point, v3.scale(normal, EPS));
    const nDotL = v3.dot(normal, this.sunDir);
    if (nDotL <= 0) return [0, 0, 0];
    if (this.occluded(origin, this.sunDir, MAX_T)) return [0, 0, 0];
    const e = this.sunIrradiance * nDotL;
    return v3.mul(this.sunColor, [e, e, e]);
  }

  ambient (normal) {
    // Cheap hemispheric ambient term, scaled by the normal's elevation.
    const up = (normal[1] + 1) / 2;
    const sky = [
      this.skyHorizon[0] + (this.skyZenith[0] - this.skyHorizon[0]) * up,
      this.skyHorizon[1] + (this.skyZenith[1] - this.skyHorizon[1]) * up,
      this.skyHorizon[2] + (this.skyZenith[2] - this.skyHorizon[2]) * up
    ];
    return v3.scale(sky, this.ambientIrradiance);
  }

  // True when the pixel-center ray lands on the ground plane. Used to pick
  // the brightness comparison patch far away from the sphere.
  hitsGround (camera, x, y, width, height) {
    const ray = camera.centerRay(x, y, width, height);
    const hit = this.intersect(ray.origin, ray.dir);
    return Boolean(hit) && hit.material === 'ground';
  }
}

function clamp01 (x) {
  return Math.min(1, Math.max(0, x));
}

module.exports = { Scene, EPS, MAX_T };
