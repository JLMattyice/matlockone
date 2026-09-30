import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient as SqlitePrismaClient } from "@/generated/sqlite/client";
import { createPrismaClient } from "@/lib/db";

import {
  applyPlan,
  buildPlan,
  convertValue,
  decideUsers,
  foreignKeys,
  insertOrder,
  parseSchema,
  type Plan,
  type Row,
  type SourceReader,
  type Writer,
} from "../scripts/import-desktop-lib";

/**
 * The desktop → online importer, end to end on two SQLite files: a copy of the
 * test database stands in for the desktop file, the test database itself for
 * the hosted one. The importer only writes through Prisma, which is the same
 * API on both engines, so this exercises the real write path.
 */

const schema = parseSchema(fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8"));

describe("reading the schema", () => {
  it("finds the links between tables", () => {
    const invoice = foreignKeys(schema, "Invoice");
    expect(invoice.get("clientId")).toEqual({ target: "Client", optional: false });
    expect(invoice.get("jobId")).toEqual({ target: "Job", optional: true });
    expect(invoice.get("organizationId")?.target).toBe("Organization");
  });

  it("orders tables so every link exists before it is used", () => {
    const models = [...schema.keys()].filter((m) => m !== "Organization" && m !== "User");
    const { order, deferred } = insertOrder(schema, models);
    const at = (m: string) => order.indexOf(m);
    expect(at("Client")).toBeLessThan(at("Invoice"));
    expect(at("Invoice")).toBeLessThan(at("InvoiceLineItem"));
    expect(at("Invoice")).toBeLessThan(at("Payment"));
    expect(at("Job")).toBeLessThan(at("JobAssignment"));
    expect(deferred.has("Job.recurrenceParentId")).toBe(true);
    expect(order).toHaveLength(models.length);
  });
});

describe("converting stored values", () => {
  it("reads the SQLite adapter's dates, flags and numbers", () => {
    expect(convertValue("DateTime", "2026-08-30T04:04:51.652+00:00")).toEqual(
      new Date("2026-08-30T04:04:51.652Z"),
    );
    expect(convertValue("DateTime", 1_790_000_000_000)).toEqual(new Date(1_790_000_000_000));
    expect(convertValue("Boolean", 1)).toBe(true);
    expect(convertValue("Boolean", 0)).toBe(false);
    expect(convertValue("Int", 1009)).toBe(1009);
    expect(convertValue("String", null)).toBeNull();
    expect(() => convertValue("DateTime", "not a date")).toThrow();
  });
});

describe("deciding what happens to each person", () => {
  it("matches by email, creates the missing, and never takes an email in use elsewhere", () => {
    const decisions = decideUsers(
      [
        { id: "a", email: "Owner@Example.test" },
        { id: "b", email: "helper@example.test" },
        { id: "c", email: "taken@example.test" },
      ],
      [{ id: "online-owner", email: "owner@example.test" }],
      new Set(["taken@example.test"]),
    );
    expect(decisions.map((d) => d.action)).toEqual(["match", "create", "drop"]);
    expect(decisions[0]).toMatchObject({ targetId: "online-owner" });
  });
});

// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
type SqliteDb = {
  prepare(sql: string): { all(...p: unknown[]): Row[] };
  exec(sql: string): void;
  close(): void;
};
const Database = require("better-sqlite3") as new (file: string, options?: object) => SqliteDb;

const online = createPrismaClient();
const tag = randomUUID().slice(0, 8);
const ownerEmail = `owner-${tag}@example.test`;
const helperEmail = `helper-${tag}@example.test`;
const takenEmail = `taken-${tag}@example.test`;

let tmpDir: string;
let desktopFile: string;
let desktop: SqlitePrismaClient;
const ids = {} as Record<string, string>;
let targetOrgId: string;
let targetOwnerId: string;
let elsewhereOrgId: string;
let plan: Plan;

function reader(db: SqliteDb): SourceReader {
  return {
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
}

beforeAll(async () => {
  // The desktop file: the test database's tables, as a separate file.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "import-desktop-"));
  desktopFile = path.join(tmpDir, "matlockone.db");
  const live = new Database(path.resolve(process.cwd(), "test.db"));
  live.exec(`VACUUM INTO '${desktopFile.replace(/'/g, "''")}'`);
  live.close();
  desktop = new SqlitePrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${desktopFile}` }) });

  const org = await desktop.organization.create({
    data: { slug: `desk-${tag}`, name: "Desk Co", invoiceNextNumber: 1009, jobNextNumber: 1002, phone: "555-0100" },
  });
  const other = await desktop.organization.create({ data: { slug: `test-${tag}`, name: "Test Co" } });
  ids.org = org.id;

  const owner = await desktop.user.create({
    data: { organizationId: org.id, email: ownerEmail, passwordHash: "hash-owner", name: "Owner", role: "OWNER" },
  });
  const helper = await desktop.user.create({
    data: { organizationId: org.id, email: helperEmail, passwordHash: "hash-helper", name: "Helper", role: "OWNER" },
  });
  const taken = await desktop.user.create({
    data: { organizationId: org.id, email: takenEmail, passwordHash: "hash-taken", name: "Taken" },
  });
  Object.assign(ids, { owner: owner.id, helper: helper.id, taken: taken.id });

  const salon = await desktop.client.create({
    data: { organizationId: org.id, type: "BUSINESS", displayName: "Maple Street Salon", createdById: owner.id },
  });
  const bakery = await desktop.client.create({
    data: { organizationId: org.id, type: "BUSINESS", displayName: "Hillside Bakery" },
  });
  await desktop.client.create({ data: { organizationId: other.id, type: "PERSON", displayName: "Not Moving" } });
  const address = await desktop.address.create({
    data: { organizationId: org.id, clientId: salon.id, line1: "1 Main St", city: "Springfield" },
  });
  const job = await desktop.job.create({
    data: {
      organizationId: org.id,
      number: "JOB-1001",
      title: "Website",
      clientId: salon.id,
      addressId: address.id,
      createdById: helper.id,
    },
  });
  const repeat = await desktop.job.create({
    data: { organizationId: org.id, number: "JOB-1002", title: "Website, again", recurrenceParentId: job.id },
  });
  await desktop.jobAssignment.create({ data: { jobId: job.id, userId: helper.id } });
  const invoice = await desktop.invoice.create({
    data: {
      organizationId: org.id,
      number: "INV-1008",
      clientId: bakery.id,
      jobId: job.id,
      status: "SENT",
      subtotalCents: 5000,
      totalCents: 5000,
      balanceCents: 3000,
      amountPaidCents: 2000,
      createdById: owner.id,
    },
  });
  await desktop.invoiceLineItem.createMany({
    data: [
      { invoiceId: invoice.id, name: "Design" },
      { invoiceId: invoice.id, name: "Hosting" },
    ],
  });
  await desktop.payment.create({
    data: { organizationId: org.id, invoiceId: invoice.id, clientId: bakery.id, amountCents: 2000, method: "CASH" },
  });
  await desktop.note.create({ data: { organizationId: org.id, body: "Call the owner", clientId: salon.id, authorId: taken.id } });
  await desktop.session.create({
    data: { token: `t-${tag}`, userId: owner.id, expiresAt: new Date(Date.now() + 86_400_000) },
  });
  await desktop.outboxMessage.create({
    data: { organizationId: org.id, channel: "EMAIL", toAddress: "x@example.test", body: "Invoice" },
  });
  Object.assign(ids, { salon: salon.id, bakery: bakery.id, job: job.id, repeat: repeat.id, invoice: invoice.id });

  // The online side: an empty business the owner signed up for, and another
  // business that already uses one teammate's email.
  const target = await online.organization.create({
    data: { slug: `online-${tag}`, name: "Signed Up Online", billingExempt: true },
  });
  const targetOwner = await online.user.create({
    data: { organizationId: target.id, email: ownerEmail, passwordHash: "online-hash", name: "Owner", role: "OWNER" },
  });
  const elsewhere = await online.organization.create({ data: { slug: `else-${tag}`, name: "Elsewhere" } });
  await online.user.create({
    data: { organizationId: elsewhere.id, email: takenEmail, passwordHash: "x", name: "Someone" },
  });
  targetOrgId = target.id;
  targetOwnerId = targetOwner.id;
  elsewhereOrgId = elsewhere.id;

  await desktop.$disconnect();

  const file = new Database(desktopFile, { readonly: true });
  const source = reader(file);
  const sourceUsers = source.rows("User", { column: "organizationId", value: ids.org });
  const users = decideUsers(
    sourceUsers,
    [{ id: targetOwnerId, email: ownerEmail }],
    new Set([takenEmail]),
  );
  plan = buildPlan({
    schema,
    source,
    sourceOrgId: ids.org,
    targetOrgId,
    users,
    targetProfile: target as unknown as Row,
  });
  file.close();

  await online.$transaction((tx) => applyPlan(tx as unknown as Writer, plan, targetOrgId));
});

afterAll(async () => {
  await online.organization.deleteMany({ where: { id: { in: [targetOrgId, elsewhereOrgId] } } });
  await online.$disconnect();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("copying a desktop business online", () => {
  it("copies the business's clients and nothing from the other business in the file", async () => {
    const clients = await online.client.findMany({ where: { organizationId: targetOrgId }, orderBy: { displayName: "asc" } });
    expect(clients.map((c) => c.displayName)).toEqual(["Hillside Bakery", "Maple Street Salon"]);
    expect(clients.map((c) => c.id).sort()).toEqual([ids.bakery, ids.salon].sort());
  });

  it("credits the owner's records to the online owner", async () => {
    const salon = await online.client.findUniqueOrThrow({ where: { id: ids.salon } });
    expect(salon.createdById).toBe(targetOwnerId);
    const invoice = await online.invoice.findUniqueOrThrow({ where: { id: ids.invoice } });
    expect(invoice.createdById).toBe(targetOwnerId);
  });

  it("adds a teammate who had no online account, keeping their password", async () => {
    const helper = await online.user.findUniqueOrThrow({ where: { id: ids.helper } });
    expect(helper.organizationId).toBe(targetOrgId);
    expect(helper.passwordHash).toBe("hash-helper");
    const job = await online.job.findUniqueOrThrow({ where: { id: ids.job } });
    expect(job.createdById).toBe(ids.helper);
    const assignments = await online.jobAssignment.findMany({ where: { jobId: ids.job } });
    expect(assignments.map((a) => a.userId)).toEqual([ids.helper]);
  });

  it("does not create a second account for an email that signs in elsewhere", async () => {
    expect(await online.user.findUnique({ where: { id: ids.taken } })).toBeNull();
    const note = await online.note.findFirstOrThrow({ where: { organizationId: targetOrgId } });
    expect(note.body).toBe("Call the owner");
    expect(note.authorId).toBeNull();
  });

  it("keeps the links between records, including a job's link to itself", async () => {
    const repeat = await online.job.findUniqueOrThrow({ where: { id: ids.repeat } });
    expect(repeat.recurrenceParentId).toBe(ids.job);
    const invoice = await online.invoice.findUniqueOrThrow({
      where: { id: ids.invoice },
      include: { lineItems: true, payments: true },
    });
    expect(invoice.jobId).toBe(ids.job);
    expect(invoice.lineItems.map((l) => l.name).sort()).toEqual(["Design", "Hosting"]);
    expect(invoice.payments.map((p) => p.amountCents)).toEqual([2000]);
    expect(invoice.balanceCents).toBe(3000);
  });

  it("brings the business's settings but keeps the online slug and billing", async () => {
    const org = await online.organization.findUniqueOrThrow({ where: { id: targetOrgId } });
    expect(org.name).toBe("Desk Co");
    expect(org.phone).toBe("555-0100");
    expect(org.invoiceNextNumber).toBe(1009);
    expect(org.slug).toBe(`online-${tag}`);
    expect(org.billingExempt).toBe(true);
  });

  it("leaves sign-ins and queued email behind, and says so", async () => {
    expect(await online.session.findUnique({ where: { token: `t-${tag}` } })).toBeNull();
    expect(await online.outboxMessage.count({ where: { organizationId: targetOrgId } })).toBe(0);
    expect(plan.excluded).toContainEqual(expect.objectContaining({ model: "OutboxMessage", count: 1 }));
    expect(plan.cleared).toContainEqual({ model: "Note", field: "authorId", count: 1 });
  });
});
