import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import {
  applyPlan,
  buildPlan,
  decideUsers,
  parseSchema,
  type Row,
  type SourceReader,
  type Writer,
} from "./import-desktop-lib";

/**
 * Copies a business from a desktop install's database file into the online
 * business that the same email signs in to.
 *
 *   npm run import:desktop -- --file "C:\path\to\matlockone.db" --email you@example.com
 *   npm run import:desktop -- --file ... --email ... --apply
 *
 * Without --apply it only reads both sides and prints what it would do. With
 * it, everything is written in one transaction.
 *
 * DATABASE_URL must be set to the hosted database in the shell, the same way
 * as for `npm run db:deploy`. It is deliberately not read from .env, which
 * points at the local development file.
 *
 * Only an empty online business is filled — no clients, jobs, estimates,
 * invoices, leads or payments — so running it twice cannot copy anything
 * twice.
 *
 * The file should be a copy taken with the desktop app closed: SQLite keeps
 * recent changes in a side file (-wal) until the app shuts down.
 *
 * Options:
 *   --from <name or id>  which desktop business, when the file holds several
 *                        and --email is not on the one you mean
 *   --to <id>            which online business, when the email is on several
 */

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

/** The tables that make a business "not empty". */
const BUSINESS_TABLES = ["client", "job", "estimate", "invoice", "lead", "payment"] as const;

function openSource(file: string): { reader: SourceReader; close(): void } {
  // Required rather than imported, like src/lib/db.ts: a native module. Rooted
  // at the project, because tsx runs this as CommonJS, where import.meta.url is
  // empty.
  const Database = createRequire(path.join(process.cwd(), "package.json"))("better-sqlite3") as new (
    file: string,
    options: { readonly: boolean; fileMustExist: boolean },
  ) => {
    prepare(sql: string): { all(...params: unknown[]): Row[] };
    close(): void;
  };
  const db = new Database(file, { readonly: true, fileMustExist: true });

  const reader: SourceReader = {
    columns(table) {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
      return cols.length ? cols.map((c) => c.name) : null;
    },
    rows(table, where) {
      return where
        ? db.prepare(`SELECT * FROM "${table}" WHERE "${where.column}" = ?`).all(where.value)
        : db.prepare(`SELECT * FROM "${table}"`).all();
    },
  };
  return { reader, close: () => db.close() };
}

function describe(value: unknown) {
  if (value === null || value === undefined || value === "") return "(blank)";
  const text = String(value).replace(/\s+/g, " ");
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

async function main() {
  const file = arg("file");
  const email = arg("email")?.trim().toLowerCase();
  const apply = process.argv.includes("--apply");
  if (!file || !email) {
    fail('Usage: npm run import:desktop -- --file "<path to matlockone.db>" --email <your sign-in email> [--apply]');
  }
  if (!fs.existsSync(file)) fail(`There is no file at ${file}`);

  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    fail(
      "DATABASE_URL is not set to the hosted database in this window.\n" +
        "Set it the same way as for `npm run db:deploy`, then run this again.",
    );
  }

  const schema = parseSchema(fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8"));
  const { reader, close } = openSource(file);

  // --- which desktop business ----------------------------------------------
  const sourceOrgs = reader.rows("Organization");
  const sourceUsersAll = reader.rows("User");
  const fromArg = arg("from")?.toLowerCase();
  const sourceMatches = fromArg
    ? sourceOrgs.filter((o) => String(o.id).toLowerCase() === fromArg || String(o.name).toLowerCase() === fromArg)
    : sourceOrgs.filter((o) =>
        sourceUsersAll.some((u) => u.organizationId === o.id && String(u.email).toLowerCase() === email),
      );
  if (sourceMatches.length !== 1) {
    const list = sourceOrgs
      .map((o) => {
        const clients = reader.rows("Client", { column: "organizationId", value: String(o.id) }).length;
        return `  ${o.name}  (id ${o.id}, ${clients} clients)`;
      })
      .join("\n");
    fail(
      `${sourceMatches.length ? "Several" : "No"} businesses in the file match. Choose one with --from:\n${list}`,
    );
  }
  const sourceOrg = sourceMatches[0];

  // --- which online business -----------------------------------------------
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 2 }) });
  try {
    const toArg = arg("to");
    const holders = await prisma.user.findMany({
      where: { email, ...(toArg ? { organizationId: toArg } : {}) },
      select: { organizationId: true },
    });
    const orgIds = [...new Set(holders.map((h) => h.organizationId))];
    if (orgIds.length === 0) {
      fail(
        toArg
          ? `${email} is not a member of online business ${toArg}.`
          : `No online account signs in with ${email}. Sign up on the website first, then run this again.`,
      );
    }
    if (orgIds.length > 1) {
      const orgs = await prisma.organization.findMany({
        where: { id: { in: orgIds } },
        select: { id: true, name: true, _count: { select: { clients: true, invoices: true } } },
      });
      const list = orgs
        .map((o) => `  ${o.name}  (id ${o.id}, ${o._count.clients} clients, ${o._count.invoices} invoices)`)
        .join("\n");
      fail(`${email} signs in to several online businesses. Choose one with --to:\n${list}`);
    }

    const target = await prisma.organization.findUniqueOrThrow({ where: { id: orgIds[0] } });
    const targetRow = target as unknown as Row;

    const counts = await Promise.all(
      BUSINESS_TABLES.map((t) =>
        (prisma[t] as unknown as { count(a: object): Promise<number> }).count({ where: { organizationId: target.id } }),
      ),
    );
    if (counts.some((n) => n > 0)) {
      const held = BUSINESS_TABLES.map((t, i) => `${counts[i]} ${t}`).filter((s) => !s.startsWith("0 ")).join(", ");
      fail(
        `The online business "${target.name}" already has records (${held}).\n` +
          "This only fills an empty business, so nothing can be copied twice. Nothing was written.",
      );
    }

    // --- people ------------------------------------------------------------
    const sourceUsers = sourceUsersAll.filter((u) => u.organizationId === sourceOrg.id);
    const targetUsers = await prisma.user.findMany({
      where: { organizationId: target.id },
      select: { id: true, email: true },
    });
    const elsewhere = await prisma.user.findMany({
      where: {
        email: { in: sourceUsers.map((u) => String(u.email).toLowerCase()) },
        organizationId: { not: target.id },
      },
      select: { email: true },
    });
    const users = decideUsers(sourceUsers, targetUsers, new Set(elsewhere.map((u) => u.email.toLowerCase())));

    const plan = buildPlan({
      schema,
      source: reader,
      sourceOrgId: String(sourceOrg.id),
      targetOrgId: target.id,
      users,
      targetProfile: targetRow,
    });

    // --- report ------------------------------------------------------------
    const billing = target.billingExempt
      ? "never billed (exempt)"
      : target.paidThrough
        ? `${target.subscriptionStatus ?? "paid"} through ${target.paidThrough.toISOString().slice(0, 10)}`
        : "no subscription on record";

    console.log(`\nFrom the desktop file:  ${sourceOrg.name}`);
    console.log(`                        ${path.resolve(file)}`);
    console.log(`Into the online business: ${target.name}  (id ${target.id}; billing: ${billing})`);

    console.log("\nPeople:");
    for (const u of users) {
      if (u.action === "match") console.log(`  ${u.email}: already online; their records are credited to that account`);
      if (u.action === "create") console.log(`  ${u.email}: added to the online business, with the same password as on the PC`);
      if (u.action === "drop") console.log(`  ${u.email}: not added (${u.reason}); what they made is kept, credited to nobody`);
    }

    console.log("\nWill copy:");
    for (const b of plan.batches) console.log(`  ${b.model.padEnd(20)} ${b.rows.length}`);
    if (plan.deferred.length) console.log(`  (then ${plan.deferred.length} links between records filled in)`);

    const changes = Object.entries(plan.profile);
    if (changes.length) {
      console.log("\nBusiness settings that change online:");
      for (const [field, value] of changes) {
        console.log(`  ${field}: ${describe(targetRow[field])} -> ${describe(value)}`);
      }
    }

    if (plan.excluded.length) {
      console.log("\nNot copied:");
      for (const e of plan.excluded) console.log(`  ${e.model} (${e.count}): ${e.reason}`);
    }
    if (plan.cleared.length) {
      console.log("\nLinks left empty because what they pointed at is not moving:");
      for (const c of plan.cleared) console.log(`  ${c.model}.${c.field}: ${c.count}`);
    }
    if (plan.dropped.length) {
      console.log("\nRecords that cannot be copied:");
      for (const d of plan.dropped) console.log(`  ${d.model} (${d.count}): ${d.reason}`);
    }

    const otherOrgs = sourceOrgs.filter((o) => o.id !== sourceOrg.id);
    if (otherOrgs.length) {
      console.log(`\nAlso in the file, and left alone: ${otherOrgs.map((o) => o.name).join(", ")}`);
    }

    if (!apply) {
      console.log("\nNothing has been written. Run the same command with --apply to copy.\n");
      return;
    }

    const written = await prisma.$transaction(
      (tx) => applyPlan(tx as unknown as Writer, plan, target.id),
      { maxWait: 20_000, timeout: 120_000 },
    );
    const clients = await prisma.client.count({ where: { organizationId: target.id } });
    console.log("\nCopied:");
    for (const [model, count] of Object.entries(written)) console.log(`  ${model.padEnd(20)} ${count}`);
    console.log(`\nDone. "${target.name}" now has ${clients} clients online.\n`);
  } finally {
    close();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
