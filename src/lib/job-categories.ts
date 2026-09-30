import {
  asStatus,
  CATEGORY_ICONS,
  JOB_KIND_ICONS,
  JOB_KIND_META,
  JOB_KINDS,
  jobKindLabel,
  type CategoryIcon,
  type JobKind,
} from "@/lib/constants";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Calendar categories: the built-in kinds, plus the ones a business adds on
 * Settings → Calendar.
 *
 * A picker or a filter carries one value for either sort. A built-in is its
 * kind ("LAUNCH"); a business's own is "category:<id>". Kinds are upper case
 * and ids are cuids, so the prefix is not strictly needed to tell them apart,
 * but a value that says what it is survives being read in a URL.
 *
 * Pure and client-safe: the job form and the calendar use it in the browser.
 */

const PREFIX = "category:";

/** A business's own category as the pages carry it. */
export type CustomCategory = {
  id: string;
  name: string;
  icon: string;
  kind: string;
};

export type CategoryChoice =
  | { kind: JobKind; categoryId: null }
  | { kind: null; categoryId: string };

export function categoryValue(entry: {
  kind: string;
  categoryId?: string | null;
}): string {
  return entry.categoryId
    ? `${PREFIX}${entry.categoryId}`
    : asStatus(JOB_KINDS, entry.kind, "JOB");
}

/** What a picker or filter value names, or null when it names nothing. */
export function parseCategoryValue(
  value: string | null | undefined,
): CategoryChoice | null {
  const raw = (value ?? "").trim();
  if (raw.startsWith(PREFIX)) {
    const id = raw.slice(PREFIX.length);
    return /^[a-z0-9]+$/i.test(id) ? { kind: null, categoryId: id } : null;
  }
  return (JOB_KINDS as readonly string[]).includes(raw)
    ? { kind: raw as JobKind, categoryId: null }
    : null;
}

/**
 * The filter for one category.
 *
 * A built-in matches only entries not filed under a category of their own:
 * a "Trade show" category stored as OTHER is not what someone filtering for
 * Other is looking for. Anything unrecognised filters nothing out, the same
 * as the other filters on those pages.
 */
export function categoryWhere(value: string | null | undefined): Prisma.JobWhereInput {
  const choice = parseCategoryValue(value);
  if (!choice) return {};
  return choice.kind !== null
    ? { kind: choice.kind, categoryId: null }
    : { categoryId: choice.categoryId };
}

/** The built-ins a business has hidden, read from its comma-separated column. */
export function parseHiddenKinds(value: string | null | undefined): JobKind[] {
  const kinds = new Set<JobKind>();
  for (const part of (value ?? "").split(",")) {
    const kind = part.trim();
    // Job is never hidden: estimates become jobs, and the app is built on them.
    if (kind !== "JOB" && (JOB_KINDS as readonly string[]).includes(kind)) {
      kinds.add(kind as JobKind);
    }
  }
  // In JOB_KINDS order, so the column is the same however it was toggled.
  return JOB_KINDS.filter((kind) => kinds.has(kind));
}

export function serializeHiddenKinds(kinds: JobKind[]): string {
  return parseHiddenKinds(kinds.join(",")).join(",");
}

export function asCategoryIcon(value: string | null | undefined): CategoryIcon {
  return asStatus(CATEGORY_ICONS, value, "tag");
}

/**
 * What to call an entry and which mark to give it.
 *
 * `plain` is an ordinary job, which the calendar and lists leave unmarked so
 * the everyday case stays quiet.
 */
export function entryCategory(
  entry: {
    kind: string;
    category?: { name: string; icon: string } | null;
  },
  jobLabel: string,
): { label: string; icon: CategoryIcon; plain: boolean } {
  if (entry.category) {
    return {
      label: entry.category.name,
      icon: asCategoryIcon(entry.category.icon),
      plain: false,
    };
  }
  const kind = asStatus(JOB_KINDS, entry.kind, "JOB");
  return {
    label: jobKindLabel(kind, jobLabel),
    icon: JOB_KIND_ICONS[kind],
    plain: kind === "JOB",
  };
}

export type CategoryOption = {
  value: string;
  label: string;
  /** For a filter list: "Launches". A business's own name is used as written. */
  plural: string;
  hint: string;
  icon: CategoryIcon;
  custom: boolean;
};

/**
 * Everything a picker or filter offers, built-ins first.
 *
 * `keep` is the value already chosen — an entry being edited, or a filter in
 * the URL. It stays on offer even when its built-in has since been hidden, so
 * opening an old entry never silently changes what it is.
 */
export function categoryOptions({
  categories,
  hiddenKinds,
  jobLabel,
  jobPlural,
  keep,
}: {
  categories: CustomCategory[];
  hiddenKinds: JobKind[];
  jobLabel: string;
  jobPlural: string;
  keep?: string | null;
}): CategoryOption[] {
  const builtIns = JOB_KINDS.filter(
    (kind) => !hiddenKinds.includes(kind) || kind === keep,
  ).map((kind) => ({
    value: kind,
    label: kind === "JOB" ? jobLabel : JOB_KIND_META[kind].label,
    plural: kind === "JOB" ? jobPlural : JOB_KIND_META[kind].plural,
    hint: kind === "JOB" ? "Billable work at a site" : JOB_KIND_META[kind].hint,
    icon: JOB_KIND_ICONS[kind],
    custom: false,
  }));

  const own = [...categories]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((category) => ({
      value: categoryValue({ kind: category.kind, categoryId: category.id }),
      label: category.name,
      plural: category.name,
      hint:
        category.kind === "JOB"
          ? `Your own category — counts toward ${jobPlural.toLowerCase()}`
          : "Your own category",
      icon: asCategoryIcon(category.icon),
      custom: true,
    }));

  return [...builtIns, ...own];
}
