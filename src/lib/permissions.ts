import { ROLE_RANK, type Role } from "./constants";

/**
 * Role-based access control.
 *
 * Permissions are checked in three places and all three matter:
 *   1. `middleware.ts` — keeps a signed-out visitor off the app entirely.
 *   2. Navigation — hides sections a role cannot open.
 *   3. Every server action / route handler — the only check that is load-bearing.
 * UI hiding is a convenience; never the enforcement point.
 */

export const PERMISSIONS = [
  "clients:read",
  "clients:write",
  "clients:delete",

  "leads:read",
  "leads:write",

  "jobs:read", // scoped: EMPLOYEE only sees jobs assigned to them
  "jobs:read:all",
  "jobs:write",
  "jobs:delete",
  "jobs:assign",
  "jobs:log-time",

  "schedule:read",
  "schedule:write",

  "estimates:read",
  "estimates:write",
  "estimates:send",
  "estimates:delete",

  "invoices:read",
  "invoices:write",
  "invoices:send",
  "invoices:delete",

  "payments:read",
  "payments:record",

  "expenses:read",
  "expenses:write",
  "expenses:delete",

  "employees:read",
  "employees:write",

  "files:read",
  "files:write",

  "reports:read",
  "settings:read",
  "settings:write",
  "org:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const MANAGER_PERMISSIONS: Permission[] = [
  "clients:read",
  "clients:write",
  "leads:read",
  "leads:write",
  "jobs:read",
  "jobs:read:all",
  "jobs:write",
  "jobs:assign",
  "jobs:log-time",
  "schedule:read",
  "schedule:write",
  "estimates:read",
  "estimates:write",
  "estimates:send",
  "invoices:read",
  "invoices:write",
  "invoices:send",
  "payments:read",
  "payments:record",
  "expenses:read",
  "expenses:write",
  "employees:read",
  "files:read",
  "files:write",
  "reports:read",
  "settings:read",
];

const EMPLOYEE_PERMISSIONS: Permission[] = [
  "clients:read",
  "jobs:read",
  "jobs:log-time",
  "schedule:read",
  "files:read",
  "files:write",
];

const ADMIN_PERMISSIONS: Permission[] = PERMISSIONS.filter(
  (p) => p !== "org:manage",
);

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: ADMIN_PERMISSIONS,
  MANAGER: MANAGER_PERMISSIONS,
  EMPLOYEE: EMPLOYEE_PERMISSIONS,
};

export type Actor = { role: Role; id?: string };

export function can(actor: Actor | null | undefined, permission: Permission) {
  if (!actor) return false;
  return ROLE_PERMISSIONS[actor.role].includes(permission);
}

export function canAny(
  actor: Actor | null | undefined,
  permissions: Permission[],
) {
  return permissions.some((p) => can(actor, p));
}

export class PermissionError extends Error {
  constructor(public readonly permission: Permission) {
    super(`Missing permission: ${permission}`);
    this.name = "PermissionError";
  }
}

/** Throws when the actor lacks the permission. Use in every mutating action. */
export function assertCan(actor: Actor | null | undefined, permission: Permission) {
  if (!can(actor, permission)) throw new PermissionError(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * True when `actor` may edit a teammate holding `targetRole`.
 * You can never edit someone at or above your own rank — except an OWNER,
 * who can edit anyone in their organization including other owners.
 */
export function canManageRole(actor: Actor, targetRole: Role) {
  if (!can(actor, "employees:write")) return false;
  if (actor.role === "OWNER") return true;
  return ROLE_RANK[actor.role] > ROLE_RANK[targetRole];
}

/** Roles the actor is allowed to hand out when creating or editing a user. */
export function assignableRoles(actor: Actor): Role[] {
  if (actor.role === "OWNER") return ["OWNER", "ADMIN", "MANAGER", "EMPLOYEE"];
  if (actor.role === "ADMIN") return ["MANAGER", "EMPLOYEE"];
  return [];
}

/**
 * Employees only see work assigned to them. Spread into a Prisma `where` on Job
 * so the restriction lives in the query rather than in a post-filter.
 */
export function jobVisibilityWhere(actor: Actor) {
  if (can(actor, "jobs:read:all")) return {};
  return { assignments: { some: { userId: actor.id ?? "" } } };
}
