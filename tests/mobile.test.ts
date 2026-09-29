import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Matlock One on a phone: what has to be true for it to fit the screen, open
 * from the home screen like an app, and say so plainly when there is no
 * signal.
 */

const request = vi.hoisted(() => ({ headers: {} as Record<string, string> }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(request.headers),
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

import { NextRequest } from "next/server";

import manifest from "@/app/manifest";
import { MARK_GREEN, MARK_M, MARK_O, MARK_OUTLINE } from "@/lib/brand-mark.mjs";
import { isPhone } from "@/lib/device";
import { directionsUrl } from "@/lib/utils";
import { middleware } from "@/middleware";

const ROOT = path.resolve(__dirname, "..");

afterEach(() => {
  request.headers = {};
});

// ------------------------------------------------------------- the layout ---

describe("every responsive grid names its phone column", () => {
  it("so a long job name shortens with an ellipsis instead of pushing the page sideways", () => {
    // A grid with no column list sizes its one implicit column to the widest
    // thing in it, and a truncated name's widest is the whole name — so the
    // dashboard, a customer's page and a team member's page were 409–483px on a
    // 375px phone. grid-cols-1 is minmax(0, 1fr): the column may shrink.
    const offenders: string[] = [];
    const files = fs.globSync("src/**/*.tsx", { cwd: ROOT }).filter((file) => !file.includes("generated"));

    for (const file of files) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const [, classes] of text.matchAll(/className="([^"]*)"/g)) {
        const tokens = classes.split(/\s+/);
        if (!tokens.includes("grid")) continue;
        const responsive = tokens.some((t) => /^(sm|md|lg|xl|2xl):grid-cols-/.test(t));
        const base = tokens.some((t) => t.startsWith("grid-cols-"));
        if (responsive && !base) offenders.push(`${file}: "${classes}"`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

// ---------------------------------------------------------- on the road ---

describe("directions", () => {
  it("opens the whole address in the phone's maps app", () => {
    expect(
      directionsUrl({ line1: "843 Thistledown Ln", line2: "Unit 4", city: "Oakmont", state: "NC", postalCode: "27519" }),
    ).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=843%20Thistledown%20Ln%2C%20Unit%204%2C%20Oakmont%2C%20NC%2C%2027519",
    );
  });

  it("leaves out what is blank, and offers nothing for an empty address", () => {
    expect(directionsUrl({ line1: "12 Main St", line2: "  ", city: "Rosedale" })).toBe(
      "https://www.google.com/maps/dir/?api=1&destination=12%20Main%20St%2C%20Rosedale",
    );
    expect(directionsUrl({ line1: null, city: "" })).toBeNull();
  });
});

describe("telling a phone from a tablet or a computer", () => {
  const as = (userAgent: string) => {
    request.headers = { "user-agent": userAgent };
    return isPhone();
  };

  it("says phone for an iPhone and an Android phone", async () => {
    expect(
      await as(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe(true);
    expect(
      await as(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe(true);
  });

  it("does not for an iPad, an Android tablet or a computer, which have the room for a week", async () => {
    expect(
      await as(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ),
    ).toBe(false);
    expect(
      await as(
        "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(
      await as(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
      ),
    ).toBe(false);
    request.headers = {};
    expect(await isPhone()).toBe(false);
  });
});

// ------------------------------------------------------- the home screen ---

/** Width, height and the alpha of the top-left pixel, read from the PNG itself. */
function png(file: string) {
  const data = fs.readFileSync(path.join(ROOT, file));
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let at = 8; at < data.length; ) {
    const length = data.readUInt32BE(at);
    const type = data.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") idat.push(data.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // Byte 0 is the first scanline's filter; the generator writes none.
  return { width, height, cornerAlpha: raw[4], centreRow: raw };
}

describe("adding Matlock One to a home screen", () => {
  it("describes an app that opens on its own, on the dashboard", () => {
    const m = manifest();

    expect(m).toMatchObject({
      name: "Matlock One",
      short_name: "Matlock One",
      start_url: "/dashboard",
      scope: "/",
      display: "standalone",
    });
  });

  it("names icons that exist, at the sizes it says, including one a phone may crop", () => {
    const icons = manifest().icons ?? [];

    expect(icons.some((icon) => icon.purpose === "maskable")).toBe(true);
    for (const icon of icons) {
      const [w, h] = String(icon.sizes).split("x").map(Number);
      expect(png(path.join("public", icon.src)), icon.src).toMatchObject({ width: w, height: h });
    }
  });

  it("rounds the ordinary icons itself, and leaves full-bleed ones for iOS and Android to shape", () => {
    // See-through corners on an iPhone icon come out black; a maskable icon
    // with them is cropped into a shape with holes.
    expect(png("public/icons/icon-192.png").cornerAlpha).toBe(0);
    expect(png("src/app/icon.png").cornerAlpha).toBe(0);
    expect(png("public/icons/maskable-512.png").cornerAlpha).toBe(255);
    expect(png("src/app/apple-icon.png")).toMatchObject({ width: 180, height: 180, cornerAlpha: 255 });
  });

  it("lets a signed-out phone fetch what it needs, and nothing more", () => {
    const visit = (p: string) => middleware(new NextRequest(`https://www.matlockone.com${p}`));

    for (const open of ["/manifest.webmanifest", "/sw.js", "/offline.html"]) {
      expect(visit(open).headers.get("location"), open).toBeNull();
    }
    expect(visit("/dashboard").headers.get("location")).toMatch(/\/login\?next=%2Fdashboard$/);
  });
});

// ----------------------------------------------------------- no signal ---

/** public/sw.js, run in a stand-in for a service worker's global scope. */
function loadWorker(network: (request: unknown) => Promise<unknown>) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const cache = new Map<string, unknown>();
  const OFFLINE = { offline: true };

  const scope = {
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  const context = vm.createContext({
    self: scope,
    fetch: network,
    Request: class {
      constructor(public url: string) {}
    },
    caches: {
      open: async () => ({ add: async (req: { url: string }) => cache.set(req.url, OFFLINE) }),
      keys: async () => ["matlock-one-offline-v2", "old-cache"],
      delete: async (key: string) => cache.delete(key),
      match: async (key: string) => cache.get(key),
    },
    Promise,
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "public/sw.js"), "utf8"), context);

  const run = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> | undefined;
    let answered: Promise<unknown> | undefined;
    listeners[type]({
      ...event,
      waitUntil: (p: Promise<unknown>) => (waited = p),
      respondWith: (p: Promise<unknown>) => (answered = p),
    });
    await waited;
    return answered ? await answered : "not handled";
  };

  return { run, OFFLINE };
}

describe("with no signal", () => {
  it("draws the same MO mark on the offline page as on the tab and sign-in", () => {
    // Inlined there, since with no signal nothing else can be fetched.
    const page = fs.readFileSync(path.join(ROOT, "public/offline.html"), "utf8");
    const { x, y, size, radius } = MARK_OUTLINE;

    expect(page).toContain(`viewBox="${x} ${y} ${size} ${size}"`);
    expect(page).toContain(`rx="${radius}" fill="${MARK_GREEN}"`);
    expect(page).toContain(`d="${MARK_M}"`);
    expect(page).toContain(
      `cx="${MARK_O.cx}" cy="${MARK_O.cy}" rx="${MARK_O.rx}" ry="${MARK_O.ry}" fill="none" stroke="#fff" stroke-width="${MARK_O.stroke}"`,
    );
  });

  it("shows the offline page for a page that cannot load", async () => {
    const worker = loadWorker(() => Promise.reject(new TypeError("Failed to fetch")));
    await worker.run("install", {});

    expect(await worker.run("fetch", { request: { mode: "navigate", url: "/jobs" } })).toBe(worker.OFFLINE);
  });

  it("always asks the network first, so nobody sees an old copy of their work", async () => {
    const live = { live: true };
    const worker = loadWorker(() => Promise.resolve(live));
    await worker.run("install", {});

    expect(await worker.run("fetch", { request: { mode: "navigate", url: "/invoices" } })).toBe(live);
  });

  it("leaves everything that is not a page load alone", async () => {
    const worker = loadWorker(() => Promise.reject(new Error("should not be asked")));

    expect(await worker.run("fetch", { request: { mode: "cors", url: "/api/messages/unread" } })).toBe(
      "not handled",
    );
  });
});
