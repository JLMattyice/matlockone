import { describe, expect, it } from "vitest";

import { captureFields, restoreFields, type FieldLike } from "@/components/ui/keep-typed";

/**
 * Putting a refused form back.
 *
 * The React half — that this runs after the reset and before paint — can only
 * be seen in a browser. What can be pinned here is the round trip: capture the
 * controls as submitted, let a "reset" put them back to their defaults, restore,
 * and every control reads as it did when the form was sent.
 */

const input = (value: string, type = "text"): FieldLike => ({ type, value });
const box = (checked: boolean, type = "checkbox"): FieldLike => ({ type, value: "on", checked });

/** What React's reset does: every control back to its default. */
function reset(defaults: Map<FieldLike, Partial<FieldLike>>) {
  for (const [field, value] of defaults) Object.assign(field, value);
}

describe("keeping a refused form", () => {
  it("gives every text control back what was typed in it", () => {
    const title = input("Replace water heater");
    const notes = input("Gas line is in the garage", "textarea");

    const saved = captureFields([title, notes]);
    reset(new Map([[title, { value: "" }], [notes, { value: "" }]]));
    restoreFields(saved);

    expect([title.value, notes.value]).toEqual([
      "Replace water heater",
      "Gas line is in the garage",
    ]);
  });

  it("keeps a field that was cleared on purpose cleared", () => {
    // An edit form resets to the record's old value. If somebody emptied the
    // field deliberately, that emptiness is what comes back.
    const phone = input("");

    const saved = captureFields([phone]);
    reset(new Map([[phone, { value: "555-0100" }]]));
    restoreFields(saved);

    expect(phone.value).toBe("");
  });

  it("gives repeated rows each their own value", () => {
    const rows = [input("12 Elm St"), input("9 Oak Ave"), input("")];

    const saved = captureFields(rows);
    reset(new Map(rows.map((row) => [row, { value: "" }])));
    restoreFields(saved);

    expect(rows.map((row) => row.value)).toEqual(["12 Elm St", "9 Oak Ave", ""]);
  });

  it("re-ticks a checkbox the component owns, even with no name to go by", () => {
    // The job form's crew list: the tick is the component's state, and the
    // reset unticks the box while the component still has the person
    // selected. Put back by element, it matches again.
    const priya = box(true);
    const tom = box(false);

    const saved = captureFields([priya, tom]);
    reset(new Map([[priya, { checked: false }]]));
    restoreFields(saved);

    expect([priya.checked, tom.checked]).toEqual([true, false]);
  });

  it("puts a radio group back to the choice that was made", () => {
    const person = box(false, "radio");
    const business = box(true, "radio");

    const saved = captureFields([person, business]);
    reset(new Map([[person, { checked: true }], [business, { checked: false }]]));
    restoreFields(saved);

    expect([person.checked, business.checked]).toEqual([false, true]);
  });

  it("restores every chosen option of a select", () => {
    const options = [{ selected: true }, { selected: false }, { selected: true }];
    const tags: FieldLike = { type: "select-multiple", value: "", options };

    const saved = captureFields([tags]);
    options.forEach((option) => (option.selected = false));
    restoreFields(saved);

    expect(options.map((option) => option.selected)).toEqual([true, false, true]);
  });

  it("leaves hidden inputs, file inputs and buttons alone", () => {
    // A hidden input is how a component carries an id or a choice. A reset
    // does not touch it, and a snapshot must not either.
    const id = input("rec_123", "hidden");
    const file = input("", "file");
    const save = input("save", "submit");

    const saved = captureFields([id, file, save]);
    id.value = "changed by its component";
    restoreFields(saved);

    expect(saved.size).toBe(0);
    expect(id.value).toBe("changed by its component");
  });

  it("leaves alone a control added after the form was sent", () => {
    const existing = input("typed before");
    const saved = captureFields([existing]);

    // A row appended while the save was in flight: not in the capture.
    const added = input("typed after");
    restoreFields(saved);

    expect(added.value).toBe("typed after");
    expect(existing.value).toBe("typed before");
  });
});
