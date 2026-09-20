import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it } from "vitest";

import {
  asCatalogView,
  catalogSummary,
  getCatalogItem,
  listCatalogItems,
  unitsInUse,
} from "@/app/(app)/catalog/queries";
import { priceBook } from "@/app/(app)/estimates/queries";
import { prisma } from "@/lib/db";
import { NAVIGATION } from "@/lib/navigation";
import { can } from "@/lib/permissions";

/**
 * The catalog is the one list whose rows are read by another screen: the
 * document editors offer active entries as one-click lines. So the things
 * worth pinning are that archiving removes an entry from that offer without
 * removing it from the catalog, and that no other business's prices can ever
 * appear in either place.
 */

let organizationId: string;
let otherOrganizationId: string;

async function seedOrg(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `catalog-${randomUUID()}`, name },
  });
  return org.id;
}

beforeEach(async () => {
  organizationId = await seedOrg("Catalog Test Co");
  otherOrganizationId = await seedOrg("Someone Else Ltd");

  await prisma.priceBookItem.createMany({
    data: [
      {
        organizationId,
        kind: "SERVICE",
        name: "Annual boiler service",
        description: "Inspection, clean and safety check.",
        unit: "job",
        unitPriceCents: 18_500,
      },
      {
        organizationId,
        kind: "LABOR",
        name: "Standard hourly rate",
        unit: "hr",
        unitPriceCents: 9_500,
      },
      {
        organizationId,
        kind: "MATERIAL",
        name: "Thermostat, programmable",
        unit: "ea",
        unitPriceCents: 12_800,
        taxable: false,
      },
      {
        organizationId,
        kind: "SERVICE",
        name: "Discontinued deep clean",
        unit: "job",
        unitPriceCents: 24_000,
        isActive: false,
      },
      {
        organizationId: otherOrganizationId,
        kind: "SERVICE",
        name: "Somebody else's service",
        unit: "job",
        unitPriceCents: 99_900,
      },
    ],
  });
});

describe("listCatalogItems", () => {
  it("shows what is offered, and not what was archived", async () => {
    const list = await listCatalogItems({ organizationId, view: "active" });

    expect(list.total).toBe(3);
    expect(list.rows.map((row) => row.name)).not.toContain(
      "Discontinued deep clean",
    );
  });

  it("can look at the archive, which is the point of archiving", async () => {
    const list = await listCatalogItems({ organizationId, view: "archived" });

    expect(list.rows.map((row) => row.name)).toEqual([
      "Discontinued deep clean",
    ]);
  });

  it("never reaches another business's prices", async () => {
    const list = await listCatalogItems({ organizationId, view: "all" });

    expect(list.total).toBe(4);
    expect(list.rows.every((row) => row.organizationId === organizationId)).toBe(
      true,
    );
  });

  it("filters by kind", async () => {
    const list = await listCatalogItems({
      organizationId,
      view: "active",
      kind: "LABOR",
    });

    expect(list.rows.map((row) => row.name)).toEqual(["Standard hourly rate"]);
  });

  it("ignores a kind that is not one", async () => {
    // The value arrives from the query string, so it can be anything.
    const list = await listCatalogItems({
      organizationId,
      view: "active",
      kind: "NONSENSE",
    });

    expect(list.total).toBe(3);
  });

  it("searches the description as well as the name", async () => {
    const list = await listCatalogItems({
      organizationId,
      view: "active",
      q: "safety check",
    });

    expect(list.rows.map((row) => row.name)).toEqual(["Annual boiler service"]);
  });

  it("groups by kind, then orders by name", async () => {
    const list = await listCatalogItems({ organizationId, view: "active" });

    expect(list.rows.map((row) => row.kind)).toEqual([
      "LABOR",
      "MATERIAL",
      "SERVICE",
    ]);
  });
});

describe("catalogSummary", () => {
  it("counts both sides, so the archived tab can show a number", async () => {
    const summary = await catalogSummary(organizationId);

    expect(summary.active).toBe(3);
    expect(summary.archived).toBe(1);
    expect(summary.byKind.get("SERVICE")).toBe(1);
  });
});

describe("what the document editors are offered", () => {
  it("matches the catalog's active list", async () => {
    const offered = await priceBook(organizationId);
    const list = await listCatalogItems({ organizationId, view: "active" });

    expect(offered.map((item) => item.name).sort()).toEqual(
      list.rows.map((row) => row.name).sort(),
    );
  });

  it("drops an entry as soon as it is archived, and brings it back", async () => {
    const item = await prisma.priceBookItem.findFirstOrThrow({
      where: { organizationId, name: "Standard hourly rate" },
    });

    await prisma.priceBookItem.update({
      where: { id: item.id },
      data: { isActive: false },
    });
    expect((await priceBook(organizationId)).map((i) => i.name)).not.toContain(
      "Standard hourly rate",
    );

    await prisma.priceBookItem.update({
      where: { id: item.id },
      data: { isActive: true },
    });
    expect((await priceBook(organizationId)).map((i) => i.name)).toContain(
      "Standard hourly rate",
    );
  });
});

describe("getCatalogItem", () => {
  it("refuses an id belonging to another business", async () => {
    const theirs = await prisma.priceBookItem.findFirstOrThrow({
      where: { organizationId: otherOrganizationId },
    });

    expect(await getCatalogItem(organizationId, theirs.id)).toBeNull();
  });
});

describe("unitsInUse", () => {
  it("offers this business's own units before the common ones", async () => {
    const units = await unitsInUse(organizationId);

    expect(units).toContain("job");
    expect(units).toContain("hr");
    // Suggestions, so the list must not repeat a unit that is both.
    expect(new Set(units).size).toBe(units.length);
  });
});

describe("who can reach the catalog", () => {
  /**
   * Prices are what the business charges, so the list is not for everyone with
   * a login. A manager quotes work and therefore maintains what is quoted; a
   * technician on site has no reason to see the margin on a part.
   */
  it("is open to the roles that quote, and closed to the ones that do not", () => {
    expect(can({ role: "OWNER" }, "catalog:write")).toBe(true);
    expect(can({ role: "ADMIN" }, "catalog:write")).toBe(true);
    expect(can({ role: "MANAGER" }, "catalog:write")).toBe(true);

    expect(can({ role: "EMPLOYEE" }, "catalog:read")).toBe(false);
    expect(can({ role: "EMPLOYEE" }, "catalog:write")).toBe(false);
  });

  it("keeps the nav entry out of an employee's sidebar", () => {
    const business = NAVIGATION.find((group) => group.title === "Business")!;
    const catalog = business.items.find((item) => item.href === "/catalog")!;

    expect(can({ role: "EMPLOYEE" }, catalog.permission)).toBe(false);
    expect(can({ role: "MANAGER" }, catalog.permission)).toBe(true);
  });
});

describe("asCatalogView", () => {
  it("defaults to what is offered, and rejects anything unexpected", () => {
    expect(asCatalogView(undefined)).toBe("active");
    expect(asCatalogView("nonsense")).toBe("active");
    expect(asCatalogView("archived")).toBe("archived");
    expect(asCatalogView("all")).toBe("all");
  });
});
