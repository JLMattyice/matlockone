import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * .vercelignore decides which files reach a hosted build, and it fails in the
 * least helpful way available: the deploy uploads without complaint and the
 * build dies on a module that is simply not there.
 *
 * It also matches the way .gitignore does, so a bare `storage/` matches at any
 * depth. That is how src/lib/storage — the entire file storage layer — was
 * excluded by a rule meant for the uploads folder at the repository root.
 */

const IGNORE_FILE = path.resolve(".vercelignore");

function patterns() {
  return fs
    .readFileSync(IGNORE_FILE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

/** Directory rules — the ones with depth-matching behaviour worth policing. */
const directoryPatterns = () => patterns().filter((p) => p.endsWith("/"));

describe(".vercelignore", () => {
  it("anchors every directory rule to the repository root", () => {
    const unanchored = directoryPatterns().filter((p) => !p.startsWith("/"));

    expect(
      unanchored,
      `Unanchored directory rules match at any depth, so "${unanchored.join('", "')}" ` +
        "can exclude a source directory that happens to share the name. Prefix each with /.",
    ).toEqual([]);
  });

  /**
   * Whether a rule would drop this path from the upload.
   *
   * Anchored rules match from the repository root; unanchored ones match a
   * segment at any depth, which is the behaviour that caused the outage.
   */
  function excludes(pattern: string, filePath: string) {
    const posix = filePath.split(path.sep).join("/");

    if (pattern.startsWith("*.")) {
      return posix.endsWith(pattern.slice(1));
    }

    const bare = pattern.replace(/^\//, "").replace(/\/$/, "");

    return pattern.startsWith("/")
      ? posix === bare || posix.startsWith(`${bare}/`)
      : posix.split("/").includes(bare);
  }

  it("keeps the file storage layer in the build", () => {
    // The exact failure this file exists for. `storage/` was meant for the
    // uploads folder at the root and took src/lib/storage with it; the build
    // then failed on "Can't resolve './storage/select'".
    const required = [
      "src/lib/storage/index.ts",
      "src/lib/storage/select.ts",
      "src/lib/storage/providers.ts",
      "src/lib/storage/ticket.ts",
      "src/lib/config.ts",
      "src/instrumentation.ts",
    ];

    for (const file of required) {
      const rule = patterns().find((pattern) => excludes(pattern, file));
      expect(rule, `.vercelignore rule "${rule}" would drop ${file}`).toBeUndefined();
    }
  });

  it("drops no application source at all", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (patterns().some((pattern) => excludes(pattern, full))) offenders.push(full);
      }
    };
    walk("src");

    expect(offenders, `.vercelignore would drop: ${offenders.join(", ")}`).toEqual([]);
  });

  it("still excludes the desktop build and local data", () => {
    // The rules exist for a reason; anchoring them must not have removed them.
    const all = patterns();
    for (const required of ["/electron/", "/desktop-build/", "/storage/", "*.db"]) {
      expect(all).toContain(required);
    }
  });
});
