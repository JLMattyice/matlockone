"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Copies the server bundle and the Node runtime into the packaged app.
 *
 * This is done here rather than through `extraResources` because
 * electron-builder applies its own ignore patterns to that copy and silently
 * drops `node_modules` and dot-directories — which would produce an installer
 * that looks complete but ships a server with no dependencies and no build
 * output. Copying directly is both exact and verifiable, so the checks below
 * fail the build rather than letting a broken installer reach anyone.
 */
/** electron-builder's Arch enum, which is not exported to plain CommonJS. */
const ARCH_NAMES = ["ia32", "x64", "armv7l", "arm64", "universal"];

/**
 * Where the packaged app keeps its resources, which is not the same place on
 * every platform.
 *
 * Windows and Linux put them in `<appOutDir>/resources`. macOS puts them inside
 * the bundle, at `<appOutDir>/<Product>.app/Contents/Resources` — capital R.
 * Using the Windows path on a Mac build writes a stray `resources` folder
 * beside the .app, so the app ships with no server at all.
 */
function resourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    return path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`,
      "Contents",
      "Resources",
    );
  }

  return path.join(context.appOutDir, "resources");
}

module.exports = async function afterPack(context) {
  const projectRoot = context.packager.info.projectDir;
  const resources = resourcesDir(context);
  const platform = context.electronPlatformName;

  const copies = [
    { from: path.join(projectRoot, "desktop-build", "app"), to: path.join(resources, "server") },
    { from: path.join(projectRoot, "desktop-build", "node"), to: path.join(resources, "node") },
  ];

  for (const { from, to } of copies) {
    if (!fs.existsSync(from)) {
      throw new Error(
        `Missing ${path.relative(projectRoot, from)}. Run \`npm run desktop:build\` first.`,
      );
    }

    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, dereference: true });
  }

  // Anything the app cannot start without. A missing file here is the
  // difference between shipping software and shipping a broken download.
  const required = [
    ["server", "server.js"],
    ["server", "schema.sql"],
    ["server", "init-db.js"],
    ["server", "reset-password.js"],
    ["server", ".next", "static"],
    ["server", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"],
    ["node", platform === "win32" ? "node.exe" : "node"],
  ];

  for (const parts of required) {
    const target = path.join(resources, ...parts);
    if (!fs.existsSync(target)) {
      throw new Error(`Packaged app is missing resources/${parts.join("/")}`);
    }
  }

  /*
   * The bundled Node has to be able to run on the machine this installer is
   * for, and nothing else in the build checks that.
   *
   * `desktop:build` ships whatever Node ran it, and the SQLite binding beside
   * it was compiled for that same platform and architecture. Package an arm64
   * bundle into an x64 target — trivial to do on an Apple Silicon Mac, since
   * the mac config asks for both — and the installer builds cleanly, installs
   * cleanly, and then dies on first launch with an exec format error the
   * customer cannot act on. Cross-compiling is not possible here, so a
   * mismatch is always a mistake, and it is worth failing the build over.
   */
  const hostFile = path.join(resources, "node", "build-host.json");
  if (fs.existsSync(hostFile)) {
    const host = JSON.parse(fs.readFileSync(hostFile, "utf8"));
    const targetArch = ARCH_NAMES[context.arch] ?? String(context.arch);

    if (host.platform !== platform || host.arch !== targetArch) {
      throw new Error(
        `Bundled Node is ${host.platform}/${host.arch} but this target is ` +
          `${platform}/${targetArch}. Run \`npm run desktop:build\` on a ` +
          `${platform}/${targetArch} machine, or build only that target.`,
      );
    }
  }

  // A developer .env in the bundle would override the configuration the
  // launcher passes and ship a known session-signing key to every customer.
  // Refuse to build rather than let that out the door.
  const serverDir = path.join(resources, "server");
  const leaked = fs
    .readdirSync(serverDir)
    .filter((entry) => entry === ".env" || entry.startsWith(".env."));

  if (leaked.length > 0) {
    throw new Error(
      `Refusing to package: ${leaked.join(", ")} found in the server bundle. ` +
        "Developer configuration must never ship inside the installer.",
    );
  }

  console.log("  • server bundle and Node runtime copied and verified");
};
