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
  saveQuickBooksExpenseAccounts,
  sendToQuickBooksNow,
  setQuickBooksOverwrite,
  setQuickBooksStartDate,
} from "@/app/(app)/settings/quickbooks/actions";
import { GET as callback } from "@/app/api/integrations/quickbooks/callback/route";
import { GET as connect } from "@/app/api/integrations/quickbooks/connect/route";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import { loadConnection, quickbooksStatus, setSendFrom } from "@/lib/quickbooks/connection";
import { customerFields, quickbooksName } from "@/lib/quickbooks/customers";
import { forgetDiscovery, oauthEndpoints } from "@/lib/quickbooks/discovery";
import { signState, verifyState } from "@/lib/quickbooks/oauth";
import { quickbooksSettings } from "@/lib/quickbooks/settings";
import {
  customerSyncSummary,
  sendCustomersSoon,
  sendToQuickBooksSoon,
  sweepQuickBooks,
  syncCustomers,
  syncQuickBooks,
  syncSummary,
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

describe("Intuit's discovery document", () => {
  const settings = quickbooksSettings({
    QUICKBOOKS_CLIENT_ID: "id",
    QUICKBOOKS_CLIENT_SECRET: "secret",
    APP_URL: "https://www.matlockone.com",
  })!;

  afterEach(() => {
    forgetDiscovery();
    vi.restoreAllMocks();
  });

  it("is where the OAuth endpoints come from, read once and kept", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        authorization_endpoint: "https://appcenter.intuit.com/connect/oauth2/v2",
        token_endpoint: "https://oauth.platform.intuit.com/oauth2/v2/tokens/bearer",
        revocation_endpoint: "https://developer.api.intuit.com/v3/oauth2/tokens/revoke",
      }),
    );

    expect(settings.discoveryUrl).toBe(
      "https://developer.api.intuit.com/.well-known/openid_sandbox_configuration",
    );
    const endpoints = await oauthEndpoints(settings);
    expect(endpoints).toEqual({
      authorizeUrl: "https://appcenter.intuit.com/connect/oauth2/v2",
      tokenUrl: "https://oauth.platform.intuit.com/oauth2/v2/tokens/bearer",
      revokeUrl: "https://developer.api.intuit.com/v3/oauth2/tokens/revoke",
    });
    await oauthEndpoints(settings);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("falls back to the known endpoints when unreachable or not Intuit's", async () => {
    const known = {
      authorizeUrl: settings.authorizeUrl,
      tokenUrl: settings.tokenUrl,
      revokeUrl: settings.revokeUrl,
    };
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("offline"));
    expect(await oauthEndpoints(settings)).toEqual(known);

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        authorization_endpoint: "https://evil.example/connect",
        token_endpoint: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
        revocation_endpoint: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
      }),
    );
    expect(await oauthEndpoints(settings)).toEqual(known);
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
      message: "Sent to QuickBooks: 3 customers.",
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
    // Intuit's reference for the refusal is kept with it, for Intuit's support.
    expect(summary.failing[0].error).toMatch(/\(Intuit reference fake-tid-\d+\)$/);

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

// ---------------------------------------------------------- the books too ---

async function addInvoice(
  clientId: string,
  data: {
    number: string;
    status?: string;
    issueDate?: Date;
    discountCents?: number;
    taxCents?: number;
    lines: { name: string; kind?: string; quantity: number; unitPriceCents: number; totalCents: number }[];
  },
) {
  const subtotal = data.lines.reduce((sum, line) => sum + line.totalCents, 0);
  const total = subtotal - (data.discountCents ?? 0) + (data.taxCents ?? 0);
  return prisma.invoice.create({
    data: {
      organizationId,
      number: data.number,
      status: data.status ?? "SENT",
      clientId,
      issueDate: data.issueDate ?? new Date(),
      sentAt: new Date(),
      subtotalCents: subtotal,
      discountCents: data.discountCents ?? 0,
      taxCents: data.taxCents ?? 0,
      totalCents: total,
      balanceCents: total,
      lineItems: {
        create: data.lines.map((line, i) => ({
          kind: line.kind ?? "SERVICE",
          name: line.name,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          totalCents: line.totalCents,
          sortOrder: i,
        })),
      },
    },
  });
}

async function addExpense(data: {
  description: string;
  category: string;
  amountCents: number;
  vendor?: string;
  method?: string;
  spentAt?: Date;
  reimbursable?: boolean;
}) {
  return prisma.expense.create({
    data: {
      organizationId,
      description: data.description,
      category: data.category,
      amountCents: data.amountCents,
      vendor: data.vendor ?? null,
      method: data.method ?? "CARD",
      spentAt: data.spentAt ?? new Date(),
      reimbursable: data.reimbursable ?? false,
    },
  });
}

/** Connected, with the books open from long ago, as a test wants them. */
async function connectedFromTheStart() {
  await connected();
  await setSendFrom(organizationId, "2000-01-01");
}

const invoiceLink = (invoiceId: string) =>
  prisma.accountingLink.findFirst({ where: { entityType: "INVOICE", entityId: invoiceId } });

type QboLine = { Amount: number; Description?: string; SalesItemLineDetail: Record<string, unknown> };

describe("sending invoices", () => {
  it("sends a sent invoice with its lines, and tax and discount as lines of their own", async () => {
    const jane = await addClient({ displayName: "Jane Doe", email: "jane@example.com" });
    await prisma.priceBookItem.create({
      data: { organizationId, kind: "SERVICE", name: "Lawn mowing", unit: "visit", unitPriceCents: 6_500 },
    });
    const invoice = await addInvoice(jane.id, {
      number: "INV-1001",
      discountCents: 1_000,
      taxCents: 2_000,
      lines: [
        { name: "Lawn Mowing", quantity: 2, unitPriceCents: 6_500, totalCents: 13_000 },
        { name: "Mulch", kind: "MATERIAL", quantity: 1.5, unitPriceCents: 8_500, totalCents: 12_750 },
        { name: "Pruning", kind: "LABOR", quantity: 1.333, unitPriceCents: 7_500, totalCents: 9_998 },
      ],
    });
    await addInvoice(jane.id, {
      number: "INV-1002",
      status: "DRAFT",
      lines: [{ name: "Draft", quantity: 1, unitPriceCents: 100, totalCents: 100 }],
    });
    await connectedFromTheStart();

    expect(await sendToQuickBooksNow(IDLE, new FormData())).toEqual({
      ok: true,
      message: "Sent to QuickBooks: 1 customer and 1 invoice.",
    });

    const sent = qb.invoices.get((await invoiceLink(invoice.id))!.externalId!)!;
    expect(sent).toMatchObject({ DocNumber: "INV-1001", TotalAmt: 367.48, BillEmail: { Address: "jane@example.com" } });
    expect(qb.invoices.size).toBe(1);

    const lines = sent.Line as QboLine[];
    const itemName = (line: QboLine) =>
      qb.items.get((line.SalesItemLineDetail.ItemRef as { value: string }).value)?.Name;
    expect(lines.map((line) => [itemName(line), line.Amount])).toEqual([
      ["Lawn mowing", 130],
      ["Materials", 127.5],
      ["Labor", 99.98],
      ["Discount", -10],
      ["Sales tax", 20],
    ]);
    // QuickBooks checks quantity × price, so 1.333 hours goes as its amount alone.
    expect(lines[0].SalesItemLineDetail).toMatchObject({ Qty: 2, UnitPrice: 65 });
    expect(lines[2].SalesItemLineDetail.Qty).toBeUndefined();
    // Non-taxable everywhere, so QuickBooks' own sales tax adds nothing on top.
    expect(
      lines.every((line) => (line.SalesItemLineDetail.TaxCodeRef as { value: string }).value === "NON"),
    ).toBe(true);
    expect([...qb.items.values()].find((item) => item.Name === "Materials")?.Type).toBe("NonInventory");
  });

  it("files lines under an item QuickBooks already has by that name", async () => {
    const services = qb.addItem({ Name: "Services", IncomeAccountRef: { value: "1" } });
    const jane = await addClient({ displayName: "Jane Doe" });
    const invoice = await addInvoice(jane.id, {
      number: "INV-1",
      lines: [{ name: "Visit", quantity: 1, unitPriceCents: 5_000, totalCents: 5_000 }],
    });
    await connectedFromTheStart();
    await sendToQuickBooksNow(IDLE, new FormData());

    const sent = qb.invoices.get((await invoiceLink(invoice.id))!.externalId!)!;
    expect(((sent.Line as QboLine[])[0].SalesItemLineDetail.ItemRef as { value: string }).value).toBe(services.Id);
    expect(qb.items.size).toBe(1);
  });

  it("updates an edited invoice, voids a cancelled one, and voids one deleted here", async () => {
    const jane = await addClient({ displayName: "Jane Doe" });
    const visit = (cents: number) => [{ name: "Visit", quantity: 1, unitPriceCents: cents, totalCents: cents }];
    const kept = await addInvoice(jane.id, { number: "INV-1", lines: visit(5_000) });
    const cancelled = await addInvoice(jane.id, { number: "INV-2", lines: visit(7_000) });
    const deleted = await addInvoice(jane.id, { number: "INV-3", lines: visit(9_000) });
    await connectedFromTheStart();
    await sendToQuickBooksNow(IDLE, new FormData());
    const keptId = (await invoiceLink(kept.id))!.externalId!;
    const cancelledId = (await invoiceLink(cancelled.id))!.externalId!;
    const deletedId = (await invoiceLink(deleted.id))!.externalId!;

    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.invoiceLineItem.updateMany({
      where: { invoiceId: kept.id },
      data: { unitPriceCents: 5_500, totalCents: 5_500 },
    });
    await prisma.invoice.update({
      where: { id: kept.id },
      data: { subtotalCents: 5_500, totalCents: 5_500, balanceCents: 5_500 },
    });
    await prisma.invoice.update({ where: { id: cancelled.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    await prisma.invoice.delete({ where: { id: deleted.id } });

    expect(await syncQuickBooks(organizationId)).toMatchObject({
      failed: 0,
      kinds: { invoices: { sent: 3, failed: 0 } },
    });
    expect(qb.invoices.get(keptId)).toMatchObject({ TotalAmt: 55, SyncToken: "1" });
    expect(qb.invoices.get(cancelledId)).toMatchObject({ TotalAmt: 0, PrivateNote: "Voided" });
    expect(await invoiceLink(cancelled.id)).toMatchObject({ remoteStatus: "VOIDED" });
    expect(qb.invoices.get(deletedId)).toMatchObject({ TotalAmt: 0, PrivateNote: "Voided" });
    expect(await invoiceLink(deleted.id)).toBeNull();
    expect(qb.invoices.size).toBe(3);

    // Nothing more to do the next time round.
    expect(await syncQuickBooks(organizationId)).toMatchObject({ sent: 0, failed: 0, remaining: 0 });
  });

  it("leaves invoices dated before the start date, until it is moved", async () => {
    const jane = await addClient({ displayName: "Jane Doe" });
    const old = await addInvoice(jane.id, {
      number: "INV-OLD",
      issueDate: new Date("2026-01-15T15:00:00Z"),
      lines: [{ name: "Visit", quantity: 1, unitPriceCents: 5_000, totalCents: 5_000 }],
    });
    await connected();
    await sendToQuickBooksNow(IDLE, new FormData());
    expect(await invoiceLink(old.id)).toBeNull();

    const form = new FormData();
    form.set("sendFrom", "2026-01-01");
    expect(await setQuickBooksStartDate(IDLE, form)).toEqual({ ok: true, message: "Start date saved." });
    for (const task of deferred.splice(0)) await task();
    expect(await invoiceLink(old.id)).toMatchObject({ remoteStatus: "ACTIVE", lastError: null });
  });
});

describe("sending payments", () => {
  it("applies each payment to its invoice in Undeposited Funds, and deletes one deleted here", async () => {
    const jane = await addClient({ displayName: "Jane Doe" });
    const invoice = await addInvoice(jane.id, {
      number: "INV-1",
      lines: [{ name: "Visit", quantity: 1, unitPriceCents: 10_000, totalCents: 10_000 }],
    });
    const first = await prisma.payment.create({
      data: { organizationId, invoiceId: invoice.id, clientId: jane.id, amountCents: 4_000, method: "CHECK", reference: "1042" },
    });
    await connectedFromTheStart();

    expect(await sendToQuickBooksNow(IDLE, new FormData())).toEqual({
      ok: true,
      message: "Sent to QuickBooks: 1 customer, 1 invoice and 1 payment.",
    });

    const invoiceId = (await invoiceLink(invoice.id))!.externalId!;
    const [payment] = [...qb.payments.values()];
    expect(payment).toMatchObject({
      TotalAmt: 40,
      PaymentRefNum: "1042",
      Line: [{ Amount: 40, LinkedTxn: [{ TxnId: invoiceId, TxnType: "Invoice" }] }],
    });
    expect(payment.DepositToAccountRef).toBeUndefined();
    expect(qb.invoices.get(invoiceId)?.Balance).toBe(60);

    // A second payment arrives, then the first is deleted here.
    await prisma.payment.create({ data: { organizationId, invoiceId: invoice.id, clientId: jane.id, amountCents: 6_000 } });
    await prisma.payment.delete({ where: { id: first.id } });
    await syncQuickBooks(organizationId);

    expect(qb.payments.size).toBe(1);
    expect([...qb.payments.values()][0].TotalAmt).toBe(60);
    expect(qb.invoices.get(invoiceId)?.Balance).toBe(40);
  });

  it("goes in the background with its invoice when recorded", async () => {
    const jane = await addClient({ displayName: "Jane Doe" });
    const invoice = await addInvoice(jane.id, {
      number: "INV-1",
      lines: [{ name: "Visit", quantity: 1, unitPriceCents: 10_000, totalCents: 10_000 }],
    });
    await connectedFromTheStart();
    await sendToQuickBooksNow(IDLE, new FormData());

    await prisma.payment.create({ data: { organizationId, invoiceId: invoice.id, clientId: jane.id, amountCents: 10_000 } });
    await sendToQuickBooksSoon(organizationId, { invoices: [invoice.id] });
    for (const task of deferred.splice(0)) await task();

    expect(qb.payments.size).toBe(1);
  });
});

describe("sending expenses", () => {
  const choose = async (choices: Record<string, string>) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(choices)) form.set(key, value);
    return saveQuickBooksExpenseAccounts(IDLE, form);
  };

  const purchaseOf = async (expenseId: string) => {
    const link = await prisma.accountingLink.findFirst({ where: { entityType: "EXPENSE", entityId: expenseId } });
    return qb.purchases.get(link!.externalId!)!;
  };

  it("waits for accounts, then sends each to the account chosen for its category, with its supplier", async () => {
    const fuel = await addExpense({ description: "Diesel", category: "FUEL", amountCents: 4_520, vendor: "Shell" });
    const parts = await addExpense({
      description: "Fittings",
      category: "MATERIALS",
      amountCents: 10_000,
      vendor: "Ferguson",
      method: "CHECK",
    });
    await addExpense({ description: "Stamps", category: "OFFICE", amountCents: 1_100 });
    await connectedFromTheStart();
    await sendToQuickBooksNow(IDLE, new FormData());
    expect(qb.purchases.size).toBe(0);

    const connection = (await loadConnection(organizationId))!;
    expect((await syncSummary(connection, "UTC")).expensesWithoutAccount).toEqual(
      new Map([
        ["FUEL", 1],
        ["MATERIALS", 1],
        ["OFFICE", 1],
      ]),
    );

    // An account that is not the company's — a tampered form — is refused.
    expect(
      await choose({ "category:FUEL": "3", "category:MATERIALS": "4", "category:OFFICE": "999", paidFrom: "6" }),
    ).toEqual({ ok: true, message: "Expense accounts saved." });
    expect((await quickbooksStatus(organizationId))?.expenseAccounts).toEqual({ FUEL: "3", MATERIALS: "4" });
    for (const task of deferred.splice(0)) await task();

    expect(qb.purchases.size).toBe(2);
    expect(await purchaseOf(fuel.id)).toMatchObject({
      PaymentType: "Cash",
      AccountRef: { value: "6" },
      Line: [{ Amount: 45.2, AccountBasedExpenseLineDetail: { AccountRef: { value: "3" } } }],
    });
    expect(await purchaseOf(parts.id)).toMatchObject({ PaymentType: "Check" });
    expect([...qb.vendors.values()].map((v) => v.DisplayName).sort()).toEqual(["Ferguson", "Shell"]);
  });

  it("pays from a card account as card purchases, and names a supplier QuickBooks will not take in the memo", async () => {
    const shared = await addClient({ displayName: "Acme Supply" });
    await addExpense({ description: "Bolts", category: "MATERIALS", amountCents: 2_500, vendor: "Acme Supply" });
    await connectedFromTheStart();
    await sendToQuickBooksNow(IDLE, new FormData());
    expect(await linkOf(shared.id)).toMatchObject({ lastError: null });

    await choose({ "category:MATERIALS": "4", paidFrom: "7" });
    await syncQuickBooks(organizationId);

    const [purchase] = [...qb.purchases.values()];
    expect(purchase).toMatchObject({
      PaymentType: "CreditCard",
      AccountRef: { value: "7" },
      PrivateNote: "Bolts · Supplier: Acme Supply",
    });
    expect(purchase.EntityRef).toBeUndefined();
  });

  it("sends a teammate's expense once paid back, takes it out if that is undone, and deletes one deleted here", async () => {
    const owed = await addExpense({ description: "Gloves", category: "MATERIALS", amountCents: 1_800, reimbursable: true });
    await connectedFromTheStart();
    await choose({ "category:MATERIALS": "4", paidFrom: "6" });
    await sendToQuickBooksNow(IDLE, new FormData());
    expect(qb.purchases.size).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.expense.update({ where: { id: owed.id }, data: { reimbursedAt: new Date() } });
    await syncQuickBooks(organizationId);
    expect(qb.purchases.size).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await prisma.expense.update({ where: { id: owed.id }, data: { reimbursedAt: null } });
    await syncQuickBooks(organizationId);
    expect(qb.purchases.size).toBe(0);

    const gone = await addExpense({ description: "Tape", category: "MATERIALS", amountCents: 600 });
    await syncQuickBooks(organizationId);
    expect(qb.purchases.size).toBe(1);
    await prisma.expense.delete({ where: { id: gone.id } });
    await syncQuickBooks(organizationId);
    expect(qb.purchases.size).toBe(0);
  });
});
