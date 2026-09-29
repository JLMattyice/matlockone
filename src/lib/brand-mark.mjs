/**
 * Matlock One's MO mark: the browser tab's icon, and the badge beside the name
 * on the sign-in and billing screens. One drawing for both, so the badge a
 * person reads and the tab they come back to are the same thing.
 *
 * Plain JavaScript so scripts/make-icon.mjs can import it without a build step.
 * Everything is on a 256 grid.
 */

/** The icon picture's green, which is also the studio's forest (`--forest`). */
export const MARK_GREEN = "#0f3d2e";

/** The rounded square the letters sit in: the outline every icon shares. */
export const MARK_OUTLINE = { x: 12, y: 12, size: 232, radius: 56 };

/**
 * Both letters are 100 tall on the middle line, 18 in from the outline on
 * either side. The M's diagonals meet on the baseline, as a bold M's do, so it
 * still reads as an M when it is five pixels wide.
 */
export const MARK_M = "M30 178V78h24l22 48 22-48h24v100H98v-48l-22 48-22-48v48z";
export const MARK_O = { cx: 180, cy: 128, rx: 34, ry: 39, stroke: 24 };

/** The whole mark as SVG, drawn at `size` pixels, for the icon generator. */
export function markSvg(size) {
  const { x, y, size: side, radius } = MARK_OUTLINE;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">` +
    `<rect x="${x}" y="${y}" width="${side}" height="${side}" rx="${radius}" fill="${MARK_GREEN}"/>` +
    `<path fill="#fff" d="${MARK_M}"/>` +
    `<ellipse cx="${MARK_O.cx}" cy="${MARK_O.cy}" rx="${MARK_O.rx}" ry="${MARK_O.ry}" ` +
    `fill="none" stroke="#fff" stroke-width="${MARK_O.stroke}"/>` +
    `</svg>`
  );
}
