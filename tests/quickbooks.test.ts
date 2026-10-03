import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startFakeQuickBooks, type FakeQuickBooks } from "./support/quickbooks-server";

/**
 * QuickBooks Online, phase 1: connecting a company and keeping its customer
 * list matching this one.
 *
 * The handshake and every request run over real HTTP against a stand-in for
 * Intuit, and against the test database, because the promises worth keeping
 * are about what reaches QuickBooks and what is remembered here: that nothing
 * goes before the owner's first Send now, that a customer is sent once and
 * updated after, that a same-name customer is linked rather than duplicated
 * and only overwritten when the owner allows it, and that a refused token
 * stops everything until the owner connects again.
 */

const session = vi.hoisted(() => ({
  user: null as unknown as Record<string, unknown>,
  org: null as unknown as Record<string, unknown>,
}));

vi.mock("@/lib/auth", () => ({
  requireContext: async () => session,
  requirePermission: async () => session,
  getContext: async () => session,
  DEMO_REFUSED_PATH: "/demo",
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

/** Work handed to after(), run by the test when it chooses. */
const deferred = vi.hoisted(() => [] as (() => Promise<void>)[]);
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => Promise<void>) => {
    deferred.push(task);
  },
}));

import {
  disconnectQuickBooks,
  sendToQuickBooksNow,
  setQuickBooksOverwrite,
} from "@/app/(app)/settings/quickbooks/actions";
import { GET as callback } from "@/app/api/integrations/quickbooks/callback/route";
import { GET as connect } from "@/app/api/integrations/quickbooks/connect/route";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { loadConnection, quickbooksStatus } from "@/lib/quickbooks/connection";
import { customerFields, quickbooksName } from "@/lib/quickbooks/customers";
import { signState, verifyState } from "@/lib/quickbooks/oauth";
import { quickbooksSettings } from "@/lib/quickbooks/settings";
import {
  customerSyncSummary,
  sendCustomersSoon,
  sweepQuickBooks,
  syncCustomers,
} from "@/lib/quickbooks/sync";

const ENV_KEYS = [
  "ENCRYPTION_KEY",
  "SESSION_SECRET",
  "QUICKBOOKS_CLIENT_ID",
  "QUICKBOOKS_CLIENT_SECRET",
  "QUICKBOOKS_OAUTH_BASE",
  "QUICKBOOKS_API_BASE",
  "QUICKBOOKS_ENVIRONMENT",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let qb: FakeQuickBooks;
const orgs: string[] = [];
let organizationId: string;
let userId: string;

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.ENCRYPTION_KEY = "quickbooks-test-encryption-key-0123456789abcdef";
  process.env.SESSION_SECRET = "quickbooks-test-session-secret";
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

async function makeBusiness(name: string, extra: { isDemo?: boolean; billingExempt?: boolean } = {}) {
  const org = await prisma.organization.create({
    data: {
      slug: `qb-${randomUUID()}`,
      name,
      billingExempt: extra.billingExempt ?? true,
      isDemo: extra.isDemo ?? false,
    },
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

async function signIn(name: string, extra?: Parameters<typeof makeBusiness>[1]) {
  const { org, user } = await makeBusiness(name, extra);
  session.org = org as unknown as Record<string, unknown>;
  session.user = user as unknown as Record<string, unknown>;
  organizationId = org.id;
  userId = user.id;
  return org.id;
}

beforeEach(async () => {
  qb = await startFakeQuickBooks();
  process.env.QUICKBOOKS_CLIENT_ID = qb.clientId;
  process.env.QUICKBOOKS_CLIENT_SECRET = qb.clientSecret;
  process.env.QUICKBOOKS_OAUTH_BASE = qb.baseUrl;
  process.env.QUICKBOOKS_API_BASE = qb.baseUrl;
  delete process.env.QUICKBOOKS_ENVIRONMENT;
  deferred.length = 0;
  await signIn("QuickBooks Test Co");
});

afterEach(async () => {
  await qb.close();
  // Each test's fake company is gone with its server; a connection left
  // pointing at it would only fail in the next test's morning run.
  await prisma.integration.deleteMany({ where: { organizationId: { in: orgs }, kind: "ACCOUNTING" } });
});

const APP = "http://localhost:3000";

/** The owner coming back from Intuit's consent screen. */
async function finishConnecting(query: Record<string, string> = {}) {
  const params = new URLSearchParams({
    code: qb.issueCode(),
    state: signState(organizationId, userId),
    realmId: qb.realmId,
    ...query,
  });
  return callback(new Request(`${APP}/api/integrations/quickbooks/callback?${params}`));
}

async function connected() {
  const response = await finishConnecting();
  expect(response.headers.get("location")).toBe(`${APP}/settings/quickbooks?connected=1`);
}

async function addClient(data: {
  displayName: string;
  type?: string;
  firstName?: string;
  lastName?: string;
  businessName?: string;
  email?: string;
  phone?: string;
  status?: string;
  street?: string;
}) {
  return prisma.client.create({
    data: {
      organizationId,
      type: data.type ?? "PERSON",
      displayName: data.displayName,
      firstName: data.firstName ?? null,
      lastName: data.lastName ?? null,
      businessName: data.businessName ?? null,
      email: data.email ?? null,
      phone: data.phone ?? null,
      status: data.status ?? "ACTIVE",
      addresses: data.street
        ? {
            create: {
              organizationId,
              line1: data.street,
              city: "Knoxville",
              state: "TN",
              postalCode: "37902",
              isPrimary: true,
              isBilling: true,
            },
          }
        : undefined,
    },
  });
}

const customerPosts = () =>
  qb.requests.filter((r) => r.method === "POST" && r.path.startsWith(`/v3/company/${qb.realmId}/customer`));

const linkOf = (clientId: string) =>
  prisma.accountingLink.findFirst({ where: { entityType: "CLIENT", entityId: clientId } });

/** An edit here, a moment later than the last send. */
async function touch(clientId: string, data: Record<string, unknown>) {
  await new Promise((resolve) => setTimeout(resolve, 5));
  await prisma.client.update({ where: { id: clientId }, data });
}

// --------------------------------------------------------------- settings ---

describe("this deployment's Intuit app", () => {
  it("is off until both keys are set, and sandbox unless told otherwise", () => {
    expect(quickbooksSettings({})).toBeNull();
    expect(quickbooksSettings({ QUICKBOOKS_CLIENT_ID: "id" })).toBeNull();

    const sandbox = quickbooksSettings({
      QUICKBOOKS_CLIENT_ID: "id",
      QUICKBOOKS_CLIENT_SECRET: "secret",
      APP_URL: "https://www.matlockone.com/",
    });
    expect(sandbox).toMatchObject({
      environment: "sandbox",
      apiBase: "https://sandbox-quickbooks.api.intuit.com",
      tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      redirectUri: "https://www.matlockone.com/api/integrations/quickbooks/callback",
    });

    expect(
      quickbooksSettings({
        QUICKBOOKS_CLIENT_ID: "id",
        QUICKBOOKS_CLIENT_SECRET: "secret",
        QUICKBOOKS_ENVIRONMENT: "Production",
      })?.apiBase,
    ).toBe("https://quickbooks.api.intuit.com");
  });
});

describe("the round-trip state", () => {
  it("is accepted only for the same business and person, unaltered and in date", () => {
    const state = signState("org-1", "user-1", 1_000);
    expect(verifyState(state, "org-1", "user-1", 2_000)).toBe(true);
    expect(verifyState(state, "org-2", "user-1", 2_000)).toBe(false);
    expect(verifyState(state, "org-1", "user-2", 2_000)).toBe(false);
    expect(verifyState(state, "org-1", "user-1", 1_000 + 16 * 60 * 1000)).toBe(false);
    expect(verifyState(`${state.split(".")[0]}.forged`, "org-1", "user-1", 2_000)).toBe(false);
    expect(verifyState(null, "org-1", "user-1", 2_000)).toBe(false);
  });
});

describe("a customer as QuickBooks sees it", () => {
  const base = {
    id: "c1",
    type: "PERSON",
    displayName: "Jane Doe",
    firstName: "Jane",
    lastName: "Doe",
    businessName: null,
    email: "jane@example.com",
    phone: "8655550142",
    mobilePhone: null,
    website: null,
    addresses: [],
  };

  it("sends a person's names, email and phone as QuickBooks writes them", () => {
    expect(customerFields(base)).toEqual({
      DisplayName: "Jane Doe",
      GivenName: "Jane",
      FamilyName: "Doe",
      CompanyName: undefined,
      PrimaryEmailAddr: { Address: "jane@example.com" },
      PrimaryPhone: { FreeFormNumber: "(865) 555-0142" },
      Mobile: undefined,
      WebAddr: undefined,
      BillAddr: undefined,
      ShipAddr: undefined,
    });
  });

  it("sends a company with its contact, its website, and the job site apart from the billing address", () => {
    const fields = customerFields({
      ...base,
      type: "BUSINESS",
      displayName: "Riverside Dental",
      businessName: "Riverside Dental",
      firstName: "Sam",
      lastName: "Lee",
      website: "riversidedental.example",
      addresses: [
        { id: "a1", line1: "400 Main St", line2: "Suite 2", city: "Lenoir City", state: "TN", postalCode: "37771", country: "US", isPrimary: true, isBilling: false },
        { id: "a2", line1: "PO Box 9", line2: null, city: "Lenoir City", state: "TN", postalCode: "37771", country: "US", isPrimary: false, isBilling: true },
      ],
    });
    expect(fields).toMatchObject({
      DisplayName: "Riverside Dental",
      CompanyName: "Riverside Dental",
      GivenName: "Sam",
      WebAddr: { URI: "https://riversidedental.example/" },
      BillAddr: { Line1: "PO Box 9", City: "Lenoir City", CountrySubDivisionCode: "TN", PostalCode: "37771", Country: "US" },
      ShipAddr: { Line1: "400 Main St", Line2: "Suite 2" },
    });
  });

  it("keeps names QuickBooks will take", () => {
    expect(quickbooksName("Acme: North\tSite")).toBe("Acme- North Site");
    expect(quickbooksName("x".repeat(600))).toHaveLength(500);
  });
});

// ------------------------------------------------------------- connecting ---

describe("connecting", () => {
  it("sends the owner to Intuit with this app, the accounting scope and a signed state", async () => {
    const response = await connect(new Request(`${APP}/api/integrations/quickbooks/connect`));
    const location = new URL(response.headers.get("location")!);

    expect(`${location.origin}${location.pathname}`).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(location.searchParams.get("client_id")).toBe(qb.clientId);
    expect(location.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(location.searchParams.get("redirect_uri")).toBe(`${APP}/api/integrations/quickbooks/callback`);
    expect(verifyState(location.searchParams.get("state"), organizationId, userId)).toBe(true);
  });

  it("keeps the demo out, and says so when this deployment has no Intuit app", async () => {
    await signIn("Demo Co", { isDemo: true });
    let response = await connect(new Request(`${APP}/api/integrations/quickbooks/connect`));
    expect(response.headers.get("location")).toBe(`${APP}/demo`);

    await signIn("Keyless Co");
    delete process.env.QUICKBOOKS_CLIENT_ID;
    response = await connect(new Request(`${APP}/api/integrations/quickbooks/connect`));
    expect(response.headers.get("location")).toBe(`${APP}/settings/quickbooks?problem=unavailable`);
  });

  it("stores the company and its tokens, and sends nothing yet", async () => {
    await addClient({ displayName: "Jane Doe" });
    await connected();

    expect(await quickbooksStatus(organizationId)).toMatchObject({
      realmId: qb.realmId,
      companyName: "Sandbox Company_US_1",
      environment: "sandbox",
      overwriteMatches: true,
      firstSentAt: null,
      needsReconnect: false,
    });
    expect((await loadConnection(organizationId))?.tokens.refreshToken).toBe("refresh-1");

    const stored = await prisma.integration.findFirst({ where: { organizationId, kind: "ACCOUNTING" } });
    expect(stored?.config).not.toContain("refresh-1");
    expect(customerPosts()).toHaveLength(0);
  });

  it("refuses a state that is not this person's, a cancel at Intuit, and a spent code", async () => {
    let response = await finishConnecting({ state: signState(organizationId, "somebody-else") });
    expect(response.headers.get("location")).toBe(`${APP}/settings/quickbooks?problem=expired`);

    response = await finishConnecting({ error: "access_denied" });
    expect(response.headers.get("location")).toBe(`${APP}/settings/quickbooks?problem=declined`);

    response = await finishConnecting({ code: "never-issued" });
    expect(response.headers.get("location")).toBe(`${APP}/settings/quickbooks?problem=refused`);

    expect(await quickbooksStatus(organizationId)).toBeNull();
  });
});

// -------------------------------------------------------- sending customers ---

describe("sending customers", () => {
  it("sends nothing by itself until the first Send now", async () => {
    const jane = await addClient({ displayName: "Jane Doe" });
    await connected();

    expect(await syncCustomers(organizationId)).toMatchObject({ skipped: "not-started" });
    await sendCustomersSoon(organizationId, [jane.id]);
    for (const task of deferred.splice(0)) await task();
    expect(customerPosts()).toHaveLength(0);
  });

  it("sends every customer that is not archived, once", async () => {
    const jane = await addClient({ displayName: "Jane Doe", firstName: "Jane", lastName: "Doe", email: "jane@example.com", street: "12 Oak St" });
    await addClient({ displayName: "Riverside Dental", type: "BUSINESS", businessName: "Riverside Dental" });
    await addClient({ displayName: "Old Customer", status: "INACTIVE" });
    await addClient({ displayName: "Gone Customer", status: "ARCHIVED" });
    await connected();

    expect(await sendToQuickBooksNow(IDLE, new FormData())).toEqual({
      ok: true,
      message: "3 customers sent to QuickBooks.",
    });
    expect([...qb.customers.values()].map((c) => c.DisplayName).sort()).toEqual([
      "Jane Doe",
      "Old Customer",
      "Riverside Dental",
    ]);
    expect(await linkOf(jane.id)).toMatchObject({ origin: "CREATED", syncToken: "0", lastError: null });
    expect((await quickbooksStatus(organizationId))?.firstSentAt).not.toBeNull();

    expect(await sendToQuickBooksNow(IDLE, new FormData())).toEqual({
      ok: true,
      message: "Everything is already in QuickBooks.",
    });
    expect(customerPosts()).toHaveLength(3);
  });

  it("sends an edit, here or to an address, as an update to the same customer", async () => {
    const jane = await addClient({ displayName: "Jane Doe", email: "jane@example.com", street: "12 Oak St" });
    await connected();
    await sendToQuickBooksNow(IDLE, new FormData());
    const externalId = (await linkOf(jane.id))!.externalId!;

    await touch(jane.id, { email: "jane.doe@example.com" });
    expect(await syncCustomers(organizationId)).toMatchObject({ sent: 1, failed: 0 });

    const update = customerPosts().at(-1)!.body as Record<string, unknown>;
    expect(update).toMatchObject({ Id: externalId, SyncToken: "0", sparse: true, PrimaryEmailAddr: { Address: "jane.doe@example.com" } });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.address.updateMany({ where: { clientId: jane.id }, data: { line1: "14 Oak St" } });
    expect(await syncCustomers(organizationId)).toMatchObject({ sent: 1 });
    expect(qb.customers.get(externalId)).toMatchObject({ SyncToken: "2", BillAddr: { Line1: "14 Oak St" } });
    expect(qb.customers.size).toBe(1);
  });

  it("links a customer QuickBooks already has by name, and overwrites it only while allowed", async () => {
    const existing = qb.addCustomer({ DisplayName: "Jane Doe", PrimaryEmailAddr: { Address: "old@example.com" } });
    const other = qb.addCustomer({ DisplayName: "Sam Lee", PrimaryEmailAddr: { Address: "sam.old@example.com" } });
    const jane = await addClient({ displayName: "Jane Doe", email: "jane@example.com" });
    const sam = await addClient({ displayName: "Sam Lee", email: "sam@example.com" });
    const pat = await addClient({ displayName: "Pat Kim", email: "pat@example.com" });
    await connected();

    // Overwriting off before the first send: matched customers are used as they are.
    const off = new FormData();
    off.set("overwrite", "off");
    await setQuickBooksOverwrite(off);
    await sendToQuickBooksNow(IDLE, new FormData());

    expect(await linkOf(sam.id)).toMatchObject({ externalId: other.Id, origin: "MATCHED" });
    expect(qb.customers.get(other.Id)?.PrimaryEmailAddr).toEqual({ Address: "sam.old@example.com" });
    expect(qb.customers.size).toBe(3);

    // Still off: an edit to a matched customer is not written; one Matlock One made is.
    await touch(sam.id, { phone: "8655550100" });
    await touch(pat.id, { phone: "8655550101" });
    await syncCustomers(organizationId);
    expect(qb.customers.get(other.Id)?.PrimaryPhone).toBeUndefined();
    expect([...qb.customers.values()].find((c) => c.DisplayName === "Pat Kim")?.PrimaryPhone).toEqual({
      FreeFormNumber: "(865) 555-0101",
    });

    // Turned on: the next change overwrites.
    const on = new FormData();
    on.set("overwrite", "on");
    await setQuickBooksOverwrite(on);
    await touch(jane.id, { phone: "8655550102" });
    await syncCustomers(organizationId);
    expect(qb.customers.get(existing.Id)).toMatchObject({
      PrimaryEmailAddr: { Address: "jane@example.com" },
      PrimaryPhone: { FreeFormNumber: "(865) 555-0102" },
    });
  });

  it("overwrites a same-name customer straight away when the switch is left on", async () => {
    const existing = qb.addCustomer({ DisplayName: "jane doe", PrimaryEmailAddr: { Address: "old@example.com" } });
    const jane = await addClient({ displayName: "Jane Doe", email: "jane@example.com" });
    await connected();
    await sendToQuickBooksNow(IDLE, new FormData());

    expect(await linkOf(jane.id)).toMatchObject({ externalId: existing.Id, origin: "MATCHED" });
    expect(qb.customers.get(existing.Id)?.PrimaryEmailAddr).toEqual({ Address: "jane@example.com" });
  });

  it("wins over an edit made in QuickBooks meanwhile, and re-makes a customer merged away there", async () => {
    const jane = await addClient({ displayName: "Jane Doe", email: "jane@example.com" });
    const sam = await addClient({ displayName: "Sam Lee" });
    await connected();
    await sendToQuickBooksNow(IDLE, new FormData());

    const janeId = (await linkOf(jane.id))!.externalId!;
    qb.editInQuickBooks(janeId, { Notes: "edited by the accountant" });
    await touch(jane.id, { email: "jane.doe@example.com" });

    const samId = (await linkOf(sam.id))!.externalId!;
    qb.remove(samId);
    await touch(sam.id, { phone: "8655550100" });

    expect(await syncCustomers(organizationId)).toMatchObject({ sent: 2, failed: 0 });
    expect(qb.customers.get(janeId)?.PrimaryEmailAddr).toEqual({ Address: "jane.doe@example.com" });
    const remade = (await linkOf(sam.id))!.externalId!;
    expect(remade).not.toBe(samId);
    expect(qb.customers.get(remade)?.DisplayName).toBe("Sam Lee");
  });

  it("explains a name a supplier already has, and sends it once renamed", async () => {
    qb.otherNames.add("Acme Supply");
    const acme = await addClient({ displayName: "Acme Supply", type: "BUSINESS", businessName: "Acme Supply" });
    await connected();

    const outcome = await sendToQuickBooksNow(IDLE, new FormData());
    expect(outcome).toEqual({ ok: false, error: "1 customer could not be sent — see below." });

    const connection = (await loadConnection(organizationId))!;
    const summary = await customerSyncSummary(connection);
    expect(summary.failing).toEqual([
      expect.objectContaining({
        id: acme.id,
        error: expect.stringContaining("already has a supplier or employee called “Acme Supply”"),
      }),
    ]);

    await touch(acme.id, { displayName: "Acme Supply (customer)" });
    expect(await syncCustomers(organizationId)).toMatchObject({ sent: 1, failed: 0 });
    expect((await customerSyncSummary(connection)).failing).toEqual([]);
  });
});

// ----------------------------------------------------------------- tokens ---

describe("keeping the connection", () => {
  it("renews an expired access token and keeps the new refresh token", async () => {
    await addClient({ displayName: "Jane Doe" });
    await connected();
    qb.expireAccessToken();

    expect(await sendToQuickBooksNow(IDLE, new FormData())).toMatchObject({ ok: true });
    expect(qb.tokenGrants()).toBe(2);
    expect((await loadConnection(organizationId))?.tokens.refreshToken).toBe("refresh-2");
  });

  it("stops and asks for a new connection once QuickBooks refuses the refresh token", async () => {
    const jane = await addClient({ displayName: "Jane Doe" });
    await addClient({ displayName: "Sam Lee" });
    await connected();
    qb.revokeRefreshToken();

    await sendToQuickBooksNow(IDLE, new FormData());
    expect(await quickbooksStatus(organizationId)).toMatchObject({ needsReconnect: true });
    expect(await linkOf(jane.id).then((link) => link?.lastError)).toBeTruthy();
    expect(customerPosts()).toHaveLength(0);

    expect(await sendToQuickBooksNow(IDLE, new FormData())).toEqual({
      ok: false,
      error: "QuickBooks needs connecting again before anything can be sent.",
    });

    // Connecting again clears it.
    await connected();
    expect(await quickbooksStatus(organizationId)).toMatchObject({ needsReconnect: false });
    expect(await syncCustomers(organizationId)).toMatchObject({ sent: 2 });
  });

  it("hands the token back on disconnect, keeps what was sent, and carries on when the same company returns", async () => {
    const jane = await addClient({ displayName: "Jane Doe" });
    await connected();
    const off = new FormData();
    off.set("overwrite", "off");
    await setQuickBooksOverwrite(off);
    await sendToQuickBooksNow(IDLE, new FormData());

    await disconnectQuickBooks();
    expect(qb.revoked).toEqual(["refresh-1"]);
    expect(await quickbooksStatus(organizationId)).toBeNull();
    expect(await linkOf(jane.id)).not.toBeNull();

    await connected();
    expect(await quickbooksStatus(organizationId)).toMatchObject({ overwriteMatches: false, firstSentAt: expect.any(String) });
    expect(await syncCustomers(organizationId)).toMatchObject({ sent: 0, remaining: 0 });
    expect(customerPosts()).toHaveLength(1);
  });
});

// ------------------------------------------------------------- background ---

describe("sending by itself", () => {
  it("sends a saved customer in the background once sending has started", async () => {
    await connected();
    await sendToQuickBooksNow(IDLE, new FormData());

    const jane = await addClient({ displayName: "Jane Doe" });
    await sendCustomersSoon(organizationId, [jane.id]);
    expect(deferred).toHaveLength(1);
    await deferred.splice(0)[0]();

    expect(await linkOf(jane.id)).toMatchObject({ origin: "CREATED", lastError: null });
  });

  it("queues nothing for a business without QuickBooks", async () => {
    const jane = await addClient({ displayName: "Jane Doe" });
    await sendCustomersSoon(organizationId, [jane.id]);
    expect(deferred).toHaveLength(0);
  });

  it("catches up each morning for paid, connected businesses that have started", async () => {
    await connected();
    await sendToQuickBooksNow(IDLE, new FormData());
    const jane = await addClient({ displayName: "Jane Doe" });

    // Connected but never pressed Send now: left alone.
    await signIn("Not Started Co");
    const waiting = await addClient({ displayName: "Waiting Customer" });
    await connected();

    const sweep = await sweepQuickBooks();
    expect(sweep).toMatchObject({ sent: 1, failed: 0, stoppedEarly: false });
    expect(await linkOf(jane.id)).toMatchObject({ lastError: null });
    expect(await linkOf(waiting.id)).toBeNull();
  });
});
