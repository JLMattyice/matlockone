"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { ROLES, type Role } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { canAddActiveUser, licenseState } from "@/lib/license/status";
import { parseMoneyToCents } from "@/lib/money";
import { hashPassword, passwordProblem } from "@/lib/password";
import { assignableRoles, canManageRole } from "@/lib/permissions";
import { destroyAllSessionsFor } from "@/lib/session";

const memberSchema = z.object({
  name: z.string().trim().min(2, "Enter their name."),
  email: z.string().trim().toLowerCase().email("Enter a valid email."),
  phone: z.string().trim().nullish(),
  position: z.string().trim().nullish(),
  role: z.enum(ROLES),
  hourlyRate: z.string().trim().nullish(),
});

function parseMemberForm(formData: FormData) {
  return memberSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: text(formData, "phone"),
    position: text(formData, "position"),
    role: formData.get("role") ?? "EMPLOYEE",
    hourlyRate: text(formData, "hourlyRate"),
  });
}

export async function createTeamMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("employees:write");

  const parsed = parseMemberForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;

  // You can only hand out a role you are allowed to hand out — otherwise a
  // manager could create an owner and escalate through the back door.
  if (!assignableRoles(user).includes(input.role)) {
    return {
      ok: false,
      fieldErrors: { role: "You cannot assign that role." },
    };
  }

  const password = String(formData.get("password") ?? "");
  const weak = passwordProblem(password);
  if (weak) return { ok: false, fieldErrors: { password: weak } };

  const clash = await prisma.user.findFirst({
    where: { organizationId: org.id, email: input.email },
    select: { id: true },
  });
  if (clash) {
    return {
      ok: false,
      fieldErrors: { email: "Someone on your team already uses that email." },
    };
  }

  // Seats are checked here rather than only in the UI: this is the point where
  // the count actually grows, and it is reachable by any caller who can post
  // this form.
  const seats = canAddActiveUser(
    licenseState(org.licenseKey),
    await prisma.user.count({
      where: { organizationId: org.id, isActive: true },
    }),
  );
  if (!seats.ok) return failed(seats.message);

  const created = await prisma.user.create({
    data: {
      organizationId: org.id,
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      position: input.position ?? null,
      role: input.role,
      hourlyRateCents: parseMoneyToCents(input.hourlyRate ?? null),
      passwordHash: await hashPassword(password),
      isActive: true,
    },
    select: { id: true },
  });

  revalidatePath("/team");
  redirect(`/team/${created.id}`);
}

export async function updateTeamMember(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("employees:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing team member id.");

  const target = await prisma.user.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, role: true },
  });
  if (!target) return failed("That team member no longer exists.");

  if (!canManageRole(user, target.role as Role)) {
    return failed("You cannot edit someone at or above your own role.");
  }

  const parsed = parseMemberForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const changingRole = input.role !== target.role;

  // Editing your own row is fine; changing your own role is not, because it
  // is the one change that could lock you out of the app you are using.
  if (changingRole && target.id === user.id) {
    return {
      ok: false,
      fieldErrors: { role: "You cannot change your own role." },
    };
  }

  if (changingRole && !assignableRoles(user).includes(input.role)) {
    return { ok: false, fieldErrors: { role: "You cannot assign that role." } };
  }

  if (changingRole && target.role === "OWNER") {
    const owners = await prisma.user.count({
      where: { organizationId: org.id, role: "OWNER", isActive: true },
    });
    if (owners <= 1) {
      return {
        ok: false,
        fieldErrors: {
          role: "This is the only owner. Promote someone else first.",
        },
      };
    }
  }

  const clash = await prisma.user.findFirst({
    where: { organizationId: org.id, email: input.email, id: { not: id } },
    select: { id: true },
  });
  if (clash) {
    return {
      ok: false,
      fieldErrors: { email: "Someone on your team already uses that email." },
    };
  }

  await prisma.user.update({
    where: { id },
    data: {
      name: input.name,
      email: input.email,
      phone: input.phone ?? null,
      position: input.position ?? null,
      role: input.role,
      hourlyRateCents: parseMoneyToCents(input.hourlyRate ?? null),
    },
  });

  revalidatePath("/team");
  revalidatePath(`/team/${id}`);
  revalidatePath("/", "layout");
  return saved("Team member updated.");
}

/**
 * Deactivating keeps the person's history — assignments, time entries, the
 * notes they wrote — while ending their access. It is never a delete.
 */
export async function setTeamMemberActive(formData: FormData) {
  const { user, org } = await requirePermission("employees:write");

  const id = String(formData.get("id") ?? "");
  const active = formData.get("active") === "true";
  if (!id) return;

  const target = await prisma.user.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, role: true, isActive: true },
  });
  if (!target) return;

  if (!canManageRole(user, target.role as Role)) return;
  if (target.id === user.id) return; // no locking yourself out

  if (!active && target.role === "OWNER") {
    const owners = await prisma.user.count({
      where: { organizationId: org.id, role: "OWNER", isActive: true },
    });
    if (owners <= 1) return;
  }

  // Reactivation is the other door into the seat count, and without this it is
  // an open one: deactivate five people, reactivate five, and the limit never
  // applied. Redirecting rather than silently returning, because a button that
  // does nothing reads as broken software, and the page it lands on is where
  // the problem gets solved anyway.
  if (active && !target.isActive) {
    const seats = canAddActiveUser(
      licenseState(org.licenseKey),
      await prisma.user.count({
        where: { organizationId: org.id, isActive: true },
      }),
    );
    if (!seats.ok) redirect("/settings/license?seats=full");
  }

  await prisma.user.update({
    where: { id },
    data: { isActive: active },
  });

  // Ending access means ending live sessions, not just the ability to sign in.
  if (!active) await destroyAllSessionsFor(id);

  revalidatePath("/team");
  revalidatePath(`/team/${id}`);
}

export async function resetTeamMemberPassword(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("employees:write");

  const id = text(formData, "id");
  const password = String(formData.get("password") ?? "");
  if (!id) return failed("Missing team member id.");

  const target = await prisma.user.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true, role: true, name: true },
  });
  if (!target) return failed("That team member no longer exists.");

  if (!canManageRole(user, target.role as Role)) {
    return failed("You cannot reset the password for someone at or above your role.");
  }

  const weak = passwordProblem(password);
  if (weak) return { ok: false, fieldErrors: { password: weak } };

  await prisma.user.update({
    where: { id },
    data: { passwordHash: await hashPassword(password) },
  });

  // Everything they had open elsewhere stops working immediately.
  await destroyAllSessionsFor(id);

  revalidatePath(`/team/${id}`);
  return saved(
    `Password reset. ${target.name} has been signed out everywhere and will need the new password.`,
  );
}
