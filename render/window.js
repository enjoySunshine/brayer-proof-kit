'use strict';

const { PathTracer } = require('./renderer.js');

const LOW_RES_SCALE = 0.5;
const LOW_RES_DELAY_MS = 16;
const FADE_DURATION_MS = 250;

// Interactive preview window.
//
// The window accumulates one full-frame sample at a time, the original
// frame-by-frame preview workflow. After a reset it first shows a stretched
// low-resolution preview; LOW_RES_DELAY_MS later the full-resolution image
// starts fading in over FADE_DURATION_MS. The fade is a pure display effect:
// the accumulated samples and the offscreen delivery never carry display
// alpha. A low-resolution preview can never be exported as a deliverable,
// because `getDisplayFrame` is the only low-res path and delivery reads the
// tracer's accumulator directly.
class PreviewWindow {
  constructor ({
    width,
    height,
    camera,
    scene,
    maxBounces,
    highlightClamp,
    clock = () => Date.now()
  }) {
    this.width = width;
    this.height = height;
    this.camera = camera;
    this.scene = scene;
    this.clock = clock;

    this.tracer = new PathTracer({
      width,
      height,
      camera,
      scene,
      maxBounces,
      highlightClamp
    });

    this.lowWidth = Math.max(1, Math.round(width * LOW_RES_SCALE));
    this.lowHeight = Math.max(1, Math.round(height * LOW_RES_SCALE));
    this.lowTracer = new PathTracer({
      width: this.lowWidth,
      height: this.lowHeight,
      camera,
      scene,
      maxBounces,
      highlightClamp
    });

    this.resetTime = clock();
    this._unsubscribe = camera.onChange(() => this.reset());
  }

  // One accumulation frame on both the full-res buffer and the low-res
  // preview buffer. Existing samples stay untouched unless a camera exposure
  // change (or an explicit reset) invalidated them.
  stepFrame () {
    this.tracer.renderSample();
    this.lowTracer.renderSample();
  }

  accumulate (frameCount) {
    for (let i = 0; i < frameCount; i++) this.stepFrame();
  }

  reset () {
    this.tracer.reset();
    this.lowTracer.reset();
    this.resetTime = this.clock();
  }

  get progress () {
    return this.tracer.samplesPerPixel;
  }

  get samplesPerPixel () {
    return this.tracer.samplesPerPixel;
  }

  // Fade state derived from the injected clock.
  _displayPhase (now = this.clock()) {
    const elapsed = now - this.resetTime;
    if (elapsed < LOW_RES_DELAY_MS) {
      return { phase: 'low', alpha: 0 };
    }
    const fade = (elapsed - LOW_RES_DELAY_MS) / FADE_DURATION_MS;
    if (fade < 1) {
      return { phase: 'fading', alpha: Math.max(0, Math.min(1, fade)) };
    }
    return { phase: 'full', alpha: 1 };
  }

  // Display-only frame: either the low-res preview or an alpha blend between
  // it and the full-resolution accumulation. Never used for delivery.
  getDisplayFrame (now = this.clock()) {
    const { phase, alpha } = this._displayPhase(now);
    const low = this.lowTracer.getLinearImage();
    if (phase === 'low') {
      return {
        phase,
        alpha: 0,
        width: this.lowWidth,
        height: this.lowHeight,
        linear: low,
        upscaled: false
      };
    }
    const full = this.tracer.getLinearImage();
    if (phase === 'full') {
      return {
        phase,
        alpha: 1,
        width: this.width,
        height: this.height,
        linear: full,
        upscaled: false
      };
    }
    // Fading: nearest-neighbor upscale of the low-res buffer, then blend.
    const blended = new Float32Array(full.length);
    for (let y = 0; y < this.height; y++) {
      const ly = Math.min(
        this.lowHeight - 1,
        Math.floor((y / this.height) * this.lowHeight)
      );
      for (let x = 0; x < this.width; x++) {
        const lx = Math.min(
          this.lowWidth - 1,
          Math.floor((x / this.width) * this.lowWidth)
        );
        const fullIdx = (y * this.width + x) * 3;
        const lowIdx = (ly * this.lowWidth + lx) * 3;
        for (let c = 0; c < 3; c++) {
          blended[fullIdx + c] =
            low[lowIdx + c] * (1 - alpha) + full[fullIdx + c] * alpha;
        }
      }
    }
    return {
      phase,
      alpha,
      width: this.width,
      height: this.height,
      linear: blended,
      upscaled: true
    };
  }

  // The raw accumulated linear buffer. This is what the offscreen delivery
  // shares; it contains no display alpha or fade.
  getAccumulatedImage () {
    return this.tracer.getLinearImage();
  }

  dispose () {
    this._unsubscribe();
  }
}

module.exports = {
  PreviewWindow,
  LOW_RES_DELAY_MS,
  FADE_DURATION_MS,
  LOW_RES_SCALE
};
