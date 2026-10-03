"use server";

import { revalidatePath } from "next/cache";

import { failed, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { parseDateTimeLocal } from "@/lib/time-zone";
import { viewerTimeZone } from "@/lib/viewer-time-zone";

/**
 * Fixing the day clock: somebody forgot to clock out, or clocked in from the
 * truck an hour late. Whoever runs the crews' schedule (jobs:assign) may
 * correct the times; the entry then says who did.
 */

const DAY = 24 * 60 * 60 * 1000;

function refresh() {
  revalidatePath("/team/time-clock");
  revalidatePath("/my-day");
}

export async function fixClockEntry(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { user, org } = await requirePermission("jobs:assign");

  const entry = await prisma.clockEntry.findFirst({
    where: { id: String(formData.get("id") ?? ""), organizationId: org.id },
    select: { id: true, userId: true, clockedOutAt: true },
  });
  if (!entry) return failed("That entry was deleted. Refresh to see the week as it is now.");

  const zone = await viewerTimeZone();
  const clockedInAt = parseDateTimeLocal(text(formData, "in"), zone);
  const outText = text(formData, "out");
  const clockedOutAt = outText ? parseDateTimeLocal(outText, zone) : null;
  const now = new Date();

  if (!clockedInAt) return { ok: false, fieldErrors: { in: "Pick when they started." } };
  if (outText && !clockedOutAt) return { ok: false, fieldErrors: { out: "Pick when they stopped." } };
  if (clockedInAt > now) return { ok: false, fieldErrors: { in: "That is still to come." } };
  if (!clockedOutAt && entry.clockedOutAt) {
    return { ok: false, fieldErrors: { out: "Pick when they stopped." } };
  }
  if (clockedOutAt) {
    if (clockedOutAt > now) return { ok: false, fieldErrors: { out: "That is still to come." } };
    if (clockedOutAt <= clockedInAt) return { ok: false, fieldErrors: { out: "That is before they started." } };
    if (clockedOutAt.getTime() - clockedInAt.getTime() > DAY) {
      return { ok: false, fieldErrors: { out: "One entry covers a day at most. Add the next day separately." } };
    }
  }

  await prisma.clockEntry.update({
    where: { id: entry.id },
    data: { clockedInAt, clockedOutAt, editedById: user.id },
  });
  refresh();
  return saved("Saved.");
}

export async function deleteClockEntry(formData: FormData) {
  const { org } = await requirePermission("jobs:assign");
  await prisma.clockEntry.deleteMany({
    where: { id: String(formData.get("id") ?? ""), organizationId: org.id },
  });
  refresh();
}
