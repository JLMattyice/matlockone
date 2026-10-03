import "server-only";

import { QuickBooksError, queryValue, quickbooksQuery } from "./api";
import type { QuickBooksConnection } from "./connection";
import { createRemote, isGone, updateRemote } from "./records";
import { formatPhone } from "../utils";

/**
 * A customer here as a QuickBooks Online Customer.
 *
 * QuickBooks keeps one list of names across customers, suppliers and
 * employees, and a name cannot contain a colon (it is how sub-customers are
 * written). Those two rules are where sending a customer can go wrong, so
 * they are dealt with here and turned into sentences the owner can act on.
 */

export type ClientForQuickBooks = {
  id: string;
  type: string;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  businessName: string | null;
  email: string | null;
  phone: string | null;
  mobilePhone: string | null;
  website: string | null;
  addresses: {
    id: string;
    line1: string;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string;
    isPrimary: boolean;
    isBilling: boolean;
  }[];
};

type QboAddress = {
  Line1: string;
  Line2?: string;
  City?: string;
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
};

export type QboCustomerFields = {
  DisplayName: string;
  GivenName?: string;
  FamilyName?: string;
  CompanyName?: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  Mobile?: { FreeFormNumber: string };
  WebAddr?: { URI: string };
  BillAddr?: QboAddress;
  ShipAddr?: QboAddress;
};

type QboCustomer = { Id: string; SyncToken: string };

/** QuickBooks' own lengths; longer is refused outright, so it is cut instead. */
function cut(value: string | null | undefined, max: number): string | undefined {
  const text = value?.trim();
  return text ? text.slice(0, max) : undefined;
}

/** A name QuickBooks will take: no colons, tabs or line breaks. */
export function quickbooksName(name: string): string {
  return name.replace(/:/g, "-").replace(/\s+/g, " ").trim().slice(0, 500);
}

function website(value: string | null): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    return new URL(withScheme).toString().slice(0, 1000);
  } catch {
    return undefined;
  }
}

function address(row: ClientForQuickBooks["addresses"][number]): QboAddress {
  return {
    Line1: row.line1.slice(0, 500),
    Line2: cut(row.line2, 500),
    City: cut(row.city, 255),
    CountrySubDivisionCode: cut(row.state, 255),
    PostalCode: cut(row.postalCode, 30),
    Country: cut(row.country, 255),
  };
}

/** Everything sent about a customer, on creation and on every update. */
export function customerFields(client: ClientForQuickBooks): QboCustomerFields {
  const billing =
    client.addresses.find((a) => a.isBilling) ??
    client.addresses.find((a) => a.isPrimary) ??
    client.addresses[0];
  const site = client.addresses.find((a) => a.isPrimary) ?? billing;

  const phone = (value: string | null) => {
    const text = cut(formatPhone(value) || value, 30);
    return text ? { FreeFormNumber: text } : undefined;
  };
  const email = cut(client.email, 100);
  const uri = website(client.website);

  return {
    DisplayName: quickbooksName(client.displayName),
    GivenName: cut(client.firstName, 100),
    FamilyName: cut(client.lastName, 100),
    CompanyName: client.type === "BUSINESS" ? cut(client.businessName, 100) : undefined,
    PrimaryEmailAddr: email ? { Address: email } : undefined,
    PrimaryPhone: phone(client.phone),
    Mobile: phone(client.mobilePhone),
    WebAddr: uri ? { URI: uri } : undefined,
    BillAddr: billing ? address(billing) : undefined,
    // Where the work happens, when that is somewhere other than where bills go.
    ShipAddr: site && billing && site.id !== billing.id ? address(site) : undefined,
  };
}

export type CustomerOutcome = {
  externalId: string;
  syncToken: string | null;
  origin: "CREATED" | "MATCHED";
};

export type CustomerLink = {
  externalId: string | null;
  syncToken: string | null;
  origin: string;
};

/**
 * Sends one customer: updates the one it was sent as before, takes over one
 * QuickBooks already has by the same name, or makes a new one.
 */
export async function pushCustomer(
  connection: QuickBooksConnection,
  client: ClientForQuickBooks,
  link: CustomerLink | null,
): Promise<CustomerOutcome> {
  const fields = customerFields(client);
  const origin = link?.origin === "MATCHED" ? "MATCHED" : "CREATED";

  if (link?.externalId) {
    // Taken over by name, with overwriting switched off: used, never written.
    if (origin === "MATCHED" && !connection.overwriteMatches) {
      return { externalId: link.externalId, syncToken: link.syncToken, origin };
    }
    try {
      const updated = await updateRemote(connection, "customer", link.externalId, link.syncToken, fields);
      return { externalId: updated.Id, syncToken: updated.SyncToken, origin };
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }

  // Inactive customers hold on to their names too, so they are looked for.
  const [existing] = await quickbooksQuery<QboCustomer>(
    connection,
    "Customer",
    `Active IN (true, false) AND DisplayName = ${queryValue(fields.DisplayName)}`,
  );

  if (existing) {
    if (!connection.overwriteMatches) {
      return { externalId: existing.Id, syncToken: existing.SyncToken, origin: "MATCHED" };
    }
    const updated = await updateRemote(connection, "customer", existing.Id, existing.SyncToken, fields);
    return { externalId: updated.Id, syncToken: updated.SyncToken, origin: "MATCHED" };
  }

  try {
    const created = await createRemote(connection, "customer", fields);
    return { externalId: created.Id, syncToken: created.SyncToken, origin: "CREATED" };
  } catch (error) {
    if (error instanceof QuickBooksError && error.code === "6240") {
      throw new QuickBooksError(
        `QuickBooks already has a supplier or employee called “${fields.DisplayName}”, and a customer cannot share the name. Rename one of them and it will be sent again.`,
        error.status,
        error.code,
      );
    }
    throw error;
  }
}
