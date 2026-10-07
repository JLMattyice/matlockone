"use client";

import { useActionState, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";

import { markInvoicePaid } from "./actions";
import { IDLE, type ActionState } from "@/lib/action-state";
import { PAYMENT_METHOD_LABELS, PAYMENT_METHODS, type PaymentMethod } from "@/lib/constants";

const WIDTH = 224;
const GAP = 6;

/**
 * "Mark paid" on a row of the invoice list: open it, pick how the money came
 * in, done — a payment for whatever is still owed, dated today. Opening the
 * menu is the deliberate step; picking a method is the answer.
 *
 * The menu is drawn on the page body rather than inside the row. The rows sit
 * inside the list's bulk-delete form, where a second form cannot go, and the
 * table's scrolling box would clip anything that hung below it.
 */
export function MarkPaidMenu({
  invoiceId,
  number,
  owed,
}: {
  invoiceId: string;
  number: string;
  /** What is still owed, formatted. */
  owed: string;
}) {
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const [state, dispatch] = useActionState<ActionState, FormData>(markInvoicePaid, IDLE);
  const [pending, startTransition] = useTransition();

  // Below the link, or above it when there is no room underneath; never off
  // either side of the screen.
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const height = menu.current.offsetHeight;
    const below = anchor.bottom + GAP;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - GAP - height) : below;
    const left = Math.min(Math.max(8, anchor.right - WIDTH), window.innerWidth - WIDTH - 8);
    setPlace({ top, left });
    menu.current.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);

  // Anything else — a click elsewhere, Escape, the page moving — closes it.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      close();
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function choose(method: PaymentMethod) {
    const form = new FormData();
    form.set("id", invoiceId);
    form.set("method", method);
    startTransition(() => dispatch(form));
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        onClick={() => {
          setPlace(null);
          setOpen((now) => !now);
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        className="mt-0.5 block w-full text-right text-xs font-medium text-brand hover:underline"
      >
        Mark paid
      </button>

      {open
        ? createPortal(
            <div
              ref={menu}
              role="menu"
              aria-label={`Mark ${number} paid`}
              style={{
                position: "fixed",
                width: WIDTH,
                top: place?.top ?? 0,
                left: place?.left ?? 0,
                // Measured first, then shown where it fits.
                visibility: place ? "visible" : "hidden",
              }}
              className="z-50 overflow-hidden rounded-lg border border-line bg-surface py-1 text-left shadow-lg"
            >
              <p className="px-3 pt-1.5 pb-2 text-xs text-ink-muted">
                Mark {number} paid —{" "}
                <span className="tabular font-semibold text-ink">{owed}</span>, today, by:
              </p>

              {PAYMENT_METHODS.map((method) => (
                <button
                  key={method}
                  type="button"
                  role="menuitem"
                  disabled={pending}
                  onClick={() => choose(method)}
                  className="block w-full px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-3 focus:bg-surface-3 focus:outline-none disabled:opacity-50"
                >
                  {PAYMENT_METHOD_LABELS[method]}
                </button>
              ))}

              {pending ? (
                <p className="px-3 py-2 text-xs text-ink-muted">Saving…</p>
              ) : state.error ? (
                <p role="alert" className="px-3 py-2 text-xs text-danger">
                  {state.error}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
