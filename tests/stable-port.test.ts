import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The port the desktop server listens on.
 *
 * This used to be whatever the operating system handed out, which is a
 * different number every launch. That address is what goes into an emailed
 * invoice — "View it here" — so a link a client was sent on Tuesday pointed at
 * nothing by Wednesday. The whole value of these is that the number does not
 * move.
 */

const require = createRequire(import.meta.url);
const { stablePort, freePort, DEFAULT_PORT } = require(
  path.resolve(process.cwd(), "electron", "runtime.js"),
) as {
  stablePort: (portFile: string, fallbackPort?: number) => Promise<number>;
  freePort: () => Promise<number>;
  DEFAULT_PORT: number;
};

/**
 * The port these tests aim at.
 *
 * Deliberately not the shipped default: Matlock One itself listens on that one,
 * and a suite that fails whenever the application is running is a suite people
 * learn to ignore. The shipped value is checked as a constant instead.
 */
let preferred: number;

let base: string;
const portFile = () => path.join(base, "port");
const held: net.Server[] = [];

/** Occupies a port so the next caller has to work around it. */
function occupy(port: number) {
  return new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(port, "0.0.0.0", () => {
      held.push(server);
      resolve();
    });
  });
}

beforeEach(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ws-port-"));
  preferred = await freePort();
});

afterEach(async () => {
  await Promise.all(
    held.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  fs.rmSync(base, { recursive: true, force: true });
});

describe("stablePort", () => {
  it("returns the same port on the next launch", async () => {
    const first = await stablePort(portFile(), preferred);
    const second = await stablePort(portFile(), preferred);

    // The one thing this exists for.
    expect(second).toBe(first);
  });

  it("remembers it on disk, not just in memory", async () => {
    const port = await stablePort(portFile(), preferred);

    // Two launches are two processes. Anything held in memory is gone.
    expect(fs.readFileSync(portFile(), "utf8").trim()).toBe(String(port));
  });

  it("starts from a known port so a firewall rule can be written once", async () => {
    // The shipped constant, so a firewall rule or a bookmark keeps working.
    expect(DEFAULT_PORT).toBe(47720);
    expect(await stablePort(portFile(), preferred)).toBe(preferred);
  });

  it("starts anyway when something else holds the port", async () => {
    await occupy(preferred);

    const port = await stablePort(portFile(), preferred);

    // Serving on an unexpected port is a broken link. Refusing to start is a
    // broken business.
    expect(port).not.toBe(preferred);
    expect(port).toBeGreaterThan(1023);
  });

  it("remembers the fallback too", async () => {
    await occupy(preferred);
    const fallback = await stablePort(portFile(), preferred);

    // Otherwise every launch after a one-off clash moves again.
    expect(fs.readFileSync(portFile(), "utf8").trim()).toBe(String(fallback));
  });

  it("keeps a port it was given even when it is not the default", async () => {
    fs.writeFileSync(portFile(), "47999");

    expect(await stablePort(portFile(), preferred)).toBe(47999);
  });

  it("ignores a file that does not hold a usable port", async () => {
    for (const rubbish of ["", "not-a-port", "0", "70000", "80"]) {
      fs.writeFileSync(portFile(), rubbish);

      // 80 is a real port but needs privileges this app does not have, and 0
      // means "pick one for me", which is the behaviour being replaced.
      const port = await stablePort(portFile(), preferred);
      expect(port).toBe(preferred);
    }
  });

  it("survives a location it cannot write to", async () => {
    // A file where a directory should be: mkdir and write both fail. Losing
    // the record costs a changed address next launch — it must not stop the
    // application starting.
    const blocker = path.join(base, "blocker");
    fs.writeFileSync(blocker, "not a directory");

    const port = await stablePort(path.join(blocker, "port"), preferred);

    expect(port).toBe(preferred);
  });
});
