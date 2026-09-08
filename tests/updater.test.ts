import { createRequire } from "node:module";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * When the app is allowed to interrupt you about a new version.
 *
 * The mechanism is electron-updater's; what is worth holding still is the
 * policy around it. A field service app is open while somebody is invoicing a
 * customer, and an update is never urgent enough to get in the way of that.
 */

const require = createRequire(import.meta.url);

type Handlers = Record<string, (payload?: unknown) => void>;

/** A stand-in for electron-updater that records what was asked of it. */
function fakeUpdater() {
  const handlers: Handlers = {};
  return {
    handlers,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    logger: null as unknown,
    checks: 0,
    installs: [] as { silent: boolean; runAfter: boolean }[],
    on(event: string, fn: (payload?: unknown) => void) {
      handlers[event] = fn;
    },
    checkForUpdates() {
      this.checks += 1;
      return Promise.resolve(null);
    },
    quitAndInstall(silent: boolean, runAfter: boolean) {
      this.installs.push({ silent, runAfter });
    },
    emit(event: string, payload?: unknown) {
      handlers[event]?.(payload);
    },
  };
}

const shown: { title?: string; buttons?: string[] }[] = [];

const { setupUpdates } = require(
  path.resolve(process.cwd(), "electron", "updater.js"),
) as {
  setupUpdates: (options: Record<string, unknown>) => (() => void) | null;
};

function options(overrides: Record<string, unknown> = {}) {
  return {
    app: { getVersion: () => "0.1.0" },
    dialog: {
      showMessageBox: (_window: unknown, config: { title?: string; buttons?: string[] }) => {
        shown.push({ title: config.title, buttons: config.buttons });
        return Promise.resolve({ response: 1 });
      },
    },
    isPackaged: true,
    log: () => {},
    getWindow: () => null,
    ...overrides,
  };
}

afterEach(() => {
  shown.length = 0;
  vi.useRealTimers();
});

describe("when updates run at all", () => {
  it("does nothing in a development run", () => {
    const updater = fakeUpdater();
    
    // There is no installed copy to replace, and electron-updater throws
    // rather than quietly doing nothing.
    expect(setupUpdates(options({ updater, isPackaged: false }))).toBeNull();
    expect(updater.checks).toBe(0);
  });

  it("starts anyway when electron-updater is missing", () => {
    
    // The launcher's dependencies are pruned hard to keep the installer small.
    // If that ever goes wrong the app must still open: an update mechanism is
    // not worth a business losing access to its records over.
    expect(() => setupUpdates(options({ updater: null }))).not.toThrow();
    expect(setupUpdates(options({ updater: null }))).toBeNull();
  });
});

describe("not being a nuisance", () => {
  it("waits before the first check rather than checking at launch", () => {
    vi.useFakeTimers();
    const updater = fakeUpdater();
    setupUpdates(options({ updater }));

    // Opening the app is the moment somebody wants to get to work.
    expect(updater.checks).toBe(0);

    vi.advanceTimersByTime(29_000);
    expect(updater.checks).toBe(0);

    vi.advanceTimersByTime(2_000);
    expect(updater.checks).toBe(1);
  });

  it("says nothing when an automatic check fails", () => {
    const updater = fakeUpdater();
    setupUpdates(options({ updater }));

    updater.emit("error", new Error("getaddrinfo ENOTFOUND"));

    // A web server being briefly unreachable is not news to somebody midway
    // through an invoice.
    expect(shown).toHaveLength(0);
  });

  it("says nothing when an automatic check finds nothing", () => {
    const updater = fakeUpdater();
    setupUpdates(options({ updater }));

    updater.emit("update-not-available", { version: "0.1.0" });

    expect(shown).toHaveLength(0);
  });

  it("never installs behind your back", () => {
    const updater = fakeUpdater();
    setupUpdates(options({ updater }));

    // The default is to apply an update on the next quit without asking.
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });

  it("downloads without asking, since that costs nothing", () => {
    const updater = fakeUpdater();
    setupUpdates(options({ updater }));

    expect(updater.autoDownload).toBe(true);
  });
});

describe("a check somebody asked for", () => {
  it("answers when there is no update", () => {
    const updater = fakeUpdater();
    const check = setupUpdates(options({ updater }))!;

    check();
    updater.emit("update-not-available", { version: "0.1.0" });

    // A button that appears to do nothing is worse than no button.
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("No update available");
  });

  it("answers when the server cannot be reached", () => {
    const updater = fakeUpdater();
    const check = setupUpdates(options({ updater }))!;

    check();
    updater.emit("error", new Error("ETIMEDOUT"));

    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Could not check for updates");
  });

  it("goes quiet again afterwards", () => {
    const updater = fakeUpdater();
    const check = setupUpdates(options({ updater }))!;

    check();
    updater.emit("update-not-available", { version: "0.1.0" });
    expect(shown).toHaveLength(1);

    // The next automatic check must not inherit the last manual one's voice.
    updater.emit("update-not-available", { version: "0.1.0" });
    expect(shown).toHaveLength(1);
  });
});

describe("once an update is downloaded", () => {
  it("asks before installing, offering to wait", async () => {
    const updater = fakeUpdater();
    setupUpdates(options({ updater }));

    updater.emit("update-downloaded", { version: "0.2.0" });
    await Promise.resolve();
    await Promise.resolve();

    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Update ready");
    expect(shown[0].buttons).toEqual(["Install and restart", "Install when I quit"]);
  });
});
