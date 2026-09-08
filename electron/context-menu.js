"use strict";

/**
 * The right-click menu.
 *
 * A browser gives you one for free; an Electron window does not. Without this,
 * right-clicking a misspelled word in an estimate does nothing at all, and
 * there is no Cut/Copy/Paste for anyone who does not know the keyboard
 * shortcuts — which, in a program used by people entering job notes on a
 * laptop all day, is most of them.
 *
 * The template is built by a pure function so it can be tested without a
 * window: given the params Chromium reports for a click, it returns exactly
 * the items that should appear.
 */

/** How many spelling suggestions to offer before it stops being a menu. */
const MAX_SUGGESTIONS = 6;

/**
 * Builds the menu for one right-click.
 *
 * `params` is Electron's context-menu params. Only the fields used here are
 * required, so a test can pass a small object.
 */
function buildContextMenuTemplate(params = {}) {
  const {
    misspelledWord = "",
    dictionarySuggestions = [],
    isEditable = false,
    selectionText = "",
    linkURL = "",
    editFlags = {},
  } = params;

  const template = [];
  const separate = () => {
    // Never open with a separator, and never show two in a row.
    if (template.length > 0 && template[template.length - 1].type !== "separator") {
      template.push({ type: "separator" });
    }
  };

  // Spelling first: it is the reason someone right-clicks a word they just
  // typed, so it should not be below a list of clipboard commands.
  if (misspelledWord) {
    for (const suggestion of dictionarySuggestions.slice(0, MAX_SUGGESTIONS)) {
      template.push({ label: suggestion, action: "replace", value: suggestion });
    }

    if (dictionarySuggestions.length === 0) {
      // Saying so beats an empty menu that looks broken.
      template.push({ label: "No spelling suggestions", enabled: false });
    }

    separate();
    template.push({
      label: "Add to dictionary",
      action: "learn",
      value: misspelledWord,
    });
    separate();
  }

  if (isEditable) {
    template.push({ label: "Undo", role: "undo", enabled: editFlags.canUndo !== false });
    template.push({ label: "Redo", role: "redo", enabled: editFlags.canRedo !== false });
    separate();
    template.push({ label: "Cut", role: "cut", enabled: editFlags.canCut !== false });
  }

  if (isEditable || selectionText) {
    template.push({ label: "Copy", role: "copy", enabled: editFlags.canCopy !== false });
  }

  if (isEditable) {
    template.push({ label: "Paste", role: "paste", enabled: editFlags.canPaste !== false });
  }

  if (linkURL) {
    separate();
    template.push({ label: "Copy link address", action: "copyLink", value: linkURL });
  }

  if (isEditable || selectionText) {
    separate();
    template.push({ label: "Select all", role: "selectAll" });
  }

  return template;
}

/**
 * Wires the menu to a window's web contents.
 *
 * `electron` is passed in rather than required here so the pure builder above
 * stays importable from a test that has no Electron.
 */
function attachContextMenu(webContents, electron, clipboard) {
  webContents.on("context-menu", (_event, params) => {
    const template = buildContextMenuTemplate(params);
    if (template.length === 0) return;

    const menu = electron.Menu.buildFromTemplate(
      template.map((item) => {
        if (item.action === "replace") {
          return {
            label: item.label,
            click: () => webContents.replaceMisspelling(item.value),
          };
        }
        if (item.action === "learn") {
          return {
            label: item.label,
            click: () =>
              webContents.session.addWordToSpellCheckerDictionary(item.value),
          };
        }
        if (item.action === "copyLink") {
          return {
            label: item.label,
            click: () => clipboard.writeText(item.value),
          };
        }
        return item;
      }),
    );

    menu.popup();
  });
}

module.exports = { buildContextMenuTemplate, attachContextMenu, MAX_SUGGESTIONS };
