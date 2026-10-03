import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Importing a customer list from a spreadsheet.
 *
 * The reader and the rules are pinned against the files small businesses
 * actually have — Excel's quirks, QuickBooks' headings, a name in one column.
 * The action runs against the test database, because the promises that
 * matter are about stored rows: that customers land in the right business
 * with their address and note, and that the same file sent twice adds nobody.
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/auth", () => ({
  requireContext: async () => session,
  requirePermission: async () => session,
  getContext: async () => session,
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import { importClients } from "@/app/(app)/clients/import/actions";
import { onFileKeys } from "@/app/(app)/clients/import/queries";
import {
  guessMapping,
  IMPORT_TEMPLATE,
  matchKeys,
  planImport,
  type ColumnMapping,
} from "@/lib/client-import";
import { decodeCsvBytes, parseCsv, toCsv } from "@/lib/csv";
import { prisma } from "@/lib/db";

// ---------------------------------------------------------------- reading ---

describe("reading a CSV file", () => {
  it("reads quoted cells with commas, quotes and line breaks in them", () => {
    const text =
      'Name,Notes\r\n"Doe, Jane","Says ""hi""\r\nGate code 4411"\r\nSam Lee,plain\r\n';
    expect(parseCsv(text)).toEqual([
      ["Name", "Notes"],
      ["Doe, Jane", 'Says "hi"\r\nGate code 4411'],
      ["Sam Lee", "plain"],
    ]);
  });

  it("works out semicolons and tabs as separators", () => {
    expect(parseCsv("Name;Email\nJane;jane@example.com\n")).toEqual([
      ["Name", "Email"],
      ["Jane", "jane@example.com"],
    ]);
    expect(parseCsv("Name\tPhone, main\nJane\t555-0100\n")).toEqual([
      ["Name", "Phone, main"],
      ["Jane", "555-0100"],
    ]);
  });

  it("follows Excel's sep= line", () => {
    expect(parseCsv("sep=;\r\nName;City, State\r\nJane;Knoxville, TN\r\n")).toEqual([
      ["Name", "City, State"],
      ["Jane", "Knoxville, TN"],
    ]);
  });

  it("drops blank rows and a byte-order mark, and keeps a last line with no newline", () => {
    expect(parseCsv("﻿Name,Email\n\n,\nJane,j@x.com")).toEqual([
      ["Name", "Email"],
      ["Jane", "j@x.com"],
    ]);
  });

  it("decodes UTF-8, older Excel's Windows-1252 and Unicode Text", () => {
    const utf8 = new TextEncoder().encode("Name\nJosé\n");
    expect(decodeCsvBytes(utf8)).toBe("Name\nJosé\n");

    // "José" as Windows-1252: é is the single byte 0xE9, invalid as UTF-8.
    const ansi = new Uint8Array([0x4a, 0x6f, 0x73, 0xe9]);
    expect(decodeCsvBytes(ansi)).toBe("José");

    const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x09, 0x00, 0x42, 0x00]);
    expect(decodeCsvBytes(utf16)).toBe("A\tB");
  });

  it("writes CSV that reads back the same", () => {
    expect(parseCsv(toCsv(IMPORT_TEMPLATE))).toEqual(IMPORT_TEMPLATE);
  });
});

// ---------------------------------------------------------------- columns ---

describe("guessing the columns", () => {
  it("reads a QuickBooks Online customer export", () => {
    expect(
      guessMapping([
        "Customer", "Company", "Street Address", "City", "State", "Country",
        "Zip", "Phone", "Email", "Attachments", "Open Balance", "Notes",
      ]),
    ).toEqual([
      "fullName", "businessName", "line1", "city", "state", null,
      "postalCode", "phone", "email", null, null, "notes",
    ]);
  });

  it("reads another app's looser headings", () => {
    expect(
      guessMapping([
        "First Name", "Last Name", "Company Name", "Main Phone #s",
        "Mobile Phone #", "E-mail Address", "Billing Address - Street 1",
        "Billing Address - Street 2", "Billing Address - City",
        "Billing Address - Zip code", "Lead Source",
      ]),
    ).toEqual([
      "firstName", "lastName", "businessName", "phone", "mobilePhone",
      "email", "line1", "line2", "city", "postalCode", "source",
    ]);
  });

  it("fills each field from one column only", () => {
    expect(guessMapping(["Phone", "Home phone", "Name", "Customer"])).toEqual([
      "phone", null, "fullName", null,
    ]);
  });

  it("recognises every heading of its own template", () => {
    expect(guessMapping(IMPORT_TEMPLATE[0]).every(Boolean)).toBe(true);
  });
});

// ------------------------------------------------------------------ rules ---

function plan(rows: string[][], onFile: string[] = []) {
  const mapping: ColumnMapping = guessMapping(rows[0]);
  return planImport(rows, mapping, onFile);
}

describe("deciding each line", () => {
  it("splits a full name, either way round", () => {
    const { ready } = plan([["Name"], ["Jane Q. Doe"], ["Lee, Sam"], ["Cher"]]);
    expect(ready.map((row) => [row.draft?.firstName, row.draft?.lastName])).toEqual([
      ["Jane Q.", "Doe"],
      ["Sam", "Lee"],
      ["Cher", null],
    ]);
  });

  it("files a company under its own name, with the person as the contact", () => {
    const { ready } = plan([
      ["Name", "Company"],
      ["Sam Lee", "Riverside Dental"],
      ["Smith Plumbing LLC", ""],
      // QuickBooks repeats the company in "Customer": no contact person there.
      ["Acme Corp", "Acme Corp"],
    ]);
    expect(ready.map((row) => row.draft)).toMatchObject([
      { type: "BUSINESS", businessName: "Riverside Dental", displayName: "Riverside Dental", firstName: "Sam", lastName: "Lee" },
      { type: "BUSINESS", businessName: "Smith Plumbing LLC", firstName: null, lastName: null },
      { type: "BUSINESS", businessName: "Acme Corp", firstName: null, lastName: null },
    ]);
  });

  it("skips a line with no name rather than inventing one", () => {
    const result = plan([["Name", "Email"], ["", "nobody@example.com"], ["Jane", ""]]);
    expect(result.unnamed.map((row) => row.line)).toEqual([2]);
    expect(result.ready.map((row) => row.line)).toEqual([3]);
  });

  it("leaves off a bad email or a cityless street, and says so", () => {
    const { ready, warned } = plan([
      ["Name", "Email", "City"],
      ["Jane Doe", "jane@", "Knoxville"],
      ["Sam Lee", "sam@example.com; sam@work.example", ""],
    ]);
    expect(ready[0].draft).toMatchObject({ email: null, address: null });
    expect(ready[0].warnings).toEqual([
      "“jane@” is not an email address, so it was left off.",
      "No street address, so the address was left off.",
    ]);
    expect(ready[1].draft?.email).toBe("sam@example.com");
    expect(warned).toHaveLength(2);
  });

  it("reads sources and yes/no answers the way people write them", () => {
    const { ready } = plan([
      ["Name", "Lead source", "Tax exempt"],
      ["A", "Referral", "Yes"],
      ["B", "Facebook ad", "no"],
      ["C", "Google / Search", "TRUE"],
      ["D", "Yard sign", "x"],
      ["E", "Met at the fair", ""],
    ]);
    expect(ready.map((row) => [row.draft?.source, row.draft?.taxExempt])).toEqual([
      ["REFERRAL", true],
      ["SOCIAL", false],
      ["GOOGLE", true],
      ["WALK_IN", true],
      ["OTHER", false],
    ]);
  });

  it("skips anyone already on file: same email, or same name and phone", () => {
    const onFile = [
      ...matchKeys({ displayName: "Jane Doe", email: "JANE@example.com", phone: null, mobilePhone: null }),
      ...matchKeys({ displayName: "Sam  Lee", email: null, phone: "+1 (865) 555-0199", mobilePhone: null }),
      ...matchKeys({ displayName: "Cher", email: null, phone: null, mobilePhone: null }),
    ];
    const result = plan(
      [
        ["Name", "Email", "Phone"],
        ["Jane Doe", "jane@example.com", ""],
        ["sam lee", "", "865.555.0199"],
        ["Cher", "", ""],
        ["Sam Lee", "", "865-555-0100"],
        ["Jane Doe", "", ""],
      ],
      onFile,
    );
    expect(result.onFile.map((row) => row.line)).toEqual([2, 3, 4]);
    // Same name, different number: a different person, as far as anyone can tell.
    expect(result.ready.map((row) => row.line)).toEqual([5, 6]);
  });

  it("adds a customer listed twice in the file only once", () => {
    const result = plan([
      ["Name", "Email"],
      ["Jane Doe", "jane@example.com"],
      ["J. Doe", "Jane@Example.com"],
      ["Cher", ""],
      ["Cher", ""],
    ]);
    expect(result.ready.map((row) => row.line)).toEqual([2, 4]);
    expect(result.repeated.map((row) => row.line)).toEqual([3, 5]);
  });
});

// ----------------------------------------------------------------- saving ---

const orgs: string[] = [];
let organizationId: string;
let userId: string;

async function makeBusiness(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `import-${randomUUID()}`, name },
  });
  const user = await prisma.user.create({
    data: {
      organizationId: org.id,
      email: `${randomUUID()}@test.local`,
      name: "Owner",
      passwordHash: "not-used",
      role: "OWNER",
    },
  });
  orgs.push(org.id);
  return { org, user };
}

beforeEach(async () => {
  const { org, user } = await makeBusiness("Import Test Co");
  organizationId = org.id;
  userId = user.id;
  session.org = org as unknown as Record<string, unknown>;
  session.user = user as unknown as Record<string, unknown>;
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

const FILE = toCsv([
  ["First name", "Last name", "Company", "Email", "Phone", "Street address", "City", "State", "ZIP", "Notes"],
  ["Jane", "Doe", "", "jane@example.com", "(865) 555-0142", "12 Oak Street", "Knoxville", "TN", "37902", "Gate code 4411"],
  ["Sam", "Lee", "Riverside Dental", "office@example.com", "(865) 555-0199", "400 Main Street", "Lenoir City", "TN", "37771", ""],
  ["", "", "", "orphan@example.com", "", "", "", "", "", ""],
  ["Pat", "Kim", "", "", "", "", "", "", "", ""],
]);

describe("importing", () => {
  it("saves each customer with its address and note, in this business only", async () => {
    const outcome = await importClients(FILE, guessMapping(parseCsv(FILE)[0]));
    expect(outcome).toEqual({ ok: true, created: 3, onFile: 0, repeated: 0, unnamed: 1 });

    const clients = await prisma.client.findMany({
      where: { organizationId },
      orderBy: { displayName: "asc" },
      include: { addresses: true, notes: true },
    });

    expect(clients.map((c) => [c.displayName, c.type, c.status, c.createdById])).toEqual([
      ["Jane Doe", "PERSON", "ACTIVE", userId],
      ["Pat Kim", "PERSON", "ACTIVE", userId],
      ["Riverside Dental", "BUSINESS", "ACTIVE", userId],
    ]);

    const jane = clients[0];
    expect(jane.addresses).toMatchObject([
      { organizationId, line1: "12 Oak Street", city: "Knoxville", state: "TN", postalCode: "37902", isPrimary: true, isBilling: true },
    ]);
    expect(jane.notes).toMatchObject([{ organizationId, body: "Gate code 4411", authorId: userId }]);
    expect(clients[1].addresses).toEqual([]);
    expect(clients[2]).toMatchObject({ firstName: "Sam", lastName: "Lee", businessName: "Riverside Dental" });
  });

  it("adds nobody when the same file is imported again", async () => {
    const mapping = guessMapping(parseCsv(FILE)[0]);
    await importClients(FILE, mapping);

    const again = await importClients(FILE, mapping);
    expect(again).toEqual({ ok: true, created: 0, onFile: 3, repeated: 0, unnamed: 1 });
    expect(await prisma.client.count({ where: { organizationId } })).toBe(3);
  });

  it("matches against this business's customers, not another's", async () => {
    const mapping = guessMapping(parseCsv(FILE)[0]);
    await importClients(FILE, mapping);

    const { org, user } = await makeBusiness("Another Co");
    session.org = org as unknown as Record<string, unknown>;
    session.user = user as unknown as Record<string, unknown>;

    expect(await importClients(FILE, mapping)).toMatchObject({ ok: true, created: 3 });
    expect(await onFileKeys(org.id)).toContain("e:jane@example.com");
  });

  it("refuses a file whose name column was not chosen, and saves nothing", async () => {
    const mapping: ColumnMapping = guessMapping(parseCsv(FILE)[0]).map((field) =>
      field === "firstName" || field === "lastName" || field === "businessName" ? null : field,
    );
    expect(await importClients(FILE, mapping)).toEqual({
      ok: false,
      error: "Choose the column that holds each name before importing.",
    });
    expect(await prisma.client.count({ where: { organizationId } })).toBe(0);
  });

  it("ignores a column mapping it does not recognise or that repeats a field", async () => {
    const text = toCsv([["Name", "Also name", "Pets"], ["Jane Doe", "Someone Else", "3 cats"]]);
    const outcome = await importClients(text, ["fullName", "fullName", "DROP TABLE"]);
    expect(outcome).toMatchObject({ ok: true, created: 1 });
    expect(await prisma.client.findMany({ where: { organizationId }, select: { displayName: true } })).toEqual([
      { displayName: "Jane Doe" },
    ]);
  });

  it("refuses an empty file and one with headings only", async () => {
    expect(await importClients("  ", [])).toMatchObject({ ok: false });
    expect(await importClients("Name,Email\r\n", ["fullName", "email"])).toEqual({
      ok: false,
      error: "That file has no rows under its column headings.",
    });
  });
});
