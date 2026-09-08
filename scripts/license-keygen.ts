import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Creates the Ed25519 key pair that signs and verifies licences.
 *
 * Run once, ever. The private half signs every licence you will issue; the
 * public half is compiled into every build so it can check them offline.
 *
 *   npm run license:keygen
 *
 * Replacing an existing key pair invalidates every licence already in a
 * customer's hands — their software stops accepting the key they paid for — so
 * this refuses to do it without --force.
 */

const root = process.cwd();
const KEY_DIR = path.join(root, "license-keys");
const PRIVATE_FILE = path.join(KEY_DIR, "signing.private.pem");
const PUBLIC_FILE = path.join(KEY_DIR, "signing.public.pem");
const EMBEDDED_FILE = path.join(root, "src", "lib", "license", "public-key.ts");

const force = process.argv.includes("--force");

if (fs.existsSync(PRIVATE_FILE) && !force) {
  console.error(
    `A signing key already exists at license-keys/signing.private.pem.

Generating a new one invalidates every licence you have ever issued: the
software in your customers' hands verifies against the old public key and will
reject their licence as forged.

If you are certain, re-run with --force.`,
  );
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

fs.mkdirSync(KEY_DIR, { recursive: true });

// 0o600: readable by this user only. It is the one secret that cannot be
// rotated without breaking customers.
fs.writeFileSync(PRIVATE_FILE, privatePem, { mode: 0o600 });
fs.writeFileSync(PUBLIC_FILE, publicPem);

const source = fs.readFileSync(EMBEDDED_FILE, "utf8");
const embedded = source.replace(
  /export const LICENSE_PUBLIC_KEY = [\s\S]*?;\n/,
  `export const LICENSE_PUBLIC_KEY = \`${publicPem.trim()}\n\`;\n`,
);

if (embedded === source) {
  throw new Error(
    `Could not find the LICENSE_PUBLIC_KEY declaration in ${path.relative(root, EMBEDDED_FILE)}. ` +
      "Paste this key in by hand:\n\n" +
      publicPem,
  );
}

fs.writeFileSync(EMBEDDED_FILE, embedded);

console.log(`Licence signing key created.

  license-keys/signing.private.pem   the secret. Back it up somewhere safe and
                                     never commit it — .gitignore covers it.
  license-keys/signing.public.pem    the same public key, as a file.
  src/lib/license/public-key.ts      updated, and meant to be committed.

Losing the private key means you can never issue or renew a licence that
existing installations will accept. Back it up before you issue anything.

Next: npm run license:issue -- --email someone@example.com --plan business
`);
