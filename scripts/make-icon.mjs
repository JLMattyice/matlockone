import fs from "node:fs";
import path from "node:path";

import sharp from "sharp";

/**
 * Generates the application icons: the desktop app's, the browser tab's, and
 * the ones a phone puts on its home screen when Matlock One is added there.
 *
 * All but one are cut from a single picture, favicon/source.png. To change the
 * icon, replace that file and re-run (`npm run icons`). The picture may be any
 * shape; the middle square of it is used, so keep what matters there. The one
 * exception is the browser tab, which is a bold MO on the picture's green —
 * see tabIcon().
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

/**
 * The browser tab's icon: a bold white MO on the picture's green, in the same
 * rounded outline as the others.
 *
 * Not cut from the picture, because a tab shows it at 16 pixels, where the
 * wordmark shrinks to a grey smudge. Drawn as shapes rather than set in a
 * font, so it comes out the same on every machine that runs this — fonts
 * differ between them, and the Mac desktop build runs it too.
 *
 * On the 256 grid: both letters 100 tall on the middle line, 18 in from the
 * outline on either side. The M's diagonals meet on the baseline, as a bold
 * M's do, so it still reads as an M when it is five pixels wide.
 */
async function tabIcon(size) {
  // Taken from the picture's corner, so a new picture brings its colour here.
  const [r, g, b] = await sharp(SOURCE)
    .extract({ left: 0, top: 0, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer();

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">` +
    `<rect x="12" y="12" width="232" height="232" rx="56" fill="rgb(${r},${g},${b})"/>` +
    `<path fill="#fff" d="M30 178V78h24l22 48 22-48h24v100H98v-48l-22 48-22-48v48z"/>` +
    `<ellipse cx="180" cy="128" rx="34" ry="39" fill="none" stroke="#fff" stroke-width="24"/>` +
    `</svg>`;

  return sharp(Buffer.from(svg))
    .ensureAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: false })
    .toBuffer();
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
write("src/app/icon.png", await tabIcon(64));
write("src/app/apple-icon.png", await icon(180, { fullBleed: true }));

console.log(`icons written:\n  ${written.join("\n  ")}`);
