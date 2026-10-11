import { generateKeyPairSync, randomUUID } from "node:crypto";

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

import { createTrialCode, setTrialCodeOn } from "@/app/(app)/accounts/actions";
import { activateLicense } from "@/app/(app)/settings/license/actions";
import { signupAction } from "@/app/(auth)/actions";
import {
  cancelPlan,
  choosePlan,
  enterTrialCode,
  removeTrialCode,
} from "@/app/(billing)/billing/actions";
import BillingPage from "@/app/(billing)/billing/page";
import BillingReturnPage from "@/app/(billing)/billing/return/page";
import { POST as webhook } from "@/app/api/checkout/paypal/webhook/route";
import { POST as uploadTicket } from "@/app/api/files/upload-ticket/route";
import { BillingBanner } from "@/components/app-shell/billing-banner";
import { requireContext, requirePermission } from "@/lib/auth";
import { paidThroughFor, restartDate, syncSubscription } from "@/lib/billing/subscription";
import { IDLE } from "@/lib/action-state";
import { forgetAccessToken, type SubscriptionDetails } from "@/lib/checkout/paypal";
import { prisma } from "@/lib/db";
import { issueLicense } from "@/lib/license/token";
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

  const cancel = url.pathname.match(/^\/v1\/billing\/subscriptions\/([^/]+)\/cancel$/);
  if (cancel && method === "POST") {
    const found = subscriptions.get(decodeURIComponent(cancel[1]));
    if (!found) return json(404, { name: "RESOURCE_NOT_FOUND" });
    if (found.status === "CANCELLED" || found.status === "EXPIRED") {
      return json(422, {
        name: "UNPROCESSABLE_ENTITY",
        details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }],
      });
    }
    found.status = "CANCELLED";
    return Promise.resolve(new Response(null, { status: 204 }));
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

// ---------------------------------------------- a licence key instead ---

describe("a licence key instead of a plan", () => {
  // The test signs its own keys, as the licence suites do, rather than
  // depending on the signing key that is deliberately not in the repo.
  const keys = generateKeyPairSync("ed25519");
  const stranger = generateKeyPairSync("ed25519");

  const licence = (signer = keys.privateKey) => {
    const now = Math.floor(Date.now() / 1000);
    return issueLicense(
      {
        id: `lic_${randomUUID()}`,
        sub: "owner@example.test",
        plan: "business",
        mode: "paid",
        seats: 10,
        iat: now - 60,
        exp: now + 30 * 86_400,
      },
      signer,
    );
  };

  const page = async () =>
    renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }));

  beforeEach(() => {
    vi.stubEnv(
      "LICENSE_PUBLIC_KEY",
      keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
    );
  });

  it("offers an owner a place to enter one, beside the plans", async () => {
    const b = await business();
    signInAs(b.owner);

    const html = await page();

    expect(html).toContain("Already have a licence key?");
    expect(html).toContain("Enter your licence key");
    expect(html).toContain("Monthly");
  });

  it("offers it where this site cannot take payments, since a key needs no PayPal", async () => {
    vi.stubEnv("PAYPAL_WEBHOOK_ID", "");
    const b = await business();
    signInAs(b.owner);

    const html = await page();

    expect(html).toContain("Payments aren’t set up on this site yet.");
    expect(html).toContain("Enter your licence key");
  });

  it("offers nobody the form who cannot commit the business, and says a key would do", async () => {
    const b = await business();
    signInAs(b.employee);

    const html = await page();

    expect(html).not.toContain("Enter your licence key");
    expect(html).toContain("or enter a licence key");
  });

  it("opens the business once a valid key is entered", async () => {
    const b = await business();
    signInAs(b.owner);

    const result = await activateLicense(IDLE, form({ licenseKey: licence() }));

    expect(result.ok).toBe(true);
    expect((await requireContext()).org.id).toBe(b.orgId);

    const html = await page();
    expect(html).toContain("Harbor Glass Co runs on a licence key.");
    expect(html).toContain("Replace your licence key");
  });

  it("refuses a key this app did not sign, and stays closed", async () => {
    const b = await business();
    signInAs(b.owner);

    const result = await activateLicense(IDLE, form({ licenseKey: licence(stranger.privateKey) }));

    expect(result.ok).toBe(false);
    expect((await orgOf(b)).licenseKey).toBeNull();
    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT /billing");
  });

  it("will not open a second business with a key another already holds", async () => {
    const key = licence();
    const first = await business();
    signInAs(first.owner);
    expect((await activateLicense(IDLE, form({ licenseKey: key }))).ok).toBe(true);

    const second = await business();
    signInAs(second.owner);
    const result = await activateLicense(IDLE, form({ licenseKey: key }));

    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.licenseKey).toBe(
      "This licence key is already in use by another business.",
    );
    expect((await orgOf(second)).licenseKey).toBeNull();
    await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT /billing");
  });

  it("lets the business that holds a key enter it again", async () => {
    const key = licence();
    const b = await business();
    signInAs(b.owner);

    expect((await activateLicense(IDLE, form({ licenseKey: key }))).ok).toBe(true);
    expect((await activateLicense(IDLE, form({ licenseKey: key }))).ok).toBe(true);
  });

  it("is not for someone who cannot commit the business", async () => {
    const b = await business();
    signInAs(b.employee);

    await expect(activateLicense(IDLE, form({ licenseKey: licence() }))).rejects.toThrow();
    expect((await orgOf(b)).licenseKey).toBeNull();
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
    // Nothing left paid for, so the first payment is now.
    const started = sent.find((r) => r.path === "/v1/billing/subscriptions");
    expect(started?.body).not.toHaveProperty("start_time");
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

// ------------------------------------------------------ launch-week offer ---

describe("the launch-week offer", () => {
  const LAUNCH_IDS = {
    PAYPAL_PLAN_STARTER_MONTHLY_LAUNCH: "P-STARTER-M-LAUNCH",
    PAYPAL_PLAN_BUSINESS_MONTHLY_LAUNCH: "P-BUSINESS-M-LAUNCH",
    PAYPAL_PLAN_PRO_MONTHLY_LAUNCH: "P-PRO-M-LAUNCH",
  };
  const BEFORE = new Date("2026-09-29T15:00:00Z");
  const DURING = new Date("2026-10-07T15:00:00Z");
  const AFTER = new Date("2026-10-20T15:00:00Z");

  const page = async () =>
    renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }));
  const choose = (plan: string, interval: string) => {
    request.headers = { "next-action": "a1b2c3" };
    return choosePlan(form({ plan, interval }));
  };
  const startedOn = () =>
    sent.find((r) => r.path === "/v1/billing/subscriptions")?.body?.plan_id;

  beforeEach(() => {
    for (const [name, value] of Object.entries(LAUNCH_IDS)) vi.stubEnv(name, value);
    // Only the clock: Prisma and the fake PayPal still need real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts a business that signs up that week on the half-price first month", async () => {
    vi.setSystemTime(DURING);
    const b = await business({ createdAt: DURING });
    signInAs(b.owner);

    await expect(choose("starter", "monthly")).rejects.toThrow("ba_token=BA-1");

    expect(startedOn()).toBe("P-STARTER-M-LAUNCH");
  });

  it("shows the first month's price beside each monthly plan", async () => {
    vi.setSystemTime(DURING);
    const b = await business({ createdAt: DURING });
    signInAs(b.owner);

    const html = await page();

    expect(html).toContain("Launch week:");
    expect(html).toContain("$14.50 for your first month");
    expect(html).toContain("$29.50 for your first month");
    expect(html).toContain("$49.50 for your first month");
    expect(html).toContain("for the first month only");
  });

  it("charges a yearly plan its own price, which has a discount of its own", async () => {
    vi.setSystemTime(DURING);
    const b = await business({ createdAt: DURING });
    signInAs(b.owner);

    await expect(choose("business", "annual")).rejects.toThrow("ba_token=BA-1");

    expect(startedOn()).toBe("P-BUSINESS-A");
  });

  it("keeps the offer for a business that signed up in the week and pays after it", async () => {
    vi.setSystemTime(DURING);
    const b = await business({ createdAt: DURING });
    vi.setSystemTime(AFTER);
    signInAs(b.owner);

    await expect(choose("pro", "monthly")).rejects.toThrow("ba_token=BA-1");

    expect(startedOn()).toBe("P-PRO-M-LAUNCH");
  });

  it("charges the full price to a business that neither signed up nor chose in the week", async () => {
    vi.setSystemTime(BEFORE);
    const b = await business({ createdAt: BEFORE });
    vi.setSystemTime(AFTER);
    signInAs(b.owner);

    expect(await page()).not.toContain("for your first month");
    await expect(choose("starter", "monthly")).rejects.toThrow("ba_token=BA-1");
    expect(startedOn()).toBe("P-STARTER-M");
  });

  it("is a business's first plan only, not a way back after cancelling", async () => {
    vi.setSystemTime(DURING);
    const b = await business({
      ...PAYING,
      createdAt: DURING,
      subscriptionId: "I-FIRST",
      subscriptionStatus: "CANCELLED",
      paidThrough: new Date(DURING.getTime() - DAY_MS),
    });
    signInAs(b.owner);

    expect(await page()).not.toContain("for your first month");
    await expect(choose("starter", "monthly")).rejects.toThrow("ba_token=BA-1");
    expect(startedOn()).toBe("P-STARTER-M");
  });

  it("is neither shown nor sold where PayPal has no launch plan", async () => {
    vi.setSystemTime(DURING);
    vi.stubEnv("PAYPAL_PLAN_BUSINESS_MONTHLY_LAUNCH", "");
    const b = await business({ createdAt: DURING });
    signInAs(b.owner);

    const html = await page();
    expect(html).toContain("$14.50 for your first month");
    expect(html).not.toContain("$29.50 for your first month");

    await expect(choose("business", "monthly")).rejects.toThrow("ba_token=BA-1");
    expect(startedOn()).toBe("P-BUSINESS-M");
  });

  it("opens the business on its monthly plan once PayPal has the launch subscription", async () => {
    vi.setSystemTime(DURING);
    const b = await business({ createdAt: DURING });
    const renews = new Date(DURING.getTime() + 31 * DAY_MS);
    paypalHas("I-LAUNCH", { customId: b.orgId, plan: "P-STARTER-M-LAUNCH", nextBilling: renews });

    const synced = await syncSubscription("I-LAUNCH");

    expect(synced).toMatchObject({ linked: true, organizationId: b.orgId, status: "ACTIVE" });
    expect(await orgOf(b)).toMatchObject({
      subscriptionPlan: "starter",
      subscriptionInterval: "monthly",
      paidThrough: renews,
    });
  });
});

// ------------------------------------------------------- free-month codes ---

describe("free-month codes", () => {
  const page = async (params: Record<string, string> = {}) =>
    renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve(params) }));
  const asAction = () => {
    request.headers = { "next-action": "a1b2c3" };
  };
  const choose = (plan: string, interval: string, extra: Record<string, string> = {}) => {
    asAction();
    return choosePlan(form({ plan, interval, ...extra }));
  };
  const startFree = (plan: string) => choose(plan, "monthly", { free: "1" });
  const enter = (code: string) => {
    asAction();
    return enterTrialCode(IDLE, form({ code }));
  };
  const startedOn = () =>
    sent.find((r) => r.path === "/v1/billing/subscriptions")?.body?.plan_id;
  const wentToPayPal = () => sent.some((r) => r.path === "/v1/billing/subscriptions");

  /** A code as the operator would make it, with a name no other test uses. */
  const makeCode = (fields: Record<string, unknown> = {}) =>
    prisma.trialCode.create({
      data: { code: `FRIEND-${randomUUID().slice(0, 8).toUpperCase()}`, ...fields },
    });

  it("takes a code however it is typed, and puts it on the business", async () => {
    const b = await business();
    const code = await makeCode();
    signInAs(b.owner);

    const result = await enter(` ${code.code.toLowerCase()} `);

    expect(result).toMatchObject({ ok: true });
    expect((await orgOf(b)).trialCodeId).toBe(code.id);
  });

  it("offers a free month on every plan once a code is on, with no payment", async () => {
    const code = await makeCode();
    const b = await business({ trialCodeId: code.id });
    signInAs(b.owner);

    const html = await page();

    expect(html).toContain(`Code ${code.code}:`);
    expect(html).toContain("no payment");
    expect(html.match(/First month free/g)).toHaveLength(3);
    expect(html.match(/Start free month/g)).toHaveLength(3);
    expect(html).not.toContain("Opening PayPal");
    expect(html).toContain("Remove code");
    expect(html).not.toContain("Have a code?");
  });

  it("opens the business on the plan chosen for a month, without PayPal", async () => {
    const code = await makeCode();
    const b = await business({ trialCodeId: code.id });
    signInAs(b.owner);

    await expect(startFree("business")).rejects.toThrow("NEXT_REDIRECT /dashboard?welcome=1");

    expect(wentToPayPal()).toBe(false);
    const org = await orgOf(b);
    expect(org).toMatchObject({ subscriptionId: null, subscriptionStatus: null, subscriptionPlan: "business" });
    expect(org.trialEndsAt).toEqual(org.paidThrough);
    const days = (org.trialEndsAt!.getTime() - Date.now()) / DAY_MS;
    expect(days).toBeGreaterThan(27);
    expect(days).toBeLessThan(32);
    // Open: the lock lets it in.
    await expect(requireContext()).resolves.toMatchObject({ org: { id: b.orgId } });
  });

  it("uses a code left in the box without Apply, when a plan is chosen", async () => {
    // Typed, then straight to a plan: they meant to use it, and must never
    // end up at PayPal paying full price for having skipped a button.
    const code = await makeCode();
    const b = await business();
    signInAs(b.owner);

    await expect(choose("starter", "monthly", { code: code.code.toLowerCase() })).rejects.toThrow(
      "NEXT_REDIRECT /dashboard?welcome=1",
    );

    expect(wentToPayPal()).toBe(false);
    expect(await orgOf(b)).toMatchObject({ trialCodeId: code.id, subscriptionPlan: "starter" });
  });

  it("stops, and sends nobody to PayPal, when the code left in the box does not work", async () => {
    const b = await business();
    signInAs(b.owner);

    await expect(choose("starter", "monthly", { code: "NOT-A-CODE" })).rejects.toThrow(
      "NEXT_REDIRECT /billing?error=code-unknown",
    );
    expect(wentToPayPal()).toBe(false);

    const html = await page({ error: "code-unknown" });
    expect(html).toContain("isn’t one we know");
    expect(html).toContain("Nothing was started.");
  });

  it("fills the box from a link, and its plan buttons carry what is in it", async () => {
    const b = await business();
    signInAs(b.owner);

    const html = await page({ code: "friend 30" });

    expect(html).toContain("Have a code?");
    expect(html).toContain('value="FRIEND30"');
    expect(html).toContain('name="code" value="FRIEND30"');
    // Only into the box: nothing is put on the business until it is used.
    expect((await orgOf(b)).trialCodeId).toBeNull();
  });

  it("refuses a code it does not know, one turned off, one ended and one full", async () => {
    const b = await business();
    signInAs(b.owner);

    expect(await enter("NO-SUCH-CODE")).toMatchObject({ ok: false, error: expect.stringContaining("isn’t one we know") });

    const off = await makeCode({ disabledAt: new Date() });
    expect(await enter(off.code)).toMatchObject({ ok: false, error: expect.stringContaining("no longer active") });

    const ended = await makeCode({ expiresAt: new Date(Date.now() - 1000) });
    expect(await enter(ended.code)).toMatchObject({ ok: false, error: expect.stringContaining("has ended") });

    const full = await makeCode({ maxUses: 1 });
    await business({ trialCodeId: full.id });
    // Making a business signs in as its people; back to this one.
    signInAs(b.owner);
    expect(await enter(full.code)).toMatchObject({ ok: false, error: expect.stringContaining("as many times") });

    expect((await orgOf(b)).trialCodeId).toBeNull();
  });

  it("does not count a business against the limit twice for entering its own code again", async () => {
    const code = await makeCode({ maxUses: 1 });
    const b = await business({ trialCodeId: code.id });
    signInAs(b.owner);

    expect(await enter(code.code)).toMatchObject({ ok: true });
  });

  it("is a business's first plan only", async () => {
    const code = await makeCode();
    const b = await business({
      ...PAYING,
      subscriptionId: `I-FIRST-${randomUUID()}`,
      subscriptionStatus: "CANCELLED",
      paidThrough: inDays(-1),
    });
    signInAs(b.owner);

    expect(await page()).not.toContain("Have a code?");
    expect(await enter(code.code)).toMatchObject({ ok: false, error: expect.stringContaining("first plan") });

    await expect(choose("starter", "monthly")).rejects.toThrow("ba_token=BA-1");
    expect(startedOn()).toBe("P-STARTER-M");
  });

  it("stops giving the free month the moment the code is turned off, and never charges instead", async () => {
    const code = await makeCode();
    const b = await business({ trialCodeId: code.id });
    await prisma.trialCode.update({ where: { id: code.id }, data: { disabledAt: new Date() } });
    signInAs(b.owner);

    const html = await page();
    expect(html).toContain(`The code ${code.code} is no longer active`);
    expect(html).not.toContain("Start free month");

    // A "Start free month" button drawn before it was turned off.
    await expect(startFree("starter")).rejects.toThrow("NEXT_REDIRECT /billing?error=code-off");
    expect(wentToPayPal()).toBe(false);

    // Choosing a plan at its price, knowingly, still goes to PayPal.
    await expect(choose("starter", "monthly")).rejects.toThrow("ba_token=BA-1");
    expect(startedOn()).toBe("P-STARTER-M");
  });

  it("gives the free month rather than the launch week's half-price one", async () => {
    vi.stubEnv("PAYPAL_PLAN_STARTER_MONTHLY_LAUNCH", "P-STARTER-M-LAUNCH");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-07T15:00:00Z"));
      const code = await makeCode();
      const b = await business({ createdAt: new Date(), trialCodeId: code.id });
      signInAs(b.owner);

      const html = await page();
      expect(html).not.toContain("Launch week:");
      expect(html).not.toContain("for your first month");

      await expect(startFree("starter")).rejects.toThrow("NEXT_REDIRECT /dashboard?welcome=1");
      expect(wentToPayPal()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can be taken back off before a plan is chosen", async () => {
    const code = await makeCode();
    const b = await business({ trialCodeId: code.id });
    signInAs(b.owner);
    asAction();

    await expect(removeTrialCode()).rejects.toThrow("NEXT_REDIRECT /billing");

    expect((await orgOf(b)).trialCodeId).toBeNull();
  });

  it("is entered by whoever manages settings, not by anybody on the team", async () => {
    const code = await makeCode();
    const b = await business();
    signInAs(b.employee);

    await expect(enter(code.code)).rejects.toThrow();
    expect((await orgOf(b)).trialCodeId).toBeNull();
  });

  describe("during the free month", () => {
    const freeMonth = async () => {
      const code = await makeCode();
      const ends = inDays(20);
      return {
        code,
        ends,
        b: await business({ trialCodeId: code.id, subscriptionPlan: "business", paidThrough: ends, trialEndsAt: ends }),
      };
    };

    it("says when it ends and how to keep going, and offers no second one", async () => {
      const { b, code } = await freeMonth();
      signInAs(b.owner);

      const html = await page();

      expect(html).toContain("free month");
      expect(html).toContain("Your free month runs until");
      expect(html).toContain("Keep going after");
      expect(html).toContain("PayPal takes its first payment on");
      expect(html).not.toContain("Manage in PayPal");
      expect(html).not.toContain("Have a code?");
      expect(html).not.toContain("Start free month");
      expect(await enter(code.code)).toMatchObject({ ok: false, error: expect.stringContaining("first plan") });
    });

    it("lines up a plan whose first payment waits for the month to end", async () => {
      const { b, ends } = await freeMonth();
      signInAs(b.owner);

      await expect(choose("business", "monthly")).rejects.toThrow("ba_token=BA-1");

      const started = sent.find((r) => r.path === "/v1/billing/subscriptions")!.body!;
      expect(started.plan_id).toBe("P-BUSINESS-M");
      expect(started.start_time).toBe(ends.toISOString());
    });

    it("keeps the free month's end when that plan is approved, and says it starts then", async () => {
      const { b, ends } = await freeMonth();
      paypalHas("I-AFTER-FREE", { customId: b.orgId, status: "APPROVED", nextBilling: null });

      await syncSubscription("I-AFTER-FREE");

      expect(await orgOf(b)).toMatchObject({
        subscriptionId: "I-AFTER-FREE",
        subscriptionStatus: "APPROVED",
        paidThrough: ends,
        trialEndsAt: ends,
      });
      signInAs(b.owner);
      expect(await page()).toContain("This plan starts then");
    });

    it("shows a line above the work until a plan is lined up", async () => {
      const { b } = await freeMonth();
      const org = await orgOf(b);

      const banner = renderToStaticMarkup(BillingBanner({ org, canManage: true }));
      expect(banner).toContain("Your free month runs until");
      expect(banner).toContain("Choose a plan");

      const lined = renderToStaticMarkup(
        BillingBanner({ org: { ...org, subscriptionId: "I-LINED", subscriptionStatus: "APPROVED" }, canManage: true }),
      );
      expect(lined).toBe("");
    });

    it("locks when the month runs out with no plan chosen, and says so", async () => {
      const code = await makeCode();
      const b = await business({
        trialCodeId: code.id,
        subscriptionPlan: "business",
        paidThrough: inDays(-5),
        trialEndsAt: inDays(-5),
      });
      signInAs(b.owner);

      await expect(requireContext()).rejects.toThrow("NEXT_REDIRECT /billing");
      expect(await page()).toContain("Your free month has ended");
    });
  });

  it("still remembers when a free month ends for a subscription on the old PayPal free-month plans", async () => {
    // The first version of codes gave the month through PayPal; anybody who
    // started on one of those plans keeps renewing on it.
    vi.stubEnv("PAYPAL_PLAN_STARTER_MONTHLY_TRIAL", "P-STARTER-M-TRIAL");
    const b = await business();
    const firstCharge = inDays(31);
    paypalHas("I-TRIAL", { customId: b.orgId, plan: "P-STARTER-M-TRIAL", nextBilling: firstCharge });

    expect(await syncSubscription("I-TRIAL")).toMatchObject({ linked: true, status: "ACTIVE" });
    expect(await orgOf(b)).toMatchObject({ subscriptionPlan: "starter", paidThrough: firstCharge, trialEndsAt: firstCharge });

    const renewal = inDays(61);
    paypalHas("I-TRIAL", { customId: b.orgId, plan: "P-STARTER-M-TRIAL", nextBilling: renewal, lastPayment: firstCharge });
    await syncSubscription("I-TRIAL");
    expect(await orgOf(b)).toMatchObject({ paidThrough: renewal, trialEndsAt: firstCharge });
  });

  it("goes onto a new business from its sign-up link", async () => {
    const code = await makeCode();
    request.headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` };

    const email = `trial-${randomUUID()}@example.test`;
    await expect(
      signupAction(
        {},
        form({
          businessName: "Bayside Lawn Care",
          name: "Dana Whitfield",
          email,
          password: "correct horse battery staple 42",
          code: code.code.toLowerCase(),
        }),
      ),
    ).rejects.toThrow(/NEXT_REDIRECT \/billing\?welcome=1$/);

    const owner = await prisma.user.findFirstOrThrow({ where: { email }, include: { organization: true } });
    expect(owner.organization.trialCodeId).toBe(code.id);
  });

  it("hands a code that does not work on to the billing screen's box", async () => {
    request.headers = { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200)}` };

    await expect(
      signupAction(
        {},
        form({
          businessName: "Bayside Lawn Care",
          name: "Dana Whitfield",
          email: `trial-${randomUUID()}@example.test`,
          password: "correct horse battery staple 42",
          code: "NOT-A-CODE",
        }),
      ),
    ).rejects.toThrow("NEXT_REDIRECT /billing?welcome=1&code=NOT-A-CODE");
  });
});

// ------------------------------------------- making codes, Accounts page ---

describe("making free-month codes on the Accounts page", () => {
  let operator: Business;

  beforeEach(async () => {
    operator = await business({ billingExempt: true });
    const owner = await prisma.user.findFirstOrThrow({ where: { organizationId: operator.orgId, role: "OWNER" } });
    vi.stubEnv("OPERATOR_EMAILS", owner.email);
    request.headers = { "next-action": "a1b2c3" };
  });

  const make = (fields: Record<string, string>) => createTrialCode(IDLE, form(fields));

  it("makes the code typed, in capitals", async () => {
    const typed = `Bni-${randomUUID().slice(0, 6)}`;
    signInAs(operator.owner);

    const result = await make({ code: typed, note: "BNI chapter", maxUses: "20", lastDay: "2099-12-31" });

    expect(result).toMatchObject({ ok: true });
    const made = await prisma.trialCode.findUniqueOrThrow({ where: { code: typed.toUpperCase() } });
    expect(made).toMatchObject({ note: "BNI chapter", maxUses: 20, disabledAt: null });
    // Works through the whole of the last day, on the operator's clock.
    expect(made.expiresAt).toEqual(new Date("2100-01-01T05:00:00Z"));
  });

  it("makes one up when none is typed", async () => {
    signInAs(operator.owner);

    const result = await make({});

    expect(result).toMatchObject({ ok: true, message: expect.stringMatching(/^Made FREE-[A-Z2-9]{6}\.$/) });
  });

  it("refuses a code that already exists, a bad limit and a day already gone", async () => {
    const taken = await prisma.trialCode.create({ data: { code: `TAKEN-${randomUUID().slice(0, 6).toUpperCase()}` } });
    signInAs(operator.owner);

    expect(await make({ code: taken.code })).toMatchObject({ fieldErrors: { code: "That code already exists." } });
    expect(await make({ code: "AB" })).toMatchObject({ fieldErrors: { code: expect.any(String) } });
    expect(await make({ maxUses: "0" })).toMatchObject({ fieldErrors: { maxUses: expect.any(String) } });
    expect(await make({ lastDay: "2020-01-01" })).toMatchObject({ fieldErrors: { lastDay: "That day has already gone." } });
  });

  it("turns a code off and back on", async () => {
    const code = await prisma.trialCode.create({ data: { code: `TOGGLE-${randomUUID().slice(0, 6).toUpperCase()}` } });
    signInAs(operator.owner);

    await setTrialCodeOn(form({ id: code.id, on: "false" }));
    expect((await prisma.trialCode.findUniqueOrThrow({ where: { id: code.id } })).disabledAt).not.toBeNull();

    await setTrialCodeOn(form({ id: code.id, on: "true" }));
    expect((await prisma.trialCode.findUniqueOrThrow({ where: { id: code.id } })).disabledAt).toBeNull();
  });

  it("answers anybody but the operator with a 404, and makes nothing", async () => {
    const b = await business({ billingExempt: true });
    signInAs(b.owner);
    const typed = `SNEAKY-${randomUUID().slice(0, 6).toUpperCase()}`;

    await expect(make({ code: typed })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await prisma.trialCode.findUnique({ where: { code: typed } })).toBeNull();
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

  it("claims nothing for a subscription no business here started", async () => {
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

  it("acknowledges news of a subscription no business holds, and changes nothing", async () => {
    // Retrying will not make it ours, so PayPal is told to stop.
    paypalHas("I-STRANGER", { customId: null });
    const before = await prisma.organization.count({ where: { subscriptionId: { not: null } } });

    const response = await deliver({
      event_type: "PAYMENT.SALE.COMPLETED",
      resource: { id: "SALE-X", billing_agreement_id: "I-STRANGER" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: "not-ours" });
    expect(await prisma.organization.count({ where: { subscriptionId: { not: null } } })).toBe(before);
  });

  it("acknowledges a verified event that is not about a subscription", async () => {
    const response = await deliver({ event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "O-1" } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ignored: true });
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

// -------------------------------------------------------------- cancelling ---

describe("cancelling from the billing page", () => {
  beforeEach(() => {
    request.headers = { "next-action": "c4n5e1" };
  });

  const page = async (params: Record<string, string> = {}) =>
    renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve(params) }));

  it("offers the owner a way to cancel, folded away with what it means", async () => {
    const until = inDays(12);
    const b = await business({ ...PAYING, subscriptionId: "I-OFFER", paidThrough: until });
    signInAs(b.owner);
    request.headers = {};

    const html = await page();

    expect(html).toContain("<summary");
    expect(html).toContain("Cancel subscription");
    expect(html).toContain("No more payments will be taken");
    expect(html).toContain("Cancel my plan");
  });

  it("offers nobody else a way to cancel", async () => {
    const b = await business({ ...PAYING, subscriptionId: "I-NOT-YOURS", paidThrough: inDays(12) });
    signInAs(b.employee);
    request.headers = {};

    expect(await page()).not.toContain("Cancel subscription");
  });

  it("cancels in PayPal and keeps the time already paid for", async () => {
    const until = inDays(12);
    const b = await business({ ...PAYING, subscriptionId: "I-STOP", paidThrough: until });
    paypalHas("I-STOP", { customId: b.orgId });
    signInAs(b.owner);

    await expect(cancelPlan()).rejects.toThrow("NEXT_REDIRECT /billing?plan_cancelled=1");

    const asked = sent.find((r) => r.path === "/v1/billing/subscriptions/I-STOP/cancel");
    expect(asked?.method).toBe("POST");
    expect(String(asked?.body?.reason)).toMatch(/billing page/);
    expect(await orgOf(b)).toMatchObject({ subscriptionStatus: "CANCELLED", paidThrough: until });
    // Still open: cancelling stops the payments, not the account.
    expect((await requireContext()).org.id).toBe(b.orgId);
  });

  it("says so afterwards, with the day it closes, and offers a way back", async () => {
    const until = inDays(12);
    const b = await business({ ...PAYING, subscriptionId: "I-AFTER", paidThrough: until });
    paypalHas("I-AFTER", { customId: b.orgId });
    signInAs(b.owner);
    await expect(cancelPlan()).rejects.toThrow("plan_cancelled=1");
    request.headers = {};

    const html = await page({ plan_cancelled: "1" });

    expect(html).toContain("Your plan is cancelled. No more payments will be taken");
    expect(html).toContain("Keep going after");
    expect(html).not.toContain("Cancel subscription");
    // Every plan is a way back, the one just cancelled included.
    expect(html).not.toContain("Current plan");
  });

  it("counts a plan PayPal already has as cancelled as cancelled", async () => {
    const b = await business({ ...PAYING, subscriptionId: "I-GONE", paidThrough: inDays(5) });
    paypalHas("I-GONE", { customId: b.orgId, status: "CANCELLED" });
    signInAs(b.owner);

    await expect(cancelPlan()).rejects.toThrow("NEXT_REDIRECT /billing?plan_cancelled=1");
    expect((await orgOf(b)).subscriptionStatus).toBe("CANCELLED");
  });

  it("changes nothing when PayPal will not cancel it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = await business({ ...PAYING, subscriptionId: "I-STUCK", paidThrough: inDays(5) });
    paypalHas("I-STUCK", { customId: b.orgId });
    signInAs(b.owner);
    paypalDown = true;

    await expect(cancelPlan()).rejects.toThrow("NEXT_REDIRECT /billing?error=cancel");
    expect((await orgOf(b)).subscriptionStatus).toBe("ACTIVE");
  });

  it("is not for someone who cannot manage billing", async () => {
    const b = await business({ ...PAYING, subscriptionId: "I-EMPLOYEE", paidThrough: inDays(5) });
    paypalHas("I-EMPLOYEE", { customId: b.orgId });
    signInAs(b.employee);

    await expect(cancelPlan()).rejects.toThrow("NEXT_REDIRECT /no-access");
    expect(sent).toEqual([]);
    expect((await orgOf(b)).subscriptionStatus).toBe("ACTIVE");
  });

  it("asks PayPal nothing when there is nothing to cancel", async () => {
    const exempt = await business({ billingExempt: true });
    signInAs(exempt.owner);
    await expect(cancelPlan()).rejects.toThrow("NEXT_REDIRECT /billing");

    const done = await business({
      ...PAYING,
      subscriptionId: "I-DONE",
      subscriptionStatus: "CANCELLED",
      paidThrough: inDays(5),
    });
    signInAs(done.owner);
    await expect(cancelPlan()).rejects.toThrow("NEXT_REDIRECT /billing");

    expect(sent.filter((r) => r.path.endsWith("/cancel"))).toEqual([]);
  });
});

// ------------------------------------------------------- coming back later ---

describe("coming back after cancelling", () => {
  beforeEach(() => {
    request.headers = { "next-action": "r3st4r" };
  });

  it("starts the new plan when the paid-for time runs out, not on top of it", async () => {
    const until = inDays(12);
    const b = await business({
      ...PAYING,
      subscriptionId: "I-WAS",
      subscriptionStatus: "CANCELLED",
      paidThrough: until,
    });
    signInAs(b.owner);

    await expect(choosePlan(form({ plan: "business", interval: "monthly" }))).rejects.toThrow(
      "ba_token=BA-1",
    );

    const started = sent.find((r) => r.path === "/v1/billing/subscriptions");
    expect(started?.body).toMatchObject({ plan_id: "P-BUSINESS-M", start_time: until.toISOString() });
  });

  it("takes over from the cancelled plan once approved, keeping the days paid for", async () => {
    const until = inDays(12);
    const b = await business({
      ...PAYING,
      subscriptionId: "I-BEFORE",
      subscriptionStatus: "CANCELLED",
      paidThrough: until,
    });
    paypalHas("I-NEXT", { customId: b.orgId, status: "APPROVED", plan: "P-PRO-A", nextBilling: null });

    await syncSubscription("I-NEXT");

    expect(await orgOf(b)).toMatchObject({
      subscriptionId: "I-NEXT",
      subscriptionStatus: "APPROVED",
      subscriptionPlan: "pro",
      subscriptionInterval: "annual",
      paidThrough: until,
    });

    // Late news of the one it replaced changes nothing.
    paypalHas("I-BEFORE", { customId: b.orgId, status: "CANCELLED" });
    await syncSubscription("I-BEFORE");
    expect((await orgOf(b)).subscriptionId).toBe("I-NEXT");
  });

  it("does not let an approved plan push aside one that is renewing", async () => {
    const b = await business({ ...PAYING, subscriptionId: "I-LIVE", paidThrough: inDays(12) });
    paypalHas("I-SIDE", { customId: b.orgId, status: "APPROVED" });

    await syncSubscription("I-SIDE");

    expect(await orgOf(b)).toMatchObject({ subscriptionId: "I-LIVE", subscriptionStatus: "ACTIVE" });
  });

  it("shows a plan waiting to start, and offers no second one beside it", async () => {
    const until = inDays(12);
    const b = await business({
      ...PAYING,
      subscriptionId: "I-WAITING",
      subscriptionStatus: "APPROVED",
      paidThrough: until,
    });
    signInAs(b.owner);
    request.headers = {};

    const html = renderToStaticMarkup(await BillingPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Starts on");
    expect(html).toContain("cancel this one first");
    expect(html).toContain("Cancel subscription");
    expect(html).not.toContain("Monthly");
  });
});

describe("restartDate", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const later = new Date("2026-10-20T12:00:00Z");

  it("is the end of the paid-for time on a plan that is not renewing", () => {
    expect(restartDate({ subscriptionStatus: "CANCELLED", paidThrough: later }, now)).toBe(later);
  });

  it("is now for a renewing plan, one with nothing left, or one about to run out", () => {
    expect(restartDate({ subscriptionStatus: "ACTIVE", paidThrough: later }, now)).toBeNull();
    expect(restartDate({ subscriptionStatus: "CANCELLED", paidThrough: null }, now)).toBeNull();
    expect(
      restartDate({ subscriptionStatus: "CANCELLED", paidThrough: new Date("2026-09-20T00:00:00Z") }, now),
    ).toBeNull();
    // PayPal refuses a start time already past by the time it reads it.
    expect(
      restartDate({ subscriptionStatus: "CANCELLED", paidThrough: new Date(now.getTime() + 30 * 60 * 1000) }, now),
    ).toBeNull();
  });
});
