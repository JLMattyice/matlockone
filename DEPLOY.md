# Deploying Matlock One

The hosted product: one deployment, many businesses, reachable from a phone
anywhere. The desktop build is unaffected by everything here — same application
code, different database and different file store. See `DESKTOP.md` for that one.

## What to provision first

This deployment uses **Supabase** for both the database and the file store — one
dashboard, one bill. Nothing below is Supabase-specific in the code: the database
is plain Postgres and the bucket is reached over the S3 protocol, so either half
can move later without a code change.

### 1. The database

Supabase gives every project several connection strings. Take **two**, from
**Project Settings → Database → Connection string**:

| Setting | Which Supabase string | Why |
| --- | --- | --- |
| `DATABASE_URL` | **Transaction pooler**, port `6543` | Serverless instances multiply under load and each opens its own pool. Postgres runs out of connections long before the app runs out of capacity. |
| `DIRECT_DATABASE_URL` | **Direct connection**, port `5432` | Migrations need a session they can hold. A transaction pooler will not give them one, and `prisma migrate deploy` fails against it. |

Do **not** append `?pgbouncer=true` or `?connection_limit=…`. Those are
parameters for Prisma's own query engine; this app talks to Postgres through the
`pg` driver adapter instead, and the pool size is set by `DATABASE_POOL_MAX`
(default 3 on Vercel).

> **The one sharp edge.** Supabase's transaction pooler does not support prepared
> statements. If the logs show `prepared statement "s0" already exists`, move
> `DATABASE_URL` to the **session pooler** (port `5432` on the pooler host). You
> trade some connection efficiency for correctness, which is the right way round.
> Try the transaction pooler first — it is the better fit for serverless.

### 2. The file store

Under **Storage**, create a bucket and leave it **private**. Every read is served
through `/api/files/[id]`, which checks the session and the organization before
it serves a byte; a public bucket makes that check decorative.

Then **Project Settings → Storage → S3 connection** gives the endpoint and
region, and **S3 Access Keys** issues the key pair:

```
STORAGE_PROVIDER="s3"
S3_BUCKET="<your bucket name>"
S3_ENDPOINT="https://<project-ref>.supabase.co/storage/v1/s3"
S3_REGION="<your project region, e.g. us-east-1>"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
S3_FORCE_PATH_STYLE="true"
```

`S3_FORCE_PATH_STYLE` is required here: Supabase addresses buckets by path
rather than by subdomain, and the default virtual-host style will not resolve.

## Environment

```
# Database — see the table above. Transaction pooler, then direct.
DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres"
DIRECT_DATABASE_URL="postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres"

# Signs session cookies. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET="..."

# Encrypts mail passwords and payment API keys before they are stored.
# Generate the same way.
ENCRYPTION_KEY="..."

# The address clients receive links to. Optional on Vercel, which supplies its
# own production domain — set it as soon as there is a real one.
APP_URL="https://app.example.com"

# Closes public sign-up. Create the owner's account first, then set this and
# redeploy; everyone else is added under Team.
ALLOW_SIGNUP="false"

# Lets Vercel's morning call run the automations — see Automations below.
# Generate the same way as SESSION_SECRET.
CRON_SECRET="..."

# File storage — Supabase Storage over the S3 protocol.
STORAGE_PROVIDER="s3"
S3_BUCKET="..."
S3_ENDPOINT="https://<project-ref>.supabase.co/storage/v1/s3"
S3_REGION="<project region>"
S3_ACCESS_KEY_ID="..."
S3_SECRET_ACCESS_KEY="..."
S3_FORCE_PATH_STYLE="true"
```

> **`ENCRYPTION_KEY` can never change.** Every stored mail password and payment
> API key is encrypted under it. Rotating it does not lock those credentials —
> it destroys them, and every business on the deployment has to re-enter every
> connected account. Generate it once, put it somewhere you will still have in
> five years, and do not keep it in the same backup as the database.

## Deploying

`vercel.json` sets the build command to `npm run build`. Migrations are **not**
run by it, deliberately.

A build container is a poor place to migrate a database. It needs a second
connection string with different properties from the one the application uses,
it runs on every deployment including previews, and when it fails it fails as a
build error rather than as a database error — several steps away from the thing
that is actually wrong.

So migrations are run by hand, from a machine that already has the credentials:

```
npm run db:deploy
```

with `DATABASE_URL` (or `DIRECT_DATABASE_URL`, which wins when set) in your local
`.env` pointing at the hosted database. Run it after any deployment that adds a
migration, before or just after the deploy — the app tolerates a schema slightly
ahead of the code, not one behind it.

`DIRECT_DATABASE_URL` is therefore optional. Set it only if you run migrations
somewhere that cannot hold a session on the pooled connection.

A development `.env` points `DATABASE_URL` at `file:./dev.db`, so the command
above run as-is would reach the local SQLite file and fail with P3005 — an
error about baselining a production database, describing neither the database
it touched nor the credentials it lacked. `scripts/require-hosted-database.mjs`
stops it first and says what to set. The usual way is one command:

```
DATABASE_URL="postgresql://…:5432/postgres" npm run db:deploy
```

Set `DATABASE_URL` rather than only `DIRECT_DATABASE_URL`, even though the
latter is what connects: `prisma.config.ts` chooses *which schema to load* by
whether `DATABASE_URL` begins with `file:`, so setting only the direct one
carries the SQLite schema to Postgres. The guard refuses that pair too.

### When it will not connect

`npm run db:check` prints what `DATABASE_URL` and `DIRECT_DATABASE_URL` parse
to — user, host, and the password's length. It never prints the password, and
it connects to nothing.

It exists because every failure here arrives described as something else:

| What Prisma says | What it usually means |
| --- | --- |
| `P1000: Authentication failed` | The password is right but the URL split early, because a reserved character in it was never percent-encoded. Or the password is genuinely unknown — see below. |
| `FATAL: tenant/user postgres.… not found` | The string is a documentation example nobody edited, or the project ref does not belong to that pooler host. |
| `the scheme is not recognized` | The variable holds `<direct connection string>`, angle brackets and all. |
| Authentication failed, user `postgres` | The Direct connection string was copied instead of the Session pooler one. The poolers need `postgres.<project-ref>`. |

**The database password is not the Supabase account login.** It is generated at
project creation, shown once, and cannot be recovered — only reset, under
Project Settings → Database. A reset changes what the deployed app needs too,
so update `DATABASE_URL` on the host and redeploy in the same sitting or the
live site loses its database on the next request.

Until it is reset, a migration can still be applied by hand: paste the
`migration.sql` into Supabase's SQL editor wrapped in `DO $$ ... IF
to_regclass('public."Table"') IS NULL ... END $$;` so it is safe to run twice.
That leaves Prisma's `_prisma_migrations` table not knowing it ran, which
`prisma migrate resolve --applied <name>` squares up once credentials work
again.

## First run

There is no seeded account. The first person to reach `/signup` creates their
own organization and becomes its owner; everybody else is invited from
**Team**. Nothing about that flow is specific to hosting — it is the same one
the desktop build uses.

### The demo workspace

The landing page invites visitors to sign in and try a workspace with a year of
work already in it. That workspace comes from `prisma/seed.ts`, and it has to
be put there deliberately:

```
DATABASE_URL="<the hosted connection string>" npm run db:seed
```

The variable goes on the command rather than in `.env`: an environment variable
that is already set wins over the file, so a local `.env` pointing at `dev.db`
does not quietly pull the seed back to SQLite. The seed reaches its database
through `createPrismaClient()`, the same adapter selection the application
uses, so the only thing deciding Postgres or SQLite is that URL.

Re-running it is safe and is how the demo gets cleaned up. The seed deletes the
organization by slug first and the cascade takes every child row with it, so a
reseed replaces the workspace rather than adding a second one. The data is
deterministic apart from dates, which are generated relative to today — so the
schedule looks live every time, and the dashboard figures do not move between
walkthroughs.

Without this, the deployment has no users at all, and `isFirstRun()` sends
every route to `/signup` — including the `/login` the landing page points at.

## Automations

Two of the automations wait for a date rather than an event: chasing an
invoice some days past due, and checking in on a customer who has gone quiet.
Nothing in a serverless deployment wakes up on its own, so `vercel.json`
schedules a call to `/api/cron/automations` at 11:00 UTC every day — early
morning across the US — which sweeps every business that has one of them on.

It needs `CRON_SECRET`. Vercel sends it with the call as a bearer token and the
route refuses anything without it, because an address anybody can hit that
makes the database walk every business is a way to slow it down for everyone.
Without the variable the route answers 503, the boot log carries a warning,
and the Automations screen goes on telling people to press Check now — which
still works, and which is how a desktop install runs them every time.

Repeat calls are harmless. Each automation fires once per invoice or customer
however often it runs, so a retried or doubled call raises nothing new. Each
business is swept separately, and one that fails is logged and skipped rather
than stopping the run for the rest.

Vercel's Hobby plan runs a daily job once a day, somewhere within the hour it
is scheduled for. The screen's "Last checked" line on each automation is the
record that it ran.

## Abuse limits

Sign-up is the front of the product now, not a desktop first-run screen, so
the two unauthenticated forms are limited. Counts live in the `RateLimit`
table, keyed by what is being limited, in fixed windows:

| Door | Limit | Window | Keyed on |
| --- | --- | --- | --- |
| Sign in | 10 | 15 minutes | The email address |
| Sign in | 50 | 15 minutes | The caller's address |
| Sign up | 5 | 1 hour | The caller's address |
| Pay redirect | 20 | 1 hour | The invoice token |

Sign-in counts every attempt and a correct password clears the count, so a
forgetful evening costs nothing. While a window is shut the right password is
refused too — the count is what is being answered, not the credentials — and
the message is identical whether or not the account exists, because a
different one would answer "does this person bank here".

**Sign-up limiting is skipped on a desktop install**, decided by
`dataStaysOnThisMachine()` rather than a flag: the first screen of a fresh
install is that form, and on an office network every machine shares one
address.

**To unlock somebody early**, delete their row:

```sql
DELETE FROM "RateLimit" WHERE key = 'login:email:someone@example.com';
```

What this does not stop is a distributed attacker — a thousand addresses
trying ten passwords each still gets ten thousand attempts. It stops the
single source working through a word list, which is the attack a small
business's login actually sees.

## Configuration is checked at boot

`src/instrumentation.ts` validates the environment when the server starts.

- **Fatal** — no `DATABASE_URL`, no or too-short `SESSION_SECRET`, local disk
  storage on Vercel. The server refuses to start.
- **Warning, logged loudly** — no `ENCRYPTION_KEY`, or client links that would
  resolve to localhost.

The split is deliberate: a deployment missing the fatal settings serves a broken
product convincingly, which is worse than one that did not come up. A missing
`ENCRYPTION_KEY` only stops integrations being saved, and the screens that need
it say so.

## What is different from the desktop build

| | Desktop | Hosted |
| --- | --- | --- |
| Database | SQLite beside the app | Postgres |
| Files | folder in the user's AppData | object store |
| Uploads | straight to the server | presigned, browser to store |
| Secrets | generated on first run | set by hand, once |
| Reachable from | the office network | anywhere |

Both run the same application code. The schema is authored once
(`prisma/schema.prisma`) and projected onto SQLite by `npm run schema:sync`;
`npm run schema:check` fails if the two have drifted, and should run in CI.
