/**
 * The key every build verifies licences against.
 *
 * Public by nature — it can only check a signature, never produce one — so it
 * is committed and ships inside the application. Its private half signs every
 * licence ever issued and lives outside this repository; `.gitignore` keeps it
 * that way.
 *
 * Written by `npm run license:keygen`. Replacing it invalidates every licence
 * already in a customer's hands, so that script refuses to overwrite an
 * existing key without --force.
 */
export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAngTrbi/vXK3pUwfqtzjWfLUsFb5jti72pJnIK+jL8kE=
-----END PUBLIC KEY-----
`;

/**
 * The verifying key, or a failure that names the fix.
 *
 * An empty key would make `verify()` throw somewhere far from the cause, and
 * the message a developer needs — run the keygen — is not one the crypto layer
 * can produce.
 */
export function licensePublicKey(): string {
  const key = process.env.LICENSE_PUBLIC_KEY?.trim() || LICENSE_PUBLIC_KEY.trim();

  if (!key) {
    throw new Error(
      "No licence public key. Run `npm run license:keygen` to create a signing " +
        "key pair, or set LICENSE_PUBLIC_KEY.",
    );
  }

  return key;
}

/** Whether this build can check licences at all. */
export function hasLicenseKey(): boolean {
  return Boolean(process.env.LICENSE_PUBLIC_KEY?.trim() || LICENSE_PUBLIC_KEY.trim());
}
