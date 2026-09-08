import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  LICENSE_MODES,
  LICENSE_PLANS,
  issueLicense,
  type LicenseMode,
  type LicensePlan,
} from "../src/lib/license/token";

/**
 * Issues one licence key.
 *
 * Run this when someone pays. It prints a token you paste into the email they
 * receive; nothing about it needs a server, now or later.
 *
 *   npm run license:issue -- --email lane@example.com --plan business
 *   npm run license:issue -- --email lane@example.com --plan pro --months 1
 *   npm run license:issue -- --email try@example.com --mode demo --months 1
 */

/** Seats per plan, matching the pricing on the site. */
const PLAN_SEATS: Record<LicensePlan, number | null> = {
  starter: 1,
  business: 10,
  pro: null,
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

const email = arg("email");
if (!email || !email.includes("@")) {
  die("Usage: npm run license:issue -- --email <address> [--plan starter|business|pro]\n       [--org \"Business Name\"] [--months 12] [--mode paid|demo] [--seats N]");
}

const plan = (arg("plan") ?? "business") as LicensePlan;
if (!(LICENSE_PLANS as readonly string[]).includes(plan)) {
  die(`Unknown plan "${plan}". One of: ${LICENSE_PLANS.join(", ")}`);
}

const mode = (arg("mode") ?? "paid") as LicenseMode;
if (!(LICENSE_MODES as readonly string[]).includes(mode)) {
  die(`Unknown mode "${mode}". One of: ${LICENSE_MODES.join(", ")}`);
}

const months = Number(arg("months") ?? 12);
if (!Number.isFinite(months) || months <= 0) {
  die("--months must be a positive number.");
}

const seatsArg = arg("seats");
const seats = seatsArg === undefined ? PLAN_SEATS[plan] : Number(seatsArg);
if (seats !== null && (!Number.isInteger(seats) || seats <= 0)) {
  die("--seats must be a whole number above zero.");
}

const keyFile =
  process.env.LICENSE_PRIVATE_KEY_FILE ??
  path.join(process.cwd(), "license-keys", "signing.private.pem");

if (!fs.existsSync(keyFile)) {
  die(
    `No signing key at ${path.relative(process.cwd(), keyFile)}.\n` +
      "Run `npm run license:keygen` first, or set LICENSE_PRIVATE_KEY_FILE.",
  );
}

const issuedAt = new Date();
// Calendar months, so a licence bought on the 3rd expires on the 3rd.
const expiresAt = new Date(issuedAt);
expiresAt.setMonth(expiresAt.getMonth() + months);

const token = issueLicense(
  {
    id: `lic_${randomUUID()}`,
    sub: email,
    org: arg("org"),
    plan,
    mode,
    seats,
    iat: Math.floor(issuedAt.getTime() / 1000),
    exp: Math.floor(expiresAt.getTime() / 1000),
  },
  fs.readFileSync(keyFile, "utf8"),
);

console.log(`
  Issued to  ${email}${arg("org") ? ` (${arg("org")})` : ""}
       Plan  ${plan}${mode === "demo" ? " (demo)" : ""}
      Seats  ${seats === null ? "unlimited" : seats}
    Expires  ${expiresAt.toISOString().slice(0, 10)}

${token}
`);
