import { hasLicenseKey, licensePublicKey } from "./public-key";
import {
  verifyLicense,
  type LicenseClaims,
  type VerifyFailure,
} from "./token";

/**
 * What a workspace is allowed to do, and why.
 *
 * One place answers this, so a limit can never be enforced in one screen and
 * forgotten in another. Everything here is derived from the licence; nothing
 * calls out to a server.
 *
 * The important design choice: an unlicensed workspace is *limited*, never
 * locked. Someone who installs this and finds a dead screen has learnt nothing
 * about the software and has no reason to come back. Someone who finds a
 * working workspace that stops at three people knows exactly what they would be
 * buying.
 */

/** Active users allowed with no valid licence. */
export const DEMO_SEATS = 3;

export type LicenseState =
  | { kind: "licensed"; license: LicenseClaims; seats: number | null }
  | {
      kind: "demo";
      /** Absent when the workspace has never had a licence. */
      reason?: VerifyFailure;
      message?: string;
      seats: number;
    };

/**
 * Resolves the licence on an organization.
 *
 * A key that fails verification degrades to demo rather than throwing: a
 * corrupted or expired licence must not take the business's own records down
 * with it. The reason travels with the result so the UI can say something
 * specific instead of "unlicensed".
 */
export function licenseState(
  licenseKey: string | null | undefined,
  now: Date = new Date(),
): LicenseState {
  if (!licenseKey || !licenseKey.trim()) {
    return { kind: "demo", seats: DEMO_SEATS };
  }

  // A build with no public key compiled in cannot verify anything. Treating
  // that as "licensed" would make the check trivially bypassable by shipping a
  // build without a key, so it degrades to demo like any other failure.
  if (!hasLicenseKey()) {
    return {
      kind: "demo",
      reason: "bad-signature",
      message: "This build cannot check licences.",
      seats: DEMO_SEATS,
    };
  }

  const result = verifyLicense(licenseKey, licensePublicKey(), now);

  if (!result.ok) {
    return {
      kind: "demo",
      reason: result.reason,
      message: result.message,
      seats: DEMO_SEATS,
    };
  }

  // A licence issued in demo mode is still a licence — it just carries the
  // limits it was issued with rather than the demo defaults.
  return {
    kind: "licensed",
    license: result.license,
    seats: result.license.seats,
  };
}

/** Active users this workspace may have, or null for unlimited. */
export function seatLimit(state: LicenseState): number | null {
  return state.kind === "licensed" ? state.seats : state.seats;
}

export type SeatCheck =
  | { ok: true }
  | { ok: false; limit: number; active: number; message: string };

/**
 * Whether one more active person may be added.
 *
 * Deliberately a check on the *transition*, never on the current state. A
 * workspace can legitimately sit above its limit — a licence downgrade, or a
 * demo of a business that already had five people — and the right response is
 * to stop the next addition, not to throw four employees out of the software
 * they were using this morning. Nothing here ever deactivates anyone.
 */
export function canAddActiveUser(
  state: LicenseState,
  activeCount: number,
): SeatCheck {
  const limit = seatLimit(state);
  if (limit === null || activeCount < limit) return { ok: true };

  const plan =
    state.kind === "licensed"
      ? `Your ${state.license.plan} licence covers ${limit} ${limit === 1 ? "person" : "people"}.`
      : `Demo mode covers ${limit} people.`;

  return {
    ok: false,
    limit,
    active: activeCount,
    message:
      `${plan} You have ${activeCount} active. ` +
      (state.kind === "licensed"
        ? "Move to a larger plan, or deactivate someone first."
        : "Enter a licence key, or deactivate someone first."),
  };
}

/** Short label for the banner and the activation screen. */
export function licenseSummary(state: LicenseState): string {
  if (state.kind === "demo") {
    if (state.reason === "expired") return "Licence expired";
    if (state.reason) return "Licence not valid";
    return "Demo mode";
  }

  const seats =
    state.seats === null
      ? "unlimited people"
      : `${state.seats} ${state.seats === 1 ? "person" : "people"}`;

  return `${state.license.plan[0].toUpperCase()}${state.license.plan.slice(1)} · ${seats}`;
}

/** Days until expiry, or null when unlicensed. Negative once past. */
export function daysRemaining(
  state: LicenseState,
  now: Date = new Date(),
): number | null {
  if (state.kind !== "licensed") return null;
  return Math.floor((state.license.exp * 1000 - now.getTime()) / 86_400_000);
}
