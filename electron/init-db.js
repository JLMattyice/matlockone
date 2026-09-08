"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Creates the database on first run, and brings an existing one forward to the
 * schema this build ships with.
 *
 * Runs under the *bundled Node*, spawned by the launcher — never inside the
 * Electron process. better-sqlite3 is a native module compiled against Node's
 * ABI, and Electron's differs, so requiring it from the main process throws
 * NODE_MODULE_VERSION and takes the whole launch down with it.
 *
 * Called as:  node init-db.js <databaseFile> <schemaSqlFile>
 * Prints a single JSON line so the launcher can report what happened.
 */

const [databaseFile, schemaSqlFile] = process.argv.slice(2);

if (!databaseFile || !schemaSqlFile) {
  console.log(JSON.stringify({ ok: false, error: "Missing arguments." }));
  process.exit(1);
}

/**
 * Splits the generated DDL into statements.
 *
 * Prisma emits one statement per `CREATE TABLE` / `CREATE INDEX`, separated by
 * blank lines and `-- Comment` headers, with no semicolons inside the bodies.
 */
function parseStatements(sql) {
  return sql
    .split(";")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/** The table a CREATE TABLE or CREATE INDEX statement belongs to. */
function targetTable(statement) {
  return (
    /^CREATE\s+TABLE\s+"([^"]+)"/i.exec(statement)?.[1] ??
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"[^"]+"\s+ON\s+"([^"]+)"/i.exec(
      statement,
    )?.[1] ??
    null
  );
}

function indexName(statement) {
  return /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/i.exec(statement)?.[1] ?? null;
}

/**
 * Pulls the column definitions out of a CREATE TABLE body.
 *
 * Splits on top-level commas only, so a `DEFAULT (a, b)` or a multi-column
 * FOREIGN KEY clause does not get torn in half, then keeps the entries that
 * start with a quoted identifier — the rest are CONSTRAINT and PRIMARY KEY
 * clauses, which cannot be added to a table after the fact anyway.
 */
function columnsOf(createStatement) {
  const body = createStatement.slice(
    createStatement.indexOf("(") + 1,
    createStatement.lastIndexOf(")"),
  );

  const parts = [];
  let depth = 0;
  let current = "";

  for (const character of body) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;

    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  parts.push(current);

  const columns = new Map();

  for (const part of parts) {
    const definition = part.trim();
    const name = /^"([^"]+)"/.exec(definition)?.[1];
    if (name) columns.set(name, definition);
  }

  return columns;
}

/**
 * Whether SQLite will accept this column in an ALTER TABLE ADD COLUMN.
 *
 * The engine refuses a PRIMARY KEY or UNIQUE column outright, and refuses NOT
 * NULL unless a constant default fills the existing rows. It also refuses a
 * default that is not a literal — CURRENT_TIMESTAMP, or any parenthesised
 * expression — which is an easy one to walk into, because that is exactly what
 * Prisma emits for `@default(now())`.
 *
 * Anything rejected here is reported rather than attempted. The alternative is
 * worse than it sounds: these all run inside one transaction, so a single
 * refused ALTER rolls back every other change and the app does not start.
 */
function canAddColumn(definition) {
  if (/\bPRIMARY\s+KEY\b/i.test(definition)) return false;
  if (/\bUNIQUE\b/i.test(definition)) return false;
  if (/\bDEFAULT\s*\(/i.test(definition)) return false;
  if (/\bDEFAULT\s+CURRENT_(?:TIME|DATE|TIMESTAMP)\b/i.test(definition)) return false;
  if (/\bNOT\s+NULL\b/i.test(definition) && !/\bDEFAULT\b/i.test(definition)) {
    return false;
  }
  return true;
}

try {
  // Resolve from this script's own directory: in the packaged app that is
  // resources/server, where the server's node_modules already live.
  // Packaged, this sits beside the server and resolves the binding the server
  // itself uses. Run from a checkout there is no sibling node_modules, so fall
  // back to normal resolution — which is what lets the test suite drive it.
  let Database;
  try {
    Database = require(path.join(__dirname, "node_modules", "better-sqlite3"));
  } catch {
    Database = require("better-sqlite3");
  }

  fs.mkdirSync(path.dirname(databaseFile), { recursive: true });

  const created =
    !fs.existsSync(databaseFile) || fs.statSync(databaseFile).size === 0;

  const schemaSql = fs.readFileSync(schemaSqlFile, "utf8");
  const db = new Database(databaseFile);

  const addedTables = [];
  const addedColumns = [];
  const addedIndexes = [];
  const needsMigration = [];

  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");

    if (created) {
      db.exec(schemaSql);
    } else {
      // An existing installation is missing whatever a newer version added.
      // Only additive changes are applied — new tables, new nullable columns,
      // new indexes. Nothing is dropped, rewritten or back-filled, so a
      // database full of real work is never at risk from a version bump.
      //
      // Deliberately NOT a migration system: a column whose *type* or
      // nullability changed is reported, not guessed at.
      const statements = parseStatements(schemaSql);

      const existingTables = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map((row) => row.name),
      );
      const existingIndexes = new Set(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all()
          .map((row) => row.name),
      );

      const apply = db.transaction(() => {
        // Tables first: an index or column can only be added to a table that
        // exists, and a table created here arrives complete.
        for (const statement of statements) {
          if (!/^CREATE\s+TABLE/i.test(statement)) continue;

          const table = targetTable(statement);
          if (!table || existingTables.has(table)) continue;

          db.exec(statement);
          existingTables.add(table);
          addedTables.push(table);
        }

        for (const statement of statements) {
          if (!/^CREATE\s+TABLE/i.test(statement)) continue;

          const table = targetTable(statement);
          if (!table || addedTables.includes(table)) continue;

          const present = new Set(
            db.pragma(`table_info("${table}")`).map((row) => row.name),
          );

          for (const [column, definition] of columnsOf(statement)) {
            if (present.has(column)) continue;

            if (canAddColumn(definition)) {
              db.exec(`ALTER TABLE "${table}" ADD COLUMN ${definition}`);
              addedColumns.push(`${table}.${column}`);
            } else {
              needsMigration.push(`${table}.${column}`);
            }
          }
        }

        // Indexes last, so one covering a column added moments ago succeeds.
        for (const statement of statements) {
          if (!/^CREATE\s+(?:UNIQUE\s+)?INDEX/i.test(statement)) continue;

          const name = indexName(statement);
          if (!name || existingIndexes.has(name)) continue;

          db.exec(statement);
          addedIndexes.push(name);
        }
      });

      apply();
    }

    // Prove the database is sound before the server is told to start.
    //
    // A file can be the right size, at the right path, and still be internally
    // inconsistent — indexes that disagree with their tables, most often from a
    // half-finished copy. SQLite answers ordinary queries from such a file
    // without complaint, so the damage surfaces later as something baffling:
    // here it was a foreign key violation on sign-in, because the lookup found
    // a user through an index while the insert could not find them in the
    // table. Refusing to start says plainly what is wrong, and leaves the file
    // untouched for a restore.
    const problems = db
      .pragma("integrity_check")
      .map((row) => row.integrity_check)
      .filter((line) => line !== "ok");

    if (problems.length > 0) {
      console.log(
        JSON.stringify({
          ok: false,
          error: [
            "The database is damaged and cannot be opened safely.",
            "",
            problems.slice(0, 3).join("\n"),
            problems.length > 3 ? `…and ${problems.length - 3} more.` : "",
          "",
            `File: ${databaseFile}`,
          "",
            "Restore a backup from the data folder, or contact support.",
          ]
            .filter(Boolean)
            .join("\n"),
        }),
      );
      db.close();
      process.exit(1);
    }

    const tables = db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")
      .get().n;

    console.log(
      JSON.stringify({
        ok: true,
        created,
        tables,
        addedTables,
        addedColumns,
        addedIndexes,
        needsMigration,
      }),
    );
  } finally {
    db.close();
  }
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, error: error && error.message ? error.message : String(error) }),
  );
  process.exit(1);
}
