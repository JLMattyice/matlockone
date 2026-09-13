import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

/**
 * The desktop build ships whichever Node runs it. A Homebrew Node once went out
 * that way — signed, notarized, and unable to start, because its runtime lives
 * in shared libraries outside the binary. These pin the checks that refuse it.
 */

const load = createRequire(import.meta.url);
const { MIN_NODE_BYTES, assertBundleableNode, foreignLibraries } = load(
  "../scripts/node-runtime.cjs",
);

// Shaped like Homebrew's node. The @rpath libnode line is the library the failed
// launch's dyld error named; the libuv line stands for the rest of its prefix.
const HOMEBREW = [
  "/usr/local/Cellar/node/25.9.0_2/bin/node:",
  "\t@rpath/libnode.141.dylib (compatibility version 0.0.0, current version 0.0.0)",
  "\t/usr/local/opt/libuv/lib/libuv.1.dylib (compatibility version 2.0.0, current version 2.0.0)",
  "\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1900.180.0)",
  "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)",
].join("\n");

const OFFICIAL = [
  "/usr/local/bin/node:",
  "\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0, current version 3107.0.0)",
  "\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.101.0)",
  "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.100.2)",
].join("\n");

const UNIVERSAL = [
  "/usr/local/bin/node (architecture x86_64):",
  "\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.101.0)",
  "\t@rpath/libnode.141.dylib (compatibility version 0.0.0, current version 0.0.0)",
  "/usr/local/bin/node (architecture arm64):",
  "\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1800.101.0)",
  "\t@rpath/libnode.141.dylib (compatibility version 0.0.0, current version 0.0.0)",
].join("\n");

describe("foreignLibraries", () => {
  it("flags the shared runtime and anything else outside the system", () => {
    expect(foreignLibraries(HOMEBREW)).toEqual([
      "@rpath/libnode.141.dylib",
      "/usr/local/opt/libuv/lib/libuv.1.dylib",
    ]);
  });

  it("passes a Node that links only what macOS ships", () => {
    expect(foreignLibraries(OFFICIAL)).toEqual([]);
  });

  it("reads a universal binary without mistaking its headers for libraries", () => {
    expect(foreignLibraries(UNIVERSAL)).toEqual(["@rpath/libnode.141.dylib"]);
  });

  it("keeps a weakly linked system library", () => {
    expect(
      foreignLibraries(
        "/x:\n\t/usr/lib/libz.1.dylib (compatibility version 1.0.0, current version 1.2.12, weak)",
      ),
    ).toEqual([]);
  });
});

describe("assertBundleableNode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-runtime-"));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  // win32 keeps otool out of these; the size check applies on every platform.
  it("refuses a launcher far too small to be the runtime itself", () => {
    const launcher = path.join(dir, "launcher");
    fs.writeFileSync(launcher, Buffer.alloc(64 * 1024));
    expect(() => assertBundleableNode(launcher, "win32")).toThrow(/launcher/);
  });

  it("accepts a binary the size of a real runtime", () => {
    const runtime = path.join(dir, "runtime");
    fs.writeFileSync(runtime, "");
    fs.truncateSync(runtime, MIN_NODE_BYTES);
    expect(() => assertBundleableNode(runtime, "win32")).not.toThrow();
  });
});
