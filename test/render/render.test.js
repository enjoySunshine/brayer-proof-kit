'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PhysicalCamera,
  REFERENCE_APERTURE,
  REFERENCE_SHUTTER
} = require('../../render/camera.js');
const { Scene } = require('../../render/scene.js');
const { PathTracer } = require('../../render/renderer.js');
const {
  PreviewWindow,
  LOW_RES_DELAY_MS,
  FADE_DURATION_MS
} = require('../../render/window.js');
const { DeliveryJob } = require('../../render/delivery.js');
const {
  buildGroundMask,
  averagePatch
} = require('../../render/analysis.js');
const { writeLinear, writePng } = require('../../render/output.js');

const W = 80;
const H = 45;

function makeTracer (camera, overrides = {}) {
  return new PathTracer({
    width: W,
    height: H,
    camera,
    scene: new Scene(),
    ...overrides
  });
}

function patchLuminance (tracer) {
  const scene = tracer.scene;
  const { mask } = buildGroundMask(scene, tracer.camera, W, H);
  return averagePatch(tracer.getLinearImage(), mask, W, H).luminance;
}

test('reference exposure at f/1.4 and 1/50 s has gain 1', () => {
  const camera = new PhysicalCamera({
    aperture: REFERENCE_APERTURE,
    shutter: REFERENCE_SHUTTER
  });
  assert.equal(camera.exposure, 1);
});

test('aperture 1.4 -> 2.0 at fixed shutter halves exposure and shrinks DoF', () => {
  const c14 = new PhysicalCamera({ aperture: 1.4 });
  const c20 = new PhysicalCamera({ aperture: 2.0 });
  // (1.4 / 2.0)^2 = 0.49
  assert.ok(Math.abs(c20.exposure / c14.exposure - 0.49) < 1e-9);
  // Smaller aperture means a smaller lens, hence less defocus blur.
  assert.ok(c20.lensRadius < c14.lensRadius);
});

test('shutter 1/50 -> 1/100 at fixed aperture halves exposure, DoF unchanged', () => {
  const base = new PhysicalCamera({ aperture: 1.4, shutter: 1 / 50 });
  const fast = new PhysicalCamera({ aperture: 1.4, shutter: 1 / 100 });
  assert.ok(Math.abs(fast.exposure / base.exposure - 0.5) < 1e-9);
  assert.equal(fast.lensRadius, base.lensRadius);
});

test('omitted shutter defaults to 1/50 s', () => {
  const camera = new PhysicalCamera({ aperture: 2.0 });
  assert.equal(camera.shutter, 1 / 50);
});

test('ground brightness ratio stays within 0.4-0.6 for both exposure changes', () => {
  const scene = new Scene();

  const base = new PathTracer({
    width: W,
    height: H,
    camera: new PhysicalCamera({ aperture: 1.4, shutter: 1 / 50 }),
    scene
  });
  const stopped = new PathTracer({
    width: W,
    height: H,
    camera: new PhysicalCamera({ aperture: 2.0, shutter: 1 / 50 }),
    scene
  });
  const fast = new PathTracer({
    width: W,
    height: H,
    camera: new PhysicalCamera({ aperture: 1.4, shutter: 1 / 100 }),
    scene
  });

  base.renderToSamples(4);
  stopped.renderToSamples(4);
  fast.renderToSamples(4);

  const baseLum = patchLuminance(base);
  const stopRatio = patchLuminance(stopped) / baseLum;
  const shutterRatio = patchLuminance(fast) / baseLum;

  assert.ok(stopRatio >= 0.4 && stopRatio <= 0.6, `aperture ratio ${stopRatio}`);
  assert.ok(
    shutterRatio >= 0.4 && shutterRatio <= 0.6,
    `shutter ratio ${shutterRatio}`
  );
});

test('repeated deliveries reproduce the identical noise pattern', () => {
  const scene = new Scene();
  const a = makeTracer(new PhysicalCamera({ aperture: 1.4 }));
  const b = makeTracer(new PhysicalCamera({ aperture: 1.4 }));
  a.renderToSamples(3);
  b.renderToSamples(3);
  const ia = a.getLinearImage();
  const ib = b.getLinearImage();
  assert.equal(ia.length, ib.length);
  for (let i = 0; i < ia.length; i++) {
    assert.equal(ia[i], ib[i]);
  }
});

test('every delivered pixel is non-negative', () => {
  const tracer = makeTracer(new PhysicalCamera());
  tracer.renderToSamples(2);
  const image = tracer.getLinearImage();
  for (const v of image) {
    assert.ok(v >= 0);
  }
});

test('changing aperture or shutter resets accumulated samples', () => {
  const camera = new PhysicalCamera();
  const tracer = makeTracer(camera);
  tracer.renderToSamples(3);
  assert.equal(tracer.samplesPerPixel, 3);
  camera.setAperture(2.0);
  assert.equal(tracer.samplesPerPixel, 0);
  tracer.renderToSamples(2);
  camera.setShutter(1 / 100);
  assert.equal(tracer.samplesPerPixel, 0);
});

test('window accumulation survives an offscreen delivery untouched', () => {
  const scene = new Scene();
  const camera = new PhysicalCamera();
  const window = new PreviewWindow({
    width: 96,
    height: 54,
    camera,
    scene
  });
  const job = new DeliveryJob({
    width: W,
    height: H,
    camera,
    scene,
    maxBounces: window.tracer.maxBounces,
    highlightClamp: window.tracer.highlightClamp
  });
  window.accumulate(5);
  const before = window.progress;
  job.render(6);
  assert.equal(window.progress, before);
  assert.equal(job.progress, 6);
});

test('window and delivery share bounce count and highlight clamp', () => {
  const scene = new Scene();
  const camera = new PhysicalCamera();
  const window = new PreviewWindow({
    width: 96,
    height: 54,
    camera,
    scene,
    maxBounces: 3,
    highlightClamp: 5
  });
  const job = new DeliveryJob({
    width: W,
    height: H,
    camera,
    scene,
    maxBounces: 3,
    highlightClamp: 5
  });
  assert.equal(window.tracer.maxBounces, job.tracer.maxBounces);
  assert.equal(window.tracer.highlightClamp, job.tracer.highlightClamp);
});

test('low-res preview precedes the 250 ms fade and never replaces delivery', () => {
  let now = 0;
  const window = new PreviewWindow({
    width: 96,
    height: 54,
    camera: new PhysicalCamera(),
    scene: new Scene(),
    clock: () => now
  });
  window.accumulate(2);

  const early = window.getDisplayFrame(now);
  assert.equal(early.phase, 'low');
  assert.equal(early.alpha, 0);
  assert.ok(early.width < 96 && early.height < 54);

  now = LOW_RES_DELAY_MS + FADE_DURATION_MS / 2;
  const fading = window.getDisplayFrame(now);
  assert.equal(fading.phase, 'fading');
  assert.ok(fading.alpha > 0 && fading.alpha < 1);
  assert.equal(fading.upscaled, true);

  now = LOW_RES_DELAY_MS + FADE_DURATION_MS + 1;
  const full = window.getDisplayFrame(now);
  assert.equal(full.phase, 'full');
  assert.equal(full.alpha, 1);
  assert.equal(full.upscaled, false);

  // The accumulated buffer is independent of the display fade alpha.
  const accumulated = window.getAccumulatedImage();
  assert.equal(accumulated.length, 96 * 54 * 3);
});

test('linear output has no tone mapping while PNG is tone mapped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-test-'));
  const linearPath = path.join(dir, 'out.pfm');
  const pngPath = path.join(dir, 'out.png');
  const tracer = makeTracer(new PhysicalCamera());
  tracer.renderToSamples(2);
  const linear = tracer.getLinearImage();

  writeLinear(linearPath, W, H, linear);
  writePng(pngPath, W, H, linear);

  const pfm = fs.readFileSync(linearPath);
  const header = pfm.toString('latin1', 0, 20).split('\n');
  assert.equal(header[0], 'PF');
  assert.ok(header[1].startsWith(`${W} ${H}`));
  assert.equal(header[2], '-1.0');

  const png = fs.readFileSync(pngPath);
  assert.equal(png.readUInt32BE(16), W);
  assert.equal(png.readUInt32BE(20), H);
  assert.equal(png[24], 8);
  assert.equal(png[25], 2);
});

test('all linear output formats are accepted and oriented correctly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-fmt-'));
  const tracer = makeTracer(new PhysicalCamera());
  tracer.renderToSamples(1);
  const linear = tracer.getLinearImage();
  for (const ext of ['pfm', 'raw', 'png']) {
    const file = path.join(dir, `out.${ext}`);
    assert.doesNotThrow(() => writeLinear(file, W, H, linear));
    assert.ok(fs.statSync(file).size > 0);
  }
});
