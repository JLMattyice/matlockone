/**
 * Domain vocabularies.
 *
 * SQLite has no enum type, so these columns are plain strings. Every value the
 * app writes must come from one of the tuples below, and every value it reads
 * is narrowed through the matching `is*` guard. Moving to Postgres later means
 * turning these tuples into real Prisma enums without touching call sites.
 */

export type Tone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

export type StatusMeta = { label: string; tone: Tone; description?: string };

// ------------------------------------------------------------------ roles ---

export const ROLES = ["OWNER", "ADMIN", "MANAGER", "EMPLOYEE"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_META: Record<Role, StatusMeta> = {
  OWNER: {
    label: "Owner",
    tone: "accent",
    description: "Full access, including organization settings and billing.",
  },
  ADMIN: {
    label: "Administrator",
    tone: "info",
    description: "Full operational access. Cannot transfer or delete the org.",
  },
  MANAGER: {
    label: "Manager",
    tone: "success",
    description: "Runs day-to-day work: clients, scheduling, quoting, billing.",
  },
  EMPLOYEE: {
    label: "Employee",
    tone: "neutral",
    description: "Sees only their own assigned work. No financial access.",
  },
};

/** Higher outranks lower. Used to stop a user editing someone above them. */
export const ROLE_RANK: Record<Role, number> = {
  OWNER: 4,
  ADMIN: 3,
  MANAGER: 2,
  EMPLOYEE: 1,
};

// ------------------------------------------------------------------ leads ---

export const LEAD_STATUSES = [
  "NEW",
  "CONTACTED",
  "QUALIFIED",
  "ESTIMATE_SENT",
  "WON",
  "LOST",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_STATUS_META: Record<LeadStatus, StatusMeta> = {
  NEW: { label: "New", tone: "info" },
  CONTACTED: { label: "Contacted", tone: "neutral" },
  QUALIFIED: { label: "Qualified", tone: "accent" },
  ESTIMATE_SENT: { label: "Estimate Sent", tone: "warning" },
  WON: { label: "Won", tone: "success" },
  LOST: { label: "Lost", tone: "danger" },
};

export const LEAD_SOURCES = [
  "REFERRAL",
  "WEBSITE",
  "GOOGLE",
  "SOCIAL",
  "REPEAT",
  "WALK_IN",
  "OTHER",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSource, string> = {
  REFERRAL: "Referral",
  WEBSITE: "Website",
  GOOGLE: "Google / Search",
  SOCIAL: "Social media",
  REPEAT: "Repeat customer",
  WALK_IN: "Walk-in",
  OTHER: "Other",
};

// ---------------------------------------------------------------- clients ---

export const CLIENT_TYPES = ["PERSON", "BUSINESS"] as const;
export type ClientType = (typeof CLIENT_TYPES)[number];

export const CLIENT_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

export const CLIENT_STATUS_META: Record<ClientStatus, StatusMeta> = {
  ACTIVE: { label: "Active", tone: "success" },
  INACTIVE: { label: "Inactive", tone: "neutral" },
  ARCHIVED: { label: "Archived", tone: "warning" },
};

// ------------------------------------------------------------------- jobs ---

export const JOB_KINDS = ["JOB", "APPOINTMENT"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  "SCHEDULED",
  "CONFIRMED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STATUS_META: Record<JobStatus, StatusMeta> = {
  SCHEDULED: { label: "Scheduled", tone: "info" },
  CONFIRMED: { label: "Confirmed", tone: "accent" },
  IN_PROGRESS: { label: "In Progress", tone: "warning" },
  COMPLETED: { label: "Completed", tone: "success" },
  CANCELLED: { label: "Cancelled", tone: "danger" },
};

/** Forward transitions offered in the UI. Cancel is allowed from anywhere open. */
export const JOB_STATUS_FLOW: Record<JobStatus, JobStatus[]> = {
  SCHEDULED: ["CONFIRMED", "IN_PROGRESS", "CANCELLED"],
  CONFIRMED: ["IN_PROGRESS", "SCHEDULED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CONFIRMED", "CANCELLED"],
  COMPLETED: ["IN_PROGRESS"],
  CANCELLED: ["SCHEDULED"],
};

export const JOB_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export type JobPriority = (typeof JOB_PRIORITIES)[number];

export const JOB_PRIORITY_META: Record<JobPriority, StatusMeta> = {
  LOW: { label: "Low", tone: "neutral" },
  NORMAL: { label: "Normal", tone: "info" },
  HIGH: { label: "High", tone: "warning" },
  URGENT: { label: "Urgent", tone: "danger" },
};

// -------------------------------------------------------------- estimates ---

export const ESTIMATE_STATUSES = [
  "DRAFT",
  "SENT",
  "VIEWED",
  "ACCEPTED",
  "DECLINED",
  "EXPIRED",
] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const ESTIMATE_STATUS_META: Record<EstimateStatus, StatusMeta> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SENT: { label: "Sent", tone: "info" },
  VIEWED: { label: "Viewed", tone: "accent" },
  ACCEPTED: { label: "Accepted", tone: "success" },
  DECLINED: { label: "Declined", tone: "danger" },
  EXPIRED: { label: "Expired", tone: "warning" },
};

// --------------------------------------------------------------- invoices ---

export const INVOICE_STATUSES = [
  "DRAFT",
  "SENT",
  "VIEWED",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "CANCELLED",
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_STATUS_META: Record<InvoiceStatus, StatusMeta> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SENT: { label: "Sent", tone: "info" },
  VIEWED: { label: "Viewed", tone: "accent" },
  PARTIALLY_PAID: { label: "Partially Paid", tone: "warning" },
  PAID: { label: "Paid", tone: "success" },
  OVERDUE: { label: "Overdue", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

/** Statuses that still owe money and belong in receivables totals. */
export const INVOICE_OPEN_STATUSES: InvoiceStatus[] = [
  "SENT",
  "VIEWED",
  "PARTIALLY_PAID",
  "OVERDUE",
];

// --------------------------------------------------------------- payments ---

export const PAYMENT_METHODS = [
  "CASH",
  "CHECK",
  "CARD",
  "BANK_TRANSFER",
  "ONLINE",
  "OTHER",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH: "Cash",
  CHECK: "Check",
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  ONLINE: "Online payment",
  OTHER: "Other",
};

// --------------------------------------------------------------- expenses ---

export const EXPENSE_CATEGORIES = [
  "MATERIALS",
  "SUBCONTRACTOR",
  "FUEL",
  "VEHICLE",
  "TOOLS",
  "EQUIPMENT",
  "PERMITS",
  "INSURANCE",
  "OFFICE",
  "SOFTWARE",
  "MARKETING",
  "TRAVEL",
  "MEALS",
  "UTILITIES",
  "PAYROLL",
  "TAXES",
  "OTHER",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  MATERIALS: "Materials",
  SUBCONTRACTOR: "Subcontractor",
  FUEL: "Fuel",
  VEHICLE: "Vehicle",
  TOOLS: "Tools",
  EQUIPMENT: "Equipment",
  PERMITS: "Permits & fees",
  INSURANCE: "Insurance",
  OFFICE: "Office & supplies",
  SOFTWARE: "Software",
  MARKETING: "Marketing",
  TRAVEL: "Travel",
  MEALS: "Meals",
  UTILITIES: "Utilities",
  PAYROLL: "Payroll",
  TAXES: "Taxes",
  OTHER: "Other",
};

// ------------------------------------------------------------ line items ---

export const LINE_ITEM_KINDS = [
  "SERVICE",
  "MATERIAL",
  "LABOR",
  "OTHER",
] as const;
export type LineItemKind = (typeof LINE_ITEM_KINDS)[number];

export const LINE_ITEM_KIND_LABELS: Record<LineItemKind, string> = {
  SERVICE: "Service",
  MATERIAL: "Material",
  LABOR: "Labor",
  OTHER: "Other",
};

export const DISCOUNT_TYPES = ["NONE", "PERCENT", "FIXED"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

// ----------------------------------------------------- files, notes, msgs ---

export const ATTACHMENT_KINDS = ["DOCUMENT", "PHOTO", "CONTRACT"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const PHOTO_STAGES = ["BEFORE", "DURING", "AFTER", "OTHER"] as const;
export type PhotoStage = (typeof PHOTO_STAGES)[number];

export const NOTE_VISIBILITIES = ["INTERNAL", "SHARED"] as const;
export type NoteVisibility = (typeof NOTE_VISIBILITIES)[number];

export const NOTIFICATION_TYPES = [
  "JOB_REMINDER",
  "APPOINTMENT_REMINDER",
  "SCHEDULE_CHANGE",
  "JOB_ASSIGNED",
  "INVOICE_DUE",
  "INVOICE_OVERDUE",
  "PAYMENT_RECEIVED",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const MESSAGE_CHANNELS = ["EMAIL", "SMS"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_STATUSES = [
  "QUEUED",
  "SENT",
  "FAILED",
  "CANCELLED",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const RECURRENCE_FREQUENCIES = [
  "DAILY",
  "WEEKLY",
  "MONTHLY",
  "YEARLY",
] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

// ----------------------------------------------------------------- guards ---

function guard<T extends readonly string[]>(values: T) {
  return (value: string | null | undefined): value is T[number] =>
    value != null && (values as readonly string[]).includes(value);
}

export const isRole = guard(ROLES);
export const isLeadStatus = guard(LEAD_STATUSES);
export const isLeadSource = guard(LEAD_SOURCES);
export const isClientStatus = guard(CLIENT_STATUSES);
export const isClientType = guard(CLIENT_TYPES);
export const isJobKind = guard(JOB_KINDS);
export const isJobStatus = guard(JOB_STATUSES);
export const isJobPriority = guard(JOB_PRIORITIES);
export const isEstimateStatus = guard(ESTIMATE_STATUSES);
export const isInvoiceStatus = guard(INVOICE_STATUSES);
export const isPaymentMethod = guard(PAYMENT_METHODS);
export const isExpenseCategory = guard(EXPENSE_CATEGORIES);
export const isLineItemKind = guard(LINE_ITEM_KINDS);
export const isDiscountType = guard(DISCOUNT_TYPES);
export const isAttachmentKind = guard(ATTACHMENT_KINDS);
export const isNoteVisibility = guard(NOTE_VISIBILITIES);
export const isMessageChannel = guard(MESSAGE_CHANNELS);

/** Read a DB string column as a known status, falling back when data is odd. */
export function asStatus<T extends readonly string[]>(
  values: T,
  value: string | null | undefined,
  fallback: T[number],
): T[number] {
  return (values as readonly string[]).includes(value ?? "")
    ? (value as T[number])
    : fallback;
}
