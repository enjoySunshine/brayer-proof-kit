#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PhysicalCamera } = require('./render/camera.js');
const { Scene } = require('./render/scene.js');
const { PreviewWindow } = require('./render/window.js');
const { DeliveryJob } = require('./render/delivery.js');
const { buildGroundMask, averagePatch } = require('./render/analysis.js');
const { writeLinear, writePng } = require('./render/output.js');

const WINDOW_WIDTH = 960;
const WINDOW_HEIGHT = 540;
const DEFAULT_SPP = 32;
const DEFAULT_WINDOW_FRAMES = 12;

function usage () {
  return `Usage:
  node render-delivery.js --linear <path> --png <path> \\
      --width <px> --height <px> --aperture <f-number> [--shutter <s>]

Options:
  --linear    output path for the linear (no tone mapping) image
              .pfm (PFM float32), .raw (raw float32) or .png (16-bit linear)
  --png       output path for the tone mapped sRGB PNG deliverable
  --width     deliverable width in pixels, e.g. 1600
  --height    deliverable height in pixels, e.g. 900
  --aperture  f-number, e.g. 1.4 or 2.0
  --shutter   shutter time in seconds, a number (0.02) or a fraction (1/50);
              defaults to 1/50 when omitted
  --spp       samples per pixel for the deliverable (default 32)
  --frames    preview window frames accumulated before delivery (default 12)
`;
}

function parseArgs (argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') {
      args.help = true;
      continue;
    }
    if (!key.startsWith('--')) {
      throw new Error(`unexpected argument: ${key}`);
    }
    const value = argv[++i];
    if (value === undefined) {
      throw new Error(`missing value for ${key}`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

function parseShutter (value) {
  if (value === undefined) return 1 / 50;
  if (value.includes('/')) {
    const [numerator, denominator] = value.split('/').map(Number);
    if (!(numerator > 0) || !(denominator > 0)) {
      throw new RangeError(`invalid shutter fraction: ${value}`);
    }
    return numerator / denominator;
  }
  const seconds = Number(value);
  if (!(seconds > 0)) {
    throw new RangeError(`invalid shutter time: ${value}`);
  }
  return seconds;
}

function ensureDirectory (filePath) {
  const dir = path.dirname(path.resolve(filePath));
  fs.mkdirSync(dir, { recursive: true });
}

function main () {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const required = ['linear', 'png', 'width', 'height', 'aperture'];
  for (const key of required) {
    if (args[key] === undefined) {
      console.error(`missing required option --${key}`);
      console.error(usage());
      process.exitCode = 1;
      return;
    }
  }

  const width = Number(args.width);
  const height = Number(args.height);
  const aperture = Number(args.aperture);
  const shutter = parseShutter(args.shutter);
  const spp = args.spp ? Number(args.spp) : DEFAULT_SPP;
  const windowFrames = args.frames
    ? Number(args.frames)
    : DEFAULT_WINDOW_FRAMES;

  if (!(width > 0) || !(height > 0)) {
    throw new RangeError('width and height must be positive integers');
  }
  if (!(aperture > 0)) {
    throw new RangeError('aperture must be a positive f-number');
  }
  if (!Number.isInteger(spp) || spp <= 0) {
    throw new RangeError('spp must be a positive integer');
  }

  // One scene, one physical camera, shared by window and offscreen delivery.
  const scene = new Scene();
  const camera = new PhysicalCamera({ aperture, shutter });

  // Fixed-size preview window, independent of the deliverable resolution.
  const window = new PreviewWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    camera,
    scene
  });

  // Offscreen job with its own buffer but identical tracer settings.
  const delivery = new DeliveryJob({
    width,
    height,
    camera,
    scene,
    maxBounces: window.tracer.maxBounces,
    highlightClamp: window.tracer.highlightClamp
  });

  console.log(
    `scene: matte ground + reflective sphere, ${width}x${height} delivery, ` +
      `window ${WINDOW_WIDTH}x${WINDOW_HEIGHT}`
  );
  console.log(
    `camera: f/${aperture.toFixed(1)}, shutter ${shutter}s ` +
      `(exposure gain ${camera.exposure.toFixed(4)} relative to f/1.4 @ 1/50)`
  );

  // 1. Let the window accumulate for a while and record its progress.
  window.accumulate(windowFrames);
  const progressBefore = window.progress;
  console.log(
    `window progress before delivery: ${progressBefore} samples/pixel`
  );

  // 2. Deliver the full-resolution image offscreen, every pixel reaching spp.
  delivery.render(spp);
  if (delivery.progress !== spp) {
    throw new Error(
      `delivery reached ${delivery.progress} spp, expected ${spp}`
    );
  }

  // 3. The window's already accumulated samples stay untouched.
  const progressAfter = window.progress;
  console.log(
    `window progress after delivery:  ${progressAfter} samples/pixel`
  );
  if (progressBefore !== progressAfter) {
    throw new Error(
      `window progress changed during delivery: ${progressBefore} -> ${progressAfter}`
    );
  }

  const linearImage = delivery.getLinearImage();

  // 4. Ground patch brightness from the linear, tone-mapping-free result.
  const { mask } = buildGroundMask(scene, camera, width, height);
  const stats = averagePatch(linearImage, mask, width, height);
  console.log(
    `ground patch: ${stats.count} pixels (far flat ground, away from sphere)`
  );
  console.log(`  mean R/G/B (linear): ${stats.meanR.toFixed(6)} / ${
    stats.meanG.toFixed(6)
  } / ${stats.meanB.toFixed(6)}`);
  console.log(`  mean luminance (linear): ${stats.luminance.toFixed(6)}`);

  // 5. Write both files.
  ensureDirectory(args.linear);
  ensureDirectory(args.png);
  const linearBytes = writeLinear(args.linear, width, height, linearImage);
  const pngBytes = writePng(args.png, width, height, linearImage);
  console.log(
    `linear image written: ${args.linear} (${linearBytes} bytes, no tone mapping)`
  );
  console.log(
    `sRGB PNG written:     ${args.png} (${pngBytes} bytes, ACES tone mapped)`
  );
}

main();
