# Matlock One for Windows

A single installer. The customer double-clicks it, and Matlock One runs on their
own computer with their data on their own disk. Nothing is required first — no
Node, no database, no terminal, no account.

## Building the installer

### Windows

`npm run desktop:pack` on a Windows machine. That is the platform this has been
built and tested on.

### macOS

The application itself is platform-neutral — Electron, Next.js and SQLite all
run on macOS, and the launcher no longer hardcodes anything Windows-specific.
What it needs is a Mac to build on:

- **The SQLite binding is a native module** and cannot be cross-compiled. A
  `npm install` on the Mac produces the arm64 or x64 binary, and the build
  ships the Mac's own Node beside it exactly as it ships node.exe on Windows.
- **Only macOS can produce a .icns and sign a bundle.** `build/icon.png` is
  512px so electron-builder can convert it.
- `npm run desktop:pack:mac` then emits a .dmg and a .zip for **this Mac's own
  architecture** — arm64 on Apple Silicon, x64 on Intel. One build, one
  architecture: the bundled Node is the one running the build, and
  `scripts/after-pack.cjs` fails anything that disagrees with it. For both,
  build once on each kind of machine, or let the CI workflow produce arm64.

Unsigned, macOS refuses the first launch with "cannot be opened because it is
from an unidentified developer" — the same class of warning as SmartScreen on
Windows, and cleared the same way: right-click the app and choose Open, or allow
it in System Settings › Privacy & Security. A $99/year Apple Developer ID plus
notarization removes it, as a code-signing certificate does on Windows.

### Two ways to produce the macOS build

**On a Mac, by hand.** Fastest when you have one in front of you:

```bash
npm ci                      # compiles the SQLite binding for this Mac
npm run desktop:pack:mac    # signs and notarizes, then writes the .dmg and .zip
```

Needs Xcode Command Line Tools (`xcode-select --install`) for the native
module to compile, the **Developer ID Application** certificate in the login
keychain — electron-builder discovers it there, so nothing has to be passed in
— and notarization credentials in the environment:

```bash
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Or an Apple ID with an app-specific password (appleid.apple.com → Sign-In and
Security → App-Specific Passwords). `APPLE_TEAM_ID` is required on this route,
and it matters when the account belongs to more than one team:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID=XXXXXXXXXX
```

**The first signed build on a Mac stalls on keychain prompts.** An Electron app
is several hundred nested binaries, `codesign` signs each one separately, and
clicking *Allow* authorizes exactly one; a prompt that is declined or never
answered surfaces as `errSecInternalComponent`. Give `codesign` standing access
to the key once, before building:

```bash
security set-key-partition-list -S apple-tool:,apple:,codesign: -s ~/Library/Keychains/login.keychain-db
```

It asks for the login password. If it insists on `-k`, zsh can read one without
echoing it — `read -s "?login password: " p` — and then take `-k "$p"`.

For a build that only has to run locally, `npm run desktop:pack:mac:unsigned`
skips both and produces a .dmg Gatekeeper will refuse until it is cleared by
hand. Never ship that one.

**On CI.** `.github/workflows/desktop-macos.yml` does the same thing on a
macOS runner, triggered by pushing a `v*` tag or run by hand against an
existing one. It needs five repository secrets — `CSC_LINK` (the Developer ID
certificate as a base64 `.p12`), `CSC_KEY_PASSWORD`, `APPLE_API_KEY_P8` (the
key's contents, which the workflow writes to a file because electron-builder
wants a path), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER` — and fails on the
first step naming any that are missing.

Prefer CI once there is more than one release: it keeps the signing identity
off a laptop, and it cannot forget a step.

Either way, five files go to the release: the `.dmg` and the `.zip`, a
`.blockmap` for each, and `latest-mac.yml` (not `latest.yml` — the two
platforms keep separate manifests and overwrite each other if confused). The
DMG is what the download page links to; the zip is what an installed copy
updates itself from, which is why it is not optional.

One limit worth knowing: an Intel build and an Apple Silicon build each write
their own `latest-mac.yml`. Upload both to one release and the second replaces
the first, so installs of the other architecture are offered an update they
cannot run. Until the two manifests are merged, or replaced by a universal
build, ship one Mac architecture per release.


```bash
npm run desktop:pack
```

That produces `dist-installer/MatlockOne-Setup-<version>.exe` (~210 MB). It takes
a couple of minutes and does four things:

1. Generates the Prisma client and the schema DDL used to create a database on
   first run.
2. Builds the app with `output: "standalone"` — a server plus only the
   dependencies it actually traced.
3. Copies the Node binary that compiled the native SQLite module.
4. Packages all of it with Electron into an NSIS installer.

To try it without building an installer:

```bash
npm run desktop:build   # assemble desktop-build/
npm run desktop         # launch it
```

## Publishing a release

The installer is not much use sitting in `dist-installer/`. `electron-builder.yml`
publishes to **GitHub Releases**, which is also where the installed app looks
for updates — one place instead of a download host plus an update feed.

Three files go up together, and they must be the *same* build:

- `MatlockOne-Setup-<version>.exe`
- `MatlockOne-Setup-<version>.exe.blockmap` — lets an update download only the
  changed chunks instead of the whole 150 MB
- `latest.yml` — the version, the file name and its SHA-512

electron-updater reads `latest.yml`, compares versions, and verifies the
installer's hash against it before running anything. Upload a mismatched set and
every existing install fails its update check with a hash error.

To publish, tag the commit the build came from and let electron-builder do the
upload:

```bash
git tag v0.2.0 && git push origin v0.2.0
GH_TOKEN=<a token with repo scope> npx electron-builder --win --publish always
```

Or create the release in the GitHub UI and attach the three files by hand.

**The repository has to be public.** GitHub serves a private repository's
release assets only to an authenticated token — which an installed copy does not
carry, and a visitor to the download page certainly does not. Private means both
the download button and the update check return 404.

Then turn the download button on, by setting this on the hosted deployment:

```
DOWNLOAD_URL_WINDOWS="https://github.com/JLMattyice/matlockone/releases/download/v0.2.0/MatlockOne-Setup-0.2.0.exe"
```

Until that variable is set the marketing page renders a placeholder saying the
build is not published, rather than a button that 404s. Setting it is the
deliberate act that makes the download real — do it *after* the release is up,
not before.

## How it is put together

Electron is a launcher and a window, not the application. It starts the real
Next.js server as a child process and points a `BrowserWindow` at it, so the
desktop build and a hosted deployment run byte-identical application code.
There is no second implementation to keep in step, and a bug fixed in one is
fixed in both.

```
Matlock One.exe  (Electron)
  ├─ starts  resources/node/node.exe  resources/server/server.js
  │            └─ the same Next.js server a hosted deployment runs
  └─ opens   a window pointed at http://localhost:<port>
```

### Decisions worth knowing

**A bundled Node, not Electron's.** The server could run under Electron's own
Node, but the native SQLite module would then be tied to Electron's ABI and
need rebuilding on every Electron upgrade. Shipping the exact Node binary that
compiled it removes that coupling — at the cost of about 87 MB.

**Data lives in Local AppData, not Roaming.** Electron defaults its data folder
to `%APPDATA%\Roaming`, which Windows synchronises on domain and roaming-profile
setups. A synchronised folder can hand one process a stale view of a file — old
contents, deleted files still listed, freshly written ones missing. That is not
theoretical: it is what broke sign-in on this machine, with the server reading an
old, index-damaged image of a database that was healthy on disk. The records now
live in `%LOCALAPPDATA%\Matlock One`, which is never roamed.

**Chromium's profile moved out of Roaming too.** The signed-in cookie lives in
Chromium's own profile, in a SQLite file of its own, and that profile was still
in Roaming after the records moved out. A rolled-back cookie jar is far less
serious than a rolled-back database, but it shows up as the one thing "keep me
signed in" exists to prevent: being asked to sign in again for no visible
reason. It now sits in `%LOCALAPPDATA%\Matlock One\browser`. Moving it costs one
sign-in on the upgrade, because the old jar is left behind rather than copied.

**The app refuses to start on a damaged database.** Every launch runs SQLite's
own `integrity_check` before the server is told to go. A file can be the right
size, at the right path, and still be internally inconsistent — indexes that
disagree with their tables, usually from a half-finished copy. SQLite answers
ordinary queries from such a file without complaint, so the damage surfaces
later as something baffling; here it was a foreign key violation on sign-in,
because the lookup found a user through an index while the insert could not find
them in the table. Refusing to start names the problem and leaves the file alone
for a restore.

**Data lives in the user's profile, never beside the program.**
`%LOCALAPPDATA%\Matlock One` holds the database, uploaded files, the two keys
and the server log. The install directory is read-only for a normal user, and keeping
records out of it means **uninstalling never deletes a business's data**.

**Both keys are generated per installation.** A constant would mean every copy
of the software could forge every other copy's sessions, and could decrypt every
other copy's saved mail passwords. They are created on first run:

| File | Protects |
|---|---|
| `session.key` | Session cookies |
| `encryption.key` | Mail passwords and API keys saved under Settings → Email |

They are deliberately separate, so rotating one does not silently invalidate the
other. `encryption.key` lives outside the database on purpose: a copied
`matlockone.db` on its own does not hand over the mailbox.

**Upgrading across a rename carries the data forward.** The app shipped as
Fieldbase, then as Work Suite, before it was renamed to Matlock One, and
Electron derives the data folder from the product name — so each renamed build
points at a folder that does not exist yet. On first run it copies the previous
installation's database, uploaded files, keys and backups across. It copies
rather than moves: if anything goes wrong the original is untouched, and the old
folder can be deleted by hand once you are satisfied.

The list of places to look for that data is in `legacyDataDirs`, newest first:

| Previous name | Where it kept data |
|---|---|
| Work Suite | `%LOCALAPPDATA%\Work Suite` |
| Work Suite (early builds) | `%APPDATA%\Work Suite`, `%APPDATA%\work-suite` |
| Fieldbase | `%APPDATA%\Fieldbase` |

The database is renamed to match the product as it is copied —
`fieldbase.db` → `worksuite.db` → `matlockone.db` — because replacing the file
in place left the running server reading a stale cached image of it. A new name
cannot inherit that.

Every entry in that list is a **historical** name. Sweeping a rename through it
points the app at the folder it is already using, so the migration finds nothing
and the customer opens an empty business. That has happened once already;
`tests/data-migration.test.ts` exists to make it fail loudly next time.

**Upgrades add missing tables, and nothing else.** On every start the launcher
compares the tables in the database against the schema the build ships with, and
creates any that are absent — inside one transaction, touching no existing row.
That is what makes it safe to install a newer version over a database full of
real work. It is *not* a migration system: a changed column on a table that
already exists needs a real migration, and adding one is the next thing to build
before shipping a release that alters existing tables.

**No developer configuration ships.** The build strips `.env` from the bundle
and `scripts/after-pack.cjs` refuses to package if one reappears — otherwise a
known `SESSION_SECRET` would be sitting inside every customer's installer.

**The database is created from DDL, not migrations.** `schema.sql` is generated
at build time from the same schema the app was compiled against, so the two can
never disagree, and no Prisma CLI is needed on the customer's machine.

**A free port is requested from the OS.** Assuming 3000 would collide with
whatever else the customer runs.

## Multiple people, one office

The server binds to `0.0.0.0`, so the machine running Matlock One *is* the office
server. Technicians open the address shown under **File → Connect your team**
(something like `http://192.168.1.20:3000`) from a phone or laptop on the same
network and sign in with their own account.

That keeps every team feature meaningful — roles, crew assignment, the
technician's own-jobs-only view, notifications — with all data staying on the
premises.

What it needs:

- **The host machine stays on.** Close Matlock One and the crew are disconnected.
- **A firewall allowance.** Windows prompts on first run; choose **Private
  networks**.
- **One network.** Phones must be on the office wifi, not cellular.

## Sending email

Settings → Email connects the mailbox that estimates, invoices and reminders go
out from — either the business's own account over SMTP (Gmail, Outlook, or a web
host) or its own Resend API key. Gmail and Outlook require an **app password**
rather than the normal account password.

The credential is encrypted with AES-256-GCM before it is written to the
database, is never shown again once saved, and **Disconnect** deletes it rather
than deactivating it. Send a test from that screen before relying on it.

With nothing connected, sending an estimate or invoice still records it and
marks the document as sent, but the screen says it was saved to the outbox and
not delivered. It never claims to have sent mail it did not send.

## Taking payment

Settings → Payments connects whichever processor the business already uses.
Clients pay on that processor's own page — paypal.com, stripe.com, squareup.com
— never on a page Matlock One serves. Two things follow from that:

- **No card details ever reach this application**, so a business running
  Matlock One is not handling card data and is not in PCI scope for it.
- **The pay link works from anywhere.** It is the one client-facing link on the
  desktop build that does not depend on being on the office network, which is
  why the invoice email puts it above the document link.

| Provider | Status | Matlock One can see what was paid |
|---|---|---|
| My own payment link | Available | No — record payments by hand |
| PayPal | Not yet | Yes, once the adapter ships |
| Stripe | Not yet | Yes, once the adapter ships |
| Square | Not yet | Yes, once the adapter ships |

"My own payment link" takes any web address the business already has — a
PayPal.Me page, Venmo, Cash App, a bank portal — and puts it on every invoice.
It works with any service in existence, at the cost of Matlock One not being able
to tell what was collected, so those payments are still recorded by hand. The
settings screen and the invoice both say so rather than offering a button that
would silently find nothing.

For the processors with a real adapter, Matlock One asks **"what has been paid?"**
rather than waiting to be told. A webhook would need an address the processor
can reach, and a desktop install has none. Polling repeats by nature, so each
payment is stored under the processor's own transaction id behind a unique
index: checking an invoice twice cannot record the same money twice.

Credentials are encrypted exactly as the email ones are, under the same
per-installation `encryption.key`, and **Disconnect** deletes them. Links
already sent keep working — they point at the processor, not at Matlock One.

## When nobody can sign in

**File → Reset a password…** sets a new password for any account on this
installation, without signing in first.

It exists because every other reset path requires being logged in — which is no
help to the only owner of a business who has forgotten their password. The
alternative is that customer phoning whoever sold them the software, and someone
editing a SQLite file by hand.

It grants nothing that physical access to the machine did not already give: the
database is a file in the user's own profile, readable and writable by anything
running as them. What changes is that the remedy no longer needs a developer.
It is not reachable over the network — it is a window on this computer, not a
page the server serves.

Choosing an account and a new password will:

- set the password, using the same rules and the same hashing as the app;
- sign that account out on every device;
- **restart the server**, so the new password works immediately.

That last step is not a nicety. The running server holds the database open, and
a password changed underneath it is rejected until it restarts — which is
exactly what makes an external edit look like it silently failed.

## Known limitation: client-facing links

Estimate and invoice share links resolve to a **local network address**. A
technician can open one on site, but a customer at home cannot — the address
does not exist outside the office network. **This applies to emailed documents
too:** the mail is genuinely delivered, but the "view it here" link inside it
only works for someone on the office network.

The **pay link is the exception** — it is hosted by the payment processor, so a
client can open it from anywhere. That is deliberate: on the desktop build it is
frequently the only link in the email that a customer at home can actually use.

For the document itself, treat email as the covering note: **Print** and **Save
as PDF** work from the estimate and invoice screens and produce exactly what the
share link shows.

This is the honest trade for keeping data on-premises. The alternative is
hosting, where the same code runs against Postgres and the links work
everywhere.

## Troubleshooting

| Symptom | Where to look |
|---|---|
| App won't start | **File → Open server log** (`%LOCALAPPDATA%\Matlock One\server.log`) |
| Team can't connect | Check the firewall allowed Matlock One on Private networks; confirm both devices are on the same network |
| Need the data | **File → Open data folder** — `matlockone.db` is a standard SQLite file |
| Locked out of every account | **File → Reset a password…** |

## Backups

There is no automatic backup. `%LOCALAPPDATA%\Matlock One` is the whole application
state: copy that folder and you have copied the business. Closing Matlock One
first guarantees a clean copy.

Copy the **whole folder**, not just `matlockone.db`. Restoring the database
without `encryption.key` leaves every connected email account unreadable, and
they would have to be entered again.
