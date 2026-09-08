"use strict";

const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

/**
 * Everything the desktop build needs to decide *where things live* before the
 * server starts.
 *
 * The installed program directory is read-only for a normal Windows user, so
 * nothing mutable can live beside the executable. The database, uploaded files
 * and the session secret all go under the per-user application data folder,
 * which also means uninstalling the app never deletes a business's records.
 */

/**
 * The database filename.
 *
 * Named for the product rather than the name it shipped under first. The
 * rename also gives the file a fresh identity, which matters more than it
 * should: replacing the old file in place left the running server reading a
 * stale cached image of it, byte-for-byte identical across three different
 * replacements. A new name cannot inherit that.
 */
const DATABASE_FILE = "matlockone.db";

/**
 * What the database was called under earlier product names, newest first.
 *
 * Append-only. Dropping a name here strands the data of every customer still
 * on that build.
 */
const LEGACY_DATABASE_FILES = ["worksuite.db", "fieldbase.db"];

/**
 * Where the business's records live.
 *
 * Electron defaults userData to *Roaming* AppData, which is the wrong home for
 * a database. Roaming is synchronised by Windows on domain and roaming-profile
 * setups, and a synchronised folder can hand a process a stale view of a file:
 * old contents, deleted files still listed, freshly written ones missing. That
 * is not theoretical — it is what broke sign-in here, with the server reading
 * an old, index-corrupt image of a database that was healthy on disk.
 *
 * Local AppData is never roamed, which is what a SQLite file needs.
 */
function dataRoot(app) {
  const local = process.env.LOCALAPPDATA;

  // e.g. C:\Users\<name>\AppData\Local\Matlock One
  if (process.platform === "win32" && local) {
    return path.join(local, app.getName());
  }

  return app.getPath("userData");
}

/**
 * Folders earlier versions kept data in, newest first.
 *
 * Absolute paths rather than names, because the data has moved between
 * AppData\Roaming and AppData\Local as well as between product names.
 *
 * Historical names only. Never rewrite an entry here to the current product
 * name — that points the migration at the folder it is already using, so it
 * finds nothing and opens the customer's business empty.
 */
function legacyDataDirs(app) {
  const roaming = app.getPath("appData");
  const local = process.env.LOCALAPPDATA;

  return [
    // The Work Suite build moved data off Roaming, so its folder — the one
    // holding live customer data on every machine upgrading into this
    // release — is the Local one. Roaming is where the names before it lived.
    ...(local ? [path.join(local, "Work Suite")] : []),
    path.join(roaming, "Work Suite"),
    path.join(roaming, "work-suite"),
    path.join(roaming, "Fieldbase"),
  ];
}

function paths(app) {
  const root = dataRoot(app);

  return {
    root,
    databaseFile: path.join(root, DATABASE_FILE),
    storageDir: path.join(root, "storage"),
    secretFile: path.join(root, "session.key"),
    encryptionKeyFile: path.join(root, "encryption.key"),
    logFile: path.join(root, "server.log"),
    portFile: path.join(root, "port"),
  };
}

/**
 * Reads a per-installation secret, generating it on first run.
 *
 * Kept at 0600 beside the database. Shipping a constant instead would mean
 * every copy of the software could forge every other copy's sessions, and
 * could decrypt every other copy's stored mail passwords.
 */
function installationSecret(secretFile) {
  try {
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // First run, or the file was removed. Fall through and make a new one.
  }

  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

/** Signs session cookies. */
function sessionSecret(secretFile) {
  return installationSecret(secretFile);
}

/**
 * Encrypts integration credentials.
 *
 * Deliberately a *different* file from the session key and never derived from
 * it, so a customer who rotates their sessions does not silently invalidate
 * every saved mail password. It also lives outside the database, which means a
 * copied .db file on its own does not hand over the mailbox.
 */
function encryptionKey(keyFile) {
  return installationSecret(keyFile);
}

/**
 * Creates the database on first run, by running init-db.js under the bundled
 * Node rather than loading SQLite here.
 *
 * better-sqlite3 is compiled against Node's ABI and Electron's differs, so a
 * `require` from this process throws NODE_MODULE_VERSION and takes the launch
 * down before a window ever appears. Handing the work to the same Node that
 * runs the server keeps one ABI in play.
 */
function ensureDatabase({ nodeBinary, initScript, databaseFile, schemaSqlFile }) {
  const result = spawnSync(
    nodeBinary,
    [initScript, databaseFile, schemaSqlFile],
    { encoding: "utf8" },
  );

  if (result.error) {
    throw new Error(`Could not run the database setup: ${result.error.message}`);
  }

  const output = (result.stdout || "").trim().split("\n").pop() || "";

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error(
      `Database setup returned no result.

${(result.stderr || output).slice(0, 500)}`,
    );
  }

  if (!parsed.ok) throw new Error(`Database setup failed: ${parsed.error}`);

  return parsed;
}

/**
 * Carries data forward from the folder an earlier name used.
 *
 * Electron derives the data directory from the product name, so renaming the
 * app points it at an empty folder and the business appears to have lost
 * everything. This copies the previous installation's files across on first
 * run of the renamed build.
 *
 * Deliberately a copy, not a move: if anything here goes wrong the original is
 * still sitting where it was. The cost is disk space the customer can reclaim
 * by deleting the old folder once they are satisfied.
 */
function migrateLegacyData(root, legacyDirs, databaseFile) {
  // Already has its own data — never overwrite it with something older.
  if (fs.existsSync(databaseFile)) return null;

  const names = Array.isArray(legacyDirs) ? legacyDirs : [legacyDirs];

  // Newest naming first, so a machine that has been through both renames
  // picks up the most recent data rather than the oldest.
  const dbNames = [path.basename(databaseFile), ...LEGACY_DATABASE_FILES];
  const legacy = names.find(
    (candidate) =>
      candidate !== root &&
      dbNames.some((db) => fs.existsSync(path.join(candidate, db))),
  );

  if (!legacy) return null;

  // The database and its write-ahead log, but never the -shm.
  //
  // Both halves of this were learned the hard way. Copying the -shm — SQLite's
  // volatile shared-memory index — pins a reader to a stale image of the
  // database: every row is present in the file, yet the application sees an
  // older, emptier version of it. Copying neither sidecar is just as wrong:
  // transactions that are committed but not yet checkpointed live only in the
  // -wal, so leaving it behind silently drops recent work.
  const wanted = [
    "session.key",
    "encryption.key",
    "server.log",
    "storage",
  ];

  // Backups the customer or the recovery tool made.
  for (const entry of fs.readdirSync(legacy)) {
    if (/-backup-.*\.db$/.test(entry)) wanted.push(entry);
  }

  fs.mkdirSync(root, { recursive: true });

  const copied = [];

  // The database first, under whatever name that installation used, written
  // out under the current one. Its write-ahead log comes with it: transactions
  // committed but not yet checkpointed live only there.
  const target = path.basename(databaseFile);
  for (const name of [target, ...LEGACY_DATABASE_FILES]) {
    const from = path.join(legacy, name);
    if (!fs.existsSync(from) || fs.existsSync(databaseFile)) continue;

    fs.cpSync(from, databaseFile);
    copied.push(`${name} -> ${target}`);

    if (fs.existsSync(`${from}-wal`)) {
      fs.cpSync(`${from}-wal`, `${databaseFile}-wal`);
      copied.push(`${name}-wal`);
    }
    break;
  }

  for (const entry of wanted) {
    const from = path.join(legacy, entry);
    const to = path.join(root, entry);
    if (!fs.existsSync(from) || fs.existsSync(to)) continue;

    fs.cpSync(from, to, { recursive: true });
    copied.push(entry);
  }

  return copied.length > 0 ? { from: legacy, copied } : null;
}

/** Asks the OS for a free port rather than assuming 3000 is available. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Whether this machine will let the server listen on `port`. */
function portAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, "0.0.0.0", () => server.close(() => resolve(true)));
  });
}

/**
 * The port to serve on, kept the same from one launch to the next.
 *
 * It used to be whatever the operating system handed out, which changes on
 * every start. That address goes into the emailed invoice — "View it here" —
 * so a link a client was sent on Tuesday pointed at nothing by Wednesday.
 * A remembered port also means a firewall rule, or a bookmark on a phone in
 * the van, only has to be set up once.
 *
 * 47720 is in the range nothing is registered for. If something has taken it
 * anyway, a free port is used and remembered instead — serving on an unexpected
 * port is a broken link, but refusing to start is a broken business.
 */
const DEFAULT_PORT = 47720;

async function stablePort(portFile, fallbackPort = DEFAULT_PORT) {
  const remembered = Number.parseInt(
    (() => {
      try {
        return fs.readFileSync(portFile, "utf8").trim();
      } catch {
        return "";
      }
    })(),
    10,
  );

  const preferred =
    Number.isInteger(remembered) && remembered >= 1024 && remembered <= 65535
      ? remembered
      : fallbackPort;

  const port = (await portAvailable(preferred)) ? preferred : await freePort();

  try {
    fs.mkdirSync(path.dirname(portFile), { recursive: true });
    fs.writeFileSync(portFile, String(port));
  } catch {
    // Losing the file costs a changed address next launch, not a failed start.
  }

  return port;
}

/**
 * The address other devices on the office network use.
 *
 * Picks the first non-internal IPv4 address. A machine with several adapters
 * (wifi plus a VPN, say) can have more than one; the rest are returned so the
 * UI can offer them if the first does not work.
 */
function lanAddresses(port) {
  const addresses = [];

  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) {
        addresses.push(`http://${entry.address}:${port}`);
      }
    }
  }

  return addresses;
}

/** Polls the server until it answers, so the window never opens on an error. */
async function waitForServer(url, { timeoutMs = 60_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      // Any HTTP answer means it is listening; a redirect to /login is normal.
      if (response.status > 0) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return false;
}

module.exports = {
  paths,
  legacyDataDirs,
  migrateLegacyData,
  sessionSecret,
  encryptionKey,
  ensureDatabase,
  freePort,
  stablePort,
  DEFAULT_PORT,
  lanAddresses,
  waitForServer,
};
