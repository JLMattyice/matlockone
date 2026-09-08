"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

/**
 * Account recovery for someone who cannot sign in.
 *
 * The in-app reset under Team requires being signed in, which is no help to the
 * only owner of a business who has forgotten their password — the exact case
 * where a customer is otherwise stuck phoning whoever sold them the software.
 *
 * This grants no access that physical possession of the machine did not already
 * give: the database is a file in the user's own profile, readable and writable
 * by anything running as them. What it changes is that the remedy no longer
 * requires a developer and a script.
 *
 * Runs under the *bundled Node*, spawned by the launcher — never inside the
 * Electron process, because better-sqlite3 is compiled against Node's ABI and
 * Electron's differs.
 *
 * Called as:
 *   node reset-password.js <databaseFile> list
 *   node reset-password.js <databaseFile> reset <email> <password>
 *
 * Prints a single JSON line so the launcher can report what happened.
 */

const [databaseFile, command, ...rest] = process.argv.slice(2);

function done(payload) {
  console.log(JSON.stringify(payload));
  process.exit(payload.ok ? 0 : 1);
}

if (!databaseFile || !command) done({ ok: false, error: "Missing arguments." });

// ---------------------------------------------------------------- password ---

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/**
 * Must produce byte-identical output to src/lib/password.ts, or the login
 * screen will reject what this writes. Same parameters, same NFKC
 * normalisation, same stored format.
 */
function hashPassword(plain) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(
      plain.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      SCRYPT_PARAMS,
      (error, derived) => {
        if (error) return reject(error);
        const { N, r, p } = SCRYPT_PARAMS;
        resolve(
          `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`,
        );
      },
    );
  });
}

/** Mirrors passwordProblem() in src/lib/password.ts. */
function passwordProblem(plain) {
  if (plain.length < 8) return "Password must be at least 8 characters.";
  if (plain.length > 200) return "Password must be under 200 characters.";
  if (!/[a-zA-Z]/.test(plain) || !/[0-9]/.test(plain)) {
    return "Password must contain at least one letter and one number.";
  }
  return null;
}

// -------------------------------------------------------------------- main ---

async function main() {
  // Packaged, this sits beside the server and resolves the binding the server
  // itself uses. Run from a checkout there is no sibling node_modules, so fall
  // back to normal resolution — which is what lets the test suite drive it.
  let Database;
  try {
    Database = require(path.join(__dirname, "node_modules", "better-sqlite3"));
  } catch {
    Database = require("better-sqlite3");
  }

  const db = new Database(databaseFile);

  try {
    db.pragma("foreign_keys = ON");

    if (command === "list") {
      const accounts = db
        .prepare(
          `SELECT u.email, u.name, u.role, u.isActive, o.name AS organization
             FROM User u
             JOIN Organization o ON o.id = u.organizationId
            ORDER BY o.name, u.name`,
        )
        .all();

      return done({ ok: true, accounts });
    }

    if (command === "reset") {
      const [email, password] = rest;
      if (!email || !password) done({ ok: false, error: "Missing arguments." });

      const weak = passwordProblem(password);
      if (weak) return done({ ok: false, error: weak });

      const user = db
        .prepare("SELECT id, name, email FROM User WHERE lower(email) = lower(?)")
        .get(email);

      if (!user) return done({ ok: false, error: `No account for ${email}.` });

      const hash = await hashPassword(password);

      const apply = db.transaction(() => {
        db.prepare("UPDATE User SET passwordHash = ? WHERE id = ?").run(
          hash,
          user.id,
        );
        // Same rule the in-app reset follows: a password change signs the
        // account out everywhere, so a stolen session cannot outlive it.
        return db.prepare("DELETE FROM Session WHERE userId = ?").run(user.id)
          .changes;
      });

      const sessionsCleared = apply();

      return done({
        ok: true,
        email: user.email,
        name: user.name,
        sessionsCleared,
      });
    }

    done({ ok: false, error: `Unknown command ${command}.` });
  } finally {
    db.close();
  }
}

main().catch((error) => {
  done({ ok: false, error: error && error.message ? error.message : String(error) });
});
