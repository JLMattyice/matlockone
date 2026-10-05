import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Packages the Windows installer, signed through Azure Artifact Signing, and
 * proves the signature took.
 *
 *   node scripts/package-windows.mjs
 *
 * Signing turns "Unknown publisher" into "Verified publisher: Jason Matlock"
 * on the download warning and the install prompt. It runs only where the
 * three AZURE_* credentials are set — the release workflow, from repository
 * secrets — so `npm run desktop:pack` on a machine without them still makes
 * an unsigned build to try out.
 *
 * REQUIRE_SIGNING=1 (the release workflow sets it) turns a missing credential
 * or a bad signature into a failed build rather than an unsigned release.
 * That matters more than it looks: an installed copy built with a publisher
 * name checks every update against it, and refuses one that is unsigned or
 * signed by anybody else. One unsigned release after the first signed one
 * would leave every signed install unable to update.
 *
 * The settings live here rather than in electron-builder.yml for the same
 * reason: in the config file they would make every local build try to sign.
 */

const SIGNING = {
  // Must be the certificate's CN exactly: installed copies match updates
  // against it. Changing who the certificate is issued to — an organization
  // identity in place of this individual one — means listing both names
  // here for as long as installs from before the change are out there.
  publisherName: "Jason Matlock",
  endpoint: "https://eus.codesigning.azure.net",
  codeSigningAccountName: "matlocksoftware",
  certificateProfileName: "matlockone",
};

const CREDENTIALS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"];
const OUT_DIR = "dist-installer";

const required = process.env.REQUIRE_SIGNING === "1";
const missing = CREDENTIALS.filter((name) => !process.env[name]);
const signing = missing.length === 0;

function fail(message) {
  console.error(`\n  package-windows: ${message}\n`);
  process.exit(1);
}

if (!signing && required) {
  // An empty GitHub secret reaches the job as an empty variable, exactly like
  // a missing one: the run log shows the name with nothing after it, not ***.
  fail(
    `signing is required and ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} empty or not set. ` +
      "Check the repository secrets have values (the run log shows *** for a filled one).",
  );
}
if (!signing) {
  console.warn(`\n  package-windows: ${missing.join(", ")} not set — building UNSIGNED.\n`);
}

const builder = createRequire(import.meta.url).resolve("electron-builder/cli.js");
const args = [builder, "--win", "--publish", "never"];
if (signing) {
  for (const [key, value] of Object.entries(SIGNING)) {
    args.push(`-c.win.azureSignOptions.${key}=${value}`);
  }
}

const build = spawnSync(process.execPath, args, { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

if (!signing) process.exit(0);

// What Windows itself says about the files a customer runs: the installer,
// and the app it puts in place.
const installers = fs
  .readdirSync(OUT_DIR)
  .filter((name) => name.endsWith(".exe"))
  .map((name) => path.join(OUT_DIR, name));
const unpacked = path.join(OUT_DIR, "win-unpacked");
const apps = fs.existsSync(unpacked)
  ? fs
      .readdirSync(unpacked)
      .filter((name) => name.endsWith(".exe"))
      .map((name) => path.join(unpacked, name))
  : [];
const files = [...installers, ...apps];
if (installers.length === 0) fail(`no installer found in ${OUT_DIR}.`);

// Windows PowerShell, which is what an installed copy checks updates with —
// but without PSModulePath. The workflow's steps run in PowerShell 7, whose
// module path Windows PowerShell inherits and then cannot load its own
// Get-AuthenticodeSignature from: it prints an error, exits 0, and every
// field comes back empty.
const probeEnv = { ...process.env };
for (const key of Object.keys(probeEnv)) {
  if (/^psmodulepath$/i.test(key)) delete probeEnv[key];
}

const problems = [];
for (const file of files) {
  const probe = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$s = Get-AuthenticodeSignature -LiteralPath '${path.resolve(file).replace(/'/g, "''")}'; ` +
        `@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject; ` +
        `timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress`,
    ],
    { encoding: "utf8", env: probeEnv },
  );

  let result = null;
  try {
    result = JSON.parse(probe.stdout.trim());
  } catch {
    // Reported below with whatever PowerShell said.
  }
  if (probe.status !== 0 || !result?.status) {
    problems.push(`${file}: could not read its signature (${(probe.stderr || probe.stdout).trim()})`);
    continue;
  }

  const { status, subject, timestamped } = result;
  const cn = /(?:^|,\s*)CN=("?)([^",]+)\1/.exec(subject ?? "")?.[2] ?? null;
  console.log(`  ${file}\n    ${status} · ${subject || "no signer"}${timestamped ? " · timestamped" : ""}`);

  if (status !== "Valid") problems.push(`${file}: signature is ${status}`);
  else if (cn !== SIGNING.publisherName) {
    problems.push(`${file}: signed by "${cn}", but publisherName says "${SIGNING.publisherName}"`);
  } else if (!timestamped) {
    problems.push(`${file}: not timestamped, so the signature would lapse with the certificate`);
  }
}

if (problems.length > 0) fail(`the signature did not check out:\n    ${problems.join("\n    ")}`);
console.log(`\n  package-windows: signed by ${SIGNING.publisherName}, and Windows agrees.\n`);
