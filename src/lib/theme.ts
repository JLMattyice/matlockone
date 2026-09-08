/**
 * Light, dark, or whatever the machine is set to.
 *
 * The default is *light* rather than "follow the system". A field service app
 * is used on a laptop in an office and on a phone in a van, next to printed
 * invoices and paper worksheets, and it is handed to clients to look at. Light
 * is what people expect a business document to look like, and a great many
 * machines ship set to dark without their owner ever choosing it.
 *
 * Anyone who prefers otherwise says so once and it sticks — including
 * "System", which is still offered and still works.
 */

export const THEME_STORAGE_KEY = "fb-theme";

export const THEMES = ["light", "system", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(value: unknown): value is Theme {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/**
 * The `data-theme` attribute to put on the document, or null to leave it off
 * and let `prefers-color-scheme` decide.
 *
 * A stored value is obeyed exactly. Anything else — nobody has chosen yet, or
 * the value is unreadable — lands on light.
 */
export function themeAttribute(stored: unknown): "light" | "dark" | null {
  if (stored === "system") return null;
  if (stored === "dark") return "dark";
  return "light";
}

/** Which button in the toggle should read as selected. */
export function initialTheme(stored: unknown): Theme {
  return isTheme(stored) ? stored : "light";
}
