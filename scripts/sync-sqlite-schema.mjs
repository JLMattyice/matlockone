import fs from "node:fs";
import path from "node:path";

/**
 * Derives the SQLite schema from the Postgres one.
 *
 * Matlock One ships twice: hosted on Postgres, and on the desktop where the
 * business's records live in a SQLite file on their own machine. Prisma cannot
 * take two providers from one schema, and hand-maintaining two copies of 950
 * lines is a bug waiting to happen — the copies drift, and the drift surfaces
 * as a column that exists in the cloud and not on the desktop, months later.
 *
 * So there is one authored schema and this script projects it. The projection
 * changes the datasource provider and the generator output path, and nothing
 * else. It is only sound because the model is deliberately provider-neutral:
 * no enums, no scalar lists, no Json, no `@db.` native types. `--check`
 * enforces exactly that, so the day someone reaches for a Postgres-only type
 * the build says so, rather than the desktop installer failing at a customer's
 * desk.
 */

const root = process.cwd();
const SOURCE = path.join(root, "prisma", "schema.prisma");
const TARGET = path.join(root, "prisma", "schema.sqlite.prisma");

const HEADER = `// GENERATED FILE — DO NOT EDIT.
//
// Projected from prisma/schema.prisma by scripts/sync-sqlite-schema.mjs, which
// changes the datasource provider and the generator output path and nothing
// else. Edit prisma/schema.prisma and run \`npm run schema:sync\`; anything
// written here by hand is erased the next time the schema changes.
`;

/**
 * Constructs with no SQLite equivalent.
 *
 * Not a style preference — each either fails to generate or silently changes
 * meaning across the two providers.
 *
 * Written as regex literals rather than `new RegExp("...")`. That is not
 * cosmetic: the string form needs doubled backslashes, and a single dropped
 * backslash turns `\s` into a literal "s", leaving a pattern that matches
 * nothing and a guard that reports success on everything.
 *
 * The scalar-list test names the scalar types explicitly because `Job[]` is a
 * relation — perfectly portable — while `String[]` is a scalar list, which
 * SQLite cannot represent. A check that flagged every `[]` would block a
 * schema that is entirely fine.
 */
const UNPORTABLE = [
  { pattern: /^\s*enum\s+\w+\s*\{/m, what: "an enum" },
  { pattern: /@db\.\w+/, what: "a `@db.` native type attribute" },
  {
    pattern: /^\s+\w+\s+(?:String|Int|Float|Boolean|DateTime|Json|Bytes|Decimal|BigInt)\s*\[\]/m,
    what: "a scalar list field",
  },
  {
    pattern: /^\s+\w+\s+(?:Json|Bytes|Decimal|BigInt)\b/m,
    what: "a Json/Bytes/Decimal/BigInt field",
  },
];

function assertPortable(source) {
  for (const { pattern, what } of UNPORTABLE) {
    const match = source.match(pattern);
    if (!match) continue;
    const line = source.slice(0, match.index).split("\n").length;
    throw new Error(
      `prisma/schema.prisma:${line} uses ${what}, which SQLite cannot represent.\n` +
        `The desktop build runs this same model on SQLite, so the schema has to\n` +
        `stay provider-neutral. Use a String validated in src/lib/constants.ts.`,
    );
  }
}

function project(source) {
  if (!/datasource\s+db\s*\{[^}]*provider\s*=\s*"postgresql"/.test(source)) {
    throw new Error(
      'prisma/schema.prisma no longer declares provider = "postgresql". ' +
        "This script projects Postgres onto SQLite; it cannot run backwards.",
    );
  }

  let out = source.replace(
    /(datasource\s+db\s*\{[^}]*provider\s*=\s*)"postgresql"/,
    '$1"sqlite"',
  );

  const outputBefore = out;
  out = out.replace(
    /(generator\s+client\s*\{[^}]*output\s*=\s*)"\.\.\/src\/generated\/prisma"/,
    '$1"../src/generated/sqlite"',
  );
  if (out === outputBefore) {
    throw new Error(
      "The generator block in prisma/schema.prisma no longer outputs to " +
        "../src/generated/prisma, so the SQLite client would be written over " +
        "the Postgres one.",
    );
  }

  // Drop the authored file's leading comment block. It describes schema.prisma
  // as the canonical source, which is true there and misleading here.
  out = out.replace(/^(?:\/\/[^\n]*\n|[ \t]*\n)+/, "");

  return `${HEADER}\n${out}`;
}

const source = fs.readFileSync(SOURCE, "utf8");
assertPortable(source);
const projected = project(source);

const existing = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, "utf8") : null;

if (process.argv.includes("--check")) {
  if (existing !== projected) {
    console.error(
      "prisma/schema.sqlite.prisma is out of date with prisma/schema.prisma.\n" +
        "Run `npm run schema:sync` and commit the result.",
    );
    process.exit(1);
  }
  console.log("schema.sqlite.prisma is in sync.");
} else if (existing === projected) {
  console.log("schema.sqlite.prisma already in sync.");
} else {
  fs.writeFileSync(TARGET, projected, "utf8");
  console.log("Wrote prisma/schema.sqlite.prisma from prisma/schema.prisma.");
}
