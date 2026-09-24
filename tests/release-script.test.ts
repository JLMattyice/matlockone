import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  changesWorthListing,
  nextVersion,
  releaseNotes,
  repositoryFrom,
  withVersion,
} from "../scripts/release-lib.mjs";

/**
 * `npm run release`.
 *
 * The version arithmetic is tested directly. The git work is tested for real,
 * against a throwaway repository whose "GitHub" is a bare repository in the
 * same temporary folder — because the failures worth preventing are git
 * failures: a tag without its commit, a release cut from a dirty tree, a
 * refusal that still changed something on the way out.
 */

const SCRIPT = path.resolve("scripts/release.mjs");
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("nextVersion", () => {
  it("bumps the part it is asked to", () => {
    expect(nextVersion("0.3.0", "patch")).toBe("0.3.1");
    expect(nextVersion("0.3.4", "minor")).toBe("0.4.0");
    expect(nextVersion("0.3.4", "major")).toBe("1.0.0");
  });

  it("takes an exact version, with or without the v", () => {
    expect(nextVersion("0.3.0", "0.5.0")).toBe("0.5.0");
    expect(nextVersion("0.3.0", "v0.3.10")).toBe("0.3.10");
  });

  it("refuses anything that is not newer", () => {
    // An installed copy only updates to a higher number, so a release at or
    // below the current one would reach nobody.
    expect(() => nextVersion("0.3.0", "0.3.0")).toThrow(/not newer/);
    expect(() => nextVersion("0.3.0", "0.2.9")).toThrow(/not newer/);
  });

  it("refuses a word it does not know", () => {
    expect(() => nextVersion("0.3.0", "bugfix")).toThrow(/patch, minor, major/);
    expect(() => nextVersion("0.3.0", "0.4.0-beta.1")).toThrow(/patch, minor, major/);
  });
});

describe("releaseNotes", () => {
  it("leads with the summary, then lists the changes", () => {
    expect(
      releaseNotes({
        version: "0.3.1",
        previousTag: "v0.3.0",
        summary: "  Automations and tasks.  ",
        subjects: ["Make the app do four things by itself", "Add tasks"],
      }),
    ).toBe(
      "Automations and tasks.\n\nChanges since v0.3.0:\n\n- Make the app do four things by itself\n- Add tasks\n",
    );
  });

  it("stands on its own without a summary", () => {
    const notes = releaseNotes({
      version: "0.3.1",
      previousTag: "v0.3.0",
      summary: "",
      subjects: ["Add tasks"],
    });
    expect(notes.startsWith("Changes since v0.3.0:")).toBe(true);
  });
});

describe("changesWorthListing", () => {
  it("drops blank lines and earlier release commits", () => {
    expect(changesWorthListing(["Add tasks", "", "Release 0.3.0", " Fix a thing "])).toEqual([
      "Add tasks",
      "Fix a thing",
    ]);
  });
});

describe("withVersion", () => {
  it("changes the version and keeps the line endings", () => {
    const crlf = '{\r\n  "name": "x",\r\n  "version": "0.3.0"\r\n}\r\n';
    expect(withVersion(crlf, "0.3.1")).toBe('{\r\n  "name": "x",\r\n  "version": "0.3.1"\r\n}\r\n');
  });

  it("changes both places a lockfile records it", () => {
    const lock = JSON.stringify({
      name: "x",
      version: "0.3.0",
      packages: { "": { name: "x", version: "0.3.0" }, "node_modules/a": { version: "1.0.0" } },
    });
    const updated = JSON.parse(withVersion(lock, "0.3.1", { lockfile: true }));

    expect(updated.version).toBe("0.3.1");
    expect(updated.packages[""].version).toBe("0.3.1");
    // A dependency that happens to be on the same number is not this package.
    expect(updated.packages["node_modules/a"].version).toBe("1.0.0");
  });
});

describe("repositoryFrom", () => {
  it("reads both kinds of GitHub remote", () => {
    expect(repositoryFrom("https://github.com/JLMattyice/matlockone.git")).toBe(
      "JLMattyice/matlockone",
    );
    expect(repositoryFrom("git@github.com:JLMattyice/matlockone.git")).toBe(
      "JLMattyice/matlockone",
    );
    expect(repositoryFrom("C:/somewhere/origin.git")).toBeNull();
  });
});

// ------------------------------------------------------------ end to end ---

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

const packageJson = (check: string) =>
  `${JSON.stringify(
    { name: "sandbox", version: "0.3.0", private: true, scripts: { "release:check": check } },
    null,
    2,
  )}\n`;

const lockfile = `${JSON.stringify(
  {
    name: "sandbox",
    version: "0.3.0",
    lockfileVersion: 3,
    packages: { "": { name: "sandbox", version: "0.3.0" } },
  },
  null,
  2,
)}\n`;

/**
 * A repository one release in, with a "GitHub" to push to.
 *
 * `check` is what `npm run release:check` does here, standing in for the real
 * typecheck and test suite.
 */
function sandbox({ check = "exit 0", changedSince = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-script-"));
  temporary.push(root);

  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");

  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "init", "--quiet", "-b", "main", work);

  // Local config only, so the machine's own settings — commit signing, line
  // ending conversion — cannot decide the outcome.
  git(work, "config", "user.name", "Release Test");
  git(work, "config", "user.email", "release@example.com");
  git(work, "config", "commit.gpgsign", "false");
  git(work, "config", "tag.gpgsign", "false");
  git(work, "config", "core.autocrlf", "false");

  fs.writeFileSync(path.join(work, "package.json"), packageJson(check));
  fs.writeFileSync(path.join(work, "package-lock.json"), lockfile);
  git(work, "add", ".");
  git(work, "commit", "--quiet", "-m", "Start");
  git(work, "tag", "-a", "v0.3.0", "-m", "Matlock One 0.3.0");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "--quiet", "origin", "main", "v0.3.0");

  if (changedSince) {
    fs.writeFileSync(path.join(work, "tasks.txt"), "tasks\n");
    git(work, "add", "tasks.txt");
    git(work, "commit", "--quiet", "-m", "Add tasks");
  }

  return { origin, work };
}

function release(work: string, request: string | null, answers = "") {
  const result = spawnSync(process.execPath, request ? [SCRIPT, request] : [SCRIPT], {
    cwd: work,
    input: answers,
    encoding: "utf8",
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const tagsOn = (origin: string) => git(origin, "tag", "-l");

describe("npm run release", { timeout: 60_000 }, () => {
  it("commits, tags and pushes the two together", async () => {
    const { origin, work } = sandbox();

    const result = release(work, "patch", "Tasks, and automations that raise them.\n0.3.1\n");

    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    expect(result.out).toContain("Released v0.3.1");

    // On "GitHub": the tag, annotated, and main carrying the version it names.
    expect(tagsOn(origin).split("\n")).toContain("v0.3.1");
    expect(git(origin, "cat-file", "-t", "v0.3.1")).toBe("tag");
    expect(git(origin, "log", "-1", "--format=%s", "main")).toBe("Release 0.3.1");
    expect(git(origin, "rev-parse", "v0.3.1^{commit}")).toBe(git(origin, "rev-parse", "main"));

    const released = JSON.parse(git(origin, "show", "main:package.json"));
    const lock = JSON.parse(git(origin, "show", "main:package-lock.json"));
    expect(released.version).toBe("0.3.1");
    expect(lock.version).toBe("0.3.1");
    expect(lock.packages[""].version).toBe("0.3.1");

    // The tag's message is what the workflow publishes as the release notes.
    const notes = git(origin, "tag", "-l", "--format=%(contents)", "v0.3.1");
    expect(notes).toContain("Tasks, and automations that raise them.");
    expect(notes).toContain("Changes since v0.3.0:");
    expect(notes).toContain("- Add tasks");
  });

  it("changes nothing when the answer is not the version", () => {
    const { origin, work } = sandbox();

    const result = release(work, "patch", "\nyes\n");

    expect(result.code).toBe(0);
    expect(result.out).toContain("Nothing was changed");
    expect(tagsOn(origin)).toBe("v0.3.0");
    expect(JSON.parse(fs.readFileSync(path.join(work, "package.json"), "utf8")).version).toBe(
      "0.3.0",
    );
    expect(git(work, "status", "--porcelain")).toBe("");
  });

  it("changes nothing when the answers run out", () => {
    // Closing the terminal mid-prompt, or piping nothing, is not a yes.
    const { origin, work } = sandbox();

    const result = release(work, "patch", "");

    expect(result.code).toBe(0);
    expect(tagsOn(origin)).toBe("v0.3.0");
  });

  it("refuses when the checks fail, before touching anything", () => {
    const { origin, work } = sandbox({ check: "exit 1" });

    const result = release(work, "patch", "\n0.3.1\n");

    expect(result.code).toBe(1);
    expect(result.err).toContain("the checks failed");
    expect(tagsOn(origin)).toBe("v0.3.0");
    expect(git(work, "status", "--porcelain")).toBe("");
  });

  it("refuses uncommitted changes, and names them", () => {
    const { work } = sandbox();
    fs.writeFileSync(path.join(work, "half-done.ts"), "export {}\n");

    const result = release(work, "patch", "\n0.3.1\n");

    expect(result.code).toBe(1);
    expect(result.err).toContain("uncommitted changes");
    expect(result.err).toContain("half-done.ts");
  });

  it("refuses a version that already exists on GitHub", () => {
    const { work } = sandbox();
    git(work, "tag", "-a", "v0.3.1", "-m", "someone else's");
    git(work, "push", "--quiet", "origin", "v0.3.1");
    git(work, "tag", "-d", "v0.3.1");

    const result = release(work, "patch", "\n0.3.1\n");

    expect(result.code).toBe(1);
    expect(result.err).toMatch(/v0\.3\.1 already exists/);
  });

  it("refuses when there is nothing new to release", () => {
    const { work } = sandbox({ changedSince: false });

    const result = release(work, "patch", "\n0.3.1\n");

    expect(result.code).toBe(1);
    expect(result.err).toContain("nothing has been committed since v0.3.0");
  });

  it("refuses to go backwards", () => {
    const { work } = sandbox();

    const result = release(work, "0.2.9", "\n0.2.9\n");

    expect(result.code).toBe(1);
    expect(result.err).toContain("not newer");
  });

  it("explains itself when asked for nothing", () => {
    const { work } = sandbox();

    const result = release(work, null);

    expect(result.code).toBe(1);
    expect(result.out).toContain("npm run release patch");
  });
});
