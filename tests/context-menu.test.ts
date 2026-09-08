import { createRequire } from "node:module";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { buildContextMenuTemplate, attachContextMenu, MAX_SUGGESTIONS } = require(
  path.resolve(process.cwd(), "electron", "context-menu.js"),
) as {
  buildContextMenuTemplate: (params: Record<string, unknown>) => MenuItem[];
  attachContextMenu: (webContents: unknown, electron: unknown, clipboard: unknown) => void;
  MAX_SUGGESTIONS: number;
};

type MenuItem = {
  label?: string;
  role?: string;
  type?: string;
  action?: string;
  value?: string;
  enabled?: boolean;
};

/**
 * The right-click menu.
 *
 * Built by a pure function precisely so it can be checked here — driving an
 * Electron window from a test is not practical, and "I wired it up" is not
 * evidence that the right items appear on the right kind of click.
 */

const labels = (items: MenuItem[]) => items.map((i) => i.label ?? i.type);

describe("spelling", () => {
  const misspelled = {
    misspelledWord: "recieve",
    dictionarySuggestions: ["receive", "relieve", "reprieve"],
    isEditable: true,
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true },
  };

  it("offers the corrections first, before clipboard commands", () => {
    const items = buildContextMenuTemplate(misspelled);

    // Someone right-clicking a red-underlined word wants the fix, not Cut.
    expect(labels(items).slice(0, 3)).toEqual(["receive", "relieve", "reprieve"]);
  });

  it("replaces the word rather than pasting it", () => {
    const [first] = buildContextMenuTemplate(misspelled);

    expect(first.action).toBe("replace");
    expect(first.value).toBe("receive");
  });

  it("offers to learn the word", () => {
    const items = buildContextMenuTemplate(misspelled);
    const learn = items.find((i) => i.action === "learn");

    // Trade names and client surnames are misspellings to a dictionary.
    expect(learn?.label).toBe("Add to dictionary");
    expect(learn?.value).toBe("recieve");
  });

  it("says so when there are no suggestions, rather than showing nothing", () => {
    const items = buildContextMenuTemplate({
      misspelledWord: "Achterberg",
      dictionarySuggestions: [],
      isEditable: true,
    });

    const note = items.find((i) => i.label === "No spelling suggestions");
    expect(note?.enabled).toBe(false);
    // Still offers to learn it — that is the whole point for a surname.
    expect(items.some((i) => i.action === "learn")).toBe(true);
  });

  it("caps a long suggestion list", () => {
    const items = buildContextMenuTemplate({
      misspelledWord: "x",
      dictionarySuggestions: Array.from({ length: 20 }, (_, n) => `option${n}`),
      isEditable: true,
    });

    expect(items.filter((i) => i.action === "replace")).toHaveLength(MAX_SUGGESTIONS);
  });
});

describe("editing", () => {
  it("gives an editable field the full set", () => {
    const items = buildContextMenuTemplate({
      isEditable: true,
      editFlags: { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true },
    });

    expect(labels(items)).toEqual([
      "Undo",
      "Redo",
      "separator",
      "Cut",
      "Copy",
      "Paste",
      "separator",
      "Select all",
    ]);
  });

  it("greys out what the field cannot do", () => {
    const items = buildContextMenuTemplate({
      isEditable: true,
      editFlags: { canUndo: false, canRedo: false, canCut: false, canCopy: false, canPaste: true },
    });

    const byLabel = Object.fromEntries(items.map((i) => [i.label, i.enabled]));
    expect(byLabel.Undo).toBe(false);
    expect(byLabel.Cut).toBe(false);
    expect(byLabel.Paste).toBe(true);
  });

  it("offers only Copy on selected read-only text", () => {
    const items = buildContextMenuTemplate({
      isEditable: false,
      selectionText: "INV-1102",
      editFlags: { canCopy: true },
    });

    // No Paste into a page you cannot type in.
    expect(labels(items)).toEqual(["Copy", "separator", "Select all"]);
  });

  it("shows nothing at all on a plain right-click in empty space", () => {
    // An empty menu is not popped up, so no stray grey box appears.
    expect(buildContextMenuTemplate({})).toEqual([]);
    expect(buildContextMenuTemplate({ isEditable: false, selectionText: "" })).toEqual([]);
  });
});

describe("links", () => {
  it("offers to copy a link address", () => {
    const items = buildContextMenuTemplate({
      linkURL: "https://www.paypal.com/invoice/p/#INV2-1",
      selectionText: "Pay now",
    });

    const copyLink = items.find((i) => i.action === "copyLink");
    expect(copyLink?.label).toBe("Copy link address");
    expect(copyLink?.value).toBe("https://www.paypal.com/invoice/p/#INV2-1");
  });
});

describe("menu shape", () => {
  const cases = [
    { name: "misspelling in a field", params: { misspelledWord: "teh", dictionarySuggestions: ["the"], isEditable: true, editFlags: {} } },
    { name: "plain editable field", params: { isEditable: true, editFlags: {} } },
    { name: "selected text", params: { selectionText: "hello", editFlags: {} } },
    { name: "link", params: { linkURL: "https://example.test", selectionText: "x", editFlags: {} } },
  ];

  for (const { name, params } of cases) {
    it(`never starts or ends with a separator: ${name}`, () => {
      const items = buildContextMenuTemplate(params);

      expect(items[0]?.type).not.toBe("separator");
      expect(items[items.length - 1]?.type).not.toBe("separator");
    });

    it(`never shows two separators in a row: ${name}`, () => {
      const items = buildContextMenuTemplate(params);

      for (let i = 1; i < items.length; i += 1) {
        expect(items[i].type === "separator" && items[i - 1].type === "separator").toBe(
          false,
        );
      }
    });
  }
});

describe("wiring", () => {
  /** Minimal stand-ins for the Electron objects attachContextMenu touches. */
  function harness() {
    const handlers: ((event: unknown, params: unknown) => void)[] = [];
    let built: { label?: string; click?: () => void }[] = [];
    let popped = 0;
    const replaced: string[] = [];
    const learned: string[] = [];
    const copied: string[] = [];

    const webContents = {
      on(name: string, handler: (event: unknown, params: unknown) => void) {
        if (name === "context-menu") handlers.push(handler);
      },
      replaceMisspelling: (word: string) => replaced.push(word),
      session: {
        addWordToSpellCheckerDictionary: (word: string) => learned.push(word),
      },
    };

    const electron = {
      Menu: {
        buildFromTemplate(template: { label?: string; click?: () => void }[]) {
          built = template;
          return { popup: () => { popped += 1; } };
        },
      },
    };

    const clipboard = { writeText: (text: string) => copied.push(text) };

    attachContextMenu(webContents, electron, clipboard);

    return {
      rightClick: (params: Record<string, unknown>) => handlers[0]?.({}, params),
      get built() { return built; },
      get popped() { return popped; },
      replaced,
      learned,
      copied,
      registered: handlers.length,
    };
  }

  it("listens for the context-menu event", () => {
    expect(harness().registered).toBe(1);
  });

  it("clicking a suggestion replaces the misspelling", () => {
    const h = harness();
    h.rightClick({
      misspelledWord: "invoce",
      dictionarySuggestions: ["invoice"],
      isEditable: true,
      editFlags: {},
    });

    h.built.find((i) => i.label === "invoice")?.click?.();
    // Replacing, not appending — the wrong word has to go away.
    expect(h.replaced).toEqual(["invoice"]);
  });

  it("clicking Add to dictionary teaches the word", () => {
    const h = harness();
    h.rightClick({
      misspelledWord: "Achterberg",
      dictionarySuggestions: [],
      isEditable: true,
      editFlags: {},
    });

    h.built.find((i) => i.label === "Add to dictionary")?.click?.();
    expect(h.learned).toEqual(["Achterberg"]);
  });

  it("clicking Copy link address puts the URL on the clipboard", () => {
    const h = harness();
    h.rightClick({ linkURL: "https://example.test/pay", selectionText: "Pay" });

    h.built.find((i) => i.label === "Copy link address")?.click?.();
    expect(h.copied).toEqual(["https://example.test/pay"]);
  });

  it("does not pop up an empty menu on a bare right-click", () => {
    const h = harness();
    h.rightClick({});

    // A stray empty grey box is worse than no menu at all.
    expect(h.popped).toBe(0);
  });

  it("pops the menu when there is something to show", () => {
    const h = harness();
    h.rightClick({ isEditable: true, editFlags: {} });

    expect(h.popped).toBe(1);
  });
});
