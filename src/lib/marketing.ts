import { ROLES, ROLE_META, type Role, type Tone } from "./constants";
import {
  NAVIGATION,
  resolveLabel,
  type NavIcon,
  type OrgLabels,
} from "./navigation";
import { PERMISSIONS, can, permissionsFor } from "./permissions";

/**
 * Facts the marketing site states about roles, derived from the same matrix
 * the application enforces.
 *
 * The landing page claims that an Employee loses most of the navigation and
 * every financial screen. That claim is not written down anywhere in the copy —
 * it is computed here from `NAVIGATION` and `can()`. Widen a role in
 * `permissions.ts` and the page narrows its own boast on the next request.
 * A marketing number that has to be updated by hand is a marketing number that
 * eventually lies.
 */

/**
 * The demo business in the frame uses stock terminology. A real organization
 * renames these in Settings, which is the point of `resolveLabel`.
 */
const DEMO_LABELS: OrgLabels = {
  jobSingular: "Job",
  jobPlural: "Jobs",
  clientSingular: "Client",
  clientPlural: "Clients",
};

export type RoleNavItem = { label: string; icon: NavIcon; allowed: boolean };
export type RoleNavGroup = { title: string; items: RoleNavItem[] };
export type RoleAbility = { label: string; allowed: boolean };

export type RoleView = {
  role: Role;
  label: string;
  tone: Tone;
  description: string;
  /**
   * Every navigation item, each flagged. The real sidebar omits what a role
   * cannot open; here the rows stay and dim, because a visitor has to see the
   * thing leave to believe it was ever there.
   */
  groups: RoleNavGroup[];
  visibleCount: number;
  hiddenCount: number;
  hiddenLabels: string[];
  /** The dashboard's own test for whether the money tiles render. */
  seesMoney: boolean;
  jobScope: "all" | "own";
  permissionCount: number;
  abilities: RoleAbility[];
};

export const TOTAL_NAV_ITEMS = NAVIGATION.reduce(
  (total, group) => total + group.items.length,
  0,
);

export const TOTAL_PERMISSIONS = PERMISSIONS.length;

/**
 * Six abilities chosen because a business owner already knows what each one
 * costs when the wrong person has it.
 */
const ABILITIES = [
  { label: "See what the company is owed", permission: "invoices:read" },
  { label: "Record a payment", permission: "payments:record" },
  { label: "Assign crew to a job", permission: "jobs:assign" },
  { label: "Read the reports", permission: "reports:read" },
  { label: "Change company settings", permission: "settings:write" },
  { label: "Transfer or delete the company", permission: "org:manage" },
] as const;

export function roleViews(): RoleView[] {
  return ROLES.map((role) => {
    const actor = { role };

    const groups: RoleNavGroup[] = NAVIGATION.map((group) => ({
      title: group.title,
      items: group.items.map((item) => ({
        label: resolveLabel(item, DEMO_LABELS),
        icon: item.icon,
        allowed: can(actor, item.permission),
      })),
    }));

    const items = groups.flatMap((group) => group.items);
    const hidden = items.filter((item) => !item.allowed);

    return {
      role,
      label: ROLE_META[role].label,
      tone: ROLE_META[role].tone,
      description: ROLE_META[role].description ?? "",
      groups,
      visibleCount: items.length - hidden.length,
      hiddenCount: hidden.length,
      hiddenLabels: hidden.map((item) => item.label),
      // Mirrors dashboard/queries.ts, which gates the money tiles on exactly this.
      seesMoney: can(actor, "invoices:read"),
      jobScope: can(actor, "jobs:read:all") ? "all" : "own",
      permissionCount: permissionsFor(role).length,
      abilities: ABILITIES.map((ability) => ({
        label: ability.label,
        allowed: can(actor, ability.permission),
      })),
    };
  });
}
