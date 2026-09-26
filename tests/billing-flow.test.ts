import { randomUUID } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Paying for Matlock One, end to end: the lock, the plan choice, PayPal's
 * answer, the webhook, the return page.
 *
 * Driven through the real requireContext, a real session and the real pages,
 * actions and route, against the test database. Two things are stood in for:
 * the request (its cookie and headers), and PayPal itself, as a fetch that
 * answers the way PayPal's documented API does. What a subscription is worth
 * is always asked of that stand-in, never read from anything the test hands
 * the code directly — which is exactly how the real thing is meant to work.
 */

const request = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: {} as Record<string, string>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined,
    set: (name: string, value: string) => {
      request.cookies.set(name, value);
    },
    delete: (name: string) => {
      request.cookies.delete(name);
    },
  }),
  headers: async () => new Headers(request.headers),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { NextRequest } from "next/server";

import { choosePlan } from "@/app/(billing)/billing/actions";
import BillingPage from "@/app/(billing)/billing/page";
import BillingReturnPage from "@/app/(billing)/billing/return/page";
import { POST as webhook } from "@/app/api/checkout/paypal/webhook/route";
import { POST as uploadTicket } from "@/app/api/files/upload-ticket/route";
import { requireContext, requirePermission } from "@/lib/auth";
import { paidThroughFor, syncSubscription } from "@/lib/billing/subscription";
import { forgetAccessToken, type SubscriptionDetails } from "@/lib/checkout/paypal";
import { prisma } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/session";

// ------------------------------------------------------------ fake PayPal ---

const PLAN_IDS = {
  PAYPAL_PLAN_STARTER_MONTHLY: "P-STARTER-M",
  PAYPAL_PLAN_STARTER_ANNUAL: "P-STARTER-A",
  PAYPAL_PLAN_BUSINESS_MONTHLY: "P-BUSINESS-M",
  PAYPAL_PLAN_BUSINESS_ANNUAL: "P-BUSINESS-A",
  PAYPAL_PLAN_PRO_MONTHLY: "P-PRO-M",
  PAYPAL_PLAN_PRO_ANNUAL: "P-PRO-A",
};

type Sent = { method: string; path: string; body: Record<string, unknown> | undefined };

let subscriptions: Map<string, Record<string, unknown>>;
let sent: Sent[];
let paypalDown: boolean;
let signatureValid: boolean;

function fakePayPal(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  let body: Record<string, unknown> | undefined;
  try {
    body = init.body ? JSON.parse(String(init.body)) : undefined;
  } catch {
    body = undefined;
  }
  sent.push({ method, path: url.pathname, body });

  const json = (status: number, value: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(value), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );

  if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "T", expires_in: 32_400 });
  if (paypalDown) return json(503, { name: "SERVICE_UNAVAILABLE" });

  if (url.pathname === "/v1/notifications/verify-webhook-signature") {
    return json(200, { verification_status: signatureValid ? "SUCCESS" : "FAILURE" });
  }

  if (url.pathname === "/v1/billing/subscriptions" && method === "POST") {
    return json(201, {
      id: "I-STARTED",
      status: "APPROVAL_PENDING",
      links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1" }],
    });
  }

  const revise = url.pathname.match(/^\/v1\/billing\/subscriptions\/([^/]+)\/revise$/);
  if (revise && method === "POST") {
    return json(200, {
      plan_id: body?.plan_id,
      links: [{ rel: "approve", href: "https://www.sandbox.paypal.com/webapps/billing/revise?ba_token=BA-2" }],
    });
  }

  const one = url.pathname.match(/^\/v1\/billing\/subscriptions\/([^/]+)$/);
  if (one && method === "GET") {
    const found = subscriptions.get(decodeURIComponent(one[1]));
    return found ? json(200, found) : json(404, { name: "RESOURCE_NOT_FOUND" });
  }

  return json(404, { name: "NOT_FOUND" });
}

/** A subscription as PayPal would describe it. */
function paypalHas(
  id: string,
  fields: {
    status?: string;
    plan?: string;
    customId?: string | null;
    nextBilling?: Date | null;
    lastPayment?: Date | null;
  } = {},
) {
  subscriptions.set(id, {
    id,
    plan_id: fields.plan ?? "P-BUSINESS-M",
    status: fields.status ?? "ACTIVE",
    ...(fields.customId === null ? {} : { custom_id: fields.customId }),
    subscriber: { email_address: "owner@example.test" },
    billing_info: {
      ...(fields.nextBilling === null
        ? {}
        : { next_billing_time: (fields.nextBilling ?? inDays(30)).toISOString() }),
      ...(fields.lastPayment ? { last_payment: { time: fields.lastPayment.toISOString() } } : {}),
    },
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(Date.now() + n * DAY_MS);

// ------------------------------------------------------------ businesses ---

type Business = { orgId: string; owner: string; employee: string };

async function business(fields: Record<string, unknown> = {}): Promise<Business> {
  const org = await prisma.organization.create({
    data: { slug: `billing-${randomUUID()}`, name: "Harbor Glass Co", ...fields },
  });

  const person = async (role: "OWNER" | "EMPLOYEE", name: string) => {
    const user = await prisma.user.create({
      data: {
        organizationId: org.id,
        email: `${role.toLowerCase()}-${randomUUID()}@example.test`,
        name,
        passwordHash: "x",
        role,
      },
    });
    await createSession(user.id);
    return request.cookies.get(SESSION_COOKIE)!;
  };

  return {
    orgId: org.id,
    owner: await person("OWNER", "Priya Nandakumar"),
    employee: await person("EMPLOYEE", "Tomas Reyes"),
  };
}

const PAYING = {
  subscriptionId: null,
  subscriptionPlan: "business",
  subscriptionStatus: "ACTIVE",
  subscriptionInterval: "monthly",
};

const signInAs = (session: string) => request.cookies.set(SESSION_COOKIE, session);
const orgOf = (b: Business) => prisma.organization.findUniqueOrThrow({ where: { id: b.orgId } });

const form = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
};

beforeEach(() => {
  vi.stubEnv("SESSION_SECRET", "s".repeat(32));
  // The test database is SQLite, which with local files is how a desktop
  // install looks. The hosted product is what is under test here; the desktop
  // install gets a test of its own below.
  vi.stubEnv("STORAGE_PROVIDER", "s3");
  vi.stubEnv("APP_URL", "https://www.matlockone.com");
  vi.stubEnv("PAYPAL_CLIENT_ID", "client");
  vi.stubEnv("PAYPAL_CLIENT_SECRET", "secret");
  vi.stubEnv("PAYPAL_WEBHOOK_ID", "WH-1");
  vi.stubEnv("PAYPAL_ENV", "sandbox");
  for (const [name, value] of Object.entries(PLAN_IDS)) vi.stubEnv(name, value);

  subscriptions = new Map();
  sent = [];
  paypalDown = false;
  signatureValid = true;
  forgetAccessToken();
  vi.stubGlobal("fetch", vi.fn(fakePayPal));

  request.cookies.clear();
  request.headers = {};
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ lock ---

describe("the lock", () => {
  it("sends a business that has never paid to billing, from any page", async () => {
    const b = await business();
    signInAs(b.owner);

    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT /billing");
    await expect(requirePermission("clients:read")).rejects.toThrow("NEXT_REDIRECT /billing");
  });

  it("sends a business whose plan ran out past its grace days", async () => {
    const b = await business({ ...PAYING, paidThrough: inDays(-10) });
    signInAs(b.owner);

    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT /billing");
  });

  it("lets the billing screen itself open, or the lock would lock itself", async () => {
    const b = await business();
    signInAs(b.owner);

    const ctx = await requireContext({ unpaid: "allow" });
    expect(ctx.org.id).toBe(b.orgId);
  });

  it("opens every page to a business that has paid", async () => {
    const b = await business({ ...PAYING, paidThrough: inDays(12) });
    signInAs(b.employee);

    expect((await requireContext()).org.id).toBe(b.orgId);
  });

  it("never locks an exempt business", async () => {
    const b = await business({ billingExempt: true });
    signInAs(b.owner);

    expect((await requireContext()).org.id).toBe(b.orgId);
  });

  it("refuses an upload from a business with no plan", async () => {
    // A route rather than a page, so requireContext never sees it.
    const b = await business();
    signInAs(b.owner);
    const client = await prisma.client.create({
      data: { organizationId: b.orgId, displayName: "Ines Carvalho", type: "PERSON" },
    });

    const response = await uploadTicket(
      new NextRequest("https://www.matlockone.com/api/files/upload-ticket", {
        method: "POST",
        body: JSON.stringify({
          entityType: "client",
          entityId: client.id,
          fileName: "site.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 1024,
        }),
      }),
    );

    expect(response.status).toBe(402);
    expect((await response.json()).error).toMatch(/active plan/);
  });
});

// ------------------------------------------------------- the billing page ---

describe("the billing page", () => {
  const page = async (params: Record<string, string> = {}) =>
    renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve(params) }));

  it("shows a new owner every plan to choose from", async () => {
    const b = await business();
    signInAs(b.owner);

    const html = await page({ welcome: "1" });

    expect(html).toContain("Choose a plan to start");
    for (const name of ["Starter", "Business", "Pro"]) expect(html).toContain(name);
    expect(html).toContain("Monthly");
    expect(html).toContain("Yearly");
  });

  it("tells a lapsed business its records are still there", async () => {
    const b = await business({ ...PAYING, paidThrough: inDays(-30) });
    signInAs(b.owner);

    const html = await page();

    expect(html).toContain("Harbor Glass Co’s plan has ended");
    expect(html).toContain("Nothing has been deleted");
  });

  it("sends someone who cannot pay to the owner, by name", async () => {
    const b = await business();
    signInAs(b.employee);

    const html = await page();

    expect(html).toContain("Ask Priya Nandakumar to choose one");
    expect(html).not.toContain("Monthly");
  });

  it("shows fixed words for an error, whatever the address says", async () => {
    const b = await business();
    signInAs(b.owner);

    const html = await page({ error: "<b>Your account is suspended, call 555-0100</b>" });

    expect(html).not.toContain("555-0100");
    expect(html).toContain("PayPal didn’t accept that just now");
  });

  it("says plainly when this site cannot take payments", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const b = await business();
    signInAs(b.owner);

    const html = await page();

    expect(html).toContain("Payments aren’t set up on this site yet.");
    expect(html).not.toContain("Monthly");
  });

  it("shows a paying business its plan and when it renews", async () => {
    const b = await business({ ...PAYING, subscriptionId: "I-PAGE", paidThrough: inDays(12) });
    signInAs(b.owner);

    const html = await page();

    expect(html).toContain("Business plan");
    expect(html).toContain("Renews automatically");
    expect(html).toContain("Current plan");
    expect(html).toContain("https://www.sandbox.paypal.com/myaccount/autopay/");
  });

  it("asks a locked desktop install for its licence key instead", async () => {
    // PayPal cannot reach a computer on an office network, so a desktop
    // install that keeps its own data pays by key.
    vi.stubEnv("STORAGE_PROVIDER", "local");
    const b = await business();
    signInAs(b.owner);

    const html = await page();

    expect(html).toContain("Enter your licence key");
    expect(html).not.toContain("Monthly");
  });

  it("is never shown to the demo", async () => {
    const b = await business({ isDemo: true });
    signInAs(b.owner);

    await expect(page()).rejects.toThrow("NEXT_REDIRECT /dashboard");
  });
});

// ------------------------------------------------------- choosing a plan ---

describe("choosing a plan", () => {
  beforeEach(() => {
    request.headers = { "next-action": "a1b2c3" };
  });

  it("starts a subscription for this business and sends the owner to approve it", async () => {
    const b = await business();
    signInAs(b.owner);

    await expect(choosePlan(form({ plan: "business", interval: "annual" }))).rejects.toThrow(
      "NEXT_REDIRECT https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=BA-1",
    );

    const started = sent.find((r) => r.path === "/v1/billing/subscriptions");
    expect(started?.body).toMatchObject({
      plan_id: "P-BUSINESS-A",
      // How the payment finds this business again, without a licence key.
      custom_id: b.orgId,
      application_context: {
        return_url: "https://www.matlockone.com/billing/return",
        cancel_url: "https://www.matlockone.com/billing?cancelled=1",
      },
    });
  });

  it("changes an active subscription rather than starting a second one", async () => {
    const b = await business({ ...PAYING, subscriptionId: "I-PAYING", paidThrough: inDays(12) });
    signInAs(b.owner);

    await expect(choosePlan(form({ plan: "pro", interval: "monthly" }))).rejects.toThrow(
      "NEXT_REDIRECT https://www.sandbox.paypal.com/webapps/billing/revise?ba_token=BA-2",
    );

    expect(sent.some((r) => r.path === "/v1/billing/subscriptions")).toBe(false);
    const revised = sent.find((r) => r.path === "/v1/billing/subscriptions/I-PAYING/revise");
    expect(revised?.body).toMatchObject({
      plan_id: "P-PRO-M",
      application_context: {
        return_url: "https://www.matlockone.com/billing/return?subscription_id=I-PAYING",
      },
    });
  });

  it("starts afresh for a business whose old subscription was cancelled", async () => {
    const b = await business({
      ...PAYING,
      subscriptionId: "I-OLD",
      subscriptionStatus: "CANCELLED",
      paidThrough: inDays(-20),
    });
    signInAs(b.owner);

    await expect(choosePlan(form({ plan: "starter", interval: "monthly" }))).rejects.toThrow(
      "ba_token=BA-1",
    );
    expect(sent.some((r) => r.path.endsWith("/revise"))).toBe(false);
  });

  it("refuses a plan that is not one of ours, before PayPal hears of it", async () => {
    const b = await business();
    signInAs(b.owner);

    await expect(choosePlan(form({ plan: "enterprise", interval: "monthly" }))).rejects.toThrow(
      "NEXT_REDIRECT /billing?error=plan",
    );
    await expect(choosePlan(form({ plan: "pro", interval: "weekly" }))).rejects.toThrow(
      "NEXT_REDIRECT /billing?error=plan",
    );
    expect(sent.filter((r) => r.path.startsWith("/v1/billing"))).toEqual([]);
  });

  it("comes back with a code when PayPal will not start it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    paypalDown = true;
    const b = await business();
    signInAs(b.owner);

    await expect(choosePlan(form({ plan: "business", interval: "monthly" }))).rejects.toThrow(
      "NEXT_REDIRECT /billing?error=paypal",
    );
  });

  it("is not for someone who cannot commit the business to a charge", async () => {
    const b = await business();
    signInAs(b.employee);

    await expect(choosePlan(form({ plan: "business", interval: "monthly" }))).rejects.toThrow(
      "NEXT_REDIRECT /no-access",
    );
    expect(sent).toEqual([]);
  });
});

// --------------------------------------------------- keeping step with PayPal ---

describe("syncSubscription", () => {
  it("opens the business the subscription was started for", async () => {
    const b = await business();
    const renews = inDays(30);
    paypalHas("I-NEW", { customId: b.orgId, nextBilling: renews });

    const synced = await syncSubscription("I-NEW");

    expect(synced).toMatchObject({ linked: true, organizationId: b.orgId, status: "ACTIVE" });
    expect(await orgOf(b)).toMatchObject({
      subscriptionId: "I-NEW",
      subscriptionStatus: "ACTIVE",
      subscriptionPlan: "business",
      subscriptionInterval: "monthly",
      paidThrough: renews,
    });
  });

  it("keeps a cancelled plan's paid-for days, and adds none", async () => {
    const until = inDays(9);
    const b = await business({ ...PAYING, subscriptionId: "I-CANCEL", paidThrough: until });
    paypalHas("I-CANCEL", { customId: b.orgId, status: "CANCELLED", nextBilling: null });

    await syncSubscription("I-CANCEL");

    expect(await orgOf(b)).toMatchObject({ subscriptionStatus: "CANCELLED", paidThrough: until });
  });

  it("does not let news of an old subscription close the one that replaced it", async () => {
    const until = inDays(25);
    const b = await business({ ...PAYING, subscriptionId: "I-CURRENT", paidThrough: until });
    paypalHas("I-OLD", { customId: b.orgId, status: "CANCELLED" });

    await syncSubscription("I-OLD");

    expect(await orgOf(b)).toMatchObject({
      subscriptionId: "I-CURRENT",
      subscriptionStatus: "ACTIVE",
      paidThrough: until,
    });
  });

  it("finds a renewal by the subscription the business holds", async () => {
    const b = await business({ ...PAYING, subscriptionId: "I-HELD", paidThrough: inDays(1) });
    const renews = inDays(31);
    paypalHas("I-HELD", { customId: null, nextBilling: renews });

    await syncSubscription("I-HELD");

    expect((await orgOf(b)).paidThrough).toEqual(renews);
  });

  it("will not let one business claim another's subscription", async () => {
    const payer = await business();
    const other = await business();
    paypalHas("I-THEIRS", { customId: payer.orgId });

    const synced = await syncSubscription("I-THEIRS", { expectOrganizationId: other.orgId });

    expect(synced).toEqual({ linked: false, reason: "not-ours" });
    expect((await orgOf(other)).subscriptionId).toBeNull();
    expect((await orgOf(payer)).subscriptionId).toBeNull();
  });

  it("leaves the anonymous licence purchase to the licence path", async () => {
    paypalHas("I-ANON", { customId: null });

    expect(await syncSubscription("I-ANON")).toEqual({ linked: false, reason: "not-ours" });
  });

  it("refuses a plan this deployment does not sell", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = await business();
    paypalHas("I-ODD", { customId: b.orgId, plan: "P-SOMEONE-ELSES" });

    expect(await syncSubscription("I-ODD")).toEqual({ linked: false, reason: "unknown-plan" });
    expect((await orgOf(b)).paidThrough).toBeNull();
  });

  it("says so when PayPal cannot be asked", async () => {
    paypalDown = true;

    expect(await syncSubscription("I-ANY")).toEqual({ linked: false, reason: "unreachable" });
  });
});

describe("paidThroughFor", () => {
  const details = (fields: Partial<SubscriptionDetails>): SubscriptionDetails => ({
    id: "I-1",
    planId: "P-BUSINESS-M",
    email: null,
    status: "ACTIVE",
    customId: null,
    nextBillingTime: null,
    lastPaymentTime: null,
    ...fields,
  });
  const current = new Date("2026-10-01T00:00:00Z");

  it("takes PayPal's next charge as the end of what was paid for", () => {
    const next = new Date("2026-10-27T10:00:00Z");
    expect(paidThroughFor(details({ nextBillingTime: next }), "monthly", current)).toEqual(next);
  });

  it("counts a period from the last payment when PayPal gives no next charge", () => {
    const paid = new Date("2026-09-27T10:00:00Z");
    expect(paidThroughFor(details({ lastPaymentTime: paid }), "monthly", null)).toEqual(
      new Date("2026-10-27T10:00:00Z"),
    );
    expect(paidThroughFor(details({ lastPaymentTime: paid }), "annual", null)).toEqual(
      new Date("2027-09-27T10:00:00Z"),
    );
  });

  it("moves nothing for a subscription that is not active", () => {
    for (const status of ["APPROVAL_PENDING", "APPROVED", "SUSPENDED", "CANCELLED", "EXPIRED"]) {
      const next = new Date("2027-01-01T00:00:00Z");
      expect(paidThroughFor(details({ status, nextBillingTime: next }), "monthly", current)).toBe(
        current,
      );
    }
  });
});

// --------------------------------------------------------------- webhook ---

describe("the webhook", () => {
  const deliver = (event: unknown) =>
    webhook(
      new Request("https://www.matlockone.com/api/checkout/paypal/webhook", {
        method: "POST",
        headers: {
          "paypal-transmission-id": "tx-1",
          "paypal-transmission-time": new Date().toISOString(),
          "paypal-transmission-sig": "sig",
          "paypal-cert-url": "https://api.paypal.com/v1/notifications/certs/CERT-1",
          "paypal-auth-algo": "SHA256withRSA",
        },
        body: JSON.stringify(event),
      }),
    );

  it("opens the business when its subscription activates", async () => {
    const b = await business();
    paypalHas("I-HOOK", { customId: b.orgId });

    const response = await deliver({
      event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
      resource: { id: "I-HOOK", status: "ACTIVE" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, organization: b.orgId });
    expect((await orgOf(b)).subscriptionStatus).toBe("ACTIVE");
  });

  it("extends the business on each renewal payment", async () => {
    const b = await business({ ...PAYING, subscriptionId: "I-RENEW", paidThrough: inDays(0) });
    const renews = inDays(30);
    paypalHas("I-RENEW", { customId: b.orgId, nextBilling: renews });

    const response = await deliver({
      event_type: "PAYMENT.SALE.COMPLETED",
      resource: { id: "SALE-1", billing_agreement_id: "I-RENEW", amount: { total: "59.00", currency: "USD" } },
    });

    expect(response.status).toBe(200);
    expect((await orgOf(b)).paidThrough).toEqual(renews);
  });

  it("trusts PayPal's record over what the event claims", async () => {
    // The event says ACTIVE; PayPal, asked, says suspended. Suspended wins,
    // so the paid-through date does not move.
    const until = inDays(2);
    const b = await business({ ...PAYING, subscriptionId: "I-LIE", paidThrough: until });
    paypalHas("I-LIE", { customId: b.orgId, status: "SUSPENDED", nextBilling: inDays(400) });

    await deliver({ event_type: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: "I-LIE", status: "ACTIVE" } });

    expect(await orgOf(b)).toMatchObject({ subscriptionStatus: "SUSPENDED", paidThrough: until });
  });

  it("asks PayPal to try again while PayPal cannot be asked", async () => {
    const b = await business();
    paypalHas("I-LATER", { customId: b.orgId });
    // Verified, then down for the lookup.
    const real = fakePayPal;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        String(input).includes("/v1/billing/subscriptions/")
          ? Promise.resolve(new Response("{}", { status: 503 }))
          : real(input, init),
      ),
    );

    const response = await deliver({
      event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
      resource: { id: "I-LATER" },
    });

    expect(response.status).toBe(503);
    expect((await orgOf(b)).subscriptionId).toBeNull();
  });

  it("reads nothing from a delivery PayPal did not sign", async () => {
    signatureValid = false;
    const b = await business();
    paypalHas("I-FORGED", { customId: b.orgId });

    const response = await deliver({
      event_type: "BILLING.SUBSCRIPTION.ACTIVATED",
      resource: { id: "I-FORGED" },
    });

    expect(response.status).toBe(401);
    expect((await orgOf(b)).subscriptionId).toBeNull();
  });
});

// ---------------------------------------------------------- the return page ---

describe("coming back from PayPal", () => {
  const back = (params: Record<string, string>) =>
    BillingReturnPage({ searchParams: Promise.resolve(params) });

  it("opens the account as soon as PayPal says the plan is active", async () => {
    const b = await business();
    signInAs(b.owner);
    paypalHas("I-BACK", { customId: b.orgId });

    await expect(back({ subscription_id: "I-BACK" })).rejects.toThrow(
      "NEXT_REDIRECT /dashboard?welcome=1",
    );
    expect((await orgOf(b)).subscriptionId).toBe("I-BACK");
  });

  it("waits, and checks again, while PayPal is still starting it", async () => {
    const b = await business();
    signInAs(b.owner);
    paypalHas("I-SLOW", { customId: b.orgId, status: "APPROVED", nextBilling: null });

    const html = renderToStaticMarkup(await back({ subscription_id: "I-SLOW", try: "2" }));

    expect(html).toContain("Finishing up with PayPal");
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("subscription_id=I-SLOW&amp;try=3");
  });

  it("stops checking after a while, and says the account opens by itself", async () => {
    const b = await business();
    signInAs(b.owner);
    paypalHas("I-SLOWER", { customId: b.orgId, status: "APPROVED", nextBilling: null });

    const html = renderToStaticMarkup(await back({ subscription_id: "I-SLOWER", try: "20" }));

    expect(html).toContain("PayPal is taking a while");
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it("opens nothing for a subscription some other business started", async () => {
    const payer = await business();
    const other = await business();
    signInAs(other.owner);
    paypalHas("I-STOLEN", { customId: payer.orgId });

    const html = renderToStaticMarkup(await back({ subscription_id: "I-STOLEN" }));

    expect(html).toContain("We couldn’t confirm that plan");
    expect((await orgOf(other)).subscriptionId).toBeNull();
    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT /billing");
  });
});
