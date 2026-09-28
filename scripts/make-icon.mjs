import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * Generates the application icons: the desktop app's, and the ones a phone
 * puts on its home screen when Matlock One is added there.
 *
 * Written as code rather than shipped as a binary so the mark can follow the
 * product's colour without a design tool in the loop — change BRAND and re-run
 * (`npm run icons`). One drawing, at every size and in two shapes:
 *
 * - rounded, with see-through corners: the desktop app, the browser tab, and
 *   Android's ordinary icon;
 * - full bleed: iOS rounds the corners itself (see-through ones come out
 *   black), and Android's "maskable" icon is cropped to whatever shape the
 *   phone uses. The mark sits well inside the middle 80% both of those keep.
 *
 * Windows accepts a PNG payload inside an .ico, so one image covers every size
 * the shell asks for. The desktop icon is drawn at 512 because that is the
 * smallest source electron-builder will turn into a macOS .icns.
 *
 * Edges are smoothed by sampling each pixel 4×4 times; without that, the
 * diagonals of the M come out stepped at the 180px an iPhone shows.
 */

const BRAND = [15, 118, 110]; // #0f766e, the teal the desktop app has always had
const INK = [255, 255, 255];
const SAMPLES = 4;

/** Everything is authored against a 256 grid; x and y here are in it. */
function insideSquircle(x, y) {
  const radius = 56;
  const min = 12;
  const max = 256 - 12;

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
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / lengthSquared));

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
const MARK = [
  [70, 186],
  [100, 74],
  [128, 142],
  [156, 74],
  [186, 186],
];
const HALF_WIDTH = 13;

function insideMark(x, y) {
  for (let i = 0; i < MARK.length - 1; i++) {
    const [x0, y0] = MARK[i];
    const [x1, y1] = MARK[i + 1];
    if (distanceToSegment(x, y, x0, y0, x1, y1) <= HALF_WIDTH ** 2) return true;
  }
  return false;
}

/** RGBA scanlines, each led by its filter byte (0 = none), as PNG wants. */
function renderPixels(size, { fullBleed }) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const scale = 256 / size;
  const total = SAMPLES * SAMPLES;
  let offset = 0;

  for (let py = 0; py < size; py++) {
    raw[offset++] = 0;

    for (let px = 0; px < size; px++) {
      let shape = 0;
      let mark = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * scale;
          const y = (py + (sy + 0.5) / SAMPLES) * scale;
          const inShape = fullBleed || insideSquircle(x, y);
          if (!inShape) continue;
          shape++;
          if (insideMark(x, y)) mark++;
        }
      }

      // Colour is the mix within the shape; the shape's own edge is alpha.
      const ink = shape ? mark / shape : 0;
      for (let c = 0; c < 3; c++) {
        raw[offset++] = Math.round(BRAND[c] * (1 - ink) + INK[c] * ink);
      }
      raw[offset++] = Math.round((shape / total) * 255);
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

function encodePng(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
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
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);

  return Buffer.concat([header, entry, png]);
}

const icon = (size, shape = { fullBleed: false }) => encodePng(size, renderPixels(size, shape));

const root = process.cwd();
const written = [];
function write(relative, data) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  written.push(`${relative} (${(data.length / 1024).toFixed(1)} KB)`);
}

// The desktop app. build/ is git-ignored; desktop:pack runs this first.
const desktop = icon(512);
write("build/icon.png", desktop);
write("build/icon.ico", encodeIco(desktop));

// The website and the home screen, committed so a deploy serves them.
write("public/icons/icon-192.png", icon(192));
write("public/icons/icon-512.png", icon(512));
write("public/icons/maskable-512.png", icon(512, { fullBleed: true }));
// Next links these two by their names: the browser tab, and the iPhone's
// home screen (full bleed, since iOS rounds the corners itself).
write("src/app/icon.png", icon(64));
write("src/app/apple-icon.png", icon(180, { fullBleed: true }));

console.log(`icons written:\n  ${written.join("\n  ")}`);
