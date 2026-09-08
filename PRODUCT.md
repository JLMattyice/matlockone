# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary — the buyer and daily operator.** Owner-operators and office managers
of small trade businesses: plumbing, electrical, HVAC, landscaping, remodeling
and similar. Typically 1–20 people. They run the business from a truck, a
kitchen table, or a small office, and the software they are replacing is some
mix of a paper calendar, a spreadsheet, a text-message thread and a shoebox of
receipts. They are not IT buyers. Many are actively wary of monthly
subscriptions and of their customer list living on someone else's server.

**Secondary — the crew.** Field technicians who only need today's assignments,
job notes and photos, and who must never see financials. The Employee role
exists for exactly this.

**Third — prospective custom-software clients.** People evaluating Matlock
Software's ability to build them something. For them Matlock One is the work
sample, not the purchase.

In-app roles are Owner, Administrator, Manager and Employee.

## Product Purpose

Matlock One runs the entire job lifecycle for a small trade business in one
place: lead, client, estimate, scheduled job, completed work, invoice, payment,
and the reports over all of it. Success is a business owner who stops
re-entering the same customer's details into four different tools, and who can
tell at a glance what work is booked, what money is owed, and what has landed.

## Positioning

Three things a neighboring product could not truthfully copy:

**It can be software you own, not software you rent.** `npm run desktop:pack`
produces a Windows installer the customer double-clicks. No Node, no terminal,
no account, no subscription. The data stays on their machine and the office PC
serves the crew over the local network. The same codebase also runs hosted —
that is a deployment choice, not a different product.

**It is a re-skinnable template, deliberately.** Business name, logo, colors and
the core record labels ("Jobs" to "Work Orders", "Clients" to "Customers") are
editable in Settings, so one codebase demos to different trades without a
rebuild.

**It is not married to one payment processor, and never touches a card.**
PayPal, Stripe, Square, or just a payment link the business already has. Clients
pay on the processor's own page, on the processor's domain, which keeps Matlock
One entirely out of PCI scope — and it is the only arrangement that works for
the desktop build, where a client at home cannot reach a laptop in the office.

## Operating Context

The office side is a desktop or laptop in a small office or at home. The field
side is a phone or tablet, often outdoors, often one-handed, sometimes on bad
signal. Evaluation happens on a desktop browser, usually by the owner, often
after hours.

The work itself is quotes that have to go out the same day, schedules that
change in the morning, photos taken before and after a job, and invoices that
get chased. Money is the sharp edge: an estimate a client accepted, an invoice
partly paid, a payment recorded twice.

## Capabilities and Constraints

**Built and working** — all seven phases are complete:

- Dashboard: revenue, receivables, upcoming work, jobs in progress, recent
  payments, overdue invoices.
- Clients & Leads: full database, multiple addresses per client, search across
  names/emails/phones/addresses, lead pipeline with conversion to client.
- Scheduling: day/week/month calendars, drag-and-drop rescheduling, an
  unscheduled queue you drag onto the grid, recurring appointments, crew
  assignment.
- Jobs: full status workflow, materials, labor time tracking, before/after
  photo pairing, notes, one-click invoicing of completed work.
- Estimates & Invoices: shared line-item editor with discounts and tax, a
  client-facing link to accept or decline, estimate-to-job conversion, partial
  payments, printable documents.
- Team: roles and permissions, workload, hours, deactivation that preserves
  history.
- Reports: revenue over time, receivables ageing, top services and clients,
  labor by person, lead-source performance, CSV export.
- Global search across clients, leads, jobs, estimates and invoices, scoped to
  what the caller's role can see.

**Constraints and explicitly undecided facts:**

- **Pricing was set on 2026-09-06** and is published: Starter $29/mo, Business
  $59/mo (most popular), Pro $99/mo, with "save 17% with annual billing".
- **Tiers differ by seats, and by nothing else that matters.** 1 person / up to
  10 / unlimited. Every plan carries the whole product *including the desktop
  install*, decided on 2026-09-06: charging more for the install would put
  owning your data behind the most expensive door, which contradicts the
  product's own strongest claim. Seat count is also the only line the software
  could plausibly enforce.
- **There is no macOS build.** `desktop:pack` runs `electron-builder --win`
  only, and a signed, notarized Mac app cannot be produced from Windows. A Mac
  install must not be advertised until a real build exists — it needs a Mac or a
  CI runner, and it is unstarted work.
- **Seat limits are enforced; taking money is not automated.** A signed licence
  carries the plan, seats and expiry, and the application enforces seats on both
  paths that can grow the count. Fulfilment exists and is idempotent: a sale is
  recorded in `Purchase` under the processor's own id behind a unique index, and
  a licence is signed once and kept, so a retry, a double-click or a customer
  chasing a lost email all return the *same* key. `npm run sale` is the
  fulfilment path today.
- **PayPal Subscriptions is built but unconfigured and unproven.** The adapter,
  the webhook route and the subscribe buttons exist; the network calls have
  never run against PayPal, because that needs live credentials. Checkout is
  offered only when `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and
  `PAYPAL_WEBHOOK_ID` are all set, so an unconfigured deployment shows the free
  download rather than a button that fails after taking money. Stripe stays
  `implemented: false`, and a test asserts nothing unimplemented is offered.
- **Renewals are keyed on the payment, never the subscription.** Each period
  arrives as its own `PAYMENT.SALE.COMPLETED` with its own id, so each earns its
  own licence with a fresh expiry. Keying on the subscription id would hand a
  renewing customer back their first, already-expired key.
- **Licence delivery is built, and uses Matlock's own mailbox.** Configured from
  `SYSTEM_MAIL_*`, deliberately separate from the per-customer email settings:
  those credentials belong to a customer and are encrypted per organization,
  and a purchase has no organization to borrow a mailbox from. `OutboxMessage`
  could not be reused for the same reason. Delivery is recorded on the purchase
  (`deliveredAt` / `deliveryError`), never sends twice, and never decides
  whether a sale succeeded — a mail failure is logged and retried through
  `npm run sale -- --deliver`, because the key is already stored and shown on
  the return page.
- **A licence key does not survive SMTP unwrapped.** It is ~300 characters on
  one line and quoted-printable soft-wraps anything past 76. Clients rejoin it
  on decode, so what the customer copies is intact — but any future change to
  how the key is sent (HTML mail especially) has to be checked against that.
- **Prices live in `src/lib/checkout/plans.ts`**, and the marketing page renders
  from it. The advertised price and the charged price cannot drift.
- **The free tier is demo mode, and it is real.** No licence means the whole
  product, capped at `DEMO_SEATS` active people, with no expiry and no
  watermark. The marketing page imports that constant rather than restating the
  number, so the claim cannot drift from the code.
- **The site no longer links `/signup`.** The hosted signup route still exists
  and still creates a full workspace with no plan and no payment; advertising it
  was giving the product away. It needs gating before it is linked again.
- **There is no public download URL yet.** The installer builds locally into
  `dist-installer/`; nothing is hosted. Any download link is a placeholder until
  a real URL exists.
- **"Projects" and "Tasks" are not modules.** The real set is Customers, Leads,
  Jobs, Scheduling, Estimates, Invoices, Payments, Expenses, Team, Documents and
  Reports. Nothing outside that list may be advertised.
- **Expenses tracks spend; it is not bookkeeping.** It records what went out,
  by category, against a job or as overhead, with receipts and reimbursements.
  It does not post to a ledger, file a tax return, or sync with an accounting
  package, and must not be described as doing any of those.
- Email sending is real (the customer's own SMTP or Resend key). SMS and in-app
  card capture are stubbed behind the same interface and must not be described
  as working.
- Sending credentials belong to the customer and are encrypted at rest; no
  shared API key ships inside the installer.
- Stack is the existing Next.js 15 / React 19 / TypeScript / Tailwind v4 /
  Prisma app in this repository. The marketing site is a public route group
  inside it, not a separate project.

## Brand Commitments

- Product name: **Matlock One** (renamed from Work Suite on 2026-09-06, which
  was itself renamed from Fieldbase). Maker:
  **Matlock Software Development**, Lenoir City / Knoxville, TN.
- Matlock One and matlocksoftware.com are siblings: same colors and DNA,
  different personality. The studio site is editorial; the product site is a
  product site.
- Studio palette, sampled live from matlocksoftware.com: forest green
  `#0F3D2E`, gold `#C9A55B`, cream `#F5F1E8`. Type there is Playfair Display
  over Inter.
- The studio's green is a **ground**, not an accent, and no bright green exists
  in the identity. `#2CA36F` was derived for interactive elements — same hue
  family, light enough to carry dark text at 6.2:1. It is the one brand value
  that was not sampled.
- Gold means premium, chosen, or highlighted. It is the page's rarest ink and
  must never become a second body color.
- Marketing grounds are the green-blacks `#080A09` and `#101512` (both are
  green-tinted, G highest, so they sit inside the family).
- **The application** keeps its own light/blue re-skinnable identity with
  `#2563eb`, tokenized in `src/app/globals.css`, and both themes stay
  first-class. **The marketing site is committed dark and deliberately not
  themeable** — it is an argument, not a workspace.
- Voice, inherited from the README: plain, specific, unhyped. It explains
  decisions and their reasons. It avoids marketing superlatives, and it says
  "saved to the outbox" rather than "sent" when that is what happened. Being
  honest about what is *not* built is part of the brand.

## Evidence on Hand

**Real and usable:**

- **A live, seeded demo.** Accounts `owner@demo.test`, `admin@demo.test`,
  `manager@demo.test`, `tech2@demo.test`, all password `demo1234`, against
  deterministic demo data (`prisma/seed.ts`). Signing in as `tech2` visibly
  demonstrates role-based access: financial tiles disappear, six sidebar
  sections vanish, the calendar goes read-only.
- **The real application UI**, available to screenshot from a local dev server.
  Any product imagery on the site must be captured from the running app — no
  mockups, no stock illustration.
- **265 tests** (16 files, all passing as of 2026-09-06; `README.md` still says
  121 and is stale), covering money arithmetic, derived
  document statuses, invoice/payment balance against a real SQLite database, the
  SMTP adapter against a real throwaway SMTP server, payment reconciliation
  idempotency, the desktop recovery tool as a real subprocess, and credential
  encryption. The suite was checked by mutation: four deliberately introduced
  bugs each produced failures.
- **The engineering write-up** in `README.md` — integer-cent money, per-row
  multi-tenancy re-checked with `assertSameOrg()`, database-backed hashed
  sessions, scrypt passwords, formula-injection escaping on CSV export, UUID
  storage paths that never trust an uploaded filename.

**Claimed but not yet supplied:**

- Customer testimonials. The owner says real ones exist; none have been
  provided. The site carries clearly-marked empty slots. **No quote, name,
  company or photo may be invented to fill them.**

**Does not exist — must not be fabricated:**

- Customer logos, user counts, revenue or time-saved metrics, review scores,
  press mentions, awards, funding, team size, founding date, uptime figures,
  certifications, case studies.

## Product Principles

1. **Say only what is true, and say what is not built.** The application already
   refuses to claim an email was sent when it was only queued. Every surface
   inherits that standard: no invented proof, no borrowed credibility, no
   pricing before pricing exists.
2. **The demo is the argument.** A finished product people can sign into beats
   any description of one. Push toward the running app rather than toward more
   copy.
3. **Ownership is the wedge.** For an audience wary of subscriptions and of
   their customer list living elsewhere, "install it, own it, your data stays
   here" is the strongest available position — and it is literally true.
4. **Money must never be described loosely.** Estimates, invoices, partial
   payments and reconciliation are where a wrong impression costs the customer
   real money. Precision here is a brand asset, not a legal footnote.
5. **Two audiences, one page, no dilution.** Trade businesses come first and own
   the page. The Matlock Software byline is a genuine second track, not an
   equal-weight split.

## Accessibility & Inclusion

- The existing app defines one visible focus treatment for every interactive
  element (`src/app/globals.css`); new surfaces keep it rather than inventing a
  second.
- Light and dark must both be correct, including at the `prefers-color-scheme`
  default where no `data-theme` attribute is set.
- Field users are frequently on phones outdoors: real contrast and touch
  targets, not decorative minimums.
- Buyers are non-technical trade professionals. Jargon a plumber would not
  recognize is an accessibility problem here, not just a style one.
