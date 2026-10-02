"use client";

import { createContext, useContext, useMemo, useState } from "react";

import { deleteExpenses } from "./actions";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Checkbox } from "@/components/ui/form";

/**
 * Selecting expenses on the list, so a pile of them can be cleared at once.
 *
 * The same shape as the invoice list: the rows stay server-rendered, and only
 * the checkboxes and the action bar read one shared set. Changing page or
 * filter clears it, so nothing hidden is ever deleted by accident.
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
    throw new Error("Expense selection used outside its provider.");
  }
  return context;
}

export function ExpenseSelection({
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
      <form
        action={async (formData) => {
          await deleteExpenses(formData);
          // The rows are gone, so a selection still holding them would offer
          // to delete things that no longer exist.
          value.clear();
        }}
      >
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
export function SelectExpense({ id }: { id: string }) {
  const { selected, toggle } = useSelection();

  return (
    <Checkbox
      checked={selected.has(id)}
      onChange={() => toggle(id)}
      aria-label="Select expense"
    />
  );
}

/** The checkbox in the header, covering everything on this page. */
export function SelectAllExpenses({ ids }: { ids: string[] }) {
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
    <div className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-2 px-4 py-2.5 text-sm">
      <span className="font-medium text-ink">
        {count === 1 ? "1 expense selected" : `${count} expenses selected`}
      </span>

      <button
        type="button"
        onClick={clear}
        className="text-ink-muted underline-offset-2 hover:text-ink hover:underline"
      >
        Clear
      </button>

      <span className="ml-auto">
        <ConfirmButton size="sm" confirmLabel={`Delete ${count} permanently?`}>
          Delete selected
        </ConfirmButton>
      </span>
    </div>
  );
}
