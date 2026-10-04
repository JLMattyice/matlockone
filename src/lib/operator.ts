import "server-only";

import { notFound } from "next/navigation";

import { requireContext, type AppContext } from "./auth";
import type { ConfigEnv } from "./config";

/**
 * Who runs Matlock One itself — not a business on it, but the person who
 * sells it — and so may see every business that has signed up.
 *
 * Named by sign-in email in OPERATOR_EMAILS (comma-separated), set in the
 * hosting environment and nowhere else: no screen grants it, no database row
 * holds it, and a business owner cannot reach it by any role. Unset, nobody
 * is an operator, which is what a desktop install and every test get.
 */
export function operatorEmails(env: ConfigEnv = process.env): string[] {
  return (env.OPERATOR_EMAILS ?? "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isOperator(
  email: string | null | undefined,
  env: ConfigEnv = process.env,
): boolean {
  if (!email) return false;
  return operatorEmails(env).includes(email.trim().toLowerCase());
}

/**
 * Page guard for the operator's screens. Anybody else gets a plain 404 rather
 * than "not allowed", so the page does not tell a customer that it exists.
 */
export async function requireOperator(): Promise<AppContext> {
  const ctx = await requireContext();
  if (!isOperator(ctx.user.email)) notFound();
  return ctx;
}
