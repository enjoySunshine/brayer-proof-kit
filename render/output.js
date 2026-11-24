'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');
const { toneMapBuffer } = require('./tonemap.js');

// ---------------------------------------------------------------------------
// PNG encoder (8-bit RGB and 16-bit RGB), dependency free.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32 (buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk (type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

function encodePng (width, height, rgbaLikeBytes, bitDepth = 8) {
  const channels = 3;
  const bytesPerSample = bitDepth / 8;
  const rowBytes = width * channels * bytesPerSample;
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
  ]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 2; // truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Filter byte 0 (none) before every scanline. Rows are written top to
  // bottom, matching the orientation shown in the preview window.
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (rowBytes + 1);
    raw[rowStart] = 0;
    rgbaLikeBytes.copy(raw, rowStart + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// 8-bit sRGB PNG from an exposure-scaled linear float buffer (RGB).
function writePng (filePath, width, height, linearImage) {
  const srgb = toneMapBuffer(linearImage);
  const rgb = Buffer.from(srgb.buffer, srgb.byteOffset, srgb.length);
  const png = encodePng(width, height, rgb, 8);
  fs.writeFileSync(filePath, png);
  return png.length;
}

// ---------------------------------------------------------------------------
// Linear, tone-mapping-free outputs for brightness comparison.
// ---------------------------------------------------------------------------

// PFM: standard portable float map, little-endian RGB float32. The PFM
// convention stores rows bottom-to-top; viewers that follow the spec
// therefore display the image upright.
function writePfm (filePath, width, height, linearImage) {
  const header = Buffer.from(
    `PF\n${width} ${height}\n-1.0\n`,
    'ascii'
  );
  const pixels = Buffer.alloc(width * height * 3 * 4);
  for (let y = 0; y < height; y++) {
    const srcRow = height - 1 - y;
    const srcOffset = srcRow * width * 3;
    const dstOffset = y * width * 3;
    for (let i = 0; i < width * 3; i++) {
      pixels.writeFloatLE(linearImage[srcOffset + i], (dstOffset + i) * 4);
    }
  }
  fs.writeFileSync(filePath, Buffer.concat([header, pixels]));
  return header.length + pixels.length;
}

// Raw little-endian float32 dump, rows top-to-bottom exactly as accumulated.
// A small sidecar header makes the layout self-describing.
function writeRaw (filePath, width, height, linearImage) {
  const header = Buffer.from(
    'RAWLINEAR1\0',
    'ascii'
  );
  const dims = Buffer.alloc(8);
  dims.writeUInt32LE(width, 0);
  dims.writeUInt32LE(height, 4);
  const pixels = Buffer.alloc(linearImage.length * 4);
  for (let i = 0; i < linearImage.length; i++) {
    pixels.writeFloatLE(linearImage[i], i * 4);
  }
  fs.writeFileSync(filePath, Buffer.concat([header, dims, pixels]));
  return header.length + dims.length + pixels.length;
}

// 16-bit PNG holding linear values (no tone mapping, no sRGB gamma),
// top-to-bottom. Values above 1 are clipped at the 16-bit maximum.
function writeLinearPng (filePath, width, height, linearImage) {
  const rowBytes = width * 3 * 2;
  const bytes = Buffer.alloc(rowBytes * height);
  for (let i = 0, j = 0; i < linearImage.length; i++, j += 2) {
    const v = Math.min(1, Math.max(0, linearImage[i]));
    bytes.writeUInt16BE(Math.round(v * 65535), j);
  }
  const png = encodePng(width, height, bytes, 16);
  fs.writeFileSync(filePath, png);
  return png.length;
}

// Dispatch on the requested extension.
function writeLinear (filePath, width, height, linearImage) {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'pfm':
      return writePfm(filePath, width, height, linearImage);
    case 'raw':
      return writeRaw(filePath, width, height, linearImage);
    case 'png':
      return writeLinearPng(filePath, width, height, linearImage);
    default:
      throw new Error(
        `unsupported linear output extension ".${ext}"; use .pfm, .raw or .png`
      );
  }
}

module.exports = {
  writePng,
  writeLinear,
  writePfm,
  writeRaw,
  writeLinearPng,
  encodePng,
  crc32
};
