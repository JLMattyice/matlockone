/**
 * What the top of the dashboard says, decided in one place.
 *
 * The dashboard used to open with counts of things — jobs, invoices, clients.
 * Counts answer "how much is in here", which nobody asks. The question an owner
 * opens this screen with is "how is the business doing", and that has two
 * halves: money (what came in, what went out, what is left over, what is still
 * owed) and work (what might come in, what is under way, what is due, what got
 * finished).
 *
 * Pure, so which tiles a role sees is tested rather than eyeballed. Showing an
 * employee the money band would be a real leak, and it is not the kind of thing
 * a screenshot of the owner's dashboard would catch.
 */

export type HealthTone = "neutral" | "brand" | "success" | "warning" | "danger";

export type HealthIcon =
  | "collected"
  | "spent"
  | "net"
  | "outstanding"
  | "pipeline"
  | "work"
  | "tasks"
  | "completed";

export type HealthTile = {
  key: string;
  label: string;
  value: string;
  sublabel: string;
  tone: HealthTone;
  icon: HealthIcon;
  href?: string;
};

export type HealthInput = {
  /** What this person may see. Each band and tile is gated on its own. */
  seesMoney: boolean;
  seesExpenses: boolean;
  seesPipeline: boolean;

  collectedCents: number;
  spentCents: number;
  outstandingCents: number;
  outstandingCount: number;
  overdueCents: number;
  overdueCount: number;

  pipelineCount: number;
  pipelineValueCents: number;

  activeWork: number;
  completedThisMonth: number;
  tasksDueToday: number;
  tasksOverdue: number;

  /** The organization's own words, so an agency sees Projects. */
  labels: { jobPlural: string; leadPlural: string };
  /** Formats cents in the organization's currency and locale. */
  money: (cents: number) => string;
  /** "September 2026", computed by the caller so this stays clock-free. */
  monthLabel: string;
};

/**
 * What is left over, and whether that is good news.
 *
 * Cash basis — money collected against money spent in the same month — which
 * is what "did we make money this month" means to somebody running a small
 * business, rather than what an accountant would call profit. The sublabel
 * says so, so nobody mistakes it for the other thing.
 */
export function netPosition(collectedCents: number, spentCents: number) {
  const cents = collectedCents - spentCents;

  const tone: HealthTone =
    cents > 0 ? "success" : cents < 0 ? "danger" : "neutral";

  return { cents, tone };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`) {
  return count === 1 ? singular : pluralForm;
}

export function healthBands(input: HealthInput): {
  money: HealthTile[];
  work: HealthTile[];
} {
  const money: HealthTile[] = [];
  const work: HealthTile[] = [];

  // ------------------------------------------------------------- money ---

  if (input.seesMoney) {
    money.push({
      key: "collected",
      label: "Collected",
      value: input.money(input.collectedCents),
      sublabel: input.monthLabel,
      tone: "brand",
      icon: "collected",
      href: "/payments",
    });

    // What went out is its own permission. A role that may see what came in
    // does not thereby get to see the business's spending.
    if (input.seesExpenses) {
      money.push({
        key: "spent",
        label: "Spent",
        value: input.money(input.spentCents),
        sublabel: input.monthLabel,
        tone: "neutral",
        icon: "spent",
        href: "/expenses",
      });

      const net = netPosition(input.collectedCents, input.spentCents);
      money.push({
        key: "net",
        label: "Net",
        value: input.money(net.cents),
        sublabel: "Collected minus spent",
        tone: net.tone,
        icon: "net",
      });
    }

    // Overdue money folds into this tile rather than taking one of its own,
    // and turns it red: the number that matters most about money owed is how
    // much of it is late.
    money.push({
      key: "outstanding",
      label: "Outstanding",
      value: input.money(input.outstandingCents),
      sublabel:
        input.overdueCount > 0
          ? `${input.money(input.overdueCents)} overdue`
          : input.outstandingCount > 0
            ? `${input.outstandingCount} unpaid ${plural(input.outstandingCount, "invoice")}`
            : "Nothing owed",
      tone: input.overdueCount > 0 ? "danger" : input.outstandingCount > 0 ? "warning" : "success",
      icon: "outstanding",
      href: "/invoices",
    });
  }

  // -------------------------------------------------------------- work ---

  if (input.seesPipeline) {
    work.push({
      key: "pipeline",
      label: "Open pipeline",
      value: input.money(input.pipelineValueCents),
      sublabel:
        input.pipelineCount > 0
          ? `${input.pipelineCount} open ${input.labels.leadPlural.toLowerCase()}`
          : `No open ${input.labels.leadPlural.toLowerCase()}`,
      tone: input.pipelineCount > 0 ? "brand" : "neutral",
      icon: "pipeline",
      href: "/leads",
    });
  }

  work.push({
    key: "work",
    label: `Active ${input.labels.jobPlural.toLowerCase()}`,
    value: String(input.activeWork),
    sublabel: "Scheduled or under way",
    tone: "neutral",
    icon: "work",
    href: "/jobs",
  });

  // Always shown, unlike the earlier tile that appeared only when something
  // was due. A number that sometimes is not there teaches people not to look
  // for it; "nothing due" is information too.
  work.push({
    key: "tasks",
    label: "Tasks due",
    value: String(input.tasksDueToday),
    sublabel:
      input.tasksOverdue > 0
        ? `${input.tasksOverdue} overdue`
        : input.tasksDueToday > 0
          ? "Nothing late"
          : "Nothing due today",
    tone: input.tasksOverdue > 0 ? "danger" : input.tasksDueToday > 0 ? "warning" : "success",
    icon: "tasks",
    href: "/tasks",
  });

  work.push({
    key: "completed",
    label: `${input.labels.jobPlural} completed`,
    value: String(input.completedThisMonth),
    sublabel: input.monthLabel,
    tone: "success",
    icon: "completed",
    href: "/jobs",
  });

  return { money, work };
}
