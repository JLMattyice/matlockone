"use strict";

/**
 * Keeping installed copies up to date.
 *
 * Without this, every fix means posting a 144 MB file to each person who has
 * the app and talking them through Windows' security warning — which is
 * exactly how a fixed bug can sit uninstalled for days while somebody keeps
 * hitting it.
 *
 * The rules here are all about not being a nuisance:
 *
 *  - A failed check is silent. Someone working on an invoice does not want a
 *    dialog because a web server was briefly unreachable, and an update is
 *    never urgent enough to interrupt for.
 *  - Nothing installs itself while the app is open. The download happens in
 *    the background and is applied when they choose, or on next quit.
 *  - A check the person asked for always answers, including "you are up to
 *    date" — a button that appears to do nothing is worse than no button.
 */

const AN_HOUR = 60 * 60 * 1000;

/**
 * electron-updater, or null.
 *
 * Loaded defensively on purpose. The launcher's dependencies are pruned hard
 * to keep the installer small, and if that pruning ever goes wrong the app
 * must still start — an update mechanism is not worth a business losing access
 * to its records over.
 */
function load(log) {
  try {
    return require("electron-updater").autoUpdater;
  } catch (error) {
    log?.(`Updates unavailable: ${error.message}`);
    return null;
  }
}

/**
 * Wires up update checking.
 *
 * Returns a function that runs a check the person asked for, or null when
 * updates cannot work here — so the caller knows whether to offer the menu
 * item at all.
 */
function setupUpdates({ app, dialog, isPackaged, log, getWindow, updater: injected }) {
  const write = (message) => log?.(`[updater] ${message}\n`);

  // A development run has no installed copy to replace, and electron-updater
  // throws rather than no-oping.
  if (!isPackaged) {
    write("skipped: not a packaged build");
    return null;
  }

  // Injected by the tests. Undefined means "load the real one"; null means
  // "there isn't one", which is what a pruned dependency looks like.
  const updater = injected === undefined ? load(write) : injected;
  if (!updater) {
    write("no updater available");
    return null;
  }

  updater.autoDownload = true;
  // Applying an update on quit is the least disruptive moment there is, but it
  // must never happen without the person having been told first.
  updater.autoInstallOnAppQuit = false;
  updater.logger = { info: write, warn: write, error: write, debug: () => {} };

  let downloaded = null;
  /** Set while a check the user asked for is in flight. */
  let asked = false;

  updater.on("update-available", (info) => {
    write(`update available: ${info?.version}`);
    if (asked) {
      dialog.showMessageBox(getWindow(), {
        type: "info",
        title: "Update available",
        message: `Matlock One ${info?.version} is available.`,
        detail:
          "It is downloading in the background. You will be asked before anything is installed, and nothing interrupts what you are doing.",
        buttons: ["OK"],
      });
      asked = false;
    }
  });

  updater.on("update-not-available", (info) => {
    write(`no update: on ${info?.version}`);
    if (asked) {
      dialog.showMessageBox(getWindow(), {
        type: "info",
        title: "No update available",
        message: "Matlock One is up to date.",
        detail: `You are running version ${app.getVersion()}.`,
        buttons: ["OK"],
      });
      asked = false;
    }
  });

  updater.on("error", (error) => {
    write(`check failed: ${error?.message ?? error}`);

    // Only ever surfaced when somebody pressed the button. An automatic check
    // that failed is not news.
    if (asked) {
      dialog.showMessageBox(getWindow(), {
        type: "warning",
        title: "Could not check for updates",
        message: "Matlock One could not reach the update server.",
        detail:
          "This does not affect the copy you are running. Check your internet connection and try again later.",
        buttons: ["OK"],
      });
      asked = false;
    }
  });

  updater.on("update-downloaded", async (info) => {
    downloaded = info;
    write(`downloaded: ${info?.version}`);

    const { response } = await dialog.showMessageBox(getWindow(), {
      type: "info",
      title: "Update ready",
      message: `Matlock One ${info?.version} is ready to install.`,
      detail:
        "Installing takes about a minute and closes the app. Your business records are not touched — they live outside the program folder.",
      buttons: ["Install and restart", "Install when I quit"],
      defaultId: 0,
      cancelId: 1,
    });

    if (response === 0) {
      // isSilent false: the installer's progress window is reassuring on a
      // download this size. isForceRunAfter true: they asked to come back.
      updater.quitAndInstall(false, true);
    } else {
      updater.autoInstallOnAppQuit = true;
      write("deferred to next quit");
    }
  });

  // Well after launch. Starting the app is the moment somebody wants to get to
  // work, not to be told about software.
  setTimeout(() => {
    updater.checkForUpdates().catch(() => {});
  }, 30_000);

  // A copy left running for weeks should still notice.
  setInterval(() => {
    if (!downloaded) updater.checkForUpdates().catch(() => {});
  }, 6 * AN_HOUR);

  return function checkNow() {
    if (downloaded) {
      updater.quitAndInstall(false, true);
      return;
    }
    asked = true;
    updater.checkForUpdates().catch(() => {
      // The error handler above reports it; this stops an unhandled rejection.
    });
  };
}

module.exports = { setupUpdates };
