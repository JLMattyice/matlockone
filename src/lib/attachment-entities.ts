/**
 * The record types a file can attach to. Kept out of the actions file because
 * a `"use server"` module may only export async functions.
 */
export const ATTACHMENT_ENTITIES = {
  client: { column: "clientId", path: (id: string) => `/clients/${id}` },
  job: { column: "jobId", path: (id: string) => `/jobs/${id}` },
  lead: { column: "leadId", path: (id: string) => `/leads/${id}` },
  estimate: { column: "estimateId", path: (id: string) => `/estimates/${id}` },
  invoice: { column: "invoiceId", path: (id: string) => `/invoices/${id}` },
  expense: { column: "expenseId", path: (id: string) => `/expenses/${id}` },
} as const;

export type AttachmentEntityType = keyof typeof ATTACHMENT_ENTITIES;

export function isAttachmentEntityType(
  value: unknown,
): value is AttachmentEntityType {
  return typeof value === "string" && value in ATTACHMENT_ENTITIES;
}
