import fs from "node:fs";
import path from "node:path";

/**
 * Says what the database connection settings actually parse to, without ever
 * printing a password.
 *
 * Every connection failure this project has produced arrived as an error about
 * something other than the real cause. `P1000: Authentication failed` reads as
 * "you typed the password wrong" when far more often the password is right and
 * the URL split in the wrong place, because a pasted password is not
 * URL-encoded. `FATAL: tenant/user postgres.abcdefgh not found` reads as a
 * missing database when the string was a documentation example nobody edited.
 * `the scheme is not recognized` reads as a malformed URL when the variable
 * holds `<direct connection string>`, brackets and all.
 *
 * So this prints the three things that are safe to look at — user, host, and
 * how many characters the password has — and names the specific mistake when
 * it can see one. It changes nothing and connects to nothing.
 */

// Mirrors prisma.config.ts and require-hosted-database.mjs: an explicitly-set
// DATABASE_URL wins, and .env fills in only when there is none. A checker that
// resolves these differently from the CLI reports on a value the CLI will not
// use, which is worse than not checking.
const envFile = path.join(process.cwd(), ".env");
if (!process.env.DATABASE_URL && fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

/** Markers that appear in documentation examples and never in a credential. */
const EXAMPLE_MARKERS = [
  "yourrealpassword",
  "yourpassword",
  "your-password",
  "your_password",
  "abcdefgh",
  "xxxx",
  "…",
  "<",
  ">",
];

/**
 * Characters that mean something inside a URL.
 *
 * A password containing one of these ends the userinfo, the host or the path
 * early, and only the fragment before it is sent as the password — which is
 * why the server rejects a password that was typed correctly.
 */
const RESERVED = ["@", "/", "?", "#", "[", "]", ":", "%", " "];

const problems = [];

function describe(label, raw) {
  console.log("");
  console.log(`  ${label}`);

  if (!raw) {
    console.log("    not set");
    return null;
  }

  const value = raw.trim();

  if (value.startsWith("file:")) {
    console.log(`    ${value}  (local SQLite)`);
    return { kind: "sqlite", value };
  }

  if (!/^postgres(ql)?:\/\//i.test(value)) {
    console.log(`    ${value.slice(0, 48)}`);

    // Named before the generic complaint, because "not a connection string"
    // is true of a pasted placeholder and tells you nothing about why.
    const example = EXAMPLE_MARKERS.find((token) =>
      value.toLowerCase().includes(token),
    );

    problems.push(
      example
        ? `${label} is still the documentation placeholder. Replace it, angle ` +
            `brackets and all, with the string from Supabase's Connect panel.`
        : `${label} is not a connection string. It should begin with postgresql://.`,
    );
    return { kind: "unknown", value };
  }

  // Split at the LAST @, which is how URL parsers read userinfo, then at the
  // FIRST colon. Doing it by hand rather than with new URL() is deliberate: a
  // password with a reserved character in it is exactly the case being
  // diagnosed, and new URL() would quietly mangle it the same way Prisma does.
  const body = value.replace(/^[a-z+]+:\/\//i, "");
  const at = body.lastIndexOf("@");

  if (at === -1) {
    console.log(`    ${value.slice(0, 48)}`);
    problems.push(`${label} has no @, so it carries no credentials.`);
    return { kind: "unknown", value };
  }

  const userinfo = body.slice(0, at);
  const hostpart = body.slice(at + 1);
  const colon = userinfo.indexOf(":");
  const user = colon === -1 ? userinfo : userinfo.slice(0, colon);
  const password = colon === -1 ? "" : userinfo.slice(colon + 1);
  const host = hostpart.split("/")[0];
  const port = host.includes(":") ? host.slice(host.lastIndexOf(":") + 1) : "";

  console.log(`    user      ${user}`);
  console.log(
    `    password  ${password.length} character${password.length === 1 ? "" : "s"} (not shown)`,
  );
  console.log(`    host      ${host}`);

  const marker = EXAMPLE_MARKERS.find((token) =>
    value.toLowerCase().includes(token),
  );
  if (marker) {
    problems.push(
      `${label} still contains "${marker}", so it is a documentation example ` +
        `rather than yours.`,
    );
  }

  const reserved = RESERVED.filter((ch) => password.includes(ch));
  if (reserved.length > 0) {
    problems.push(
      `${label}'s password contains ${reserved.map((c) => `"${c}"`).join(", ")}. ` +
        `Those characters have a meaning inside a URL, so the string splits in ` +
        `the wrong place and only part of the password reaches the server. ` +
        `Percent-encode them, or reset the password to letters and numbers.`,
    );
  }

  const pooler = host.includes("pooler.supabase.com");
  if (pooler && !user.includes(".")) {
    problems.push(
      `${label} uses the pooler but the user is "${user}". Supabase's poolers ` +
        `need postgres.<project-ref> — you have copied the Direct connection ` +
        `string rather than the Session pooler one.`,
    );
  }

  return { kind: "postgres", value, user, password, host, port, pooler };
}

console.log("");
console.log("  What the Prisma CLI will see:");

const database = describe("DATABASE_URL", process.env.DATABASE_URL);
const direct = describe("DIRECT_DATABASE_URL", process.env.DIRECT_DATABASE_URL);

console.log("");

// DATABASE_URL decides which schema loads, by whether it starts with file:.
// DIRECT_DATABASE_URL, when set, decides what is connected to. Setting only
// the second takes the SQLite schema to Postgres.
if (direct && direct.kind !== "sqlite" && database?.kind === "sqlite") {
  problems.push(
    "DIRECT_DATABASE_URL points at Postgres but DATABASE_URL is a local file, " +
      "which is what selects the SQLite schema. Migrations would take the " +
      "wrong schema to a real database.",
  );
}

const connecting = direct ?? database;

if (connecting?.kind === "postgres" && connecting.port === "6543") {
  problems.push(
    "This is the transaction pooler (port 6543). It is the right setting for " +
      "the application and the wrong one for migrations, which need 5432.",
  );
}

if (!database && !direct) {
  console.log("  Neither variable is set, and there is no .env to read.");
  console.log("");
  process.exit(1);
}

if (problems.length === 0) {
  if (connecting?.kind === "sqlite") {
    console.log("  Pointed at the local SQLite file, which is correct for");
    console.log("  development. `npm run db:push` applies the schema to it;");
    console.log("  migrations are for the hosted database only.");
  } else {
    console.log("  Shaped correctly. If a connection is still refused, the");
    console.log("  password itself is wrong — and note that the database");
    console.log("  password is not your Supabase account login. It is shown");
    console.log("  once at project creation, so if it was not saved it cannot");
    console.log("  be recalled: reset it under Project Settings, Database.");
    console.log("");
    console.log("  Resetting it also changes what the live site needs, so");
    console.log("  update DATABASE_URL on the host and redeploy together.");
  }
  console.log("");
  process.exit(0);
}

for (const problem of problems) {
  console.log(`  PROBLEM: ${problem}`);
  console.log("");
}

process.exit(1);
