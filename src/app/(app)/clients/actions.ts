"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { failed, invalid, saved, text, type ActionState } from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { CLIENT_STATUSES, CLIENT_TYPES } from "@/lib/constants";
import { prisma } from "@/lib/db";

const addressSchema = z.object({
  id: z.string().nullish(),
  label: z.string().trim().nullish(),
  line1: z.string().trim().min(1, "Street address is required."),
  line2: z.string().trim().nullish(),
  city: z.string().trim().nullish(),
  state: z.string().trim().nullish(),
  postalCode: z.string().trim().nullish(),
  isPrimary: z.boolean().default(false),
  isBilling: z.boolean().default(false),
  notes: z.string().trim().nullish(),
});

const clientSchema = z
  .object({
    type: z.enum(CLIENT_TYPES),
    firstName: z.string().trim().nullish(),
    lastName: z.string().trim().nullish(),
    businessName: z.string().trim().nullish(),
    email: z.union([z.string().trim().email("Enter a valid email."), z.null()]),
    phone: z.string().trim().nullish(),
    mobilePhone: z.string().trim().nullish(),
    website: z.string().trim().nullish(),
    status: z.enum(CLIENT_STATUSES),
    source: z.string().trim().nullish(),
    taxExempt: z.boolean().default(false),
    addresses: z.array(addressSchema),
  })
  .superRefine((value, ctx) => {
    // A record needs something to be called: a business name, or a person's name.
    if (value.type === "BUSINESS" && !value.businessName) {
      ctx.addIssue({
        code: "custom",
        path: ["businessName"],
        message: "Business name is required.",
      });
    }
    if (value.type === "PERSON" && !value.firstName && !value.lastName) {
      ctx.addIssue({
        code: "custom",
        path: ["firstName"],
        message: "Enter a first or last name.",
      });
    }
  });

type ClientInput = z.infer<typeof clientSchema>;

function parseClientForm(formData: FormData) {
  let addresses: unknown = [];
  const raw = formData.get("addressesJson");
  if (typeof raw === "string" && raw.trim()) {
    try {
      addresses = JSON.parse(raw);
    } catch {
      addresses = [];
    }
  }

  return clientSchema.safeParse({
    type: formData.get("type"),
    firstName: text(formData, "firstName"),
    lastName: text(formData, "lastName"),
    businessName: text(formData, "businessName"),
    email: text(formData, "email"),
    phone: text(formData, "phone"),
    mobilePhone: text(formData, "mobilePhone"),
    website: text(formData, "website"),
    status: formData.get("status") ?? "ACTIVE",
    source: text(formData, "source"),
    taxExempt: formData.get("taxExempt") === "on",
    addresses,
  });
}

/** The sortable, searchable name. Derived so the list never has to coalesce. */
function displayNameFor(input: ClientInput) {
  if (input.type === "BUSINESS") return input.businessName!.trim();
  return [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
}

/** Exactly one address is primary; the first one wins if none was marked. */
function normalizeAddresses(addresses: ClientInput["addresses"]) {
  if (addresses.length === 0) return [];
  const primaryIndex = Math.max(
    addresses.findIndex((a) => a.isPrimary),
    0,
  );
  return addresses.map((address, i) => ({
    ...address,
    isPrimary: i === primaryIndex,
  }));
}

export async function createClient(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { user, org } = await requirePermission("clients:write");

  const parsed = parseClientForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const addresses = normalizeAddresses(input.addresses);

  const client = await prisma.client.create({
    data: {
      organizationId: org.id,
      type: input.type,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      businessName: input.businessName ?? null,
      displayName: displayNameFor(input),
      email: input.email ?? null,
      phone: input.phone ?? null,
      mobilePhone: input.mobilePhone ?? null,
      website: input.website ?? null,
      status: input.status,
      source: input.source ?? null,
      taxExempt: input.taxExempt,
      createdById: user.id,
      addresses: {
        create: addresses.map((address) => ({
          organizationId: org.id,
          label: address.label ?? null,
          line1: address.line1,
          line2: address.line2 ?? null,
          city: address.city ?? null,
          state: address.state ?? null,
          postalCode: address.postalCode ?? null,
          isPrimary: address.isPrimary,
          isBilling: address.isBilling,
          notes: address.notes ?? null,
        })),
      },
    },
  });

  revalidatePath("/clients");
  redirect(`/clients/${client.id}`);
}

export async function updateClient(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("clients:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing client id.");

  const existing = await prisma.client.findFirst({
    where: { id, organizationId: org.id },
    include: { addresses: { select: { id: true } } },
  });
  if (!existing) return failed("That client no longer exists.");

  const parsed = parseClientForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  const input = parsed.data;
  const addresses = normalizeAddresses(input.addresses);

  // Addresses are referenced by jobs, estimates and invoices, so rows the user
  // kept are updated in place rather than deleted and recreated — recreating
  // would null out the address on every historical record that pointed at it.
  const keptIds = new Set(
    addresses.map((address) => address.id).filter(Boolean) as string[],
  );
  const removedIds = existing.addresses
    .map((address) => address.id)
    .filter((addressId) => !keptIds.has(addressId));

  await prisma.$transaction(async (tx) => {
    await tx.client.update({
      where: { id },
      data: {
        type: input.type,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        businessName: input.businessName ?? null,
        displayName: displayNameFor(input),
        email: input.email ?? null,
        phone: input.phone ?? null,
        mobilePhone: input.mobilePhone ?? null,
        website: input.website ?? null,
        status: input.status,
        source: input.source ?? null,
        taxExempt: input.taxExempt,
      },
    });

    for (const address of addresses) {
      const data = {
        label: address.label ?? null,
        line1: address.line1,
        line2: address.line2 ?? null,
        city: address.city ?? null,
        state: address.state ?? null,
        postalCode: address.postalCode ?? null,
        isPrimary: address.isPrimary,
        isBilling: address.isBilling,
        notes: address.notes ?? null,
      };

      if (address.id) {
        await tx.address.updateMany({
          where: { id: address.id, organizationId: org.id, clientId: id },
          data,
        });
      } else {
        await tx.address.create({
          data: { ...data, organizationId: org.id, clientId: id },
        });
      }
    }

    if (removedIds.length) {
      await tx.address.deleteMany({
        where: { id: { in: removedIds }, organizationId: org.id, clientId: id },
      });
    }
  });

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
  return saved("Client updated.");
}

export async function setClientStatus(formData: FormData) {
  const { org } = await requirePermission("clients:write");

  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !CLIENT_STATUSES.includes(status as (typeof CLIENT_STATUSES)[number])) {
    return;
  }

  // updateMany with the org in the filter: a mismatched id changes nothing
  // rather than touching another tenant's row.
  await prisma.client.updateMany({
    where: { id, organizationId: org.id },
    data: { status },
  });

  revalidatePath("/clients");
  revalidatePath(`/clients/${id}`);
}

export async function deleteClient(formData: FormData) {
  const { org } = await requirePermission("clients:delete");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const counts = await prisma.client.findFirst({
    where: { id, organizationId: org.id },
    select: {
      _count: { select: { jobs: true, invoices: true, estimates: true } },
    },
  });

  if (!counts) return;

  // Deleting a client with financial history would take its invoices and
  // estimates with it and leave the books wrong. Those records get archived.
  const hasHistory =
    counts._count.jobs > 0 ||
    counts._count.invoices > 0 ||
    counts._count.estimates > 0;

  if (hasHistory) {
    await prisma.client.updateMany({
      where: { id, organizationId: org.id },
      data: { status: "ARCHIVED" },
    });
    revalidatePath("/clients");
    revalidatePath(`/clients/${id}`);
    return;
  }

  await prisma.client.deleteMany({ where: { id, organizationId: org.id } });
  revalidatePath("/clients");
  redirect("/clients");
}
