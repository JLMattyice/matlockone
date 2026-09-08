"use strict";

const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  dialog,
  ipcMain,
  shell,
} = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const { attachContextMenu } = require("./context-menu");
const { setupUpdates } = require("./updater");
const {
  encryptionKey,
  ensureDatabase,
  stablePort,
  legacyDataDirs,
  migrateLegacyData,
  lanAddresses,
  paths,
  sessionSecret,
  waitForServer,
} = require("./runtime");

/**
 * Matlock One desktop.
 *
 * Electron here is a launcher and a window, not the application. It starts the
 * real Next.js server as a child process and points a BrowserWindow at it, so
 * the desktop build and a hosted deployment run byte-identical application
 * code — there is no second implementation to keep in step.
 *
 * The server binds to 0.0.0.0 on purpose: this machine is the office server,
 * and phones and laptops on the same network sign in against it.
 */

// Only one copy may run: two servers would fight over the same database file.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/**
 * Move Chromium's profile out of Roaming AppData, next to the database.
 *
 * The signed-in cookie lives in that profile, in a SQLite file of Chromium's
 * own. Roaming is synchronised by Windows and can hand a process a stale view
 * of a file — which is exactly how the database was corrupted here. A rolled
 * back cookie jar is far less serious than a rolled back database, but it
 * shows up as the one thing "keep me signed in" is supposed to prevent: being
 * asked to sign in again for no visible reason.
 *
 * Must run before the app is ready, while nothing has opened the profile yet.
 */
if (process.platform === "win32" && process.env.LOCALAPPDATA) {
  const profile = path.join(paths(app).root, "browser");
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
}

let serverProcess = null;
/** Runs an update check the person asked for, or null if updates cannot work. */
let checkForUpdates = null;
let mainWindow = null;
let recoveryWindow = null;
let log = null;
let connectionInfo = { local: "", lan: [] };

const isPackaged = app.isPackaged;

/** The bundled Node's filename. Only Windows gives it an extension. */
const NODE_BINARY_NAME = process.platform === "win32" ? "node.exe" : "node";

/** Where the built server and its assets live in each mode. */
function resourcePaths() {
  // `server`, not `app`: Electron reserves resources/app for an unpacked
  // application directory and will not let a payload live there.
  const base = isPackaged
    ? path.join(process.resourcesPath, "server")
    : path.resolve(__dirname, "..");

  return {
    serverEntry: isPackaged
      ? path.join(base, "server.js")
      : path.join(base, ".next", "standalone", "server.js"),
    serverCwd: isPackaged ? base : path.join(base, ".next", "standalone"),
    schemaSqlFile: isPackaged
      ? path.join(base, "schema.sql")
      : path.join(base, "prisma", "schema.sql"),
    initScript: isPackaged
      ? path.join(base, "init-db.js")
      : path.join(base, "electron", "init-db.js"),
    resetScript: isPackaged
      ? path.join(base, "reset-password.js")
      : path.join(base, "electron", "reset-password.js"),
    // The server runs under a bundled Node, not under Electron-as-Node.
    // better-sqlite3 is a native module: running it under Electron would tie
    // the build to Electron's ABI and force a rebuild on every Electron bump.
    // Shipping the same Node that compiled it removes that coupling entirely.
    nodeBinary: isPackaged
      ? path.join(process.resourcesPath, "node", NODE_BINARY_NAME)
      : "node",
  };
}

/**
 * An append-only log that is actually on disk when you go looking for it.
 *
 * fs.createWriteStream buffers, and Electron being force-quit or the server
 * being killed discards whatever is still in memory. Writing synchronously
 * costs nothing at this volume and means the log never lies about what
 * happened.
 */
function openLog(logFile) {
  // Keep it from growing without bound across months of daily launches. One
  // previous generation is kept, which is enough to compare a working run with
  // a broken one.
  try {
    const MAX_BYTES = 2 * 1024 * 1024;
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_BYTES) {
      fs.renameSync(logFile, `${logFile}.old`);
    }
  } catch {
    // A locked or unreadable log must not stop the app from starting.
  }

  let fd = null;
  try {
    fd = fs.openSync(logFile, "a");
  } catch {
    // Read-only disk, or the folder is gone. The app still runs; it just
    // cannot explain itself afterwards.
  }

  return {
    write(text) {
      if (fd === null) return;
      try {
        fs.writeSync(fd, typeof text === "string" ? text : text.toString());
      } catch {
        // Disk full mid-session. Losing the log is not worth crashing over.
      }
    },
    close() {
      if (fd === null) return;
      try {
        fs.closeSync(fd);
      } catch {
        // Already gone.
      }
      fd = null;
    },
  };
}

async function startServer() {
  const store = paths(app);
  const resources = resourcePaths();

  fs.mkdirSync(store.storageDir, { recursive: true });

  // The app shipped as "Fieldbase", then "Work Suite", before it was renamed
  // to this, and Electron derives the data folder from the product name.
  // Without this, a customer upgrading across a rename opens the app to an
  // empty business.
  // NOTE: these are historical folder names and must never be renamed along
  // with the product. A find-and-replace across "Fieldbase" once rewrote this
  // list to the *current* name, which made the migration look for the folder it
  // was already using, find nothing, and start the customer with an empty
  // database. Their data was safe only because this copies rather than moves.
  const carried = migrateLegacyData(
    store.root,
    legacyDataDirs(app),
    store.databaseFile,
  );

  const { created, addedTables, addedColumns, needsMigration } = ensureDatabase({
    nodeBinary: resources.nodeBinary,
    initScript: resources.initScript,
    databaseFile: store.databaseFile,
    schemaSqlFile: resources.schemaSqlFile,
  });

  // The same port every launch: the address goes out in emailed invoices.
  const port = await stablePort(store.portFile);
  const local = `http://localhost:${port}`;

  connectionInfo = { local, lan: lanAddresses(port), firstRun: created };

  log = openLog(store.logFile);

  // Every run gets a header, so a log holding several launches can be read.
  log.write(
    `
=== Matlock One started ${new Date().toISOString()} on port ${port} ===
`,
  );

  // Worth a line in the log: if an upgrade goes wrong, this is the first thing
  // to look at.
  if (carried) {
    log.write(
      `[matlock-one] Carried data forward from ${carried.from}: ${carried.copied.join(", ")}\n`,
    );
  }
  if (addedTables && addedTables.length > 0) {
    log.write(`[matlock-one] Upgraded database, added: ${addedTables.join(", ")}
`);
  }
  if (addedColumns && addedColumns.length > 0) {
    log.write(`[matlock-one] Upgraded database, added: ${addedColumns.join(", ")}
`);
  }
  if (needsMigration && needsMigration.length > 0) {
    log.write(
      `[matlock-one] NOT applied automatically, needs a migration: ${needsMigration.join(", ")}
`,
    );
  }

  serverProcess = spawn(
    resources.nodeBinary,
    [resources.serverEntry],
    {
      cwd: resources.serverCwd,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        // 0.0.0.0 so the crew can reach it; localhost would make this
        // single-machine software.
        HOSTNAME: "0.0.0.0",
        // Forward slashes even on Windows: a file: URL is a URL, and a
        // backslash in one is an escape character, not a separator.
        DATABASE_URL: `file:${store.databaseFile.split(path.sep).join("/")}`,
        STORAGE_DIR: store.storageDir,
        SESSION_SECRET: sessionSecret(store.secretFile),
        // Protects the mail passwords and API keys saved under Settings.
        ENCRYPTION_KEY: encryptionKey(store.encryptionKeyFile),
        // Client-facing links resolve on the local network.
        APP_URL: connectionInfo.lan[0] ?? local,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Written synchronously rather than piped into a write stream. A stream
  // buffers until 64KB or close, so a server that starts and is then killed
  // leaves an empty log — exactly the run you need to read. This is a
  // troubleshooting log; it has to be on disk before the next thing happens.
  serverProcess.stdout.on("data", (chunk) => log.write(chunk));
  serverProcess.stderr.on("data", (chunk) => log.write(chunk));

  serverProcess.on("exit", (code) => {
    log.write(`
=== server exited with code ${code} at ${new Date().toISOString()} ===
`);

    // A server that dies takes the window with it rather than leaving a blank
    // frame the user cannot do anything with.
    if (code !== 0 && !app.isQuitting) {
      dialog.showErrorBox(
        "Matlock One stopped unexpectedly",
        `The server exited with code ${code}.\n\nDetails were written to:\n${store.logFile}`,
      );
      app.quit();
    }
  });

  const ready = await waitForServer(local);
  if (!ready) {
    dialog.showErrorBox(
      "Matlock One could not start",
      `The server did not respond in time.\n\nDetails were written to:\n${store.logFile}`,
    );
    app.quit();
    return null;
  }

  return local;
}

/**
 * Where the desktop window opens. "/" is the public marketing site, which is
 * for people deciding whether to install this — not for someone who already
 * did. Middleware forwards a signed-in visitor from /login to /dashboard, so
 * this is the same two-way entry the root route used to provide, minus the
 * sales pitch.
 */
function appEntry(base) {
  return `${base}/login`;
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: "#0b1120",
    title: "Matlock One",
    autoHideMenuBar: false,
    webPreferences: {
      // Nothing in the app needs Node, and the page is a web app: keep the
      // renderer sandboxed as a browser tab would be.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // Underlines misspellings in notes, descriptions and email bodies.
      spellcheck: true,
    },
  });

  // A browser window gives you a right-click menu for free; an Electron one
  // does not. Without this there is no Cut/Copy/Paste and no way to accept a
  // spelling correction except by retyping the word.
  attachContextMenu(mainWindow.webContents, { Menu }, clipboard);

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(appEntry(url));

  // External links open in the real browser, not inside the app frame.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith(connectionInfo.local)) {
      shell.openExternal(target);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function showConnectionInfo() {
  const store = paths(app);
  const lan = connectionInfo.lan;

  const body = lan.length
    ? [
        "Your team can sign in from any phone or computer on the same network.",
        "",
        "Open this address in their browser:",
        ...lan.map((address) => `    ${address}`),
        "",
        "This computer must stay on and running Matlock One for them to connect.",
        "Windows may ask you to allow Matlock One through the firewall the first",
        "time — choose Private networks.",
      ].join("\n")
    : [
        "No network connection was detected, so only this computer can use",
        "Matlock One right now.",
        "",
        "Connect this machine to your office network and restart Matlock One to",
        "let your team sign in.",
      ].join("\n");

  dialog
    .showMessageBox(mainWindow, {
      type: "info",
      title: "Connect your team",
      message: "Matlock One is running on this computer",
      detail: `${body}\n\nYour data is stored at:\n${store.root}`,
      buttons: lan.length ? ["Copy address", "Close"] : ["Close"],
      defaultId: 0,
      cancelId: lan.length ? 1 : 0,
      noLink: true,
    })
    .then(({ response }) => {
      if (lan.length && response === 0) clipboard.writeText(lan[0]);
    });
}

// ------------------------------------------------------------- recovery ---

/**
 * Runs the recovery script under the bundled Node and parses its one JSON line.
 *
 * Shares the reasoning with ensureDatabase: better-sqlite3 cannot be required
 * from the Electron process, so anything touching the database is handed to the
 * same Node that runs the server.
 */
function runRecovery(args) {
  const store = paths(app);
  const resources = resourcePaths();

  const result = spawnSync(
    resources.nodeBinary,
    [resources.resetScript, store.databaseFile, ...args],
    { encoding: "utf8" },
  );

  if (result.error) {
    return { ok: false, error: `Could not run the recovery tool: ${result.error.message}` };
  }

  const output = (result.stdout || "").trim().split("\n").pop() || "";

  try {
    return JSON.parse(output);
  } catch {
    return {
      ok: false,
      error: (result.stderr || output || "The recovery tool returned nothing.").slice(0, 300),
    };
  }
}

/**
 * Restarts the server after a password change.
 *
 * Without this the reset appears not to work: the running server holds the
 * database open and keeps checking against the hash it already had, so the new
 * password is rejected until the app is restarted by hand. Learned the hard
 * way — the fix has to be part of the feature, not an instruction to the user.
 */
async function restartServerAfterRecovery() {
  if (serverProcess && !serverProcess.killed) {
    // The exit handler treats a non-zero code as a crash worth reporting.
    app.isQuitting = true;
    serverProcess.kill();
    app.isQuitting = false;
  }
  serverProcess = null;

  const url = await startServer();
  if (!url) return;

  if (mainWindow) mainWindow.loadURL(appEntry(url));
  else createWindow(url);
}

function openRecoveryWindow() {
  if (recoveryWindow) {
    recoveryWindow.focus();
    return;
  }

  recoveryWindow = new BrowserWindow({
    width: 520,
    height: 520,
    parent: mainWindow ?? undefined,
    modal: Boolean(mainWindow),
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Reset a password",
    backgroundColor: "#0b1120",
    autoHideMenuBar: true,
    webPreferences: {
      // The form gets exactly two IPC calls through the preload and nothing
      // else: no Node, no filesystem, isolated context.
      preload: path.join(__dirname, "recover-preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });

  // Pasting a password from a password manager is the normal way to use this.
  attachContextMenu(recoveryWindow.webContents, { Menu }, clipboard);

  recoveryWindow.loadFile(path.join(__dirname, "recover.html"));
  recoveryWindow.on("closed", () => {
    recoveryWindow = null;
  });
}

ipcMain.handle("recovery:list", () => runRecovery(["list"]));

ipcMain.handle("recovery:reset", async (event, { email, password }) => {
  // Only the window this process opened may drive a reset.
  if (!recoveryWindow || event.sender !== recoveryWindow.webContents) {
    return { ok: false, error: "Unexpected request." };
  }

  const result = runRecovery(["reset", String(email ?? ""), String(password ?? "")]);

  if (result.ok) {
    if (log) {
      log.write(
        `=== password reset for ${result.email} via the launcher at ${new Date().toISOString()} ===\n`,
      );
    }

    // Let the window show its confirmation before it disappears.
    setTimeout(async () => {
      if (recoveryWindow) recoveryWindow.close();
      await restartServerAfterRecovery();
    }, 1200);
  }

  return result;
});

ipcMain.on("recovery:cancel", (event) => {
  if (recoveryWindow && event.sender === recoveryWindow.webContents) {
    recoveryWindow.close();
  }
});

function buildMenu() {
  const store = paths(app);

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [
          {
            label: "Connect your team…",
            accelerator: "CmdOrCtrl+Shift+C",
            click: showConnectionInfo,
          },
          { type: "separator" },
          {
            label: "Open data folder",
            click: () => shell.openPath(store.root),
          },
          {
            label: "Open server log",
            click: () => shell.openPath(store.logFile),
          },
          { type: "separator" },
          {
            label: "Reset a password…",
            click: openRecoveryWindow,
          },
          { type: "separator" },
          { role: "quit", label: "Exit Matlock One" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Help",
        submenu: [
          // Absent rather than disabled in a development run: a greyed-out
          // item invites a click and then explains nothing.
          ...(checkForUpdates
            ? [
                {
                  label: "Check for updates…",
                  click: () => checkForUpdates(),
                },
                { type: "separator" },
              ]
            : []),
          {
            label: "About Matlock One",
            click: () =>
              dialog.showMessageBox(mainWindow, {
                type: "info",
                title: "About Matlock One",
                message: `Matlock One ${app.getVersion()}`,
                detail:
                  "Field service management.\n\nYour data never leaves this computer unless you choose to share it.",
                buttons: ["Close"],
                noLink: true,
              }),
          },
        ],
      },
    ]),
  );
}

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  buildMenu();

  let url;
  try {
    url = await startServer();
  } catch (error) {
    // Without this, a failure here rejects into nothing: the process stays
    // alive with no window and no explanation.
    dialog.showErrorBox(
      "Matlock One could not start",
      `${error && error.message ? error.message : String(error)}

Data folder:
${paths(app).root}`,
    );
    app.quit();
    return;
  }

  if (!url) return;

  createWindow(url);

  // After the window, so the log file exists and there is something to parent
  // a dialog to. The menu is rebuilt because it was assembled before this ran
  // and the "Check for updates" item only belongs there if updates can work.
  checkForUpdates = setupUpdates({
    app,
    dialog,
    isPackaged,
    log: (message) => log?.write(message),
    getWindow: () => mainWindow,
  });
  if (checkForUpdates) buildMenu();

  // Tell them how to get the crew connected the first time only.
  if (connectionInfo.firstRun) setTimeout(showConnectionInfo, 1200);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(url);
  });
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
});

// The child server must not outlive the app, or the next launch finds the
// database locked by an orphan.
app.on("quit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
  if (log) {
    log.write(`=== Matlock One quit ${new Date().toISOString()} ===
`);
    log.close();
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (serverProcess && !serverProcess.killed) serverProcess.kill();
    if (log) {
      log.write(`=== Matlock One received ${signal} ===
`);
      log.close();
    }
    process.exit(0);
  });
}
