'use strict';
/**
 * icon.js — the app mark: the check-in app's rounded box, with a Service
 * Star in place of the check.
 *
 * Why it matters that these two look alike but not identical: both apps run
 * on the same Pi for the same troop and live side by side in a leader's tab
 * strip. Sharing the box and the palette says "same troop, same toolkit";
 * swapping the check for a star says which one you are looking at.
 *
 * Geometry is the 512-unit space the check-in app's lib/theme.js uses, so
 * the two marks line up pixel for pixel. The star is FILLED rather than
 * stroked — a stroked five-pointed star loses its points below about 32px,
 * which is exactly the size a favicon renders at.
 *
 * Rasterization is by hand (signed-distance + supersampling, Node's own
 * zlib for the PNG container) for the same reason the check-in app does it:
 * this runs on a Pi, the repo is public, and one icon is not worth a native
 * image dependency. Ported from troop-checkin's server/lib/iconPng.js.
 */
const zlib = require('zlib');

// Trail Life palette — the same values as the check-in app's 'traillife'
// preset, so the two marks are the same two colours.
const PINE = '#17402C';
const PAPER = '#F4F3EC';

// --------------------------------------------------------------- geometry ---
// The box is the check-in app's, unchanged: stroke centre line and radius.
const BOX = { cx: 256, cy: 256, half: 186, r: 30, halfStroke: 6 };
// Five-pointed star, point up. 0.382 is the pentagram's inner/outer ratio —
// any fatter and it reads as a flower at favicon size.
const STAR = { cx: 256, cy: 264, outer: 112, innerRatio: 0.382, points: 5 };

/** The star's 10 vertices, outer and inner alternating, starting point-up. */
function starVertices({ cx, cy, outer, innerRatio, points } = STAR) {
  const inner = outer * innerRatio;
  const out = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

/** Even-odd is wrong for a star polygon; the ray-crossing rule is right. */
function inPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from p to the rounded-rect outline (we only care about |d|). */
function boxEdgeDistance(x, y) {
  const qx = Math.abs(x - BOX.cx) - (BOX.half - BOX.r);
  const qy = Math.abs(y - BOX.cy) - (BOX.half - BOX.r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  const d = Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - BOX.r;
  return Math.abs(d);
}

const STAR_PTS = starVertices();

/** Is this point inside the paper-coloured mark? */
function inMark(x, y) {
  if (boxEdgeDistance(x, y) <= BOX.halfStroke) return true;
  return inPolygon(x, y, STAR_PTS);
}

// ------------------------------------------------------------------- SVG ---
const round1 = (n) => Math.round(n * 10) / 10;

/** The star as an SVG path `d` attribute. */
function starPath() {
  return `${STAR_PTS.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${round1(x)} ${round1(y)}`).join(' ')} Z`;
}

function iconSvg({ pine = PINE, paper = PAPER } = {}) {
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Service Stars">'
    + `<rect width="512" height="512" fill="${pine}"/>`
    + `<rect x="70" y="70" width="372" height="372" rx="30" fill="none" stroke="${paper}" stroke-width="12"/>`
    + `<path d="${starPath()}" fill="${paper}"/>`
    + '</svg>\n';
}

// ------------------------------------------------------------- rasterizer ---
const SS = 4; // supersampling grid per axis — 16 coverage samples per pixel

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** size x size RGB buffer: `paper` mark over a `pine` ground, antialiased. */
function rasterize(size, pine = PINE, paper = PAPER) {
  const bg = hexToRgb(pine);
  const fg = hexToRgb(paper);
  const scale = 512 / size;
  const out = Buffer.alloc(size * size * 3);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          if (inMark((px + (sx + 0.5) / SS) * scale, (py + (sy + 0.5) / SS) * scale)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const i = (py * size + px) * 3;
      for (let c = 0; c < 3; c++) out[i + c] = Math.round(bg[c] + (fg[c] - bg[c]) * a);
    }
  }
  return out;
}

// ---------------------------------------------------------- PNG container ---
let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c;
  }
  return CRC_TABLE;
}
function crc32(buf) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 8-bit truecolour PNG, filter 0 on every row (flat colour compresses fine). */
function encodePng(size, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const stride = size * 3;
  const raw = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Keyed by size + colours; the common case never rasterizes twice.
const cache = new Map();
function iconPng(size, pine = PINE, paper = PAPER) {
  const key = `${size}|${pine}|${paper}`;
  let png = cache.get(key);
  if (!png) {
    png = encodePng(size, rasterize(size, pine, paper));
    cache.set(key, png);
  }
  return png;
}

module.exports = {
  PINE, PAPER, BOX, STAR,
  starVertices, starPath, iconSvg, inMark, rasterize, encodePng, iconPng, _cache: cache,
};
