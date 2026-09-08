"use client";

import { createContext, useContext, useMemo, useState } from "react";

import { deleteInvoices } from "./actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Checkbox } from "@/components/ui/form";

/**
 * Selecting invoices on the list, so a pile of them can be dealt with at once.
 *
 * The rows themselves stay server-rendered — only the checkboxes and the action
 * bar are client components, reading one shared set. That keeps the table's
 * data on the server where it belongs, and means selection survives nothing:
 * changing page or filter deliberately clears it, because a hidden selection
 * you cannot see is a hidden selection you can delete by accident.
 */

type Selection = {
  selected: Set<string>;
  toggle: (id: string) => void;
  setAll: (ids: string[], on: boolean) => void;
  clear: () => void;
};

const SelectionContext = createContext<Selection | null>(null);

function useSelection() {
  const context = useContext(SelectionContext);
  if (!context) {
    throw new Error("Invoice selection used outside its provider.");
  }
  return context;
}

export function InvoiceSelection({
  children,
  canDelete,
}: {
  children: React.ReactNode;
  canDelete: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const value = useMemo<Selection>(
    () => ({
      selected,
      toggle: (id) =>
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        }),
      setAll: (ids, on) =>
        setSelected((current) => {
          const next = new Set(current);
          for (const id of ids) {
            if (on) next.add(id);
            else next.delete(id);
          }
          return next;
        }),
      clear: () => setSelected(new Set()),
    }),
    [selected],
  );

  return (
    <SelectionContext.Provider value={value}>
      <form action={deleteInvoices}>
        {[...selected].map((id) => (
          <input key={id} type="hidden" name="ids" value={id} />
        ))}
        {canDelete ? <BulkBar /> : null}
        {children}
      </form>
    </SelectionContext.Provider>
  );
}

/** The checkbox on one row. */
export function SelectInvoice({ id }: { id: string }) {
  const { selected, toggle } = useSelection();

  return (
    <Checkbox
      checked={selected.has(id)}
      onChange={() => toggle(id)}
      aria-label="Select invoice"
    />
  );
}

/** The checkbox in the header, covering everything on this page. */
export function SelectAllInvoices({ ids }: { ids: string[] }) {
  const { selected, setAll } = useSelection();

  const onPage = ids.filter((id) => selected.has(id)).length;
  const all = ids.length > 0 && onPage === ids.length;

  return (
    <Checkbox
      checked={all}
      // Some but not all: the box shows a dash rather than claiming either.
      ref={(input) => {
        if (input) input.indeterminate = onPage > 0 && !all;
      }}
      onChange={() => setAll(ids, !all)}
      aria-label={all ? "Clear selection" : "Select all on this page"}
    />
  );
}

function BulkBar() {
  const { selected, clear } = useSelection();
  const count = selected.size;

  if (count === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm">
      <span className="font-medium text-ink">
        {count === 1 ? "1 invoice selected" : `${count} invoices selected`}
      </span>

      <button
        type="button"
        onClick={clear}
        className="text-ink-muted underline-offset-2 hover:text-ink hover:underline"
      >
        Clear
      </button>

      <span className="ml-auto flex items-center gap-3">
        <span className="hidden text-xs text-ink-subtle sm:inline">
          Deleting also removes any payments recorded against them.
        </span>
        <ConfirmButton size="sm" confirmLabel={`Delete ${count} permanently?`}>
          Delete selected
        </ConfirmButton>
      </span>
    </div>
  );
}
