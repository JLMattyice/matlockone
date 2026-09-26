import { createInterface } from "node:readline/promises";

import {
  applySetup,
  describeSurvey,
  envLines,
  hasWrongPrice,
  needsChanges,
  survey,
  type PayPalCall,
} from "../src/lib/billing/paypal-setup";
import { accessToken, apiBase, type PayPalConfig } from "../src/lib/checkout/paypal";

/**
 * Sets up a PayPal account to sell Matlock One, and prints what Vercel needs.
 *
 *   npm run paypal:setup
 *   npm run paypal:setup -- https://staging.example.com/api/checkout/paypal/webhook
 *
 * Asks for the PayPal app's Client ID and Secret (developer.paypal.com → Apps
 * & Credentials), unless PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are already
 * set. It shows what it found and what it would create, and changes nothing
 * in PayPal until you type yes. Safe to run again: it reuses what is there.
 */

const DEFAULT_WEBHOOK = "https://www.matlockone.com/api/checkout/paypal/webhook";

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string) => (await rl.question(question)).trim();

  try {
    const clientId = process.env.PAYPAL_CLIENT_ID?.trim() || (await ask("PayPal Client ID: "));
    const clientSecret =
      process.env.PAYPAL_CLIENT_SECRET?.trim() || (await ask("PayPal Secret: "));
    const mode = (process.env.PAYPAL_ENV?.trim() || (await ask("live or sandbox? [live]: ")) || "live")
      .toLowerCase();

    if (!clientId || !clientSecret) throw new Error("Both the Client ID and the Secret are needed.");
    if (mode !== "live" && mode !== "sandbox") throw new Error(`"${mode}" is not live or sandbox.`);
    const live = mode === "live";

    const webhookUrl = process.argv[2]?.trim() || DEFAULT_WEBHOOK;
    if (!webhookUrl.startsWith("https://")) {
      throw new Error("PayPal only delivers webhooks to an https:// address.");
    }

    const config: PayPalConfig = { clientId, clientSecret, live, webhookId: "", planIds: {} };

    const call: PayPalCall = async (method, path, body) => {
      const response = await fetch(`${apiBase(config)}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${await accessToken(config)}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`PayPal answered ${response.status} to ${method} ${path}:\n${text.slice(0, 800)}`);
      }
      return text ? JSON.parse(text) : {};
    };

    console.log(`\nLooking at the ${live ? "LIVE" : "sandbox"} PayPal account…\n`);
    const found = await survey(call, webhookUrl);
    for (const line of describeSurvey(found, webhookUrl)) console.log(`  ${line}`);
    console.log("");

    if (hasWrongPrice(found)) {
      throw new Error(
        "A plan above is at a different price from Matlock One's. Deactivate it in\n" +
          "PayPal (Pay & Get Paid → Subscriptions), then run this again. Nothing was changed.",
      );
    }

    let result;
    if (needsChanges(found)) {
      const answer = await ask(`Create the missing pieces in ${live ? "LIVE" : "sandbox"} PayPal? Type yes: `);
      if (answer.toLowerCase() !== "yes") {
        console.log("Stopped. Nothing was changed.");
        return;
      }
      result = await applySetup(call, found, webhookUrl);
      console.log("\nDone.");
    } else {
      result = await applySetup(call, found, webhookUrl);
      console.log("Everything was already set up.");
    }

    console.log(
      "\nPut these in Vercel (Settings → Environment Variables, Production), along\n" +
        "with PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, then redeploy:\n",
    );
    for (const line of envLines(result, live)) console.log(line);
    console.log("");
  } finally {
    rl.close();
  }
}

// exitCode rather than exit(): on Windows, exiting while fetch is still
// closing its connection trips an assertion inside Node and prints a crash.
main().catch((error) => {
  console.error(`\n${(error as Error).message}`);
  process.exitCode = 1;
});
