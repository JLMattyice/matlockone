"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { isRole } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { notify } from "@/lib/notifications";
import { can } from "@/lib/permissions";
import { storageRoom } from "@/lib/quotas";
import {
  clientAddress,
  hit,
  REQUESTS_PER_BUSINESS,
  REQUESTS_PER_IP,
  retryAfterPhrase,
} from "@/lib/rate-limit";
import { REQUEST_PHOTO_LIMIT } from "@/lib/service-request";
import { isImageMime, putFile } from "@/lib/storage";

/**
 * The public "Request service" form.
 *
 * Anybody can send it, so it is treated like any form on the open internet:
 * every field is checked and cut to length, a hidden field catches the
 * simplest bots, each address and each business has a ceiling an hour, and
 * photos are images only, five at most, small enough to have been shrunk on
 * the phone. What arrives becomes a new lead — with the details as a note and
 * the photos on it — and the office is told.
 */

export type RequestResult =
  | { ok: true }
  | { ok: false; error?: string; fieldErrors?: Record<string, string> };

/** The most a photo may weigh once the phone has shrunk it. */
const PHOTO_MAX_BYTES = 4 * 1024 * 1024;

const TIMES = ["ANY", "MORNING", "AFTERNOON", "EVENING"] as const;
const TIME_LABELS: Record<(typeof TIMES)[number], string> = {
  ANY: "any time",
  MORNING: "morning",
  AFTERNOON: "afternoon",
  EVENING: "evening",
};

const requestSchema = z
  .object({
    name: z.string().trim().min(2, "Tell us your name.").max(120),
    email: z.union([z.string().trim().email("That email doesn't look right.").max(200), z.literal("")]),
    phone: z.string().trim().max(40),
    service: z.string().trim().max(120),
    description: z.string().trim().min(3, "Tell us a little about what you need.").max(4000),
    line1: z.string().trim().max(200),
    city: z.string().trim().max(120),
    state: z.string().trim().max(60),
    postalCode: z.string().trim().max(20),
    preferredDate: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]),
    preferredTime: z.enum(TIMES),
  })
  .superRefine((value, ctx) => {
    if (!value.email && value.phone.replace(/\D/g, "").length < 7) {
      ctx.addIssue({ code: "custom", path: ["phone"], message: "Leave a phone number or an email so we can reach you." });
    }
  });

const field = (form: FormData, key: string) => {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
};

export async function submitServiceRequest(slug: string, form: FormData): Promise<RequestResult> {
  const org = await prisma.organization.findUnique({ where: { slug } });
  if (!org || !org.requestsEnabled) {
    return { ok: false, error: "This business isn't taking requests online right now." };
  }
  if (org.isDemo) {
    return { ok: false, error: "This is the demo, so requests aren't recorded. Create your account to take your own." };
  }

  // A field people never see. Filled means a bot; it is told it worked.
  if (field(form, "company_website")) return { ok: true };

  const parsed = requestSchema.safeParse({
    name: field(form, "name"),
    email: field(form, "email"),
    phone: field(form, "phone"),
    service: field(form, "service"),
    description: field(form, "description"),
    line1: field(form, "line1"),
    city: field(form, "city"),
    state: field(form, "state"),
    postalCode: field(form, "postalCode"),
    preferredDate: field(form, "preferredDate"),
    preferredTime: field(form, "preferredTime") || "ANY",
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[String(issue.path[0])] ??= issue.message;
    return { ok: false, fieldErrors };
  }
  const input = parsed.data;

  const photos = form
    .getAll("photos")
    .filter((value): value is File => value instanceof File && value.size > 0);
  if (photos.length > REQUEST_PHOTO_LIMIT) {
    return { ok: false, error: `Up to ${REQUEST_PHOTO_LIMIT} photos, please.` };
  }
  if (photos.some((photo) => !isImageMime(photo.type) || photo.size > PHOTO_MAX_BYTES)) {
    return { ok: false, error: "Photos only, each under 4 MB." };
  }

  // Counted only once the request is otherwise good, so a typo does not
  // spend somebody's allowance.
  const address = await clientAddress();
  for (const [key, rule] of [
    [`request:ip:${address}`, REQUESTS_PER_IP],
    [`request:org:${org.id}`, REQUESTS_PER_BUSINESS],
  ] as const) {
    const verdict = await hit(key, rule);
    if (!verdict.ok) {
      return {
        ok: false,
        error: `Too many requests have been sent just now. Please try again ${retryAfterPhrase(verdict.retryAfterSeconds)}, or call us.`,
      };
    }
  }

  // Sent from a customer's portal: filed under them.
  const portalToken = field(form, "for");
  const client = portalToken
    ? await prisma.client.findFirst({
        where: { portalToken, organizationId: org.id },
        select: { id: true, displayName: true },
      })
    : null;

  const lead = await prisma.lead.create({
    data: {
      organizationId: org.id,
      name: input.name,
      email: input.email || null,
      phone: input.phone || null,
      source: client ? "REPEAT" : "WEBSITE",
      status: "NEW",
      clientId: client?.id ?? null,
    },
  });

  const where = [input.line1, input.city, [input.state, input.postalCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");
  const when = input.preferredDate
    ? `${input.preferredDate}, ${TIME_LABELS[input.preferredTime]}`
    : input.preferredTime !== "ANY"
      ? TIME_LABELS[input.preferredTime]
      : null;

  await prisma.note.create({
    data: {
      organizationId: org.id,
      leadId: lead.id,
      body: [
        client ? `Requested from ${client.displayName}'s portal.` : "Requested on the website form.",
        input.service ? `Service: ${input.service}` : null,
        where ? `Where: ${where}` : null,
        when ? `Preferred: ${when}` : null,
        "",
        input.description,
      ]
        .filter((line) => line !== null)
        .join("\n"),
    },
  });

  // Photos go only while the business has room; the request stands either way.
  const room = await storageRoom(org);
  let photosKept = 0;
  for (const photo of photos) {
    if (room.take(photo.size)) break;
    const stored = await putFile(org.id, photo);
    if (!stored.ok) continue;
    await prisma.attachment.create({
      data: {
        organizationId: org.id,
        leadId: lead.id,
        kind: "PHOTO",
        caption: "Sent with the request",
        ...stored.file,
      },
    });
    photosKept++;
  }

  const people = await prisma.user.findMany({
    where: { organizationId: org.id, isActive: true },
    select: { id: true, role: true },
  });
  await notify({
    organizationId: org.id,
    userIds: people
      .filter((person) => isRole(person.role) && can({ role: person.role, id: person.id }, "leads:write"))
      .map((person) => person.id),
    type: "SERVICE_REQUEST",
    title: `New request from ${input.name}`,
    body: [input.service, input.description.slice(0, 160), photosKept ? `${photosKept} photo${photosKept === 1 ? "" : "s"}` : null]
      .filter(Boolean)
      .join(" · "),
    entityType: "LEAD",
    entityId: lead.id,
    actionUrl: `/leads/${lead.id}`,
  });

  revalidatePath("/leads");
  return { ok: true };
}
