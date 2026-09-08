/**
 * The address shape the client form edits before it is saved.
 *
 * Lives outside the form module because server components build the initial
 * value: a function exported from a `"use client"` file cannot be *called* on
 * the server, only referenced as a client entry point.
 */
export type AddressDraft = {
  /** Stable React list key. Existing rows reuse their database id. */
  key: string;
  id: string | null;
  label: string;
  line1: string;
  line2: string;
  city: string;
  state: string;
  postalCode: string;
  isPrimary: boolean;
  isBilling: boolean;
  notes: string;
};

export function emptyAddress(isPrimary = false): AddressDraft {
  return {
    key: `new-${Math.random().toString(36).slice(2)}`,
    id: null,
    label: "",
    line1: "",
    line2: "",
    city: "",
    state: "",
    postalCode: "",
    isPrimary,
    isBilling: isPrimary,
    notes: "",
  };
}
