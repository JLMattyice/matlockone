"use server";

import { redirect } from "next/navigation";

import { logout } from "@/lib/auth";

/**
 * From the demo to a real account.
 *
 * Signs the visitor out of the demo first: sign-up is only reachable signed
 * out, since middleware sends a signed-in visitor on /signup to their
 * dashboard — which for a demo visitor is the demo again.
 *
 * Deliberately not behind requireContext, which would turn this away as a
 * submission from the demo. Leaving is the one thing the demo must allow.
 */
export async function leaveDemoForSignup() {
  await logout();
  redirect("/signup?from=demo");
}
