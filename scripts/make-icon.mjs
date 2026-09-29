import fs from "node:fs";
import path from "node:path";

import sharp from "sharp";

/**
 * Generates the application icons: the desktop app's, the browser tab's, and
 * the ones a phone puts on its home screen when Matlock One is added there.
 *
 * Every one of them is cut from a single picture, favicon/source.png. To change
 * the icon, replace that file and re-run (`npm run icons`). The picture may be
 * any shape; the middle square of it is used, so keep what matters there.
 *
 * Each size comes in one of two shapes:
 *
 * - rounded, with see-through corners: the desktop app, the browser tab, and
 *   Android's ordinary icon;
 * - full bleed: iOS rounds the corners itself (see-through ones come out
 *   black), and Android's "maskable" icon is cropped to whatever shape the
 *   phone uses, so what matters has to sit inside the middle 80% of it.
 *
 * Windows accepts a PNG payload inside an .ico, so one image covers every size
 * the shell asks for. The desktop icon is drawn at 512 because that is the
 * smallest source electron-builder will turn into a macOS .icns.
 */

const SOURCE = "favicon/source.png";

/**
 * The rounded shape, authored against a 256 grid: a square inset 12 on each
 * side with corners of radius 56 — the same outline the desktop app has always
 * had, so the new icon sits where the old one did.
 */
function roundedMask(size) {
  const unit = size / 256;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<rect x="${12 * unit}" y="${12 * unit}" width="${232 * unit}" height="${232 * unit}" ` +
      `rx="${56 * unit}" fill="#fff"/></svg>`,
  );
}

async function icon(size, { fullBleed } = { fullBleed: false }) {
  let image = sharp(SOURCE).resize(size, size, { fit: "cover", position: "centre" }).ensureAlpha();
  if (!fullBleed) image = image.composite([{ input: roundedMask(size), blend: "dest-in" }]);
  // RGBA with no row filters: tests/mobile.test.ts reads the corner's alpha
  // straight out of the pixel data.
  return image.png({ compressionLevel: 9, adaptiveFiltering: false }).toBuffer();
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

const root = process.cwd();
const written = [];
function write(relative, data) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  written.push(`${relative} (${(data.length / 1024).toFixed(1)} KB)`);
}

// The desktop app. build/ is git-ignored; desktop:pack runs this first.
const desktop = await icon(512);
write("build/icon.png", desktop);
write("build/icon.ico", encodeIco(desktop));

// The website and the home screen, committed so a deploy serves them.
write("public/icons/icon-192.png", await icon(192));
write("public/icons/icon-512.png", await icon(512));
write("public/icons/maskable-512.png", await icon(512, { fullBleed: true }));
// Next links these two by their names: the browser tab, and the iPhone's
// home screen (full bleed, since iOS rounds the corners itself).
write("src/app/icon.png", await icon(64));
write("src/app/apple-icon.png", await icon(180, { fullBleed: true }));

console.log(`icons written:\n  ${written.join("\n  ")}`);
