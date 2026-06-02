// Rasterize the StraVIBE logomark (icon.svg) to a 128x128 RGBA PNG using only
// Node built-ins. The SVG is a handful of rounded rects, so we render them
// directly — supersampled 4x for smooth corners — and encode the PNG by hand.
//
//   node scripts/make-icon.js   ->   icon.png
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = 128;
const SS = 4; // supersample factor
const R = OUT * SS; // render resolution
const S = R / 24; // SVG viewBox is 0..24

// [x, y, w, h, radius, r, g, b] in viewBox units — order = paint order.
const SHAPES = [
  [0, 0, 24, 24, 5, 0x0a, 0x0a, 0x0a], // background rounded square
  [3, 14, 4, 7, 1.4, 0x8f, 0x8f, 0x8f], // short bar
  [10, 10, 4, 11, 1.4, 0xc2, 0xc2, 0xc2], // mid bar
  [17, 4.5, 4, 16.5, 1.4, 0xfa, 0xfa, 0xfa], // leader bar
];

function inRoundRect(px, py, x, y, w, h, r) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}

// Render at high res: each pixel is opaque shape color or transparent.
const hi = Buffer.alloc(R * R * 4);
for (let y = 0; y < R; y++) {
  for (let x = 0; x < R; x++) {
    const ux = (x + 0.5) / S;
    const uy = (y + 0.5) / S;
    let col = null;
    for (const [sx, sy, sw, sh, sr, r, g, b] of SHAPES) {
      if (inRoundRect(ux, uy, sx, sy, sw, sh, sr)) col = [r, g, b];
    }
    const o = (y * R + x) * 4;
    if (col) {
      hi[o] = col[0];
      hi[o + 1] = col[1];
      hi[o + 2] = col[2];
      hi[o + 3] = 255;
    }
  }
}

// Box-downsample SS*SS -> 1, premultiplied so transparent edges stay clean.
const out = Buffer.alloc(OUT * OUT * 4);
for (let y = 0; y < OUT; y++) {
  for (let x = 0; x < OUT; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const o = ((y * SS + dy) * R + (x * SS + dx)) * 4;
        const al = hi[o + 3];
        r += hi[o] * al;
        g += hi[o + 1] * al;
        b += hi[o + 2] * al;
        a += al;
      }
    }
    const o = (y * OUT + x) * 4;
    const n = SS * SS;
    out[o] = a ? Math.round(r / a) : 0;
    out[o + 1] = a ? Math.round(g / a) : 0;
    out[o + 2] = a ? Math.round(b / a) : 0;
    out[o + 3] = Math.round(a / n);
  }
}

// --- minimal PNG encoder (RGBA, 8-bit, single IDAT) ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const tb = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
  return Buffer.concat([len, tb, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// 10,11,12 = compression/filter/interlace = 0

const raw = Buffer.alloc((OUT * 4 + 1) * OUT);
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0; // filter: none
  out.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

const dest = path.join(__dirname, "..", "icon.png");
fs.writeFileSync(dest, png);
console.log(`wrote ${dest} (${OUT}x${OUT}, ${png.length} bytes)`);
