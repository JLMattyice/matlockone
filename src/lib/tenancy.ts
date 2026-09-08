import "server-only";

import { notFound } from "next/navigation";

import { requireContext } from "./auth";

/**
 * Multi-tenant guard rails.
 *
 * Every domain table carries `organizationId`. Queries must filter on it, and
 * anything fetched by a client-supplied id must be re-checked before use — an
 * id is guessable, a tenant boundary is not.
 */

/** `where: { ...(await orgScope()), status: "ACTIVE" }` */
export async function orgScope() {
  const { org } = await requireContext();
  return { organizationId: org.id };
}

export async function currentOrgId() {
  const { org } = await requireContext();
  return org.id;
}

/**
 * 404s (rather than 403s) when a row belongs to another organization, so the
 * response cannot be used to probe which ids exist in other tenants.
 */
export function assertSameOrg<T extends { organizationId: string } | null>(
  row: T,
  organizationId: string,
): NonNullable<T> {
  if (!row || row.organizationId !== organizationId) notFound();
  return row as NonNullable<T>;
}

/** Same check for callers that would rather branch than throw. */
export function belongsToOrg(
  row: { organizationId: string } | null | undefined,
  organizationId: string,
) {
  return Boolean(row && row.organizationId === organizationId);
}
