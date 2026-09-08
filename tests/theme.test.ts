import { describe, expect, it } from "vitest";

import {
  initialTheme,
  isTheme,
  themeAttribute,
  THEME_STORAGE_KEY,
  THEMES,
} from "@/lib/theme";

/**
 * Which theme a machine that has never been asked should get.
 *
 * "Follow the system" sounds like the respectful default and is the wrong one
 * here: a great many machines ship set to dark without their owner choosing it,
 * and this app sits next to printed invoices and gets turned around to show a
 * client. Light is what a business document looks like.
 */

describe("the default", () => {
  it("is light when nobody has chosen", () => {
    expect(themeAttribute(null)).toBe("light");
    expect(themeAttribute(undefined)).toBe("light");
    expect(initialTheme(null)).toBe("light");
  });

  it("is light rather than whatever the operating system says", () => {
    // The distinction that matters: null means "put light on the document",
    // not "take the attribute off and let prefers-color-scheme decide".
    expect(themeAttribute(null)).not.toBeNull();
  });

  it("is light when storage is unreadable or holds nonsense", () => {
    // A private window, blocked site data, or a value from an older build.
    for (const value of ["", "sepia", 0, {}, []]) {
      expect(themeAttribute(value)).toBe("light");
      expect(initialTheme(value)).toBe("light");
    }
  });
});

describe("a choice that was made", () => {
  it("is obeyed", () => {
    expect(themeAttribute("dark")).toBe("dark");
    expect(themeAttribute("light")).toBe("light");
    expect(initialTheme("dark")).toBe("dark");
  });

  it("still lets somebody follow their machine", () => {
    // System is no longer the default, but it is still on offer and has to
    // keep working — null is what takes the attribute off the document.
    expect(themeAttribute("system")).toBeNull();
    expect(initialTheme("system")).toBe("system");
  });

  it("survives a round trip through the toggle's three buttons", () => {
    for (const theme of THEMES) {
      expect(isTheme(theme)).toBe(true);
      expect(initialTheme(theme)).toBe(theme);
    }
  });
});

describe("the stored key", () => {
  it("does not change, so a saved preference is not lost", () => {
    // Renaming this silently resets every existing installation back to the
    // default, which reads as the app forgetting a setting.
    expect(THEME_STORAGE_KEY).toBe("fb-theme");
  });

  it("rejects values that are not themes", () => {
    expect(isTheme("Dark")).toBe(false);
    expect(isTheme(null)).toBe(false);
    expect(isTheme("")).toBe(false);
  });
});
