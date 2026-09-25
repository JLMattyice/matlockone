"use client";

import { useCallback, useLayoutEffect, useRef } from "react";

import type { ActionState } from "@/lib/action-state";

/**
 * Keeps what somebody typed when a form's save is refused.
 *
 * React 19 resets a form's fields when its action finishes, whether the action
 * succeeded or not. Success is fine: a create moves to the new record, and an
 * edit resets to the values just saved. A refusal is not. One field wrong — a
 * missing title, an amount that is not a number — and a new record's form comes
 * back empty, or an edit snaps back to the old values, with a message pointing
 * at the single field that needed fixing. Everything else has to be typed again.
 *
 * Worse than retyping: the reset also unticks checkboxes whose ticks belong to
 * the component rather than the form — the job form's crew list — while the
 * component still has them selected. The box reads unticked, and the next save
 * assigns the person anyway.
 *
 * The sign-in and sign-up forms fixed the typing half by having the server send
 * the values back and wiring every field to them. That works for four fields;
 * across the record forms it is dozens, and missing one fails silently. So this
 * does it in the browser, for every control at once: each is read as the form
 * is submitted and, when the answer is a refusal, put back exactly as it was.
 * The form is not rebuilt between the two, so they are the same elements.
 *
 * They go back in a layout effect, which runs after React's reset in the same
 * commit and before anything is painted, so a refused form never visibly
 * blanks. Nothing is sent anywhere, which is also why a password can be kept:
 * it never leaves the page it was typed into.
 *
 * Returns the ref to give the <form>.
 */
export function useKeepTyped(state: ActionState) {
  const form = useRef<HTMLFormElement | null>(null);
  const submitted = useRef<Map<FieldLike, SavedField> | null>(null);

  // A ref callback, so the listener follows the element if it is replaced.
  const ref = useCallback((element: HTMLFormElement | null) => {
    form.current = element;
    if (!element) return;

    const capture = () => {
      submitted.current = captureFields(controlsOf(element));
    };

    element.addEventListener("submit", capture);
    return () => element.removeEventListener("submit", capture);
  }, []);

  useLayoutEffect(() => {
    const saved = submitted.current;
    submitted.current = null;

    // ok is false only for a refusal. A success is true, and the starting
    // state has no ok at all.
    if (!form.current || !saved || state.ok !== false) return;

    restoreFields(saved);
  }, [state]);

  return ref;
}

function controlsOf(element: HTMLFormElement): FieldLike[] {
  return Array.from(element.elements).filter(
    (control): control is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
      control instanceof HTMLInputElement ||
      control instanceof HTMLSelectElement ||
      control instanceof HTMLTextAreaElement,
  );
}

/**
 * The parts of a form control this reads and writes — the shape of an input,
 * a select and a textarea, described structurally so it can be tested without
 * a browser.
 */
export type FieldLike = {
  type: string;
  value: string;
  checked?: boolean;
  options?: ArrayLike<{ selected: boolean }>;
};

export type SavedField = {
  value: string;
  checked: boolean;
  selected: boolean[] | null;
};

/**
 * Types left alone. A form reset does not touch a hidden input, and hidden
 * inputs are how components carry ids and choices, so writing one from a
 * snapshot could only make it disagree with the component that owns it. A
 * file input cannot be given a value, and buttons have none worth keeping.
 */
const UNTOUCHED = new Set(["hidden", "file", "submit", "button", "reset", "image"]);

/** Every control as it stands, keyed by the control itself. */
export function captureFields(fields: Iterable<FieldLike>): Map<FieldLike, SavedField> {
  const saved = new Map<FieldLike, SavedField>();

  for (const field of fields) {
    if (UNTOUCHED.has(field.type)) continue;

    saved.set(field, {
      value: field.value,
      checked: Boolean(field.checked),
      selected: field.options
        ? Array.from(field.options, (option) => option.selected)
        : null,
    });
  }

  return saved;
}

/**
 * Puts each control back as it was captured.
 *
 * By element rather than by name, so a checkbox that belongs to a component
 * and has no name of its own comes back ticked, and repeated rows each get
 * their own value without any counting. A control added after the capture is
 * not in it and is left as it is; one removed since is simply not written to.
 */
export function restoreFields(saved: Map<FieldLike, SavedField>): void {
  for (const [field, was] of saved) {
    if (field.type === "checkbox" || field.type === "radio") {
      field.checked = was.checked;
      continue;
    }

    if (field.options && was.selected) {
      // Option by option, which covers a multi-select; for a single select it
      // is the same as setting the value.
      Array.from(field.options).forEach((option, index) => {
        option.selected = was.selected![index] ?? false;
      });
      continue;
    }

    field.value = was.value;
  }
}
