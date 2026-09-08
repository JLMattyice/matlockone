import { licensePublicKey } from "../src/lib/license/public-key";
import { verifyLicense } from "../src/lib/license/token";

/**
 * Checks a licence key against the public key compiled into this build.
 *
 * For the support question that will otherwise cost an hour: a customer says
 * their key is rejected, and you need to know whether it is expired, meant for
 * a different build, or simply mistyped — without asking them to read a 300
 * character string down the phone.
 *
 *   npm run license:verify -- MO1.xxx.yyy
 */

const token = process.argv[2];

if (!token || token.startsWith("--")) {
  console.error("Usage: npm run license:verify -- <licence key>");
  process.exit(1);
}

const result = verifyLicense(token, licensePublicKey());

if (!result.ok) {
  console.error(`\n  REJECTED  ${result.reason}\n  ${result.message}\n`);
  process.exit(1);
}

const { license } = result;
const expires = new Date(license.exp * 1000);
const days = Math.floor((expires.getTime() - Date.now()) / 86_400_000);

console.log(`
  VALID

  Issued to  ${license.sub}${license.org ? ` (${license.org})` : ""}
       Plan  ${license.plan}${license.mode === "demo" ? " (demo)" : ""}
      Seats  ${license.seats === null ? "unlimited" : license.seats}
    Expires  ${expires.toISOString().slice(0, 10)}  (${days} days from now)
         Id  ${license.id}
`);
