# Offscreen path-tracer delivery

A dependency-free, deterministic CPU path tracer used to deliver a
client-sized render (default 1600x900) while a separate fixed-size preview
window (960x540) keeps accumulating. Everything runs in plain Node.js with
the built-in `zlib` module; nothing is downloaded and the existing
playground/gallery is untouched.

## Running a delivery

From the project root:

```sh
node render-delivery.js \
  --linear deliverables/shot-f14.pfm \
  --png    deliverables/shot-f14.png \
  --width 1600 --height 900 \
  --aperture 1.4 --shutter 1/50
```

Options:

- `--linear`   linear, tone-mapping-free output used for brightness checks.
  Extensions: `.pfm` (float32 PFM), `.raw` (raw float32 with a small header),
  `.png` (16-bit linear).
- `--png`      8-bit sRGB PNG with the renderer's current ACES tone mapping.
- `--width`, `--height` deliverable pixel dimensions.
- `--aperture` f-number, e.g. `1.4` or `2.0`.
- `--shutter`  seconds as a number (`0.02`) or fraction (`1/50`). Omitted
  means `1/50`.
- `--spp`      samples per pixel for the delivery (default 32).
- `--frames`   preview frames accumulated before delivery (default 12).

The command first accumulates the 960x540 window, records its progress, runs
the offscreen delivery to the requested sample count, reads the window
progress again, writes both files, and prints the mean linear luminance of a
ground patch far from the sphere.

## Physical camera and exposure

Exposure gain is relative to the reference settings f/1.4 at 1/50 s:

```
gain = (shutter / (1/50)) * (1.4 / fNumber)^2
```

So f/1.4 -> f/2.0 at a fixed shutter halves brightness (0.49), and
1/50 -> 1/100 at a fixed aperture also halves it (0.5). The shutter only
scales the gain; depth of field comes solely from the thin-lens aperture, so
stopping down shrinks the blur without changing the exposure geometry.

Changing aperture or shutter through the camera notifies every attached
tracer (window and offscreen), and each restarts accumulation from zero.

## Determinism

Each pixel sample seeds its RNG from `(width, x, y, sampleIndex)`. Repeating
the same delivery reproduces the identical noise pattern; the key excludes
exposure settings, so an exposure change restarts accumulation without
re-scrambling the noise.

## Preview window behavior

After a reset the window shows a half-resolution preview first. 16 ms later
the full-resolution accumulation fades in over 250 ms. The fade is display
only: the accumulated buffer and the offscreen delivery carry no display
alpha, and the low-resolution buffer can never be exported.

## Modules

- `rng.js`       seedable 32-bit RNG and per-pixel keying
- `math.js`      vector and GGX sampling helpers
- `camera.js`    thin-lens physical camera, exposure model, change events
- `scene.js`     procedural matte ground, reflective sphere, sun and sky
- `renderer.js`  the shared scalar path tracer (bounces + highlight clamp)
- `window.js`    frame-by-frame preview with low-res/fade display states
- `delivery.js`  offscreen full-resolution accumulation job
- `tonemap.js`   ACES + sRGB used for the PNG and display frames only
- `output.js`    dependency-free PNG encoder and linear file writers
- `analysis.js`  ground-patch mask and mean luminance

## Tests

```sh
node --test test/render/render.test.js
node test/render/acceptance.js
```
