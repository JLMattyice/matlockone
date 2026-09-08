import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

/**
 * Assembles everything the desktop installer ships.
 *
 * The output is `desktop-build/`:
 *   app/        the Next.js standalone server, its traced node_modules, and
 *               the schema DDL used to create a database on first run
 *   node/       the Node binary that compiled the native SQLite module
 *
 * electron-builder copies both into the installer's resources. Nothing here is
 * a second implementation of the app — it is the same server that runs when
 * hosted, just placed where a packaged Electron app can find it.
 */

const root = process.cwd();
const require = createRequire(import.meta.url);

const OUT = path.join(root, "desktop-build");
const APP_OUT = path.join(OUT, "app");
const NODE_OUT = path.join(OUT, "node");

function run(command, args, label) {
  process.stdout.write(`  ${label}… `);
  execFileSync(command, args, { cwd: root, stdio: "pipe" });
  process.stdout.write("done\n");
}

function copyDir(from, to) {
  fs.cpSync(from, to, { recursive: true, dereference: true });
}

console.log("Building Matlock One desktop\n");

// 0. The launcher is plain JavaScript, so it sits outside the TypeScript
//    project and tsc never sees it. Parse each file before building: a syntax
//    error here produces a running process with no window and no message,
//    which is the worst possible failure to debug from a customer's desk.
for (const file of fs.readdirSync(path.join(root, "electron"))) {
  if (!file.endsWith(".js")) continue;
  const target = path.join(root, "electron", file);
  try {
    execFileSync(process.execPath, ["--check", target], { stdio: "pipe" });
  } catch (error) {
    throw new Error(`electron/${file} does not parse:
${error.stderr?.toString() ?? ""}`);
  }
}
console.log("  launcher syntax… done");

// 1. A fresh output tree, so a stale file can never ship.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(APP_OUT, { recursive: true });
fs.mkdirSync(NODE_OUT, { recursive: true });

// 2. The Prisma client, then the DDL that creates a database on first run.
//    Generated from the same schema this build compiles against, so the two
//    can never disagree.
const prismaCli = require.resolve("prisma/build/index.js");
run(process.execPath, [prismaCli, "generate"], "Prisma client");

const schemaSql = execFileSync(
  process.execPath,
  [
    prismaCli,
    "migrate",
    "diff",
    "--from-empty",
    "--to-schema",
    path.join("prisma", "schema.prisma"),
    "--script",
  ],
  { cwd: root, encoding: "utf8" },
);
fs.writeFileSync(path.join(root, "prisma", "schema.sql"), schemaSql);
fs.writeFileSync(path.join(APP_OUT, "schema.sql"), schemaSql);
console.log("  schema DDL… done");

// 3. The application build. `output: "standalone"` in next.config.ts emits a
//    server plus only the dependencies it actually traced.
run(process.execPath, [require.resolve("next/dist/bin/next"), "build"], "Next build");

const standalone = path.join(root, ".next", "standalone");
if (!fs.existsSync(standalone)) {
  throw new Error(
    "No .next/standalone directory. Check that next.config.ts sets output: 'standalone'.",
  );
}

// 4. Standalone omits the static assets and public files by design; without
//    these the app loads but renders unstyled.
copyDir(standalone, APP_OUT);
copyDir(path.join(root, ".next", "static"), path.join(APP_OUT, ".next", "static"));

const publicDir = path.join(root, "public");
if (fs.existsSync(publicDir)) {
  copyDir(publicDir, path.join(APP_OUT, "public"));
}
console.log("  server + assets… done");

// 5. Next copies .env into the standalone output and reloads it at runtime,
//    where it would override everything the launcher passes. Shipping it would
//    point every install at a relative dev.db inside Program Files AND put a
//    known SESSION_SECRET in every customer's copy — a signing key anyone
//    could use to forge sessions. The desktop app supplies its configuration
//    explicitly, so none of these belong in the build.
for (const entry of fs.readdirSync(APP_OUT)) {
  if (entry === ".env" || entry.startsWith(".env.")) {
    fs.rmSync(path.join(APP_OUT, entry), { force: true });
    console.log(`  removed ${entry} from the bundle… done`);
  }
}

// 6. The scripts that touch the database live beside the server so they
//    resolve better-sqlite3 from the same node_modules and run under the same
//    Node as the server itself.
for (const script of ["init-db.js", "reset-password.js"]) {
  fs.copyFileSync(
    path.join(root, "electron", script),
    path.join(APP_OUT, script),
  );
}
console.log("  database scripts… done");

// 7. The native SQLite module is the one thing tracing cannot bundle as plain
//    JavaScript, so make sure the compiled binding actually came across.
const binding = path.join(
  APP_OUT,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);
if (!fs.existsSync(binding)) {
  const source = path.join(root, "node_modules", "better-sqlite3");
  copyDir(source, path.join(APP_OUT, "node_modules", "better-sqlite3"));
}
if (!fs.existsSync(binding)) {
  throw new Error(
    "better_sqlite3.node is missing from the build. Run `npm rebuild better-sqlite3` and try again.",
  );
}
console.log("  native SQLite binding… done");

// 8. Ship the exact Node that compiled that binding. Running the server under
//    Electron's Node instead would tie the build to Electron's ABI.
fs.copyFileSync(process.execPath, path.join(NODE_OUT, path.basename(process.execPath)));

//    Record what this bundle is for. Neither the Node binary nor the SQLite
//    binding can be cross-compiled, so scripts/after-pack.cjs refuses to
//    package this into an installer for a different platform or architecture
//    rather than shipping one that dies on first launch.
fs.writeFileSync(
  path.join(NODE_OUT, "build-host.json"),
  `${JSON.stringify({ platform: process.platform, arch: process.arch }, null, 2)}\n`,
);
console.log(`  Node runtime… done (${process.platform}/${process.arch})`);

const size = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) {
      total += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
    }
  }
  return (total / 1024 / 1024).toFixed(0);
};

console.log(`\nReady in desktop-build/  (app ${size(APP_OUT)} MB + node ${size(NODE_OUT)} MB)`);
console.log("Next: npm run desktop:pack   (installer)   or   npm run desktop   (run it)");
