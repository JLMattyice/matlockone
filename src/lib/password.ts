import {
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";

// promisify() resolves to scrypt's 3-argument overload, which drops the cost
// parameters, so the options-taking form is wrapped by hand.
function scryptAsync(
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, derived) =>
      error ? reject(error) : resolve(derived),
    );
  });
}

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * scrypt from Node's standard library — no native module to compile on Windows.
 * Stored format: scrypt$N$r$p$<salt hex>$<hash hex>
 */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(
    plain.normalize("NFKC"),
    salt,
    KEY_LENGTH,
    SCRYPT_PARAMS,
  );

  const { N, r, p } = SCRYPT_PARAMS;
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, nRaw, rRaw, pRaw, saltHex, hashHex] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!N || !r || !p) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashHex, "hex");
  } catch {
    return false;
  }

  const derived = await scryptAsync(
    plain.normalize("NFKC"),
    Buffer.from(saltHex, "hex"),
    expected.length,
    { N, r, p, maxmem: 64 * 1024 * 1024 },
  );

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Cheap strength check used by the signup and password-change forms. */
export function passwordProblem(plain: string): string | null {
  if (plain.length < 8) return "Password must be at least 8 characters.";
  if (plain.length > 200) return "Password must be under 200 characters.";
  if (!/[a-zA-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    return "Password must contain at least one letter and one number.";
  }
  return null;
}
