import { describe, expect, it } from "vitest";

import {
  healthBands,
  netPosition,
  type HealthInput,
} from "@/lib/business-health";

/**
 * The top of the dashboard.
 *
 * Most of what is worth pinning is who sees which tiles, because the failure
 * that matters — an employee shown the business's money — would never show up
 * on the owner's screen, which is the one everybody looks at.
 */

const money = (cents: number) =>
  (cents < 0 ? "-$" : "$") + (Math.abs(cents) / 100).toFixed(2);

function input(overrides: Partial<HealthInput> = {}): HealthInput {
  return {
    seesMoney: true,
    seesExpenses: true,
    seesPipeline: true,
    collectedCents: 4_284_000,
    spentCents: 1_723_000,
    outstandingCents: 842_000,
    outstandingCount: 6,
    overdueCents: 124_000,
    overdueCount: 2,
    pipelineCount: 5,
    pipelineValueCents: 3_150_000,
    activeWork: 14,
    completedThisMonth: 9,
    tasksDueToday: 8,
    tasksOverdue: 3,
    labels: { jobPlural: "Jobs", leadPlural: "Leads" },
    money,
    monthLabel: "September 2026",
    ...overrides,
  };
}

const keys = (tiles: { key: string }[]) => tiles.map((tile) => tile.key);

describe("netPosition", () => {
  it("is what came in less what went out", () => {
    expect(netPosition(4_284_000, 1_723_000)).toEqual({
      cents: 2_561_000,
      tone: "success",
    });
  });

  it("turns red when the month spent more than it collected", () => {
    expect(netPosition(100_000, 250_000)).toEqual({ cents: -150_000, tone: "danger" });
  });

  it("stays neutral on a month with nothing either way", () => {
    expect(netPosition(0, 0)).toEqual({ cents: 0, tone: "neutral" });
  });
});

describe("who sees what", () => {
  it("gives an owner both bands in full", () => {
    const bands = healthBands(input());

    expect(keys(bands.money)).toEqual(["collected", "spent", "net", "outstanding"]);
    expect(keys(bands.work)).toEqual(["pipeline", "work", "tasks", "completed"]);
  });

  it("gives an employee the work band and no money at all", () => {
    const bands = healthBands(
      input({ seesMoney: false, seesExpenses: false, seesPipeline: false }),
    );

    expect(bands.money).toEqual([]);
    expect(keys(bands.work)).toEqual(["work", "tasks", "completed"]);
  });

  it("keeps spending and net from a role that may see only what came in", () => {
    // Seeing invoices does not grant seeing the business's spending, and net
    // would reveal spending by subtraction.
    const bands = healthBands(input({ seesExpenses: false }));

    expect(keys(bands.money)).toEqual(["collected", "outstanding"]);
  });

  it("keeps the pipeline from a role without leads", () => {
    const bands = healthBands(input({ seesPipeline: false }));
    expect(keys(bands.work)).not.toContain("pipeline");
  });
});

describe("the tiles", () => {
  it("shows net as the difference, in the organization's money", () => {
    const net = healthBands(input()).money.find((tile) => tile.key === "net")!;

    expect(net.value).toBe("$25610.00");
    expect(net.sublabel).toBe("Collected minus spent");
  });

  it("folds overdue money into outstanding, and turns it red", () => {
    const outstanding = healthBands(input()).money.find(
      (tile) => tile.key === "outstanding",
    )!;

    expect(outstanding.sublabel).toBe("$1240.00 overdue");
    expect(outstanding.tone).toBe("danger");
  });

  it("calls a clean ledger what it is", () => {
    const outstanding = healthBands(
      input({ outstandingCents: 0, outstandingCount: 0, overdueCents: 0, overdueCount: 0 }),
    ).money.find((tile) => tile.key === "outstanding")!;

    expect(outstanding.sublabel).toBe("Nothing owed");
    expect(outstanding.tone).toBe("success");
  });

  it("uses the organization's own words", () => {
    const bands = healthBands(
      input({ labels: { jobPlural: "Projects", leadPlural: "Opportunities" } }),
    );

    const work = bands.work.find((tile) => tile.key === "work")!;
    const pipeline = bands.work.find((tile) => tile.key === "pipeline")!;
    const completed = bands.work.find((tile) => tile.key === "completed")!;

    expect(work.label).toBe("Active projects");
    expect(pipeline.sublabel).toBe("5 open opportunities");
    expect(completed.label).toBe("Projects completed");
  });

  it("always shows tasks, saying so when nothing is due", () => {
    // A tile that sometimes is not there teaches people not to look for it.
    const tasks = healthBands(input({ tasksDueToday: 0, tasksOverdue: 0 })).work.find(
      (tile) => tile.key === "tasks",
    )!;

    expect(tasks.value).toBe("0");
    expect(tasks.sublabel).toBe("Nothing due today");
    expect(tasks.tone).toBe("success");
  });

  it("flags late tasks before anything else about them", () => {
    const tasks = healthBands(input()).work.find((tile) => tile.key === "tasks")!;

    expect(tasks.sublabel).toBe("3 overdue");
    expect(tasks.tone).toBe("danger");
  });

  it("links each tile to the list behind its number", () => {
    const bands = healthBands(input());
    const all = [...bands.money, ...bands.work];

    // Net is the only one with no single list behind it.
    for (const tile of all) {
      if (tile.key === "net") expect(tile.href).toBeUndefined();
      else expect(tile.href).toMatch(/^\//);
    }
  });
});
