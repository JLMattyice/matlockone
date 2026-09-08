import "server-only";

import fs from "node:fs";

/**
 * The key that signs licences.
 *
 * Read from the environment, never from a committed file and never from
 * anything the packaging step can pick up. This is the one secret that cannot
 * be rotated without breaking every customer: a new key makes every licence
 * already issued verify as a forgery.
 *
 * `server-only` is load-bearing here rather than decorative — importing this
 * into anything that reaches a browser bundle is the failure that ends the
 * product, and this makes that a build error instead of a discovery.
 *
 * A desktop install has neither variable set, and so cannot issue licences.
 * That is correct: selling Matlock One is the hosted deployment's job, and a
 * customer's own copy has no business being able to mint keys.
 */

export function canIssueLicenses(): boolean {
  return Boolean(privateKeyOrNull());
}

export function licensePrivateKey(): string {
  const key = privateKeyOrNull();

  if (!key) {
    throw new Error(
      "No licence signing key. Set LICENSE_PRIVATE_KEY to the PEM, or " +
        "LICENSE_PRIVATE_KEY_FILE to a path holding it. Never commit either.",
    );
  }

  return key;
}

function privateKeyOrNull(): string | null {
  const inline = process.env.LICENSE_PRIVATE_KEY?.trim();
  // Newlines do not survive every environment-variable panel, so a PEM pasted
  // into one often arrives with literal \n. Accept both rather than fail with
  // an unhelpful crypto error.
  if (inline) return inline.replace(/\\n/g, "\n");

  const file = process.env.LICENSE_PRIVATE_KEY_FILE?.trim();
  if (!file) return null;

  try {
    const contents = fs.readFileSync(file, "utf8").trim();
    return contents || null;
  } catch {
    // An unreadable path is the same situation as an unset one: this
    // deployment cannot issue licences, and should say so rather than crash on
    // an unrelated request.
    return null;
  }
}
