# Matlock One

Field service management for small trade businesses — clients, leads, scheduling,
jobs, estimates, invoicing and payments.

Built as a re-skinnable template: business name, logo, colors and the core
record labels ("Jobs" → "Work Orders", "Clients" → "Customers") are all editable
in Settings, so the same codebase can be demoed to different trades without a
rebuild.

## Two ways to run it

**As a Windows app.** `npm run desktop:pack` produces an installer the customer
double-clicks — no Node, no terminal, no account. Data stays on their machine
and the office PC hosts the team over the local network. See
[DESKTOP.md](DESKTOP.md).

**As a hosted app.** Everything below.

## Running it in development

```bash
npm install && npm run db:push && npm run db:seed && npm run dev
```

Then open http://localhost:3000 and sign in.

| Account | Password | Role | What they see |
|---|---|---|---|
| `owner@demo.test` | `demo1234` | Owner | Everything, including settings |
| `admin@demo.test` | `demo1234` | Administrator | Everything except org transfer |
| `manager@demo.test` | `demo1234` | Manager | Operations and billing, no settings write |
| `tech2@demo.test` | `demo1234` | Employee | Only their own assigned work, no financials |

Signing in as `tech2` is the quickest way to see role-based access working: the
financial dashboard tiles disappear, the sidebar loses six sections, the job
list narrows to their own assignments, the calendar goes read-only, and typing
`/invoices` into the address bar lands on an explanatory "no access" screen
rather than the data.

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Dev server on :3000 |
| `npm run build` | Generates the Prisma client, then a production build |
| `npm test` | Runs the test suite once |
| `npm run desktop:pack` | Builds the Windows installer into `dist-installer/` |
| `npm run desktop:build` | Assembles the desktop bundle without packaging |
| `npm run desktop` | Runs the desktop app from that bundle |
| `npm run test:watch` | Re-runs affected tests as you edit |
| `npm run db:push` | Applies the schema for the current `DATABASE_URL` |
| `npm run schema:sync` | Regenerates `prisma/schema.sqlite.prisma` from the Postgres schema |
| `npm run schema:check` | Fails if that projection is stale or unportable (run it in CI) |
| `npm run db:seed` | Loads demo data (safe to re-run; scoped to the demo org) |
| `npm run db:reset` | **Destroys all data**, recreates the schema, reseeds |
| `npm run db:studio` | Prisma Studio, a table browser for the local database |

`db:reset` wipes the database. It is meant for local development only — never
point it at anything real.

## Stack

- **Next.js 15** (App Router, server components, server actions) + **React 19**
- **TypeScript** in strict mode
- **Tailwind CSS v4**, CSS-variable design tokens, light + dark
- **Prisma 7** over **Postgres** (hosted) or **SQLite** (desktop), via driver
  adapters

### One schema, two databases

Matlock One ships twice from one codebase: hosted on Postgres, and as a desktop
install where the business's records are a SQLite file on their own machine.

`prisma/schema.prisma` is the only schema anyone edits. `npm run schema:sync`
projects it onto `prisma/schema.sqlite.prisma`, changing the datasource provider
and the generator output path and nothing else — so a schema change is written
once. `npm run schema:check` fails if the projection is stale, and also rejects
anything SQLite cannot represent (enums, scalar lists, `Json`, `@db.` native
types), which is what keeps the projection honest.

`DATABASE_URL` decides the rest at runtime. Its scheme selects the driver
adapter in `src/lib/db.ts`, the schema `prisma.config.ts` hands the CLI, and
whether searches ask for case-insensitive matching. An unrecognised URL is
rejected at startup rather than guessed at.

**Searches go through `like()` in `src/lib/search.ts`, never a bare `contains`.**
SQLite's LIKE is case-insensitive for ASCII; Postgres LIKE is not, and needs
`mode: "insensitive"` — which SQLite in turn rejects. Neither spelling is
portable, so the choice is made in one place instead of at 69 call sites. A bare
`contains` still compiles and still passes the SQLite tests; it just quietly
half-works in the cloud, which is exactly the kind of bug that reaches a
customer.

### Where files live

Photos and documents go through a three-function seam in `src/lib/storage/`
(`put` / `get` / `remove`), the same shape as the payment and email seams. Which
store is underneath is decided by the environment:

| Provider | Used by | Direct upload |
| --- | --- | --- |
| `local` | desktop installs, local development | no — and does not need it |
| `s3` | any S3-compatible store: R2, S3, Backblaze, Supabase, MinIO | yes |
| `vercel-blob` | hosted on Vercel | yes |

Local disk is **refused on Vercel**, whose filesystem is read-only and belongs
to a single invocation. Without that check the failure is silent and delayed:
every upload appears to succeed and is a broken link by the next request.

**Uploads bypass the server where they can.** A serverless function's request
body is capped at 4.5MB — under the 15MB this application allows, and under a
great many phone photos. So the browser asks `/api/files/upload-ticket` for a
presigned URL, sends the bytes straight to the store, and hands back a signed
ticket naming the key, the organization, the person and the record. The confirm
step re-reads the object's real size from the store rather than believing the
size the client promised, and checks the ticket's organization against the
caller's own. Where a store cannot presign, the form submits the files normally
and nothing about that path changed.

## How it is put together

```
prisma/schema.prisma     Full domain model for every phase
prisma/seed.ts           Deterministic demo data
src/lib/
  constants.ts           Status vocabularies + display metadata
  money.ts               Cents arithmetic and document totals
  permissions.ts         Role → permission matrix
  auth.ts                Session resolution, login, page guards
  tenancy.ts             Organization scoping helpers
  db.ts                  Prisma client
src/app/(auth)/          Sign in, create workspace
src/app/(app)/           The application shell and its modules
src/components/          Design system and shell components
```

### Decisions worth knowing

**Money is integer cents.** Every currency column is `…Cents: Int`, and tax and
discount rates are basis points (`825` = 8.25%). No floating-point arithmetic
touches money. `computeTotals()` in `src/lib/money.ts` is the single source of
truth for subtotals, discounts and tax, and it apportions a discount across the
taxable slice so a partly non-taxable document is not over-credited.

**Multi-tenancy is in every row.** Every domain table carries `organizationId`.
Queries filter on it, and anything fetched by an id from the URL is re-checked
with `assertSameOrg()`, which 404s rather than 403s so responses cannot be used
to probe which records exist in other tenants.

**Permissions are checked three times, but only one counts.** Middleware keeps
signed-out visitors out, navigation hides sections a role cannot open, and the
server re-checks on every page and action. The first two are convenience; the
third is the enforcement point.

**Sessions are database-backed and hashed.** The cookie carries a random token;
the database stores only its HMAC. A leaked database backup contains no usable
session credentials. Passwords use scrypt from Node's standard library — no
native module to compile.

**Statuses are strings, not enums.** SQLite has no enum type, so they are
validated against the tuples in `src/lib/constants.ts`. They stay strings on
Postgres too: the schema has to project cleanly onto SQLite for the desktop
build, and `npm run schema:check` enforces that.

**Document totals are never trusted from the browser.** The line-item editor
recalculates as you type so the number moves with the form, but `createEstimate`
and `updateEstimate` recompute every figure server-side from the submitted lines
through the same `computeTotals()`. A tampered payload cannot set its own price.

**Expiry is derived, not stored.** An estimate becomes expired purely by the
clock passing its date, so `effectiveEstimateStatus()` computes it at read time
rather than a sweep job rewriting rows. The stored status stays a record of what
a person actually did.

**The client link is the credential.** `/share/estimate/<token>` is addressed by
an unguessable token and selects only the fields that page needs. Its actions
accept a token and a decision — never a record id, a price or an organization —
and refuse anything already decided or expired.

**"Viewed" is recorded from the browser, not the request.** Corporate mail
gateways fetch links before anyone reads them; marking viewed server-side would
report every estimate as read on delivery. Requiring the page to actually run in
a browser makes the signal mean something.

**Search obeys the same permission model as the pages.** Each branch of the
global search is gated on the permission that guards its module, and jobs are
narrowed by the same visibility rule the jobs list uses — so an employee cannot
surface a colleague's job, or any invoice, through the search box.

**Reports separate money billed from money received.** "Invoiced" and
"Collected" are shown side by side rather than merged into one "revenue"
number, because billing in a period is not the same as being paid in it.

**"Net cash" is not profit, and says so.** It is collected less spent over the
same window — nothing is accrued or depreciated, and it counts only what has
been recorded in the app. A report that quietly called that figure profit would
be the most expensive kind of wrong. Spend is split into job costs and overhead
by whether the expense was booked to a job, which is the attribution someone
actually made rather than a guess from its category.

**CSV export escapes formula injection.** A cell starting with `=`, `+`, `-` or
`@` is prefixed with a quote, so a client name cannot become executable in
someone's spreadsheet.

**Uploads never trust the filename.** Storage paths are generated from a UUID
under an organization-prefixed directory; the name that arrived over the wire is
kept only as a display label. Files are served by database id through
`/api/files/[id]`, scoped to the caller's organization — nothing a client sends
selects a file, and a cross-tenant request gets the same 404 as a missing one.

**Deactivating a team member ends live sessions, not just sign-in.** The same
applies to an admin resetting someone's password. Keeping their history intact
is the reason it is never a delete.

**Role changes are guarded three ways:** you can only grant a role you hold the
authority to grant, you cannot change your own role, and the last active owner
cannot be demoted or deactivated.

**Payments are the ledger; the invoice caches a summary of them.**
`amountPaidCents` and `balanceCents` are derived from the payment rows, and
`recalculateInvoice()` runs inside the same transaction as every write that
could move either — adding a payment, removing one, or editing the invoice
total. The summary cannot drift from the rows it summarises, and removing a
payment correctly walks a Paid invoice back to what the client had last seen.

**Invoice status is part stored, part derived.** DRAFT, SENT, VIEWED, PAID and
CANCELLED record something a person did, so they live in the column.
PARTIALLY_PAID and OVERDUE follow from the balance and the calendar, so they are
computed at read time — an invoice can never sit in the database claiming to be
current the day after it lapsed.

**An invoice with payments against it cannot be edited.** Changing the amount
after money has arrived would rewrite what the client agreed to owe, so the app
points you at a credit or a separate invoice instead.

**Recurring jobs are real rows, not computed occurrences.** Each occurrence is
its own Job, so any single visit can be moved, reassigned or cancelled without
disturbing the series. `MAX_OCCURRENCES` in `src/lib/recurrence.ts` bounds how
far ahead one rule can write, so "every day, forever" cannot fill the table.

**Document numbers come from an atomic counter.** `allocateNumber()` bumps the
organization's counter with a database-level `increment` inside the same
transaction that creates the record, so two people creating a job at the same
moment cannot be handed the same number, and a rollback returns the number
rather than burning it.

**Email is real; SMS and card payments are still stubbed behind the same
interface.** Every message is written to an `OutboxMessage` table first and then
handed to whatever account the organization connected under Settings → Email.
With nothing connected the row is still written and stays queued, so the app is
fully demoable with no API keys and no spend — and the UI says "saved to the
outbox", never "sent". Adding SMS or a payment provider means writing one
adapter against the same seam.

**Clients pay on the processor's own page, and Matlock One never sees a card.**
A business connects whichever processor it already uses — PayPal, Stripe,
Square, or just a payment link it already has. Matlock One asks that processor for
a web address to pay at and puts it on the invoice and in the email; the payment
page belongs to the processor, on the processor's domain. That keeps this
application entirely out of PCI scope, and it is the only arrangement that works
for the desktop build, where a client at home cannot reach a laptop in the
office. Reconciliation is by polling for the same reason — a webhook needs an
address the processor can reach.

**A repeated poll cannot record the same payment twice.** Each incoming payment
is stored under the processor's own transaction id behind a unique index on
`(organizationId, provider, externalId)`. The database rejects the duplicate;
nothing depends on a check that could race with itself. Without it, polling a
paid invoice twice would show it overpaid and the client owed a refund.

**Every password box can be unmasked.** Typing a password you cannot see is how
people get locked out of their own software — a capital that did not register, a
trailing space. `PasswordInput` wraps every one of them, and the toggle is a
`type="button"` outside the tab order so it is never submitted and never sits
between the field and the submit button.

**Sending credentials belong to the customer, and are encrypted at rest.** A
shared API key cannot ship inside a downloadable installer: anyone with the
download could extract it and send mail as us. So a business connects its own
mailbox over SMTP or its own Resend key, and that secret is sealed with
AES-256-GCM under a key held outside the database (`ENCRYPTION_KEY`, generated
per installation by the desktop launcher). A copied `.db` file on its own does
not hand over the mailbox, and the plain text is never read back into a form
field — changing it means typing a new one.

## What is built

All seven phases are complete.

| Phase | Scope |
|---|---|
| 1 | Foundation, auth, RBAC, settings & branding, app shell, dashboard |
| 2 | Clients & Leads |
| 3 | Jobs & Scheduling / Calendar |
| 4 | Estimates |
| 5 | Invoicing & Payments |
| 6 | Team, Documents & Photos, Notifications |
| 7 | Reports & Analytics, Global Search |

**Dashboard** — money in against money out over six months, receivables, spend
this month, upcoming work, jobs in progress, recent payments, overdue invoices,
reimbursements owed to the team, quick actions. Every financial figure is
skipped at the query rather than fetched and hidden, so a role without the
permission never has the number in the page at all.

**Clients & Leads** — full database with search across names, emails, phones and
addresses; multiple addresses per client; complete history; a lead pipeline with
conversion to client.

**Scheduling** — day, week and month calendars with drag-and-drop rescheduling,
an unscheduled queue you drag onto the grid, recurring appointments, and crew
assignment.

**Jobs** — the full status workflow, materials, labor time tracking, photos with
before/after pairing, notes, and one-click invoicing of completed work.

**Estimates & Invoices** — a shared line-item editor with discounts and tax, a
client-facing link for accepting or declining, conversion of an accepted
estimate into a scheduled job, payment recording with partial payments, and
printable documents.

**Expenses** — what the business spends, by category, booked against a job or
carried as overhead. Receipts attach to the record, costs can be flagged to
rebill, and anything a team member paid out of pocket is tracked as owed back
until it is settled. An expense booked to a job appears on that job and counts
towards what it cost, so a completed job shows its margin rather than just its
revenue.

**Team** — roles and permissions, workload, hours, deactivation that preserves
history.

**Reports** — money in against money out over time, receivables ageing, spend by
category and vendor, top services and clients, labor by person, lead-source
performance, and CSV export. Spend is gated on the expenses permission, in the
export as well as on the page.

**Global search** — one box across clients, leads, jobs, estimates and invoices,
scoped to what your role can see.

## Tests

```bash
npm test
```

121 tests covering the code where a bug costs money, or where a failure would be
silent:

- **`tests/money.test.ts`** — parsing what people type into cents, rounding,
  and `computeTotals`: discounts, tax on mixed taxable/exempt documents, the
  proportional apportionment, over-discounting, credits, and empty documents.
- **`tests/documents.test.ts`** — the derived statuses. Estimate expiry,
  invoice PAID / OVERDUE / PARTIALLY_PAID precedence, draft and cancelled
  invoices staying put, a stale PAID walking back when a payment is deleted,
  and receivables ageing buckets.
- **`tests/invoice-balance.test.ts`** — runs against a real throwaway SQLite
  database, because the guarantee under test is transactional: the payment rows
  are the ledger and the invoice caches a summary that must not drift from them.
  Also covers document numbering, including that a rolled-back transaction
  gives its number back rather than leaving a gap in the invoice sequence.
- **`tests/email.test.ts`** — runs the SMTP adapter against a real, throwaway
  SMTP server that speaks the actual protocol (`tests/support/smtp-server.ts`),
  rather than a mock of nodemailer that would only prove the mock was called.
  Covers the envelope and headers, that the stored credentials are what get
  authenticated with, and that a rejected password or an unreachable server
  comes back as an explanation a business owner can act on.
- **`tests/payments.test.ts`** — reconciliation, against the real database
  because the guarantee under test is a database constraint: a repeated poll
  records nothing twice, a batch that repeats an old capture still records the
  new one, part-payments leave a balance, and the same id from two different
  processors stays two payments. Also that no provider is offered in the UI
  without an adapter behind it.
- **`tests/dashboard.test.ts`** — the figures everyone opens the app to see:
  spend scoped to this month and this business, money owed to a teammate
  deliberately *not* scoped to the month, both series bucketed onto the same
  six months, and a role without the expenses permission getting nothing
  fetched rather than something hidden.
- **`tests/expenses.test.ts`** — the spend list and its totals, against the real
  database because the guarantee is a Prisma query: another business's spending
  never reaches the figures, the period and flag filters agree with the sums
  beside them, what is owed back to a teammate survives a change of date range,
  and a deleted job drops its link without erasing what it cost. Also the job
  running cost, including that a role which cannot see spend gets a total with
  no invisible component in it.
- **`tests/recovery.test.ts`** — the desktop launcher's account-recovery tool,
  run as a real subprocess and checked with the application's own
  `verifyPassword`. It carries a second copy of the scrypt code because it runs
  outside the Next build, and drift between the two would mean the cure for a
  lockout causes one.
- **`tests/secret-box.test.ts`** — credential encryption: the round trip, that
  the plain text appears in none of the stored columns, a fresh nonce per seal,
  and that a tampered ciphertext or another installation's key returns null
  instead of a wrong password.

The suite was checked by mutation: breaking the discount apportionment, the
`paidAt` reset, the numbering off-by-one and the payment idempotency each
produced failures, so these are tests that would actually catch a regression
rather than tests that merely pass.

## Scheduled work

`sendInvoiceReminders()` in `src/app/(app)/invoices/reminders.ts` chases every
invoice due within three days or already overdue. It is triggered by hand from
the Invoices screen today, but takes no request-specific state, so pointing a
cron job or a queue at it later needs no change. Re-running it is safe: it skips
anything already chased today by checking the outbox, so the record of what was
actually sent decides — not a flag on the invoice.

## Working on it

Do not run `npm run build` while `npm run dev` is running. Both write to
`.next`, and the production build overwrites the chunks the dev server is
serving, which breaks it with confusing `MODULE_NOT_FOUND` errors until you
stop it, delete `.next`, and restart.
# matlockone
