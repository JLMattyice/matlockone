"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  bool,
  failed,
  invalid,
  saved,
  text,
  type ActionState,
} from "@/lib/action-state";
import { requirePermission } from "@/lib/auth";
import { LINE_ITEM_KINDS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { parseMoneyToCents } from "@/lib/money";

/**
 * Writes for the catalog.
 *
 * Nothing here reaches an estimate or an invoice that already exists. A
 * document copies a catalog entry's name, unit and price onto its own line
 * when the line is added, so editing an entry changes what the next document
 * offers and nothing that was already priced. That is the reason a price can
 * be corrected without a warning, and the reason deleting is allowed at all.
 */

const catalogSchema = z
  .object({
    name: z.string().trim().min(1, "Give it a name."),
    kind: z.enum(LINE_ITEM_KINDS),
    description: z.string().trim().nullish(),
    unit: z.string().trim().max(16, "Keep the unit short."),
    price: z.string().trim(),
    taxable: z.boolean(),
    isActive: z.boolean(),
  })
  .superRefine((input, ctx) => {
    const cents = parseMoneyToCents(input.price);

    if (cents == null) {
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: "Enter a price, or 0 for something priced per job.",
      });
      return;
    }

    // Zero is allowed on purpose: an entry that exists to be named on a
    // document and priced there is a normal thing to keep in a price book.
    if (cents < 0) {
      ctx.addIssue({
        code: "custom",
        path: ["price"],
        message: "A price cannot be negative.",
      });
    }
  });

function parseCatalogForm(formData: FormData) {
  return catalogSchema.safeParse({
    name: formData.get("name"),
    kind: formData.get("kind") ?? "SERVICE",
    description: text(formData, "description"),
    // An empty unit is the common case for a flat-rate service, and "ea" is
    // what every document already defaults to.
    unit: (text(formData, "unit") || "ea").trim(),
    price: formData.get("price") ?? "0",
    taxable: bool(formData, "taxable"),
    isActive: bool(formData, "isActive"),
  });
}

/** What both writes put on the row, so the two cannot drift. */
function values(input: z.infer<typeof catalogSchema>) {
  return {
    name: input.name,
    kind: input.kind,
    description: input.description || null,
    unit: input.unit || "ea",
    unitPriceCents: parseMoneyToCents(input.price)!,
    taxable: input.taxable,
    isActive: input.isActive,
  };
}

export async function createCatalogItem(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("catalog:write");

  const parsed = parseCatalogForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  await prisma.priceBookItem.create({
    data: { organizationId: org.id, ...values(parsed.data) },
  });

  // Both document editors read the price book, so a new entry has to show up
  // in an estimate that is already open in another tab.
  revalidatePath("/catalog");
  revalidatePath("/estimates");
  revalidatePath("/invoices");
  redirect("/catalog");
}

export async function updateCatalogItem(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const { org } = await requirePermission("catalog:write");

  const id = text(formData, "id");
  if (!id) return failed("Missing item id.");

  const existing = await prisma.priceBookItem.findFirst({
    where: { id, organizationId: org.id },
    select: { id: true },
  });
  if (!existing) return failed("That item no longer exists.");

  const parsed = parseCatalogForm(formData);
  if (!parsed.success) return invalid(parsed.error);

  await prisma.priceBookItem.update({
    where: { id },
    data: values(parsed.data),
  });

  revalidatePath("/catalog");
  revalidatePath("/estimates");
  revalidatePath("/invoices");
  return saved("Saved.");
}

/**
 * Archive and restore.
 *
 * Archiving takes an entry out of the document editors without touching
 * anything priced with it, which is what somebody actually wants when a
 * service is discontinued or a supplier stops stocking a part.
 */
export async function setCatalogItemActive(formData: FormData) {
  const { org } = await requirePermission("catalog:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  const isActive = String(formData.get("isActive") ?? "") === "true";

  await prisma.priceBookItem.updateMany({
    where: { id, organizationId: org.id },
    data: { isActive },
  });

  revalidatePath("/catalog");
  revalidatePath("/estimates");
  revalidatePath("/invoices");
}

export async function deleteCatalogItem(formData: FormData) {
  const { org } = await requirePermission("catalog:write");

  const id = String(formData.get("id") ?? "");
  if (!id) return;

  // deleteMany rather than delete: scoping by organization in the same
  // statement means another workspace's id simply matches nothing.
  await prisma.priceBookItem.deleteMany({
    where: { id, organizationId: org.id },
  });

  revalidatePath("/catalog");
  revalidatePath("/estimates");
  revalidatePath("/invoices");
  redirect("/catalog");
}
