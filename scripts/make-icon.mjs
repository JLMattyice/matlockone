import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Generates the application icon.
 *
 * Written as code rather than shipped as a binary so the mark can follow the
 * product's colour without a design tool in the loop — change BRAND and re-run.
 * Windows accepts a PNG payload inside an .ico, so one image covers every size
 * the shell asks for. It is drawn at 512 because that is the smallest source
 * electron-builder will turn into a macOS .icns; Windows downsamples happily.
 */

const SIZE = 512;
/** Everything below is authored against a 256 grid and scaled from it. */
const S = SIZE / 256;
const BRAND = [15, 118, 110]; // #0f766e, the demo organisation's teal
const INK = [255, 255, 255];

/** Rounded-square mask, so the icon sits correctly among modern app icons. */
function insideSquircle(x, y) {
  const radius = 56 * S;
  const min = 12 * S;
  const max = SIZE - 12 * S;

  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);

  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

/** Squared distance from a point to a line segment. */
function distanceToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const lengthSquared = dx * dx + dy * dy;

  // Where along the segment the nearest point falls, clamped to its ends so
  // the stroke has flat caps rather than running past the corners.
  const t = Math.max(
    0,
    Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lengthSquared),
  );

  const nx = x0 + t * dx;
  const ny = y0 + t * dy;

  return (px - nx) ** 2 + (py - ny) ** 2;
}

/**
 * A bold "M" for Matlock One, drawn as a thick polyline.
 *
 * A stroked path rather than rectangles because the letter's diagonals cannot
 * be made from axis-aligned bars, and a stroke keeps even weight at 16px where
 * an outlined glyph would smear.
 *
 * Geometrically the "W" this replaced, mirrored about the glyph's horizontal
 * axis. That keeps every join a clean apex — vertical outer stems would meet
 * the diagonals at a right angle, and flat caps leave a visible notch there.
 */
function insideMark(x, y) {
  const points = [
    [70, 186],
    [100, 74],
    [128, 142],
    [156, 74],
    [186, 186],
  ].map(([px, py]) => [px * S, py * S]);

  const halfWidth = 13 * S;

  for (let i = 0; i < points.length - 1; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    if (distanceToSegment(x, y, x0, y0, x1, y1) <= halfWidth ** 2) return true;
  }

  return false;
}

function renderPixels() {
  // One filter byte (0 = none) then RGBA per pixel, per scanline.
  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4));
  let offset = 0;

  for (let y = 0; y < SIZE; y++) {
    raw[offset++] = 0;

    for (let x = 0; x < SIZE; x++) {
      const inSquare = insideSquircle(x, y);
      const inMark = inSquare && insideMark(x, y);
      const [r, g, b] = inMark ? INK : BRAND;

      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = inSquare ? 255 : 0;
    }
  }

  return raw;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);

  return Buffer.concat([length, body, crc]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

function encodePng(raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Wraps the PNG in a single-image .ico directory. */
function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image

  const entry = Buffer.alloc(16);
  entry[0] = 0; // 0 means 256
  entry[1] = 0;
  entry[2] = 0; // palette unused
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32BE(0, 8);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

const buildDir = path.join(process.cwd(), "build");
fs.mkdirSync(buildDir, { recursive: true });

const png = encodePng(renderPixels());
fs.writeFileSync(path.join(buildDir, "icon.png"), png);
fs.writeFileSync(path.join(buildDir, "icon.ico"), encodeIco(png));

console.log(`icon written to build/  (${(png.length / 1024).toFixed(1)} KB)`);
