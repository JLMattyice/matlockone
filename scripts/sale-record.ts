// First, and it must stay first: it sets DATABASE_URL before src/lib/db.ts is
// loaded, and that module reads it at import time.
import "./load-env";

import fs from "node:fs";
import path from "node:path";

import {
  deliverLicense,
  undeliveredPurchases,
} from "../src/lib/checkout/deliver";
import { fulfilPurchase, purchasesFor } from "../src/lib/checkout/fulfil";
import { formatPrice, isPlan } from "../src/lib/checkout/plans";
import type { LicensePlan } from "../src/lib/license/token";

/**
 * Records a sale and issues its licence.
 *
 * This is the fulfilment path until a processor is wired up, and it is what
 * `license:issue` should not be used for any more. That script signs a key and
 * forgets it; this one writes the sale down first, so a customer who loses the
 * email gets the *same* key back rather than a second one, and so there is an
 * answer to "what did this person actually buy".
 *
 *   npm run sale -- --email lane@example.com --plan business --ref INV-2026-014
 *   npm run sale -- --lookup lane@example.com
 *
 * `--ref` is the idempotency key: your invoice number, a PayPal transaction id,
 * whatever identifies the sale. Running the same command twice returns the
 * licence already issued instead of minting a new one.
 *
 * Everything runs inside main(): tsx compiles these scripts as CommonJS, where
 * top-level await is a syntax error rather than a runtime one.
 */

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

function signingKey(): string {
  const inline = process.env.LICENSE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (inline) return inline;

  // Same default as license:keygen writes, so a local run needs no setup.
  const file =
    process.env.LICENSE_PRIVATE_KEY_FILE ??
    path.join(process.cwd(), "license-keys", "signing.private.pem");

  if (!fs.existsSync(file)) {
    die("No signing key. Run `npm run license:keygen`, or set LICENSE_PRIVATE_KEY.");
  }

  return fs.readFileSync(file, "utf8");
}

async function main() {
  // Retry every key that was issued but never reached anyone. Safe to run at
  // any time: delivery skips anything already sent.
  if (process.argv.includes("--deliver")) {
    const pending = await undeliveredPurchases();

    if (pending.length === 0) {
      console.log("\n  Every issued licence has been delivered.\n");
      return;
    }

    console.log(`\n  ${pending.length} undelivered licence(s):\n`);

    for (const purchase of pending) {
      const outcome = await deliverLicense(purchase);
      console.log(
        outcome.ok
          ? `  sent      ${purchase.email}  (${purchase.provider}/${purchase.externalId})`
          : `  FAILED    ${purchase.email}  ${outcome.error}`,
      );
    }

    console.log("");
    return;
  }

  const lookup = arg("lookup");

  if (lookup) {
    const rows = await purchasesFor(lookup);

    if (rows.length === 0) {
      console.log(`\n  Nothing sold to ${lookup}.\n`);
      return;
    }

    console.log(`\n  ${rows.length} purchase(s) for ${lookup}:\n`);
    for (const row of rows) {
      console.log(
        `  ${row.createdAt.toISOString().slice(0, 10)}  ${row.plan.padEnd(9)}` +
          `${row.provider}/${row.externalId}\n    ${row.licenseKey ?? "(no licence issued)"}\n`,
      );
    }
    return;
  }

  const email = arg("email");
  if (!email || !email.includes("@")) {
    die(
      "Usage: npm run sale -- --email <address> --plan <starter|business|pro> --ref <id>\n" +
        '       [--org "Business Name"] [--months 12] [--seats N] [--provider MANUAL]\n' +
        "       npm run sale -- --lookup <address>",
    );
  }

  const plan = arg("plan") ?? "business";
  if (!isPlan(plan)) {
    die(`Unknown plan "${plan}". One of: starter, business, pro`);
  }

  const ref = arg("ref");
  if (!ref) {
    die(
      "--ref is required. Use your invoice number or the processor's transaction\n" +
        "id: it is what stops the same sale being fulfilled twice.",
    );
  }

  const seatsArg = arg("seats");

  const result = await fulfilPurchase(
    {
      provider: arg("provider") ?? "MANUAL",
      externalId: ref,
      email,
      orgName: arg("org") ?? null,
      plan: plan as LicensePlan,
      months: Number(arg("months") ?? 12),
      ...(seatsArg === undefined ? {} : { seats: Number(seatsArg) }),
    },
    { privateKey: signingKey() },
  );

  if (!result.ok) die(`\n  Not fulfilled: ${result.error}\n`);

  const { purchase, licenseKey, reissued } = result;

  // Try to send it. The key is printed below either way, so a deployment with
  // no mailbox configured still completes the sale — it just needs the key
  // pasting into an email by hand.
  const delivery = await deliverLicense(purchase);

  const deliveryLine = delivery.ok
    ? delivery.skipped
      ? "Already emailed to them earlier."
      : `Emailed to ${purchase.email}.`
    : `NOT emailed: ${delivery.error}\n  Send the key below by hand, then \`npm run sale -- --deliver\` once mail works.`;

  console.log(`
  ${reissued ? "ALREADY FULFILLED — returning the licence already issued" : "Sale recorded and licence issued"}

  Customer  ${purchase.email}${purchase.orgName ? ` (${purchase.orgName})` : ""}
      Plan  ${purchase.plan}
     Seats  ${purchase.seats === null ? "unlimited" : purchase.seats}
      Term  ${purchase.months} months
    Amount  ${formatPrice(purchase.amountCents, purchase.currency)}
 Reference  ${purchase.provider}/${purchase.externalId}

${licenseKey}

  ${deliveryLine}
`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
