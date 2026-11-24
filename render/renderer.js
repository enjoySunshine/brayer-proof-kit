'use strict';

const { pixelRng } = require('./rng.js');
const { clamp, clamp01, sampleGGX } = require('./math.js');

const EPS = 1e-4;
const MAX_T = 1e6;
const DEFAULT_SETTINGS = {
  maxBounces: 4,
  highlightClamp: 8
};

// One path tracer instance owns one image buffer at one resolution. The
// preview window and the offscreen delivery each create an instance with the
// same scene, camera and settings, so both run exactly the same ray tracing
// code with the same bounce count and highlight clamp.
//
// The accumulator stores exposure-scaled linear radiance (no tone mapping).
// Every random draw derives from (width, x, y, sampleIndex), which makes a
// repeated delivery reproduce the identical noise pattern.
class PathTracer {
  constructor ({
    width,
    height,
    camera,
    scene,
    maxBounces = DEFAULT_SETTINGS.maxBounces,
    highlightClamp = DEFAULT_SETTINGS.highlightClamp
  }) {
    if (!(width > 0) || !(height > 0)) {
      throw new RangeError('width and height must be positive');
    }
    this.width = width;
    this.height = height;
    this.camera = camera;
    this.scene = scene;
    this.maxBounces = maxBounces;
    this.highlightClamp = highlightClamp;

    this.accumulator = new Float32Array(width * height * 3);
    this.samples = 0;

    // Reused per-pixel scratch space; the hot loop never allocates.
    this.scratch = new Float32Array(32);

    // Any aperture or shutter change invalidates every accumulated sample,
    // both for the window and for an offscreen delivery.
    this._unsubscribe = camera.onChange(() => this.reset());
  }

  reset () {
    this.accumulator.fill(0);
    this.samples = 0;
  }

  get samplesPerPixel () {
    return this.samples;
  }

  get progress () {
    return this.samples;
  }

  // Average one additional sample per pixel over the whole image.
  renderSample () {
    const { width, height, accumulator, camera, scene, scratch } = this;
    // Read the instance field directly: a destructured local number would be
    // a stale copy and every renderSample call would reuse sample index 0.
    const sampleIndex = this.samples;
    const exposure = camera.exposure;
    const clampMax = this.highlightClamp;
    const maxBounces = this.maxBounces;

    const fwdX = camera.forward[0];
    const fwdY = camera.forward[1];
    const fwdZ = camera.forward[2];
    const rightX = camera.right[0];
    const rightY = camera.right[1];
    const rightZ = camera.right[2];
    const upX = camera.cameraUp[0];
    const upY = camera.cameraUp[1];
    const upZ = camera.cameraUp[2];
    const eyeX = camera.eye[0];
    const eyeY = camera.eye[1];
    const eyeZ = camera.eye[2];
    const focusDistance = camera.focusDistance;
    const halfW = camera.halfWidth;
    const halfH = camera.halfHeight;
    const lensRadius = camera.lensRadius;

    const sphereCx = scene.sphereCenter[0];
    const sphereCy = scene.sphereCenter[1];
    const sphereCz = scene.sphereCenter[2];
    const sphereR = scene.sphereRadius;
    const groundY = scene.groundY;
    const groundAlbedo = scene.groundAlbedo;
    const f0 = scene.sphereF0;
    const roughness = scene.sphereRoughness;
    const a2 = roughness ** 4;
    const k = (roughness * roughness) / 2;
    const sunX = scene.sunDir[0];
    const sunY = scene.sunDir[1];
    const sunZ = scene.sunDir[2];
    const sunIrr = scene.sunIrradiance;
    const sunColor = scene.sunColor;
    const ambientIrr = scene.ambientIrradiance;
    const envGain = scene.envReflectionGain;
    const skyHorizon = scene.skyHorizon;
    const skyZenith = scene.skyZenith;
    const invPi = 1 / Math.PI;

    let pixel = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rng = pixelRng(width, x, y, sampleIndex);

        // --- Thin-lens camera ray, inlined -------------------------------
        const jx = rng.next();
        const jy = rng.next();
        const ndcX = (2 * (x + jx)) / width - 1;
        const ndcY = 1 - (2 * (y + jy)) / height;
        let dx = fwdX + rightX * ndcX * halfW + upX * ndcY * halfH;
        let dy = fwdY + rightY * ndcX * halfW + upY * ndcY * halfH;
        let dz = fwdZ + rightZ * ndcX * halfW + upZ * ndcY * halfH;
        let dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl;
        dy /= dl;
        dz /= dl;

        // Focal point of the pinhole ray.
        const fx = eyeX + dx * focusDistance;
        const fy = eyeY + dy * focusDistance;
        const fz = eyeZ + dz * focusDistance;

        const diskR = Math.sqrt(rng.next());
        const diskTheta = 2 * Math.PI * rng.next();
        const lx = diskR * Math.cos(diskTheta) * lensRadius;
        const ly = diskR * Math.sin(diskTheta) * lensRadius;
        let ox = eyeX + rightX * lx + upX * ly;
        let oy = eyeY + rightY * lx + upY * ly;
        let oz = eyeZ + rightZ * lx + upZ * ly;
        dx = fx - ox;
        dy = fy - oy;
        dz = fz - oz;
        dl = Math.hypot(dx, dy, dz) || 1;
        dx /= dl;
        dy /= dl;
        dz /= dl;

        // --- Path tracing state ------------------------------------------
        let tpX = 1;
        let tpY = 1;
        let tpZ = 1;
        let radR = 0;
        let radG = 0;
        let radB = 0;
        let alive = 1;

        for (let bounce = 0; bounce <= maxBounces && alive; bounce++) {
          // --- Intersect ground ------------------------------------------
          let tGround = Infinity;
          if (Math.abs(dy) >= 1e-9) {
            const t = (groundY - oy) / dy;
            if (t > EPS) tGround = t;
          }
          // --- Intersect sphere ------------------------------------------
          const ocx = ox - sphereCx;
          const ocy = oy - sphereCy;
          const ocz = oz - sphereCz;
          const b = ocx * dx + ocy * dy + ocz * dz;
          const c =
            ocx * ocx + ocy * ocy + ocz * ocz - sphereR * sphereR;
          const disc = b * b - c;
          let tSphere = Infinity;
          if (disc >= 0) {
            const root = Math.sqrt(disc);
            const t1 = -b - root;
            if (t1 > EPS) tSphere = t1;
            else {
              const t2 = -b + root;
              if (t2 > EPS) tSphere = t2;
            }
          }

          let nX;
          let nY;
          let nZ;
          let material;
          let hitT;
          if (tSphere < tGround) {
            material = 1; // metal
            hitT = tSphere;
            nX = ox + dx * hitT - sphereCx;
            nY = oy + dy * hitT - sphereCy;
            nZ = oz + dz * hitT - sphereCz;
            const nl = Math.hypot(nX, nY, nZ) || 1;
            nX /= nl;
            nY /= nl;
            nZ /= nl;
          } else if (tGround < Infinity) {
            material = 0; // ground
            hitT = tGround;
            nX = 0;
            nY = 1;
            nZ = 0;
          } else {
            // Environment: hemispheric gradient plus sun disk.
            const tt = (dy + 1) / 2;
            let er = skyHorizon[0] + (skyZenith[0] - skyHorizon[0]) * tt;
            let eg = skyHorizon[1] + (skyZenith[1] - skyHorizon[1]) * tt;
            let eb = skyHorizon[2] + (skyZenith[2] - skyHorizon[2]) * tt;
            const sunDot = dx * sunX + dy * sunY + dz * sunZ;
            const cosLimit = Math.cos(scene.sunRadius);
            if (sunDot > cosLimit) {
              const edge = clamp01(
                (sunDot - cosLimit) / (1 - cosLimit)
              );
              const strength = sunIrr * (0.6 + 0.4 * edge);
              er = sunColor[0] * strength;
              eg = sunColor[1] * strength;
              eb = sunColor[2] * strength;
            }
            radR += tpX * er;
            radG += tpY * eg;
            radB += tpZ * eb;
            break;
          }

          const px = ox + dx * hitT;
          const py = oy + dy * hitT;
          const pz = oz + dz * hitT;
          const sox = px + nX * EPS;
          const soy = py + nY * EPS;
          const soz = pz + nZ * EPS;

          // --- Shadow ray toward the sun ---------------------------------
          const nDotL = nX * sunX + nY * sunY + nZ * sunZ;
          let shadowed = 0;
          if (nDotL > 0) {
            if (Math.abs(sunY) >= 1e-9) {
              const tg = (groundY - soy) / sunY;
              // Tolerance: a tg near zero is the ground intersecting its own
              // shadow ray, not a real occluder.
              if (tg > 1e-3 && tg < MAX_T) shadowed = 1;
            }
            if (!shadowed) {
              const qx = sox - sphereCx;
              const qy = soy - sphereCy;
              const qz = soz - sphereCz;
              const bs = qx * sunX + qy * sunY + qz * sunZ;
              const cs =
                qx * qx + qy * qy + qz * qz - sphereR * sphereR;
              if (bs * bs - cs >= 0) {
                const root = Math.sqrt(bs * bs - cs);
                const t1 = -bs - root;
                if (t1 > EPS && t1 < MAX_T) shadowed = 1;
                else {
                  const t2 = -bs + root;
                  if (t2 > EPS && t2 < MAX_T) shadowed = 1;
                }
              }
            }
          }

          // --- Direct lighting -------------------------------------------
          if (material === 0) {
            // Lambertian ground.
            let irrR = ambientIrr *
              (skyHorizon[0] + (skyZenith[0] - skyHorizon[0]) * ((nY + 1) / 2));
            let irrG = ambientIrr *
              (skyHorizon[1] + (skyZenith[1] - skyHorizon[1]) * ((nY + 1) / 2));
            let irrB = ambientIrr *
              (skyHorizon[2] + (skyZenith[2] - skyHorizon[2]) * ((nY + 1) / 2));
            if (nDotL > 0 && !shadowed) {
              const e = sunIrr * nDotL;
              irrR += sunColor[0] * e;
              irrG += sunColor[1] * e;
              irrB += sunColor[2] * e;
            }
            radR += tpX * irrR * groundAlbedo[0] * invPi;
            radG += tpY * irrG * groundAlbedo[1] * invPi;
            radB += tpZ * irrB * groundAlbedo[2] * invPi;
          } else {
            // Cook-Torrance metal.
            const vx = -dx;
            const vy = -dy;
            const vz = -dz;
            const nDotV = Math.max(1e-4, nX * vx + nY * vy + nZ * vz);
            if (nDotL > 0 && !shadowed) {
              let hx = vx + sunX;
              let hy = vy + sunY;
              let hz = vz + sunZ;
              const hl = Math.hypot(hx, hy, hz) || 1;
              hx /= hl;
              hy /= hl;
              hz /= hl;
              const nDotH = clamp01(nX * hx + nY * hy + nZ * hz);
              const vDotH = clamp01(vx * hx + vy * hy + vz * hz);
              const d =
                a2 /
                (Math.PI *
                  (nDotH * nDotH * (a2 - 1) + 1) ** 2);
              const gv = nDotV / (nDotV * (1 - k) + k);
              const gl = nDotL / (nDotL * (1 - k) + k);
              const g = gv * gl;
              const fTerm = (1 - vDotH) ** 5;
              const denom = Math.max(1e-8, 4 * nDotV * nDotL);
              const e = sunIrr * nDotL;
              radR +=
                (tpX *
                  (f0[0] + (1 - f0[0]) * fTerm) *
                  d *
                  g *
                  sunColor[0] *
                  e) /
                denom;
              radG +=
                (tpY *
                  (f0[1] + (1 - f0[1]) * fTerm) *
                  d *
                  g *
                  sunColor[1] *
                  e) /
                denom;
              radB +=
                (tpZ *
                  (f0[2] + (1 - f0[2]) * fTerm) *
                  d *
                  g *
                  sunColor[2] *
                  e) /
                denom;
            }
            // Fresnel-tinted ambient sky reflection.
            const fTerm = (1 - nDotV) ** 5;
            const up = (nY + 1) / 2;
            const skyR =
              skyHorizon[0] + (skyZenith[0] - skyHorizon[0]) * up;
            const skyG =
              skyHorizon[1] + (skyZenith[1] - skyHorizon[1]) * up;
            const skyB =
              skyHorizon[2] + (skyZenith[2] - skyHorizon[2]) * up;
            radR += tpX * (f0[0] + (1 - f0[0]) * fTerm) * skyR * ambientIrr * envGain;
            radG += tpY * (f0[1] + (1 - f0[1]) * fTerm) * skyG * ambientIrr * envGain;
            radB += tpZ * (f0[2] + (1 - f0[2]) * fTerm) * skyB * ambientIrr * envGain;
          }

          if (bounce === maxBounces) break;

          // --- Sample next bounce ----------------------------------------
          if (material === 0) {
            // Cosine-weighted hemisphere sample around the ground normal.
            const r1 = rng.next();
            const r2 = rng.next();
            const phi = 2 * Math.PI * r1;
            const rr = Math.sqrt(r2);
            const lx2 = Math.cos(phi) * rr;
            const ly2 = Math.sqrt(Math.max(0, 1 - r2));
            const lz2 = Math.sin(phi) * rr;
            // Normal is (0,1,0): tangent x, bitangent z.
            dx = lx2;
            dy = ly2;
            dz = lz2;
            tpX *= groundAlbedo[0];
            tpY *= groundAlbedo[1];
            tpZ *= groundAlbedo[2];
          } else {
            scratch[0] = nX;
            scratch[1] = nY;
            scratch[2] = nZ;
            const hArr = sampleGGX(
              [nX, nY, nZ],
              roughness,
              rng
            );
            const hx = hArr[0];
            const hy = hArr[1];
            const hz = hArr[2];
            // Reflect d around h: d' = d - 2 (d.h) h
            const dh = dx * hx + dy * hy + dz * hz;
            const rx = dx - 2 * dh * hx;
            const ry = dy - 2 * dh * hy;
            const rz = dz - 2 * dh * hz;
            if (rx * nX + ry * nY + rz * nZ <= 0) {
              alive = 0;
              break;
            }
            const nDotH = clamp01(nX * hx + nY * hy + nZ * hz);
            const nDotL2 = clamp01(nX * rx + nY * ry + nZ * rz);
            const vDotH = clamp01(-dx * hx + -dy * hy + -dz * hz);
            const nDotVb = Math.max(
              1e-4,
              -dx * nX + -dy * nY + -dz * nZ
            );
            const d =
              a2 /
              (Math.PI * (nDotH * nDotH * (a2 - 1) + 1) ** 2);
            const gv = nDotVb / (nDotVb * (1 - k) + k);
            const gl = nDotL2 / (nDotL2 * (1 - k) + k);
            const g = gv * gl;
            const fTerm = (1 - vDotH) ** 5;
            const denom = Math.max(
              1e-8,
              d * nDotH * Math.max(1e-4, nDotVb)
            );
            const common = (d * g * nDotL2 * 4 * vDotH) / denom;
            const wR = clamp(
              (f0[0] + (1 - f0[0]) * fTerm) * common,
              0,
              1
            );
            const wG = clamp(
              (f0[1] + (1 - f0[1]) * fTerm) * common,
              0,
              1
            );
            const wB = clamp(
              (f0[2] + (1 - f0[2]) * fTerm) * common,
              0,
              1
            );
            tpX *= wR;
            tpY *= wG;
            tpZ *= wB;
            dx = rx;
            dy = ry;
            dz = rz;
          }

          ox = sox;
          oy = soy;
          oz = soz;
          const dl2 = Math.hypot(dx, dy, dz) || 1;
          dx /= dl2;
          dy /= dl2;
          dz /= dl2;
        }

        // Highlight clamp on light transport, then the exposure gain. The
        // clamp shape is exposure independent; only overall brightness moves.
        accumulator[pixel] += clamp(radR, 0, clampMax) * exposure;
        accumulator[pixel + 1] += clamp(radG, 0, clampMax) * exposure;
        accumulator[pixel + 2] += clamp(radB, 0, clampMax) * exposure;
        pixel += 3;
      }
    }
    this.samples += 1;
  }

  // Block until every pixel has accumulated `target` samples in total.
  renderToSamples (target, onFrame) {
    while (this.samples < target) {
      this.renderSample();
      if (onFrame) onFrame(this.samples);
    }
  }

  // Mean of the accumulated samples, the exposure-scaled linear image.
  getLinearImage () {
    if (this.samples === 0) {
      return new Float32Array(this.accumulator.length);
    }
    const out = new Float32Array(this.accumulator.length);
    const inv = 1 / this.samples;
    for (let i = 0; i < out.length; i++) {
      out[i] = this.accumulator[i] * inv;
    }
    return out;
  }
}

module.exports = { PathTracer, DEFAULT_SETTINGS };
