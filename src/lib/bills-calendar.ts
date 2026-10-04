import { ROLES, type Role } from "./constants";

/**
 * Who sees repeating bills on the calendar.
 *
 * The owner's choice, by role, kept on the business as a comma-separated list
 * (a string because SQLite has no lists). Owners, admins and managers to
 * start: the roles that can already see expenses. A role without access to
 * expenses can be given the calendar too, and then sees a bill's name and
 * date but never its amount.
 *
 * Pure and client-safe: the settings form reads it in the browser.
 */

/** Read from the column: known roles only, once each, in rank order. */
export function parseBillRoles(value: string | null | undefined): Role[] {
  const listed = new Set((value ?? "").split(",").map((part) => part.trim()));
  return ROLES.filter((role) => listed.has(role));
}

export function serializeBillRoles(roles: readonly string[]): string {
  return parseBillRoles(roles.join(",")).join(",");
}

export function seesBillsOnCalendar(role: string, setting: string | null | undefined) {
  return (parseBillRoles(setting) as string[]).includes(role);
}

/** The category filter's value for bills, beside the job categories. */
export const BILLS_FILTER = "BILLS";
