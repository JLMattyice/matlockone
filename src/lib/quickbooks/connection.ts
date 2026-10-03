import "server-only";

import type { TokenSet } from "./oauth";
import type { QuickBooksEnvironment } from "./settings";
import { prisma } from "../db";
import { open as openSecret, seal } from "../secret-box";
import { todayIn } from "../time-zone";

/**
 * A business's QuickBooks connection, kept in the Integration table like its
 * mail and payment connections: the non-secret part as JSON, the tokens
 * sealed with the deployment's encryption key.
 *
 * One accounting connection per business (kind ACCOUNTING), so connecting a
 * different QuickBooks company replaces the old one rather than leaving two.
 */

export const ACCOUNTING_KIND = "ACCOUNTING";
export const QUICKBOOKS = "QUICKBOOKS";

export type QuickBooksConfig = {
  realmId: string;
  companyName: string;
  environment: QuickBooksEnvironment;
  /**
   * Whether a customer QuickBooks already had under the same name gets
   * Matlock One's details. On unless the owner turns it off; when off, such a
   * customer is used as it is and never written to.
   */
  overwriteMatches: boolean;
  connectedAt: string;
  /**
   * Set by the first press of Send now, and moved on by each one after.
   * Nothing goes over by itself while it is null, so the overwrite switch can
   * be set before any QuickBooks customer is touched.
   */
  firstSentAt: string | null;
  /** Intuit refused the tokens: shown as "connect again", and nothing is tried. */
  needsReconnect: boolean;
  /**
   * Invoices issued, and expenses spent, on or after this day (YYYY-MM-DD)
   * go over; earlier ones are assumed to be in the books already. The day
   * of first connecting unless the owner picks another.
   */
  sendFrom: string;
  /** The company's country as QuickBooks has it; sales tax is US-shaped there. */
  country: string | null;
  /** The income account the items Matlock One makes are filed under. */
  incomeAccountId: string | null;
  /** Expense category → QuickBooks expense account id, as the owner chose. */
  expenseAccounts: Record<string, string>;
  /** The bank or card account expenses are paid from, and which it is. */
  paidFromAccountId: string | null;
  paidFromIsCard: boolean;
};

export type QuickBooksConnection = QuickBooksConfig & {
  organizationId: string;
  tokens: TokenSet;
};

function readConfig(raw: string | null | undefined): QuickBooksConfig | null {
  try {
    const value = JSON.parse(raw ?? "") as Partial<QuickBooksConfig>;
    if (!value || typeof value.realmId !== "string" || !value.realmId) return null;
    return {
      realmId: value.realmId,
      companyName: typeof value.companyName === "string" ? value.companyName : "",
      environment: value.environment === "production" ? "production" : "sandbox",
      overwriteMatches: value.overwriteMatches !== false,
      connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : "",
      firstSentAt: typeof value.firstSentAt === "string" ? value.firstSentAt : null,
      needsReconnect: value.needsReconnect === true,
      sendFrom:
        typeof value.sendFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.sendFrom)
          ? value.sendFrom
          : (typeof value.connectedAt === "string" ? value.connectedAt : new Date().toISOString()).slice(0, 10),
      country: typeof value.country === "string" ? value.country : null,
      incomeAccountId: typeof value.incomeAccountId === "string" ? value.incomeAccountId : null,
      expenseAccounts:
        value.expenseAccounts && typeof value.expenseAccounts === "object"
          ? Object.fromEntries(
              Object.entries(value.expenseAccounts).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
              ),
            )
          : {},
      paidFromAccountId: typeof value.paidFromAccountId === "string" ? value.paidFromAccountId : null,
      paidFromIsCard: value.paidFromIsCard === true,
    };
  } catch {
    return null;
  }
}

async function row(organizationId: string) {
  return prisma.integration.findUnique({
    where: { organizationId_kind: { organizationId, kind: ACCOUNTING_KIND } },
  });
}

/** What the settings page shows: everything but the tokens. Null when not connected. */
export async function quickbooksStatus(organizationId: string): Promise<QuickBooksConfig | null> {
  const integration = await row(organizationId);
  if (!integration || integration.provider !== QUICKBOOKS || !integration.isActive) return null;
  return readConfig(integration.config);
}

/**
 * The connection with its tokens, or null when there is nothing usable —
 * not connected, switched off, or tokens that no longer decrypt because the
 * encryption key changed.
 */
export async function loadConnection(organizationId: string): Promise<QuickBooksConnection | null> {
  const integration = await row(organizationId);
  if (!integration || integration.provider !== QUICKBOOKS || !integration.isActive) return null;

  const config = readConfig(integration.config);
  if (!config) return null;

  const opened = openSecret({
    cipherText: integration.secretCipher ?? undefined,
    nonce: integration.secretNonce ?? undefined,
    tag: integration.secretTag ?? undefined,
  });
  if (!opened) return null;

  try {
    const tokens = JSON.parse(opened) as TokenSet;
    if (typeof tokens.accessToken !== "string" || typeof tokens.refreshToken !== "string") return null;
    return { ...config, organizationId, tokens };
  } catch {
    return null;
  }
}

function sealedTokens(tokens: TokenSet) {
  const sealed = seal(JSON.stringify(tokens));
  return { secretCipher: sealed.cipherText, secretNonce: sealed.nonce, secretTag: sealed.tag };
}

/** A new connection, or the same business connecting again. */
export async function saveConnection(input: {
  organizationId: string;
  userId: string;
  realmId: string;
  companyName: string;
  environment: QuickBooksEnvironment;
  tokens: TokenSet;
  /** The business's time zone, so "from today" means its today. */
  timeZone?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  // Read whether or not it is switched on: a disconnected company's choices
  // are kept for the day it is connected again.
  const stored = await row(input.organizationId);
  const previous = stored?.provider === QUICKBOOKS ? readConfig(stored.config) : null;
  const sameCompany = previous?.realmId === input.realmId;

  // Connecting the same company again keeps the owner's choices and the fact
  // that sending has started. A different company starts from the top.
  const config: QuickBooksConfig = {
    realmId: input.realmId,
    companyName: input.companyName,
    environment: input.environment,
    overwriteMatches: sameCompany ? previous.overwriteMatches : true,
    connectedAt: now.toISOString(),
    firstSentAt: sameCompany ? previous.firstSentAt : null,
    needsReconnect: false,
    sendFrom: sameCompany
      ? previous.sendFrom
      : input.timeZone
        ? todayIn(input.timeZone)
        : now.toISOString().slice(0, 10),
    country: sameCompany ? previous.country : null,
    // Account ids belong to one company; another company starts unmapped.
    incomeAccountId: sameCompany ? previous.incomeAccountId : null,
    expenseAccounts: sameCompany ? previous.expenseAccounts : {},
    paidFromAccountId: sameCompany ? previous.paidFromAccountId : null,
    paidFromIsCard: sameCompany ? previous.paidFromIsCard : false,
  };

  const data = {
    provider: QUICKBOOKS,
    isActive: true,
    config: JSON.stringify(config),
    ...sealedTokens(input.tokens),
    secretHint: null,
    lastTestedAt: now,
    lastTestOk: true,
    lastError: null,
  };

  await prisma.integration.upsert({
    where: { organizationId_kind: { organizationId: input.organizationId, kind: ACCOUNTING_KIND } },
    create: {
      organizationId: input.organizationId,
      kind: ACCOUNTING_KIND,
      createdById: input.userId,
      ...data,
    },
    update: data,
  });
}

async function updateConfig(organizationId: string, change: Partial<QuickBooksConfig>) {
  const integration = await row(organizationId);
  const config = readConfig(integration?.config);
  if (!integration || !config) return;
  await prisma.integration.update({
    where: { id: integration.id },
    data: { config: JSON.stringify({ ...config, ...change }) },
  });
}

/** Called after every refresh: Intuit may have issued a new refresh token. */
export async function storeTokens(organizationId: string, tokens: TokenSet) {
  await prisma.integration.updateMany({
    where: { organizationId, kind: ACCOUNTING_KIND, provider: QUICKBOOKS },
    data: sealedTokens(tokens),
  });
}

export function setCompanyName(organizationId: string, companyName: string, country: string | null) {
  return updateConfig(organizationId, { companyName, country });
}

export function setSendFrom(organizationId: string, sendFrom: string) {
  return updateConfig(organizationId, { sendFrom });
}

export function setIncomeAccount(organizationId: string, incomeAccountId: string) {
  return updateConfig(organizationId, { incomeAccountId });
}

export function setExpenseAccounts(
  organizationId: string,
  choice: { expenseAccounts: Record<string, string>; paidFromAccountId: string | null; paidFromIsCard: boolean },
) {
  return updateConfig(organizationId, choice);
}

export function setOverwriteMatches(organizationId: string, overwriteMatches: boolean) {
  return updateConfig(organizationId, { overwriteMatches });
}

export function markFirstSent(organizationId: string, now = new Date()) {
  return updateConfig(organizationId, { firstSentAt: now.toISOString() });
}

export async function markNeedsReconnect(organizationId: string, message: string) {
  await updateConfig(organizationId, { needsReconnect: true });
  await prisma.integration.updateMany({
    where: { organizationId, kind: ACCOUNTING_KIND, provider: QUICKBOOKS },
    data: { lastTestOk: false, lastError: message },
  });
}

/**
 * Disconnects: the tokens are wiped and the connection switched off. The
 * owner's choices stay on the row, and the links to what was sent stay too —
 * they are filed under the QuickBooks company — so connecting the same
 * company again picks up where it left off instead of sending everyone twice.
 */
export async function removeConnection(organizationId: string): Promise<QuickBooksConnection | null> {
  const connection = await loadConnection(organizationId);
  await prisma.integration.updateMany({
    where: { organizationId, kind: ACCOUNTING_KIND, provider: QUICKBOOKS },
    data: {
      isActive: false,
      secretCipher: null,
      secretNonce: null,
      secretTag: null,
      lastError: null,
    },
  });
  return connection;
}
