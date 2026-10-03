/**
 * The automations a business can turn on.
 *
 * Deliberately a short list in code rather than a rule builder. A builder asks
 * somebody running a plumbing company to think in triggers, conditions and
 * actions before anything happens at all; this asks them to read four
 * sentences and flick a switch. The cost is that a new automation needs a
 * release — which, for four of them, is the cheaper side of the trade.
 *
 * Most automations make a task: visible on the dashboard, assignable, and
 * unable to embarrass the business in front of a client. The ones marked
 * EMAIL write to the customer instead — a follow-up, a reminder, a request
 * for a review — which is a different order of risk, so every one of them
 * starts switched off (the owner's choice), goes out through the business's
 * own mail account, fires once per thing, and catches up on at most the last
 * two weeks when first turned on rather than writing to everyone who ever
 * owed money.
 *
 * Client-safe: the settings screen renders this list. The code that runs them
 * is in ./run, which is server-only.
 */

export type WorkflowTrigger =
  /** Fired the moment the thing happens, inside the action that does it. */
  | "invoice.paid"
  | "estimate.accepted"
  /** Found by a sweep, because nothing in the product knows what time it is. */
  | "invoice.overdue"
  | "client.idle"
  | "estimate.unanswered"
  | "invoice.due-soon"
  | "job.upcoming"
  | "job.completed";

/** What an automation does when it fires: raise a task, or email the customer. */
export type WorkflowAction = "TASK" | "EMAIL";

export type WorkflowSetting = {
  key: "days" | "dueInDays";
  label: string;
  hint: string;
  min: number;
  max: number;
};

export type WorkflowTemplate = {
  id: string;
  trigger: WorkflowTrigger;
  action: WorkflowAction;
  /** How it reads in the settings list, as a sentence about what will happen. */
  name: string;
  description: string;
  /** What the task it raises is called. `{subject}` is the client or document. Empty for EMAIL. */
  taskTitle: string;
  settings: WorkflowSetting[];
  defaults: { days?: number; dueInDays: number };
};

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "overdue.chase",
    trigger: "invoice.overdue",
    action: "TASK",
    name: "Chase an invoice that has gone overdue",
    description:
      "Raises a task to follow up when an invoice is still unpaid a set number of days past its due date. One task per invoice, however many times the check runs.",
    taskTitle: "Chase {subject} about {document}",
    settings: [
      {
        key: "days",
        label: "Days past due",
        hint: "How late an invoice has to be before this fires.",
        min: 1,
        max: 120,
      },
      {
        key: "dueInDays",
        label: "Give the task",
        hint: "Days from now for the task's own due date.",
        min: 0,
        max: 30,
      },
    ],
    defaults: { days: 7, dueInDays: 1 },
  },
  {
    id: "paid.thank",
    trigger: "invoice.paid",
    action: "TASK",
    name: "Thank a customer who has paid in full",
    description:
      "When the last of an invoice is settled, raises a task to say thank you. Small, and the thing most businesses mean to do and forget.",
    taskTitle: "Thank {subject} for paying {document}",
    settings: [
      {
        key: "dueInDays",
        label: "Give the task",
        hint: "Days from now for the task's own due date.",
        min: 0,
        max: 30,
      },
    ],
    defaults: { dueInDays: 2 },
  },
  {
    id: "accepted.schedule",
    trigger: "estimate.accepted",
    action: "TASK",
    name: "Book the work when a quote is accepted",
    description:
      "The moment an estimate is marked accepted, raises a task to get it on the calendar — the step between winning work and doing it, which is where work goes missing.",
    taskTitle: "Schedule the work for {subject} ({document})",
    settings: [
      {
        key: "dueInDays",
        label: "Give the task",
        hint: "Days from now for the task's own due date.",
        min: 0,
        max: 30,
      },
    ],
    defaults: { dueInDays: 1 },
  },
  {
    id: "idle.followup",
    trigger: "client.idle",
    action: "TASK",
    name: "Check in on a customer who has gone quiet",
    description:
      "Raises a task for any active customer with no work, document or payment for a set number of days. Fires once per customer, not once a week forever.",
    taskTitle: "Check in with {subject} — nothing since {document}",
    settings: [
      {
        key: "days",
        label: "Days of silence",
        hint: "How long since anything happened with that customer.",
        min: 30,
        max: 730,
      },
      {
        key: "dueInDays",
        label: "Give the task",
        hint: "Days from now for the task's own due date.",
        min: 0,
        max: 30,
      },
    ],
    defaults: { days: 90, dueInDays: 3 },
  },

  // ------------------------------------------------------ emails a customer ---
  {
    id: "estimate.followup.email",
    trigger: "estimate.unanswered",
    action: "EMAIL",
    name: "Email a follow-up on an unanswered estimate",
    description:
      "Emails the customer a friendly nudge, with the link to look it over and accept, when an estimate they were sent has had no answer for a set number of days. Once per estimate.",
    taskTitle: "",
    settings: [
      { key: "days", label: "Days after sending", hint: "How long to wait for an answer first.", min: 1, max: 30 },
    ],
    defaults: { days: 3, dueInDays: 0 },
  },
  {
    id: "invoice.due-soon.email",
    trigger: "invoice.due-soon",
    action: "EMAIL",
    name: "Email a reminder before an invoice is due",
    description:
      "Emails the customer a reminder, with the link to pay, a set number of days before an unpaid invoice's due date. Once per invoice.",
    taskTitle: "",
    settings: [
      { key: "days", label: "Days before it's due", hint: "How far ahead to remind.", min: 1, max: 30 },
    ],
    defaults: { days: 3, dueInDays: 0 },
  },
  {
    id: "invoice.overdue.email",
    trigger: "invoice.overdue",
    action: "EMAIL",
    name: "Email a reminder when an invoice is overdue",
    description:
      "Emails the customer when an invoice is still unpaid a set number of days past its due date, with the link to pay. Payments are checked first, so somebody who just paid is not chased. Once per invoice.",
    taskTitle: "",
    settings: [
      { key: "days", label: "Days past due", hint: "How late before the reminder goes.", min: 1, max: 120 },
    ],
    defaults: { days: 7, dueInDays: 0 },
  },
  {
    id: "appointment.reminder.email",
    trigger: "job.upcoming",
    action: "EMAIL",
    name: "Email an appointment reminder",
    description:
      "Emails the customer the day, time and address of a booked visit ahead of time. Rescheduling a visit sends a new reminder for the new day.",
    taskTitle: "",
    settings: [
      { key: "days", label: "Days before the visit", hint: "1 is the day before.", min: 1, max: 7 },
    ],
    defaults: { days: 1, dueInDays: 0 },
  },
  {
    id: "review.request.email",
    trigger: "job.completed",
    action: "EMAIL",
    name: "Email a request for a review",
    description:
      "A set number of days after work is completed, thanks the customer and asks for a review at your review link. Everyone is asked the same way, happy or not, and each customer only once.",
    taskTitle: "",
    settings: [
      { key: "days", label: "Days after the work", hint: "Give it time to be appreciated.", min: 0, max: 30 },
    ],
    defaults: { days: 2, dueInDays: 0 },
  },
];

/** The sweep-driven triggers. */
const SCHEDULED_TRIGGERS: WorkflowTrigger[] = [
  "invoice.overdue",
  "client.idle",
  "estimate.unanswered",
  "invoice.due-soon",
  "job.upcoming",
  "job.completed",
];

/** Whether this automation waits for a sweep rather than firing on an event. */
export function isScheduled(template: WorkflowTemplate): boolean {
  return SCHEDULED_TRIGGERS.includes(template.trigger);
}

export function templateById(id: string): WorkflowTemplate | null {
  return WORKFLOW_TEMPLATES.find((template) => template.id === id) ?? null;
}

export type WorkflowConfig = { days: number; dueInDays: number };

/**
 * The settings an automation will actually use.
 *
 * Stored config is JSON written by a form, so every value is treated as
 * suspect: anything missing, unparseable or outside the template's own range
 * falls back to the default rather than refusing to run. An automation that
 * stops working because a number was odd is worse than one that runs with the
 * number it shipped with.
 */
export function resolveConfig(
  template: WorkflowTemplate,
  raw: string | null | undefined,
): WorkflowConfig {
  const defaults: WorkflowConfig = {
    days: template.defaults.days ?? 0,
    dueInDays: template.defaults.dueInDays,
  };

  if (!raw) return defaults;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return defaults;
  }

  const clamped = (key: WorkflowSetting["key"]) => {
    const setting = template.settings.find((option) => option.key === key);
    if (!setting) return defaults[key];

    const value = Number(parsed[key]);
    if (!Number.isFinite(value)) return defaults[key];

    return Math.min(setting.max, Math.max(setting.min, Math.round(value)));
  };

  return { days: clamped("days"), dueInDays: clamped("dueInDays") };
}

/** Fills the task title, which is the only templated string here. */
export function taskTitleFor(
  template: WorkflowTemplate,
  parts: { subject: string; document: string },
): string {
  return template.taskTitle
    .replace("{subject}", parts.subject)
    .replace("{document}", parts.document)
    .slice(0, 200);
}
