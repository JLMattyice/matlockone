/**
 * Job checklists: the reusable lists a business keeps on Settings →
 * Checklists, and the items copied from them onto a job.
 *
 * The owner chose "track only": items are ticked off in the field and shown
 * on the job, and an open item never stops a job being completed.
 *
 * Pure and client-safe: the settings form reads the examples and the limits
 * in the browser.
 */

export const CHECKLIST_NAME_MAX = 80;
export const CHECKLIST_ITEM_MAX = 200;
/** Items on one saved checklist, and on one job. */
export const CHECKLIST_MAX_ITEMS = 60;
export const MAX_CHECKLISTS = 50;

/**
 * Splits pasted or typed text into items, one per line.
 *
 * People paste lists from wherever they kept them, so the marks those lists
 * come with — "-", "*", "•", "[ ]", "1." — are dropped rather than kept as
 * part of the item. Blank lines go, and so does a line repeated exactly.
 */
export function parseChecklistLines(text: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw
      .replace(/^\s*(?:[-*•–]|\[\s?[xX]?\s?\]|\d{1,3}[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, CHECKLIST_ITEM_MAX);
    if (!line) continue;
    const key = line.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(line);
  }
  return items;
}

/** A saved checklist's items, read back from its column. */
export function readChecklistItems(value: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "")
      : [];
  } catch {
    return [];
  }
}

/** Ready-made lists to start from, so the screen is never a blank page. */
export const CHECKLIST_EXAMPLES: { name: string; items: string[] }[] = [
  {
    name: "Job wrap-up",
    items: [
      "Before photos taken",
      "Work done as quoted",
      "After photos taken",
      "Site cleaned up, debris hauled off",
      "Walked the customer through the work",
    ],
  },
  {
    name: "HVAC service visit",
    items: [
      "Replace or clean the filter",
      "Check refrigerant pressures",
      "Clean the condenser coil",
      "Test the thermostat",
      "Check electrical connections",
      "Flush the condensate drain",
    ],
  },
  {
    name: "Move-out clean",
    items: [
      "Inside the oven and fridge",
      "Cabinets wiped inside and out",
      "Bathrooms scrubbed",
      "Baseboards and window sills",
      "Floors vacuumed and mopped",
      "Trash taken out",
    ],
  },
];
