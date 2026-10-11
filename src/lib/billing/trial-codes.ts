/**
 * Free-month codes: the operator makes them on the Accounts page and hands
 * them out, and a business that enters one gets a month of Matlock One free,
 * without paying or giving any payment details.
 *
 * Choosing a plan with a working code opens the business on that plan for a
 * month straight away; PayPal is not involved. Before the month is up the
 * business chooses a plan to keep going, and that plan's first payment waits
 * until the free month ends (restartDate in subscription.ts). If it does not,
 * the business locks when the month runs out, like any plan that ends.
 *
 * Pure, so every rule is tested without a database or a clock. Nothing from
 * Node either: the Accounts page's form reads the limits below in the browser.
 */

export const TRIAL_CODE_MIN = 3;
export const TRIAL_CODE_MAX = 24;
export const TRIAL_NOTE_MAX = 120;
/** A limit past this is a typo for "no limit". */
export const TRIAL_USES_MAX = 10_000;

const SHAPE = /^[A-Z0-9-]+$/;

/**
 * What somebody typed, as it is kept: capitals, no spaces. "friend 30" and
 * "Friend30 " are the same code as "FRIEND30", because a code read out over
 * the phone or copied out of a text message should not fail on its case.
 */
export function normalizeTrialCode(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, "").toUpperCase();
}

/** Why a code cannot be made as typed, or null when it can. */
export function trialCodeProblem(code: string): string | null {
  if (code.length < TRIAL_CODE_MIN || code.length > TRIAL_CODE_MAX || !SHAPE.test(code)) {
    return `Use ${TRIAL_CODE_MIN} to ${TRIAL_CODE_MAX} letters, numbers or dashes.`;
  }
  return null;
}

export type TrialCodeFields = {
  maxUses: number | null;
  expiresAt: Date | null;
  disabledAt: Date | null;
};

export type TrialCodeState = "live" | "off" | "ended" | "used-up";

export const TRIAL_CODE_STATE_META: Record<
  TrialCodeState,
  { label: string; tone: "success" | "neutral" | "warning" }
> = {
  live: { label: "Live", tone: "success" },
  "used-up": { label: "Used up", tone: "warning" },
  ended: { label: "Ended", tone: "neutral" },
  off: { label: "Off", tone: "neutral" },
};

/**
 * Whether the code still gives a free month to a business that holds it.
 *
 * Turning a code off or reaching its end stops it at once, for businesses
 * that entered it and have not chosen a plan yet as much as for anybody new.
 * Reaching its limit does not: the businesses that used up the limit are the
 * ones it was for.
 */
export function trialCodeLive(code: TrialCodeFields, now: Date = new Date()): boolean {
  if (code.disabledAt) return false;
  return !code.expiresAt || code.expiresAt.getTime() > now.getTime();
}

/** Where a code stands, for the Accounts page. uses: businesses that entered it. */
export function trialCodeState(
  code: TrialCodeFields,
  uses: number,
  now: Date = new Date(),
): TrialCodeState {
  if (code.disabledAt) return "off";
  if (code.expiresAt && code.expiresAt.getTime() <= now.getTime()) return "ended";
  if (code.maxUses !== null && uses >= code.maxUses) return "used-up";
  return "live";
}

type FirstPlanFields = {
  subscriptionId: string | null;
  trialEndsAt: Date | null;
  isDemo: boolean;
  billingExempt: boolean;
};

/**
 * Only a business's first plan: one that has ever held a subscription, or
 * already had a free month, has had its first month. Never the demo or an
 * exempt business, which are not billed at all.
 */
export function canTakeTrial(org: FirstPlanFields): boolean {
  return !org.isDemo && !org.billingExempt && org.subscriptionId === null && org.trialEndsAt === null;
}

/** When a free month started now ends: the same day next month. */
export function freeMonthEnds(now: Date = new Date()): Date {
  const end = new Date(now);
  const day = end.getUTCDate();
  end.setUTCMonth(end.getUTCMonth() + 1);
  // January 31st plus a month is the end of February, not March 3rd.
  if (end.getUTCDate() !== day) end.setUTCDate(0);
  return end;
}

export type ApplyRefusal = "unknown" | "off" | "ended" | "used-up" | "not-first";

/** What the billing screen says for each refusal. Fixed text, never the code itself. */
export const APPLY_REFUSALS: Record<ApplyRefusal, string> = {
  unknown: "That code isn’t one we know. Check the spelling and try again.",
  off: "That code is no longer active.",
  ended: "That code has ended.",
  "used-up": "That code has been used as many times as it allows.",
  "not-first": "Codes are for a business’s first plan, so this one can’t be used here.",
};

/**
 * Why a business cannot enter this code now, or null when it can.
 *
 * usesByOthers leaves out the business asking, so entering the same code a
 * second time is never refused for the room it already takes up.
 */
export function applyRefusal(
  org: FirstPlanFields,
  code: TrialCodeFields | null,
  usesByOthers: number,
  now: Date = new Date(),
): ApplyRefusal | null {
  if (!code) return "unknown";
  if (!canTakeTrial(org)) return "not-first";

  const state = trialCodeState(code, usesByOthers, now);
  return state === "live" ? null : state;
}

/** Whether a business choosing a plan starts a free month on it instead of paying. */
export function trialOfferApplies(
  org: FirstPlanFields,
  code: TrialCodeFields | null,
  now: Date = new Date(),
): boolean {
  return code !== null && canTakeTrial(org) && trialCodeLive(code, now);
}

/** "12 of 20", "3" — a code's uses, for the Accounts page. */
export function usesLabel(uses: number, maxUses: number | null): string {
  return maxUses === null ? String(uses) : `${uses} of ${maxUses}`;
}
