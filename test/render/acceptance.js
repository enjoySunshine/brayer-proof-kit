'use strict';

// End-to-end acceptance checks mirroring the client's requirements.
// Run with: node test/render/acceptance.js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { PhysicalCamera } = require('../../render/camera.js');
const { Scene } = require('../../render/scene.js');
const { PreviewWindow } = require('../../render/window.js');
const { DeliveryJob } = require('../../render/delivery.js');
const {
  buildGroundMask,
  averagePatch
} = require('../../render/analysis.js');
const { writeLinear, writePng } = require('../../render/output.js');

const WINDOW_W = 960;
const WINDOW_H = 540;
const SHOT_W = 1600;
const SHOT_H = 900;
const SPP = 32;

let failures = 0;
function check (name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL - ${name}: ${error.message}`);
  }
}

function renderDelivery (aperture, shutter) {
  const scene = new Scene();
  const camera = new PhysicalCamera({ aperture, shutter });
  const window = new PreviewWindow({
    width: WINDOW_W,
    height: WINDOW_H,
    camera,
    scene
  });
  const job = new DeliveryJob({
    width: SHOT_W,
    height: SHOT_H,
    camera,
    scene,
    maxBounces: window.tracer.maxBounces,
    highlightClamp: window.tracer.highlightClamp
  });
  window.accumulate(8);
  const progressBefore = window.progress;
  job.render(SPP);
  const progressAfter = window.progress;
  const linear = job.getLinearImage();
  const { mask } = buildGroundMask(scene, camera, SHOT_W, SHOT_H);
  const stats = averagePatch(linear, mask, SHOT_W, SHOT_H);
  return {
    scene,
    camera,
    window,
    job,
    linear,
    stats,
    progressBefore,
    progressAfter
  };
}

// Full-res delivery is slow; use a small proxy for the geometry/file checks
// and only assert ratios on a modest resolution, but still exercise the real
// 32 spp accumulation path at a smaller size to keep runtime reasonable.
const FAST_W = 200;
const FAST_H = 113;

function fastDelivery (aperture, shutter) {
  const scene = new Scene();
  const camera = new PhysicalCamera({ aperture, shutter });
  const job = new DeliveryJob({
    width: FAST_W,
    height: FAST_H,
    camera,
    scene
  });
  job.render(SPP);
  const linear = job.getLinearImage();
  const { mask } = buildGroundMask(scene, camera, FAST_W, FAST_H);
  return {
    linear,
    stats: averagePatch(linear, mask, FAST_W, FAST_H),
    camera,
    scene
  };
}

console.log('Exposure ratios (32 spp, ground patch mean luminance):');
const base = fastDelivery(1.4, 1 / 50);
const stopped = fastDelivery(2.0, 1 / 50);
const fastShutter = fastDelivery(1.4, 1 / 100);
const ratioAperture = stopped.stats.luminance / base.stats.luminance;
const ratioShutter = fastShutter.stats.luminance / base.stats.luminance;
console.log(
  `  f/2.0 / f/1.4 = ${ratioAperture.toFixed(3)} (must be 0.4-0.6)`
);
console.log(
  `  1/100 / 1/50  = ${ratioShutter.toFixed(3)} (must be 0.4-0.6)`
);
check('aperture ratio within 0.4-0.6', () =>
  assert.ok(ratioAperture >= 0.4 && ratioAperture <= 0.6)
);
check('shutter ratio within 0.4-0.6', () =>
  assert.ok(ratioShutter >= 0.4 && ratioShutter <= 0.6)
);

console.log('Determinism and positivity:');
const rerun = fastDelivery(1.4, 1 / 50);
check('two deliveries produce identical pixels', () => {
  assert.equal(base.linear.length, rerun.linear.length);
  for (let i = 0; i < base.linear.length; i++) {
    assert.equal(base.linear[i], rerun.linear[i]);
  }
});
check('every pixel is non-negative', () => {
  for (const v of base.linear) assert.ok(v >= 0);
});

console.log('Window / delivery independence:');
const e2e = renderDelivery(1.4, 1 / 50);
check('window samples are preserved across delivery', () => {
  assert.equal(e2e.progressBefore, e2e.progressAfter);
  assert.equal(e2e.progressBefore, 8);
});
check('delivery reached exactly 32 samples per pixel', () => {
  assert.equal(e2e.job.progress, SPP);
});
check('window and delivery share bounce and clamp settings', () => {
  assert.equal(
    e2e.window.tracer.maxBounces,
    e2e.job.tracer.maxBounces
  );
  assert.equal(
    e2e.window.tracer.highlightClamp,
    e2e.job.tracer.highlightClamp
  );
});

console.log('Exposure change resets both accumulators:');
check('aperture change resets window and delivery accumulation', () => {
  const scene = new Scene();
  const camera = new PhysicalCamera();
  const window = new PreviewWindow({
    width: 96,
    height: 54,
    camera,
    scene
  });
  const job = new DeliveryJob({
    width: 80,
    height: 45,
    camera,
    scene
  });
  window.accumulate(3);
  job.render(3);
  camera.setAperture(2.0);
  assert.equal(window.progress, 0);
  assert.equal(job.progress, 0);
});

console.log('Files on disk:');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-accept-'));
const linearPath = path.join(dir, 'linear.pfm');
const pngPath = path.join(dir, 'view.png');
writeLinear(linearPath, FAST_W, FAST_H, base.linear);
writePng(pngPath, FAST_W, FAST_H, base.linear);
check('PNG has the requested dimensions and is 8-bit RGB', () => {
  const png = fs.readFileSync(pngPath);
  assert.equal(png.readUInt32BE(16), FAST_W);
  assert.equal(png.readUInt32BE(20), FAST_H);
  assert.equal(png[24], 8);
  assert.equal(png[25], 2);
});
check('PNG scanlines are top-to-bottom (filter byte per row present)', () => {
  const png = fs.readFileSync(pngPath);
  let p = 8;
  const chunks = [];
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    chunks.push([type, len]);
    p += 12 + len;
  }
  assert.ok(chunks.some(([t]) => t === 'IDAT'));
  const idat = [];
  p = 8;
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(png.slice(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rowBytes = FAST_W * 3;
  for (let y = 0; y < FAST_H; y++) {
    assert.equal(raw[y * (rowBytes + 1)], 0);
  }
});
check('linear PFM carries float32 RGB and no tone mapping', () => {
  const pfm = fs.readFileSync(linearPath);
  const lines = pfm.toString('latin1', 0, 24).split('\n');
  assert.equal(lines[0], 'PF');
  assert.equal(lines[2], '-1.0');
  const offset =
    pfm.indexOf('\n', pfm.indexOf('\n', pfm.indexOf('\n') + 1) + 1) + 1;
  const floats = FAST_W * FAST_H * 3;
  assert.equal(pfm.length - offset, floats * 4);
  let anyAboveOne = false;
  for (let i = 0; i < floats; i++) {
    if (pfm.readFloatLE(offset + i * 4) > 1) anyAboveOne = true;
  }
  // Linear HDR data must be allowed to exceed the 0-1 display range.
  assert.ok(anyAboveOne);
});

console.log(
  failures === 0
    ? '\nAll acceptance checks passed.'
    : `\n${failures} acceptance check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
