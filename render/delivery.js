'use strict';

const { PathTracer } = require('./renderer.js');

// Offscreen delivery job. It is a separate PathTracer instance at the
// deliverable resolution, but constructed with the same scene, camera, bounce
// count and highlight clamp as the preview window, so the two are guaranteed
// to run the same ray tracing code.
//
// Camera exposure changes reset this accumulator just like the window's.
// The job never reads the window's low-resolution preview or its display
// alpha: it accumulates full-resolution samples itself.
class DeliveryJob {
  constructor ({ width, height, camera, scene, maxBounces, highlightClamp }) {
    this.tracer = new PathTracer({
      width,
      height,
      camera,
      scene,
      maxBounces,
      highlightClamp
    });
    this.width = width;
    this.height = height;
  }

  get progress () {
    return this.tracer.samplesPerPixel;
  }

  reset () {
    this.tracer.reset();
  }

  // Accumulate exactly `target` samples for every pixel.
  render (target, onFrame) {
    this.tracer.renderToSamples(target, onFrame);
  }

  getLinearImage () {
    return this.tracer.getLinearImage();
  }
}

module.exports = { DeliveryJob };
