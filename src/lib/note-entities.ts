/**
 * The record types a note can attach to.
 *
 * Kept out of the actions file because a `"use server"` module may only export
 * async functions — exporting this map from there breaks the build.
 */
export const NOTE_ENTITIES = {
  client: { column: "clientId", path: (id: string) => `/clients/${id}` },
  lead: { column: "leadId", path: (id: string) => `/leads/${id}` },
  job: { column: "jobId", path: (id: string) => `/jobs/${id}` },
  estimate: { column: "estimateId", path: (id: string) => `/estimates/${id}` },
  invoice: { column: "invoiceId", path: (id: string) => `/invoices/${id}` },
  expense: { column: "expenseId", path: (id: string) => `/expenses/${id}` },
} as const;

export type NoteEntityType = keyof typeof NOTE_ENTITIES;

export function isNoteEntityType(value: unknown): value is NoteEntityType {
  return typeof value === "string" && value in NOTE_ENTITIES;
}
