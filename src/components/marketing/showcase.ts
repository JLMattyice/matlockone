import { businessType } from "@/lib/business-types";
import {
  NAVIGATION,
  resolveLabel,
  type NavIcon,
} from "@/lib/navigation";

/**
 * What the marketing page shows of each screen.
 *
 * Which screens there are, what they are called and how they are grouped is
 * not written here: it is read from the application's own sidebar, so a screen
 * added to the app appears on the page and a renamed one is renamed on it. Only
 * the words and the sample rows are authored. Figures are demonstration data
 * for a business that does not exist.
 *
 * Statuses in the sample rows are the app's own labels (constants.ts), checked
 * by tests/marketing-showcase.test.ts, so a visitor never reads a badge the
 * software cannot show.
 */

export type BadgeTone = "green" | "gold" | "neutral" | "warn";
export type Column = { key: string; label: string; align?: "right" };
export type Row = Record<string, string> & { status?: string; tone?: BadgeTone };

type Showcase = {
  headline: string;
  body: string;
  columns: Column[];
  rows: Row[];
  chart?: boolean;
};

export type Module = Showcase & { id: string; label: string; icon: NavIcon };
export type ModuleGroup = { title: string; modules: Module[] };

/** The business in the frame is a plumber, so it speaks the Contractor preset. */
const SAMPLE_LABELS = businessType("CONTRACTOR").labels;

/**
 * Keyed by the screen's address in the app. Settings has no entry on purpose:
 * it is where the business is set up, not a screen anyone works in.
 */
export const SHOWCASE: Record<string, Showcase> = {
  "/dashboard": {
    headline: "The morning read",
    body: "Money collected, spent and still owed this month, then the work: what is booked, what is under way and which tasks are due — before the first call.",
    columns: [
      { key: "item", label: "This month" },
      { key: "detail", label: "Detail" },
      { key: "amount", label: "Amount", align: "right" },
    ],
    rows: [
      { item: "Collected", detail: "23 payments", amount: "$42,850.00" },
      { item: "Spent", detail: "Materials, fuel and rent", amount: "$11,940.00" },
      { item: "Outstanding", detail: "7 invoices", amount: "$9,860.00" },
      { item: "Open pipeline", detail: "5 leads", amount: "$18,300.00" },
    ],
  },
  "/my-day": {
    headline: "The crew's day on one screen",
    body: "Clock in, today's visits in order, and the big buttons a tech reaches for: directions, call the customer, start the timer, a photo, a note, done. A buzz on their phone when they are put on a job or the day changes.",
    columns: [
      { key: "time", label: "Time" },
      { key: "visit", label: "Visit" },
      { key: "status", label: "Status", align: "right" },
    ],
    rows: [
      { time: "8:00 AM", visit: "Water heater swap · Ellis", status: "Completed", tone: "gold" },
      { time: "10:30 AM", visit: "Leak under the sink · Ortega", status: "In Progress", tone: "green" },
      { time: "1:00 PM", visit: "Annual inspection · Park", status: "Scheduled", tone: "neutral" },
    ],
  },
  "/tasks": {
    headline: "Nothing slips through",
    body: "To-dos with a due date and a person, tied to the client, job or lead they are about. Automations add some for you: an overdue invoice to chase, an accepted estimate to book, a client who has gone quiet.",
    columns: [
      { key: "task", label: "Task" },
      { key: "about", label: "About" },
      { key: "who", label: "Who" },
      { key: "due", label: "Due" },
    ],
    rows: [
      { task: "Chase the overdue invoice", about: "INV-0460", who: "Lane", due: "Today" },
      { task: "Book the accepted work", about: "EST-1043", who: "Priya", due: "Tomorrow" },
      { task: "Order the replacement panel", about: "JOB-1164", who: "Tariq", due: "Friday" },
    ],
  },
  "/messages": {
    headline: "Talk to the crew in one place",
    body: "Direct and group conversations, and a thread on every job where the photos sent are saved to the job. Internal only — nothing in a thread is ever sent to a client.",
    columns: [
      { key: "thread", label: "Conversation" },
      { key: "latest", label: "Latest" },
      { key: "when", label: "When" },
    ],
    rows: [
      { thread: "JOB-1167 · Lakeshore Dental", latest: "Priya: Old unit is out, photos attached", when: "9:42 AM" },
      { thread: "Whole crew", latest: "Tom: Running 15 minutes behind", when: "8:10 AM" },
      { thread: "Tariq", latest: "Permit came through for Old Mill Ct", when: "Yesterday" },
    ],
  },
  "/schedule": {
    headline: "Drag it to move it",
    body: "Day, week and month. Unscheduled work waits in a queue you drag onto the grid, repeat visits book themselves, and each person's schedule can follow them into Google, Outlook or Apple Calendar.",
    columns: [
      { key: "time", label: "Time" },
      { key: "what", label: "Job" },
      { key: "who", label: "Crew" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { time: "8:30 AM", what: "AC unit replacement", who: "Priya + Tom", status: "Confirmed", tone: "gold" },
      { time: "10:30 AM", what: "Drain clearing", who: "Simone", status: "Confirmed", tone: "gold" },
      { time: "11:30 AM", what: "Panel upgrade", who: "Tariq", status: "Scheduled", tone: "neutral" },
      { time: "2:00 PM", what: "Thermostat replacement", who: "Priya", status: "In Progress", tone: "green" },
    ],
  },
  "/jobs": {
    headline: "The work itself",
    body: "Materials, hours, before-and-after photos and notes — all attached to the job they belong to. Finished work becomes an invoice in one click.",
    columns: [
      { key: "ref", label: "Job" },
      { key: "client", label: "Client" },
      { key: "crew", label: "Crew" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { ref: "JOB-1167", client: "Lakeshore Dental", crew: "Priya, Tom", status: "In Progress", tone: "green" },
      { ref: "JOB-1166", client: "Oscar Nakamura", crew: "Simone", status: "Scheduled", tone: "neutral" },
      { ref: "JOB-1164", client: "Delia Moreau", crew: "Tariq", status: "Completed", tone: "gold" },
    ],
  },
  "/estimates": {
    headline: "Quotes that turn into work",
    body: "The client accepts or declines on a private link. An accepted estimate becomes a job — booked straight onto the calendar if you like — without anything being retyped.",
    columns: [
      { key: "ref", label: "Estimate" },
      { key: "client", label: "Client" },
      { key: "total", label: "Total", align: "right" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { ref: "EST-1043", client: "Bev Hollingsworth", total: "$2,480.00", status: "Accepted", tone: "green" },
      { ref: "EST-1042", client: "Marisol Vega", total: "$3,200.00", status: "Viewed", tone: "gold" },
      { ref: "EST-1041", client: "Tom Delacroix", total: "$980.00", status: "Sent", tone: "neutral" },
    ],
  },
  "/invoices": {
    headline: "Billed, and chased",
    body: "Emailed with a pay link and a PDF. Reminders check with the payment processor first, so nobody is chased for a bill they paid this morning. An invoice can repeat weekly, monthly or yearly, and a client can put it on PayPal auto-pay.",
    columns: [
      { key: "ref", label: "Invoice" },
      { key: "client", label: "Client" },
      { key: "balance", label: "Balance", align: "right" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { ref: "INV-0461", client: "Lakeshore Dental", balance: "$0.00", status: "Paid", tone: "green" },
      { ref: "INV-0460", client: "Delia Moreau", balance: "$1,240.00", status: "Overdue", tone: "warn" },
      { ref: "INV-0459", client: "Bev Hollingsworth", balance: "$480.00", status: "Partially Paid", tone: "gold" },
    ],
  },
  "/payments": {
    headline: "However you already take money",
    body: "PayPal, Stripe, Square, Clover, Shopify, or a payment link you already have. Clients pay on the processor's own page — Matlock One never sees a card — and what they pay is recorded against the invoice without anyone typing it in.",
    columns: [
      { key: "date", label: "Date" },
      { key: "client", label: "Client" },
      { key: "method", label: "Method" },
      { key: "amount", label: "Amount", align: "right" },
    ],
    rows: [
      { date: "Sep 4", client: "Lakeshore Dental", method: "Online payment", amount: "$2,480.00" },
      { date: "Sep 2", client: "Oscar Nakamura", method: "Card", amount: "$615.00" },
      { date: "Aug 29", client: "Bev Hollingsworth", method: "Check", amount: "$500.00" },
    ],
  },
  "/expenses": {
    headline: "What went out, and what for",
    body: "Spending by category, against a job or as overhead, with the receipt attached and anything owed back to whoever paid. Rent, software and insurance can repeat on their own. It tracks spending; it is not bookkeeping.",
    columns: [
      { key: "date", label: "Date" },
      { key: "vendor", label: "Vendor" },
      { key: "category", label: "Category" },
      { key: "for", label: "For" },
      { key: "amount", label: "Amount", align: "right" },
    ],
    rows: [
      { date: "Sep 4", vendor: "Ferguson Supply", category: "Materials", for: "JOB-1167", amount: "$1,184.20" },
      { date: "Sep 3", vendor: "Shell", category: "Fuel", for: "Overhead", amount: "$86.40" },
      { date: "Sep 1", vendor: "State Farm", category: "Insurance", for: "Repeats monthly", amount: "$212.00" },
    ],
  },
  "/clients": {
    headline: "One record per client",
    body: "Every address, every job, every quote and every dollar they have ever paid on one page, with a timeline of everything that has happened. Already keep a list? Bring it in from a spreadsheet in one go.",
    columns: [
      { key: "name", label: "Client" },
      { key: "where", label: "Location" },
      { key: "jobs", label: "Jobs" },
      { key: "balance", label: "Balance", align: "right" },
    ],
    rows: [
      { name: "Lakeshore Dental", where: "Fairhaven", jobs: "14", balance: "$0.00" },
      { name: "Bev Hollingsworth", where: "Kingsbury", jobs: "3", balance: "$480.00" },
      { name: "Oscar Nakamura", where: "Beaumont Ave", jobs: "7", balance: "$0.00" },
      { name: "Delia Moreau", where: "Old Mill Ct", jobs: "2", balance: "$1,240.00" },
    ],
  },
  "/leads": {
    headline: "Before they are clients",
    body: "A pipeline from New to Won, with what each stage is worth and where each lead came from. A won lead becomes a client without being typed in again.",
    columns: [
      { key: "name", label: "Lead" },
      { key: "source", label: "Source" },
      { key: "value", label: "Value", align: "right" },
      { key: "status", label: "Status" },
    ],
    rows: [
      { name: "Marisol Vega", source: "Referral", value: "$3,200", status: "Estimate sent", tone: "gold" },
      { name: "Tom Delacroix", source: "Google", value: "$980", status: "Contacted", tone: "neutral" },
      { name: "Priya Raghavan", source: "Repeat", value: "$6,400", status: "Won", tone: "green" },
    ],
  },
  "/team": {
    headline: "Who can see what",
    body: "An employee sees the jobs assigned to them and nothing financial. Roles are re-checked on the server for every page and every action.",
    columns: [
      { key: "name", label: "Name" },
      { key: "role", label: "Role" },
      { key: "week", label: "This week" },
      { key: "status", label: "Money" },
    ],
    rows: [
      { name: "Lane Matlock", role: "Owner", week: "—", status: "Full access", tone: "gold" },
      { name: "Priya Raghavan", role: "Manager", week: "32h", status: "Billing", tone: "green" },
      { name: "Tariq Nasser", role: "Employee", week: "38h", status: "No access", tone: "neutral" },
    ],
  },
  "/catalog": {
    headline: "Your price list, priced once",
    body: "The services, materials and labor you sell, picked into any estimate or invoice instead of retyped. Bring an existing price list in from a spreadsheet. Changing a price here never rewrites a document already sent.",
    columns: [
      { key: "item", label: "Item" },
      { key: "kind", label: "Kind" },
      { key: "unit", label: "Unit" },
      { key: "price", label: "Price", align: "right" },
    ],
    rows: [
      { item: "Water heater install, 50 gal", kind: "Service", unit: "ea", price: "$1,850.00" },
      { item: "Drain clearing", kind: "Service", unit: "ea", price: "$185.00" },
      { item: "Labor", kind: "Labor", unit: "hr", price: "$95.00" },
      { item: "PEX pipe, 1/2 in", kind: "Material", unit: "ft", price: "$0.85" },
    ],
  },
  "/reports": {
    headline: "Billed is not the same as banked",
    body: "Invoiced and collected sit side by side rather than merged into one revenue number. Spending, what is owed, recurring revenue, top clients and services, labor by person and where work came from follow — and the whole report exports to a spreadsheet.",
    columns: [],
    rows: [],
    chart: true,
  },
  "/files": {
    headline: "Photos and paperwork, attached",
    body: "Before-and-after photos pair up on the job. Files are served by database id and scoped to your business — a filename never selects a file.",
    columns: [
      { key: "file", label: "File" },
      { key: "job", label: "Attached to" },
      { key: "size", label: "Size", align: "right" },
    ],
    rows: [
      { file: "panel-before.jpg", job: "JOB-1164", size: "2.4 MB" },
      { file: "panel-after.jpg", job: "JOB-1164", size: "2.1 MB" },
      { file: "permit-4471.pdf", job: "JOB-1167", size: "184 KB" },
    ],
  },
};

/** The app's sidebar, in its order and its words, less what has no showcase. */
export const MODULE_GROUPS: ModuleGroup[] = NAVIGATION.map((group) => ({
  title: group.title,
  modules: group.items.flatMap((item) => {
    const showcase = SHOWCASE[item.href];
    return showcase
      ? [
          {
            ...showcase,
            id: item.href,
            label: resolveLabel(item, SAMPLE_LABELS),
            icon: item.icon,
          },
        ]
      : [];
  }),
})).filter((group) => group.modules.length > 0);

export const MODULES: Module[] = MODULE_GROUPS.flatMap((group) => group.modules);
