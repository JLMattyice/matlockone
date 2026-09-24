import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  changesWorthListing,
  nextVersion,
  releaseNotes,
  repositoryFrom,
  withVersion,
} from "./release-lib.mjs";

/**
 * Cuts a release of the desktop app.
 *
 *   npm run release patch     0.3.0 → 0.3.1
 *   npm run release minor     0.3.0 → 0.4.0
 *   npm run release 0.4.0     exactly that
 *
 * By hand, a release was four commands in the right order plus a draft on
 * GitHub to remember to publish, and each step had its own way to go quietly
 * wrong: a tag that disagrees with package.json ships installers that report
 * the old version, so nothing updates; a tag pushed without its commit builds
 * something that is not on main; a forgotten draft reaches nobody.
 *
 * This does the steps in order, refuses when the state is wrong, runs the
 * typecheck and tests first, and asks before changing anything. It pushes the
 * commit and the tag together — both or neither — and from there
 * .github/workflows/release.yml builds and publishes.
 *
 * No flags, only the one word. Flags have to pass through npm and, on
 * Windows, through PowerShell's npm shim, which swallows the `--` npm needs
 * to hand them on.
 */

const BRANCH = "main";
const PACKAGE = "package.json";
const LOCKFILE = "package-lock.json";

function fail(message, detail = []) {
  console.error(`\n  release: ${message}\n`);
  for (const line of detail) console.error(`    ${line}`);
  if (detail.length > 0) console.error("");
  process.exit(1);
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.error) fail(`could not run git: ${result.error.message}`);

  const out = (result.stdout ?? "").trim();
  const err = (result.stderr ?? "").trim();

  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(" ")} failed.`, (err || out).split("\n"));
  }

  return { ok: result.status === 0, out, err };
}

/**
 * Reads one answer.
 *
 * Through readline's async iterator rather than question(): the iterator
 * buffers lines, so answers piped in all at once are each still there when
 * their question is asked, instead of arriving before anybody is listening.
 */
let rl = null;
let lines = null;

async function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    lines = rl[Symbol.asyncIterator]();
  }
  process.stdout.write(question);
  const { value, done } = await lines.next();
  return done ? null : value;
}

function finish(code = 0) {
  rl?.close();
  process.exit(code);
}

// ---------------------------------------------------------------- the ask ---

const request = process.argv[2];

if (!request) {
  console.log(`
  Usage:
    npm run release patch     for fixes         (0.3.0 → 0.3.1)
    npm run release minor     for new features  (0.3.0 → 0.4.0)
    npm run release 0.4.0     for an exact version
`);
  process.exit(1);
}

// ------------------------------------------------------- where things are ---

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).out;
if (branch !== BRANCH) {
  fail(`releases are cut from ${BRANCH}, and this is ${branch}.`, [`git switch ${BRANCH}`]);
}

// Refused rather than ignored. The release is built from commits, but the
// checks below run against the working tree — so with uncommitted changes they
// would pass or fail on files that are not going out.
const dirty = git(["status", "--porcelain"]).out;
if (dirty) {
  const files = dirty.split("\n");
  fail("there are uncommitted changes. Commit or stash them first:", [
    ...files.slice(0, 12),
    ...(files.length > 12 ? [`…and ${files.length - 12} more`] : []),
  ]);
}

git(["fetch", "--quiet", "--tags", "origin", BRANCH]);

const behind = Number(git(["rev-list", "--count", `HEAD..origin/${BRANCH}`]).out);
if (behind > 0) {
  fail(
    `${BRANCH} is ${behind} commit${behind === 1 ? "" : "s"} behind GitHub, so the release would leave ${behind === 1 ? "it" : "them"} out.`,
    ["git pull"],
  );
}

// ------------------------------------------------------ what is going out ---

const current = JSON.parse(fs.readFileSync(PACKAGE, "utf8")).version;

let version;
try {
  version = nextVersion(current, request);
} catch (error) {
  fail(error.message);
}

const tag = `v${version}`;

if (git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`], { allowFailure: true }).ok) {
  fail(`${tag} already exists on this machine.`);
}
if (git(["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).out) {
  fail(`${tag} already exists on GitHub.`);
}

const described = git(["describe", "--tags", "--abbrev=0", "--match", "v*"], {
  allowFailure: true,
});
const previousTag = described.ok ? described.out : null;

const subjects = changesWorthListing(
  git(["log", "--no-merges", "--format=%s", previousTag ? `${previousTag}..HEAD` : "HEAD"])
    .out.split("\n"),
);

if (previousTag && subjects.length === 0) {
  fail(`nothing has been committed since ${previousTag}, so there is nothing to release.`);
}

const unpushed = Number(git(["rev-list", "--count", `origin/${BRANCH}..HEAD`]).out);

// ------------------------------------------------------------- the checks ---

console.log(`\n  Checking before anything changes: typecheck, then tests.\n`);

// stdin is withheld from the checks so they cannot swallow the answers to the
// questions after them. A shell because on Windows npm is npm.cmd, which only
// a shell can start — and one fixed string rather than an argument list,
// since Node rightly warns that arguments given to a shell are not escaped.
const checks = spawnSync("npm run release:check", {
  stdio: ["ignore", "inherit", "inherit"],
  shell: true,
});

if (checks.status !== 0) {
  fail("the checks failed, so nothing was changed.", ["Fix them and run this again."]);
}

// --------------------------------------------------------------- the plan ---

const shown = subjects.slice(0, 20);

console.log(`
  Ready to release ${version} (now ${current}).

  ${subjects.length} change${subjects.length === 1 ? "" : "s"}${previousTag ? ` since ${previousTag}` : ""}:
${shown.map((subject) => `    - ${subject}`).join("\n")}${subjects.length > shown.length ? `\n    …and ${subjects.length - shown.length} more` : ""}
${unpushed > 0 ? `\n  ${unpushed} of those ${unpushed === 1 ? "is" : "are"} not on GitHub yet and will go up with the release.\n` : ""}
  What happens:
    1. package.json and package-lock.json become ${version}
    2. a commit, "Release ${version}", and the tag ${tag} carrying the notes
    3. both pushed together, and GitHub builds and publishes the release
`);

const summary = await ask(
  "  One sentence for the release notes, as a customer would read it.\n  Press Enter to leave it out.\n  > ",
);

const answer = await ask(`\n  Type ${version} to release it, or anything else to stop.\n  > `);

if (answer?.trim() !== version) {
  console.log("\n  Stopped. Nothing was changed.\n");
  finish(0);
}

// ---------------------------------------------------------------- the act ---

fs.writeFileSync(PACKAGE, withVersion(fs.readFileSync(PACKAGE, "utf8"), version));

const hasLockfile = fs.existsSync(LOCKFILE);
if (hasLockfile) {
  fs.writeFileSync(
    LOCKFILE,
    withVersion(fs.readFileSync(LOCKFILE, "utf8"), version, { lockfile: true }),
  );
}

// Named paths only. The tree was clean a moment ago, but committing by name
// means nothing that appeared since can ride along.
git(["commit", "--quiet", "-m", `Release ${version}`, "--", PACKAGE, ...(hasLockfile ? [LOCKFILE] : [])]);

const notesFile = path.join(os.tmpdir(), `matlock-one-release-${version}.md`);
fs.writeFileSync(
  notesFile,
  releaseNotes({ version, previousTag, summary, subjects }),
);
git(["tag", "-a", tag, "-F", notesFile]);
fs.rmSync(notesFile, { force: true });

// Atomic: the commit and the tag land together or not at all. A tag without
// its commit on main would build a version main does not have.
const pushed = git(["push", "--atomic", "--quiet", "origin", BRANCH, tag], {
  allowFailure: true,
});

if (!pushed.ok) {
  fail("GitHub refused the push, so nothing was released.", [
    ...pushed.err.split("\n"),
    "",
    "The release commit and tag exist only on this machine. Either push them:",
    `  git push --atomic origin ${BRANCH} ${tag}`,
    "or undo them:",
    `  git tag -d ${tag}`,
    "  git reset --keep HEAD~1",
  ]);
}

const repository = repositoryFrom(git(["remote", "get-url", "origin"]).out);

console.log(`
  Released ${tag}.

  GitHub is building it now. Windows takes roughly fifteen minutes, and macOS
  runs alongside once the Apple signing secrets are set:
    ${repository ? `https://github.com/${repository}/actions/workflows/release.yml` : "the Actions tab on GitHub"}

  Once it is published, installed copies update within six hours, or thirty
  seconds after they next open. The download buttons follow within five
  minutes.
`);

finish(0);
