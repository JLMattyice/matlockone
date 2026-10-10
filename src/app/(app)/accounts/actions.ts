"use server";

import { randomInt } from "node:crypto";

import { revalidatePath } from "next/cache";

import { failed, saved, text, type ActionState } from "@/lib/action-state";
import {
  normalizeTrialCode,
  TRIAL_NOTE_MAX,
  TRIAL_USES_MAX,
  trialCodeProblem,
} from "@/lib/billing/trial-codes";
import { prisma } from "@/lib/db";
import { requireOperator } from "@/lib/operator";
import { parseDateTimeLocal, todayIn } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

/**
 * Making and switching off free-month codes, from the Accounts page. Only
 * OPERATOR_EMAILS may: anybody else gets the same 404 the page gives them.
 */

const ACCOUNTS_PATH = "/accounts";

// No 0/O or 1/I/L, so a code read out over the phone cannot be misheard.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function madeUpCode(): string {
  let tail = "";
  for (let i = 0; i < 6; i++) tail += ALPHABET[randomInt(ALPHABET.length)];
  return `FREE-${tail}`;
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

/** The day after a "YYYY-MM-DD", the same way round. */
function dayAfter(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

export async function createTrialCode(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireOperator();

  const typed = normalizeTrialCode(text(formData, "code"));
  if (typed) {
    const problem = trialCodeProblem(typed);
    if (problem) return { ok: false, fieldErrors: { code: problem } };
  }

  const note = text(formData, "note");
  if (note && note.length > TRIAL_NOTE_MAX) {
    return { ok: false, fieldErrors: { note: `Keep it under ${TRIAL_NOTE_MAX} characters.` } };
  }

  const limit = text(formData, "maxUses");
  const maxUses = limit === null ? null : Number(limit);
  if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > TRIAL_USES_MAX)) {
    return {
      ok: false,
      fieldErrors: { maxUses: "A whole number of businesses, or leave it empty for no limit." },
    };
  }

  // "The last day it works" is a date on the operator's own clock, so the
  // code stops at the midnight that ends that day there.
  const lastDay = text(formData, "lastDay");
  let expiresAt: Date | null = null;
  if (lastDay) {
    const zone = await viewerTimeZone();
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(lastDay) && parseDateTimeLocal(lastDay, zone) !== null;
    if (!valid) return { ok: false, fieldErrors: { lastDay: "Pick a date, or leave it empty." } };
    if (lastDay < todayIn(zone)) {
      return { ok: false, fieldErrors: { lastDay: "That day has already gone." } };
    }
    expiresAt = parseDateTimeLocal(dayAfter(lastDay), zone);
  }

  // A made-up code is tried again on the rare clash; a typed one is the
  // operator's to change.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = typed || madeUpCode();
    try {
      await prisma.trialCode.create({ data: { code, note, maxUses, expiresAt } });
      revalidatePath(ACCOUNTS_PATH);
      return saved(`Made ${code}.`);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      if (typed) return { ok: false, fieldErrors: { code: "That code already exists." } };
    }
  }

  return failed("Couldn’t make a code just now. Try again.");
}

/**
 * Turning a code off, or back on. Off, it stops giving a free month at once,
 * including to businesses that entered it and have not chosen a plan yet.
 * Anybody already on their free month keeps it: that is PayPal's now.
 */
export async function setTrialCodeOn(formData: FormData) {
  await requireOperator();

  const id = text(formData, "id");
  if (!id) return;

  await prisma.trialCode.updateMany({
    where: { id },
    data: { disabledAt: formData.get("on") === "true" ? null : new Date() },
  });
  revalidatePath(ACCOUNTS_PATH);
}
