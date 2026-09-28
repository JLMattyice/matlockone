import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MIN_CRON_SECRET } from "@/lib/config";

/**
 * The desktop launcher running the date-based automations by itself —
 * electron/sweeps.js, driven with fake timers and a stand-in for the local
 * server, so a three-hour schedule is checked in milliseconds.
 */

const require = createRequire(import.meta.url);
const { startAutomationSweeps, newSweepSecret, FIRST_RUN_MS, EVERY_MS } = require(
  path.resolve(__dirname, "../electron/sweeps.js"),
) as {
  startAutomationSweeps: (options: Record<string, unknown>) => () => void;
  newSweepSecret: () => string;
  FIRST_RUN_MS: number;
  EVERY_MS: number;
};

type Call = { url: string; authorization: string | undefined };

function fakeServer(answer: () => Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, authorization: init?.headers?.authorization });
    return answer();
  });
  return { calls, fetchImpl };
}

const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

afterEach(() => {
  vi.useRealTimers();
});

describe("the launcher's automations check", () => {
  it("waits a couple of minutes after start, then runs every few hours", async () => {
    vi.useFakeTimers();
    const server = fakeServer(() => ok({ businesses: 1, created: 2, failed: [] }));
    const lines: string[] = [];

    const stop = startAutomationSweeps({
      baseUrl: "http://localhost:3100",
      secret: "s".repeat(64),
      log: (line: string) => lines.push(line),
      fetchImpl: server.fetchImpl,
    });

    // Not at start, so the first screen is never slowed by it.
    await vi.advanceTimersByTimeAsync(FIRST_RUN_MS - 1000);
    expect(server.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(server.calls).toEqual([
      { url: "http://localhost:3100/api/cron/automations", authorization: `Bearer ${"s".repeat(64)}` },
    ]);
    expect(lines.at(-1)).toBe("[automations] checked 1 business(es), raised 2 task(s)\n");

    await vi.advanceTimersByTimeAsync(EVERY_MS);
    expect(server.calls.length).toBeGreaterThanOrEqual(2);
    const afterTwo = server.calls.length;

    stop();
    await vi.advanceTimersByTimeAsync(EVERY_MS * 3);
    expect(server.calls).toHaveLength(afterTwo);
  });

  it("logs a failed check and carries on to the next", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const server = fakeServer(() => {
      attempt++;
      return attempt === 1 ? Promise.reject(new Error("connect ECONNREFUSED")) : ok({ businesses: 1, created: 0, failed: [] });
    });
    const lines: string[] = [];

    startAutomationSweeps({
      baseUrl: "http://localhost:3100",
      secret: "s".repeat(64),
      log: (line: string) => lines.push(line),
      fetchImpl: server.fetchImpl,
      firstRunMs: 10,
      everyMs: 100,
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(lines.at(-1)).toBe("[automations] check did not run: connect ECONNREFUSED\n");

    await vi.advanceTimersByTimeAsync(100);
    expect(lines.at(-1)).toMatch(/checked 1 business/);
  });

  it("says so when the server refuses it", async () => {
    vi.useFakeTimers();
    const server = fakeServer(() => Promise.resolve(new Response("{}", { status: 401 })));
    const lines: string[] = [];

    startAutomationSweeps({
      baseUrl: "http://localhost:3100",
      secret: "wrong",
      log: (line: string) => lines.push(line),
      fetchImpl: server.fetchImpl,
      firstRunMs: 10,
      everyMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(10);

    expect(lines).toEqual(["[automations] check refused: 401\n"]);
  });

  it("never stacks a second check on one still running", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const server = fakeServer(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ businesses: 0, created: 0 }), { status: 200 }));
        }),
    );

    startAutomationSweeps({
      baseUrl: "http://localhost:3100",
      secret: "s".repeat(64),
      fetchImpl: server.fetchImpl,
      firstRunMs: 10,
      everyMs: 20,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(server.calls).toHaveLength(1);

    release();
    await vi.advanceTimersByTimeAsync(20);
    expect(server.calls.length).toBe(2);
  });

  it("makes a fresh secret each launch, long enough for the route to accept", () => {
    const one = newSweepSecret();
    const two = newSweepSecret();

    expect(one).not.toBe(two);
    expect(one.length).toBeGreaterThanOrEqual(MIN_CRON_SECRET);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
  });
});
