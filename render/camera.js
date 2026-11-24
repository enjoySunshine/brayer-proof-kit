'use strict';

const { v3, sampleDisk } = require('./math.js');

// Exposure reference: at f/1.4 and 1/50 s the delivered brightness equals the
// current preview, i.e. the exposure gain is exactly 1.
const REFERENCE_APERTURE = 1.4;
const REFERENCE_SHUTTER = 1 / 50;

// Physical thin-lens camera.
//
// Exposure model: radiance reaching the sensor is proportional to
//   shutter time / (f-number)^2
// so the gain relative to the reference settings is
//   (t / t_ref) * (N_ref / N)^2
// f/1.4 -> f/2.0 at fixed shutter therefore halves the brightness, and
// 1/50 -> 1/100 at fixed aperture halves it as well. The shutter itself does
// not touch the lens geometry, so depth of field only depends on the aperture.
class PhysicalCamera {
  constructor (options = {}) {
    this.eye = options.eye ? v3.copy(options.eye) : [0, 1.05, 4];
    this.target = options.target ? v3.copy(options.target) : [0, 0.45, 0];
    this.up = options.up ? v3.copy(options.up) : [0, 1, 0];

    // Full-frame-ish sensor, 16:9, 50 mm lens.
    this.sensorWidth = options.sensorWidth ?? 0.036;
    this.sensorHeight = options.sensorHeight ?? 0.02025;
    this.focalLength = options.focalLength ?? 0.05;

    this.aperture = options.aperture ?? REFERENCE_APERTURE;
    this.shutter = options.shutter ?? REFERENCE_SHUTTER;

    this.listeners = [];
    this._updateFrame();
  }

  _updateFrame () {
    this.forward = v3.normalize(v3.sub(this.target, this.eye));
    this.right = v3.normalize(v3.cross(this.forward, this.up));
    this.cameraUp = v3.cross(this.right, this.forward);
    this.focusDistance = v3.length(v3.sub(this.target, this.eye));
    this.halfHeight = Math.tan(
      Math.atan(this.sensorHeight / 2 / this.focalLength)
    );
    this.halfWidth = this.halfHeight * (this.sensorWidth / this.sensorHeight);
  }

  get exposure () {
    return (
      (this.shutter / REFERENCE_SHUTTER) *
      (REFERENCE_APERTURE / this.aperture) ** 2
    );
  }

  get lensRadius () {
    // f-number N = focalLength / diameter, so radius = f / (2 N).
    return this.focalLength / (2 * this.aperture);
  }

  onChange (callback) {
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  setAperture (aperture) {
    if (!(aperture > 0)) {
      throw new RangeError('aperture must be a positive f-number');
    }
    if (aperture === this.aperture) return;
    this.aperture = aperture;
    this._updateFrame();
    for (const cb of this.listeners) cb('aperture');
  }

  setShutter (shutter) {
    if (!(shutter > 0)) {
      throw new RangeError('shutter must be a positive time in seconds');
    }
    if (shutter === this.shutter) return;
    this.shutter = shutter;
    this._updateFrame();
    for (const cb of this.listeners) cb('shutter');
  }

  // Pinhole ray through a pixel (x, y with y = 0 at the image top), with
  // sub-pixel jitter (jx, jy in [0, 1)).
  _pinholeRay (x, y, width, height, jx, jy) {
    const ndcX = (2 * (x + jx)) / width - 1;
    const ndcY = 1 - (2 * (y + jy)) / height;
    const dir = v3.normalize([
      this.forward[0] +
        this.right[0] * ndcX * this.halfWidth +
        this.cameraUp[0] * ndcY * this.halfHeight,
      this.forward[1] +
        this.right[1] * ndcX * this.halfWidth +
        this.cameraUp[1] * ndcY * this.halfHeight,
      this.forward[2] +
        this.right[2] * ndcX * this.halfWidth +
        this.cameraUp[2] * ndcY * this.halfHeight
    ]);
    return { origin: v3.copy(this.eye), dir };
  }

  // Full thin-lens ray: lens jitter produces depth of field, scaled by the
  // f-number only. Returns origin and direction.
  generateRay (x, y, width, height, rng) {
    const jx = rng.next();
    const jy = rng.next();
    const pinhole = this._pinholeRay(x, y, width, height, jx, jy);

    // Point where the pinhole ray crosses the focal plane.
    const focalPoint = v3.add(
      pinhole.origin,
      v3.scale(pinhole.dir, this.focusDistance)
    );

    const [lx, ly] = sampleDisk(rng);
    const radius = this.lensRadius;
    const origin = [
      this.eye[0] + this.right[0] * lx * radius + this.cameraUp[0] * ly * radius,
      this.eye[1] + this.right[1] * lx * radius + this.cameraUp[1] * ly * radius,
      this.eye[2] + this.right[2] * lx * radius + this.cameraUp[2] * ly * radius
    ];
    const dir = v3.normalize(v3.sub(focalPoint, origin));
    return { origin, dir };
  }

  // Ray through the pixel center with no lens jitter, used for classifying
  // which pixels look at the ground. Fully deterministic without an RNG.
  centerRay (x, y, width, height) {
    return this._pinholeRay(x, y, width, height, 0.5, 0.5);
  }
}

module.exports = {
  PhysicalCamera,
  REFERENCE_APERTURE,
  REFERENCE_SHUTTER
};
