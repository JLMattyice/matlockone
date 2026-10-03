"use server";

import { randomBytes } from "node:crypto";

import { revalidatePath } from "next/cache";

import { onFileKeys } from "./queries";
import { requirePermission } from "@/lib/auth";
import { isImportField, mapsAName, planImport } from "@/lib/client-import";
import { parseCsv } from "@/lib/csv";
import { prisma } from "@/lib/db";
import { sendCustomersSoon } from "@/lib/quickbooks/sync";
import {
  IMPORT_MAX_BYTES,
  inGroups,
  sanitizeMapping,
  tableProblem,
} from "@/lib/import-columns";

export type ImportResult =
  | { ok: true; created: number; onFile: number; repeated: number; unnamed: number }
  | { ok: false; error: string };

/**
 * Ids made here rather than by Prisma, so each address and note can name its
 * customer within the same batch of inserts. Same shape as a cuid: a letter,
 * then lowercase letters and digits.
 */
function newId() {
  return `c${randomBytes(12).toString("hex")}`;
}

/**
 * Imports a customer list.
 *
 * The file arrives as the text the browser read, and is parsed and decided
 * again here — the preview was the browser's opinion. Customers already on
 * file are matched against the database as it is now, not as it was when the
 * page loaded, so the same file sent twice adds nobody the second time.
 *
 * Everything is written in one transaction: an import either lands whole or
 * not at all, never as the first 300 of 500.
 */
export async function importClients(
  csv: string,
  rawMapping: unknown,
): Promise<ImportResult> {
  const { user, org } = await requirePermission("clients:write");

  if (typeof csv !== "string" || csv.trim() === "") {
    return { ok: false, error: "That file is empty." };
  }
  if (csv.length > IMPORT_MAX_BYTES) {
    return { ok: false, error: "That file is over 4 MB. Split the list into parts and import each one." };
  }

  const table = parseCsv(csv);
  const problem = tableProblem(table);
  if (problem) return { ok: false, error: problem };

  const mapping = sanitizeMapping(rawMapping, table[0].length, isImportField);
  if (!mapsAName(mapping)) {
    return { ok: false, error: "Choose the column that holds each name before importing." };
  }

  const plan = planImport(table, mapping, await onFileKeys(org.id));

  const clients = [];
  const addresses = [];
  const notes = [];

  for (const { draft } of plan.ready) {
    if (!draft) continue;
    const clientId = newId();

    clients.push({
      id: clientId,
      organizationId: org.id,
      type: draft.type,
      firstName: draft.firstName,
      lastName: draft.lastName,
      businessName: draft.businessName,
      displayName: draft.displayName,
      email: draft.email,
      phone: draft.phone,
      mobilePhone: draft.mobilePhone,
      website: draft.website,
      source: draft.source,
      taxExempt: draft.taxExempt,
      createdById: user.id,
    });

    if (draft.address) {
      // The only address, so it is where work happens and where bills go —
      // what the new-customer form assumes for a first address too.
      addresses.push({
        organizationId: org.id,
        clientId,
        line1: draft.address.line1,
        line2: draft.address.line2,
        city: draft.address.city,
        state: draft.address.state,
        postalCode: draft.address.postalCode,
        isPrimary: true,
        isBilling: true,
      });
    }

    if (draft.note) {
      notes.push({ organizationId: org.id, clientId, body: draft.note, authorId: user.id });
    }
  }

  if (clients.length > 0) {
    await prisma.$transaction([
      ...inGroups(clients).map((data) => prisma.client.createMany({ data })),
      ...inGroups(addresses).map((data) => prisma.address.createMany({ data })),
      ...inGroups(notes).map((data) => prisma.note.createMany({ data })),
    ]);
    // A long list goes over in part now; the rest in the morning run or on
    // Send now.
    await sendCustomersSoon(org.id, clients.map((client) => client.id));
    revalidatePath("/clients");
  }

  return {
    ok: true,
    created: clients.length,
    onFile: plan.onFile.length,
    repeated: plan.repeated.length,
    unnamed: plan.unnamed.length,
  };
}
