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

## First run

There is no seeded account. The first person to reach `/signup` creates their
own organization and becomes its owner; everybody else is invited from
**Team**. Nothing about that flow is specific to hosting — it is the same one
the desktop build uses.

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
