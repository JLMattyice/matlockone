import { randomUUID } from "node:crypto";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Calendar categories: a business's own, and the built-ins it can hide.
 *
 * The helpers are pinned on their own; the actions run against the test
 * database signed in as a real user, because the promises worth keeping are
 * about stored rows — that an entry behaves as its category says, that one
 * business cannot file under another's category, and that deleting one keeps
 * what was filed under it.
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

// Saving an entry reads the viewer's zone from a request cookie.
vi.mock("@/lib/viewer-time-zone", () => ({ viewerTimeZone: async () => "UTC" }));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT ${url}`);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import { createJob, updateJob } from "@/app/(app)/jobs/actions";
import { periodTotals } from "@/app/(app)/reports/queries";
import {
  deleteJobCategory,
  saveJobCategory,
  setBuiltInShown,
} from "@/app/(app)/settings/calendar/actions";
import { IDLE } from "@/lib/action-state";
import { prisma } from "@/lib/db";
import {
  categoryOptions,
  categoryValue,
  categoryWhere,
  entryCategory,
  parseCategoryValue,
  parseHiddenKinds,
  serializeHiddenKinds,
} from "@/lib/job-categories";

// ------------------------------------------------------------- helpers ---

describe("category values", () => {
  it("reads a built-in kind and a business's own category", () => {
    expect(parseCategoryValue("LAUNCH")).toEqual({ kind: "LAUNCH", categoryId: null });
    expect(parseCategoryValue("category:ckabc123")).toEqual({
      kind: null,
      categoryId: "ckabc123",
    });
  });

  it("names nothing for anything else", () => {
    for (const junk of ["", null, undefined, "launch", "category:", "category:a b", "DROP"]) {
      expect(parseCategoryValue(junk)).toBeNull();
    }
  });

  it("round-trips an entry", () => {
    expect(categoryValue({ kind: "EVENT" })).toBe("EVENT");
    expect(categoryValue({ kind: "OTHER", categoryId: "ck1" })).toBe("category:ck1");
    expect(categoryValue({ kind: "nonsense" })).toBe("JOB");
  });

  it("filters a built-in to entries without a category of their own", () => {
    expect(categoryWhere("OTHER")).toEqual({ kind: "OTHER", categoryId: null });
    expect(categoryWhere("category:ck1")).toEqual({ categoryId: "ck1" });
    expect(categoryWhere("junk")).toEqual({});
    expect(categoryWhere(undefined)).toEqual({});
  });
});

describe("hidden built-ins", () => {
  it("never hides Job, drops unknowns and duplicates, keeps a stable order", () => {
    expect(parseHiddenKinds("EVENT, JOB,LAUNCH,EVENT,bogus")).toEqual(["LAUNCH", "EVENT"]);
    expect(parseHiddenKinds("")).toEqual([]);
    expect(serializeHiddenKinds(["OTHER", "MEETING"])).toBe("MEETING,OTHER");
  });
});

describe("what an entry is called", () => {
  it("leaves a plain job unmarked and names everything else", () => {
    expect(entryCategory({ kind: "JOB" }, "Project")).toEqual({
      label: "Project",
      icon: "briefcase",
      plain: true,
    });
    expect(entryCategory({ kind: "SOCIAL_POST" }, "Job")).toMatchObject({
      label: "Social post",
      plain: false,
    });
    // A category that counts as work is still marked: it has its own name.
    expect(
      entryCategory({ kind: "JOB", category: { name: "Install", icon: "wrench" } }, "Job"),
    ).toEqual({ label: "Install", icon: "wrench", plain: false });
  });

  it("falls back to a tag for a mark it does not know", () => {
    expect(
      entryCategory({ kind: "OTHER", category: { name: "X", icon: "gone" } }, "Job").icon,
    ).toBe("tag");
  });
});

describe("the picker", () => {
  const categories = [
    { id: "ck2", name: "Trade show", icon: "ticket", kind: "OTHER" },
    { id: "ck1", name: "Newsletter", icon: "mail", kind: "OTHER" },
  ];

  it("offers visible built-ins first, then the business's own by name", () => {
    const values = categoryOptions({
      categories,
      hiddenKinds: ["LAUNCH", "SOCIAL_POST"],
      jobLabel: "Job",
      jobPlural: "Jobs",
    }).map((option) => option.value);

    expect(values).toEqual([
      "JOB",
      "APPOINTMENT",
      "MEETING",
      "DEADLINE",
      "EVENT",
      "OTHER",
      "category:ck1",
      "category:ck2",
    ]);
  });

  it("keeps a hidden built-in on offer for the entry already using it", () => {
    const values = categoryOptions({
      categories: [],
      hiddenKinds: ["LAUNCH"],
      jobLabel: "Job",
      jobPlural: "Jobs",
      keep: "LAUNCH",
    }).map((option) => option.value);

    expect(values).toContain("LAUNCH");
  });
});

// ------------------------------------------------------------- actions ---

let organizationId: string;
const orgs: string[] = [];

async function makeBusiness(name: string) {
  const org = await prisma.organization.create({
    data: { slug: `cats-${randomUUID()}`, name },
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

async function signInAs(orgId: string, userId: string) {
  session.org = (await prisma.organization.findUniqueOrThrow({
    where: { id: orgId },
  })) as unknown as Record<string, unknown>;
  session.user = (await prisma.user.findUniqueOrThrow({
    where: { id: userId },
  })) as unknown as Record<string, unknown>;
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function addCategory(name: string, icon = "tag", countsAsWork = false) {
  return saveJobCategory(
    IDLE,
    form({ name, icon, ...(countsAsWork ? { countsAsWork: "on" } : {}) }),
  );
}

async function categoryId(name: string) {
  const row = await prisma.jobCategory.findFirstOrThrow({
    where: { organizationId, name },
  });
  return row.id;
}

/** Creates an entry through the real action and returns the stored row. */
async function book(title: string, category: string) {
  const result = await createJob(
    IDLE,
    form({
      title,
      category,
      status: "SCHEDULED",
      priority: "NORMAL",
      durationMinutes: "60",
    }),
  ).catch((error: Error) => {
    // Success ends in a redirect to the new entry.
    if (error.message.startsWith("NEXT_REDIRECT")) return null;
    throw error;
  });
  const job = await prisma.job.findFirst({ where: { organizationId, title } });
  return { result, job };
}

beforeEach(async () => {
  const { org, user } = await makeBusiness("Categories Test Co");
  organizationId = org.id;
  await signInAs(org.id, user.id);
});

afterAll(async () => {
  await prisma.organization.deleteMany({ where: { id: { in: orgs } } });
});

describe("adding a category", () => {
  it("adds one, stored as the kind it behaves as", async () => {
    expect(await addCategory("Newsletter", "mail")).toMatchObject({ ok: true });
    expect(await addCategory("Install", "wrench", true)).toMatchObject({ ok: true });

    const rows = await prisma.jobCategory.findMany({
      where: { organizationId },
      orderBy: { name: "asc" },
      select: { name: true, icon: true, kind: true },
    });
    expect(rows).toEqual([
      { name: "Install", icon: "wrench", kind: "JOB" },
      { name: "Newsletter", icon: "mail", kind: "OTHER" },
    ]);
  });

  it("refuses a second of the same name, whatever the case", async () => {
    await addCategory("Newsletter");
    const again = await addCategory("newsletter");
    expect(again.ok).toBe(false);
    // Named as it is stored, not as it was typed the second time.
    expect(again.fieldErrors?.name).toBe("You already have Newsletter.");
  });

  it("refuses a built-in's name, and says so when that built-in is hidden", async () => {
    expect((await addCategory("Meeting")).fieldErrors?.name).toMatch(/already a built-in/);

    await setBuiltInShown(form({ kind: "MEETING", shown: "false" }));
    session.org = (await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    })) as unknown as Record<string, unknown>;

    expect((await addCategory("meeting")).fieldErrors?.name).toMatch(/turned off/);
  });

  it("refuses a mark that is not on the list", async () => {
    const result = await addCategory("Odd", "skull");
    expect(result.ok).toBe(false);
    expect(result.fieldErrors?.icon).toBeTruthy();
  });
});

describe("filing an entry under a category", () => {
  it("takes the kind from the category, not the form", async () => {
    await addCategory("Install", "wrench", true);
    const id = await categoryId("Install");

    const { job } = await book("Kitchen install", `category:${id}`);
    expect(job).toMatchObject({ kind: "JOB", categoryId: id });
  });

  it("will not file under another business's category", async () => {
    const other = await makeBusiness("Someone Else Ltd");
    const theirs = await prisma.jobCategory.create({
      data: { organizationId: other.org.id, name: "Theirs" },
    });

    const { result, job } = await book("Sneaky", `category:${theirs.id}`);
    expect(result?.fieldErrors?.category).toBeTruthy();
    expect(job).toBeNull();
  });

  it("clears the category when an entry is moved to a built-in", async () => {
    await addCategory("Newsletter", "mail");
    const id = await categoryId("Newsletter");
    const { job } = await book("October issue", `category:${id}`);

    await updateJob(
      IDLE,
      form({
        id: job!.id,
        title: "October issue",
        category: "DEADLINE",
        status: "SCHEDULED",
        priority: "NORMAL",
        durationMinutes: "60",
      }),
    ).catch(() => null);

    expect(
      await prisma.job.findUnique({
        where: { id: job!.id },
        select: { kind: true, categoryId: true },
      }),
    ).toEqual({ kind: "DEADLINE", categoryId: null });
  });
});

describe("changing and deleting a category", () => {
  it("takes its entries along when it starts or stops counting as work", async () => {
    await addCategory("Photo shoot", "camera");
    const id = await categoryId("Photo shoot");
    const { job } = await book("Spring shoot", `category:${id}`);
    expect(job?.kind).toBe("OTHER");

    await saveJobCategory(
      IDLE,
      form({ id, name: "Photo shoot", icon: "camera", countsAsWork: "on" }),
    );

    expect((await prisma.job.findUnique({ where: { id: job!.id } }))?.kind).toBe("JOB");
  });

  it("keeps what was filed under it, reading as the built-in it behaved as", async () => {
    await addCategory("Trade show", "ticket");
    const id = await categoryId("Trade show");
    const { job } = await book("Home expo", `category:${id}`);

    await deleteJobCategory(form({ id }));

    expect(await prisma.jobCategory.count({ where: { organizationId } })).toBe(0);
    expect(
      await prisma.job.findUnique({
        where: { id: job!.id },
        select: { kind: true, categoryId: true },
      }),
    ).toEqual({ kind: "OTHER", categoryId: null });
  });

  it("will not delete another business's category", async () => {
    const other = await makeBusiness("Someone Else Ltd");
    const theirs = await prisma.jobCategory.create({
      data: { organizationId: other.org.id, name: "Theirs" },
    });

    await deleteJobCategory(form({ id: theirs.id }));
    expect(await prisma.jobCategory.findUnique({ where: { id: theirs.id } })).not.toBeNull();
  });
});

describe("hiding built-ins", () => {
  it("hides and shows one, and never Job", async () => {
    await setBuiltInShown(form({ kind: "LAUNCH", shown: "false" }));
    await setBuiltInShown(form({ kind: "EVENT", shown: "false" }));
    await setBuiltInShown(form({ kind: "JOB", shown: "false" }));
    await setBuiltInShown(form({ kind: "LAUNCH", shown: "true" }));

    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
    });
    expect(org.hiddenJobKinds).toBe("EVENT");
  });
});

describe("counting finished work", () => {
  it("counts a category that is work, and not one that only holds a date", async () => {
    await addCategory("Install", "wrench", true);
    await addCategory("Newsletter", "mail");
    const install = await categoryId("Install");
    const newsletter = await categoryId("Newsletter");

    await book("Deck install", `category:${install}`);
    await book("May issue", `category:${newsletter}`);
    await prisma.job.updateMany({
      where: { organizationId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    const now = new Date();
    const totals = await periodTotals(organizationId, {
      from: new Date(now.getTime() - 60 * 60_000),
      to: new Date(now.getTime() + 60 * 60_000),
      label: "test",
      zone: "UTC",
    });
    expect(totals.jobsCompleted).toBe(1);
  });
});
