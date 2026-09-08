import type { z } from "zod";

/** Shape every server action returns, so forms share one submit handler. */
export type ActionState = {
  ok?: boolean;
  message?: string;
  error?: string;
  fieldErrors?: Record<string, string>;
};

export const IDLE: ActionState = {};

export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

export function invalid(error: z.ZodError): ActionState {
  return { ok: false, fieldErrors: fieldErrorsFrom(error) };
}

export function failed(message: string): ActionState {
  return { ok: false, error: message };
}

export function saved(message = "Saved."): ActionState {
  return { ok: true, message };
}

/** Reads a FormData text field, collapsing blanks to null. */
export function text(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function bool(formData: FormData, key: string): boolean {
  return formData.get(key) === "on" || formData.get(key) === "true";
}

export function int(formData: FormData, key: string): number | null {
  const raw = text(formData, key);
  if (raw == null) return null;
  const value = Number(raw.replace(/[^0-9-]/g, ""));
  return Number.isFinite(value) ? Math.trunc(value) : null;
}
