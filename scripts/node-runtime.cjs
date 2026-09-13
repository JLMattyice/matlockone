"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

/*
 * Whether a Node binary can travel inside the desktop app.
 *
 * The build ships whichever Node ran it (scripts/build-desktop.mjs, step 8), so
 * the SQLite binding compiled beside it matches its ABI. That only works if the
 * binary stands on its own. The official builds do. Homebrew's does not: its
 * `node` is a small launcher that loads the runtime from a shared libnode, and
 * the libraries under that, out of Homebrew's own prefix. Copied into an app it
 * finds none of them, and the first launch dies in dyld before the database is
 * ever created.
 *
 * That shipped once — signed, notarized and uploaded — because the only check
 * on the bundled Node was that the file existed. It did; it just was not a
 * runtime. These are the checks that would have stopped it.
 */

/**
 * Below this a "node" is a launcher for a runtime that lives somewhere else.
 * Every official build is several times larger; Homebrew's launcher is well
 * under a megabyte.
 */
const MIN_NODE_BYTES = 20 * 1024 * 1024;

/**
 * The libraries in `otool -L` output that a clean Mac will not have.
 *
 * Only /usr/lib and /System/Library ship with macOS. Everything else — an
 * @rpath or @loader_path reference, /usr/local, /opt/homebrew — is a file on
 * the build machine, and it will not be on a customer's. Lines are matched on
 * the version suffix every dependency carries, so the per-architecture headers
 * a universal binary prints are never mistaken for libraries.
 */
function foreignLibraries(otoolOutput) {
  const libraries = otoolOutput
    .split(/\r?\n/)
    .filter((line) => line.includes("(compatibility version"))
    .map((line) => line.trim().replace(/\s+\(compatibility version.*$/, ""))
    .filter(
      (library) =>
        !library.startsWith("/usr/lib/") && !library.startsWith("/System/Library/"),
    );
  return [...new Set(libraries)];
}

/**
 * Throws, saying how to fix it, unless the Node at `nodePath` can ship.
 *
 * `platform` is the platform the bundle is for, which is always the one running
 * the build: nothing here cross-compiles.
 */
function assertBundleableNode(nodePath, platform = process.platform) {
  const bytes = fs.statSync(nodePath).size;
  if (bytes < MIN_NODE_BYTES) {
    throw new Error(
      refusal(
        nodePath,
        `it is only ${(bytes / 1024).toFixed(0)} KB, which makes it a launcher for a runtime installed somewhere else rather than the runtime itself`,
        platform,
      ),
    );
  }

  if (platform !== "darwin") return;

  let listing;
  try {
    listing = execFileSync("otool", ["-L", nodePath], { encoding: "utf8" });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        "otool is not installed, so the libraries the bundled Node loads cannot be checked. " +
          "Install the Xcode Command Line Tools (`xcode-select --install`); the SQLite binding needs them to compile anyway.",
      );
    }
    throw error;
  }

  const foreign = foreignLibraries(listing);
  if (foreign.length > 0) {
    throw new Error(
      refusal(
        nodePath,
        `it loads libraries a customer's Mac will not have:\n    ${foreign.join("\n    ")}`,
        platform,
      ),
    );
  }
}

function refusal(nodePath, reason, platform) {
  const fix =
    platform === "darwin"
      ? "Use an official Node build: the installer from nodejs.org, or nvm, fnm or Volta, which install the same binaries. " +
        "If Homebrew's node is installed, run `brew unlink node` first so the official one is the `node` on your PATH. " +
        "Then `rm -rf node_modules && npm ci`, so the SQLite binding is compiled against it, and build again."
      : "Use an official Node build from nodejs.org, reinstall dependencies with `npm ci`, and build again.";
  return `Cannot ship the Node at ${nodePath}: ${reason}.\n  ${fix}`;
}

module.exports = { MIN_NODE_BYTES, assertBundleableNode, foreignLibraries };
