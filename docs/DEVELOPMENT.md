# Development and review workflow

Read [AGENTS.md](../AGENTS.md), [the journal](<../project journal.md>), and
[TODO.md](../TODO.md). All changes belong on `Dev/` branches; agents may push/open
PRs, and the owner reviews/merges. Bundle routine documentation edits with the
implementation rather than creating a PR for each small update.

## Tools and installs

The VM has user-local Node/npm (version pinned by `.nvmrc`), GitHub CLI, and
PostgreSQL 18.6 tools. PostgreSQL server/client/libpq Ubuntu packages were downloaded,
verified against repository SHA-256 metadata, and extracted under
`~/.local/share/assettracker-tools/postgresql/`. Wrappers in `~/.local/bin/` supply
its local library path. No system service or production database was installed.

Git push/fetch uses the repository's dedicated SSH alias/deploy key; PR operations
use the authorized GitHub CLI account. Keep keys, tokens, and database URLs out of
Git and logs. The original checkout has unrelated work; preserve it.

Each application has its own lockfile. Run `npm run install:ci` in the root and
`service-request/`; it uses `npm ci` without advisory submission. The shared
`@tanmar/database` package is a relative local dependency, so retain the repository
layout to install both apps. `.npmrc` packages the shared module into each app's
node_modules so the QR server does not rely on the tracker's installed dependencies.
After editing `packages/database/`, refresh its local copies in both apps before
building/testing. Regenerate lockfiles intentionally only for approved
dependency/runtime changes. Do not run `npm audit fix --force`.

After pulling a changed lockfile, rerun that app's `npm run install:ci` before
validation; a clean Git tree does not prove node_modules matches the lockfile.
Compare GitHub advisories/alerts with npm results: a zero npm count can precede
advisory ingestion. Source-map security regressions resolve through each app's
actual PostCSS copy and test malformed/nested offset rejection, bounded sparse-map
conversion in a resource-limited child, and valid CSS mappings. Each app runs them
in its own default suite, without requiring the other's installed dependencies.

## Local applications

Follow [self-hosting setup](SELF-HOSTING.md) for databases and roles. Each app has
private `.env.local` runtime settings and a separate `.env.migrate` owner connection.
Node CLI commands load the corresponding file; Next.js loads `.env.local`. Server
secrets are never prefixed with `NEXT_PUBLIC_` or put in `public/asset-tracker/config.js`.

Run `npm run db:migrate` separately in each app, then `npm run admin:provision` at
the root in a terminal. PIN entry is hidden; no PIN arguments, environment variables,
or SQL files are used. Bootstrap takes a PostgreSQL table lock and refuses if any
user exists, including inactive users. Public HTTP setup always returns 403.

`npm run dev` uses loopback ports 5173/5174. `npm start` runs a built production Node
server on the same defaults. Local D1/Workers are no longer part of either path.
Use synthetic data; do not import production records for development. Test phones
require reachable HTTPS and an approved public destination, not a localhost label.

## Checks

In each app:

```bash
npm test
npm run typecheck
npm run lint
```

`npm test` builds with native Next.js and tests real Node HTTP responses/static
assets. Tracker regressions also verify hidden bootstrap UI, operator validation,
and credential-free deactivation drafts/served JavaScript. After an unchanged
successful build, run `node --experimental-strip-types --test tests/*.test.mjs`.
Wait for a build to finish before running that app's standalone type check:
the build replaces `.next/types`, which TypeScript includes in its file list.
On 2026-10-05 both builds/type checks passed. Inherited lint issues remain under
QA-02: root vendor errors/browser warnings. QR lint now passes with three
image warnings; the public-form rewrite removed its two effect-state errors.
Changed server/helper code passes focused lint checks.

On this VM, the Codex tool sandbox needs suitable child-process/local-socket
permissions for real verification. Restricted attempts can fail TypeScript
--showConfig parsing or report only test-file successes without running registered
subtests. Check that actual named scenarios executed; the journal records only
verified full/subset results, not those misleading sandbox attempts.

## Optional real-browser rendering checks

Build both apps first, then run `npm run test:browser` from the root. The suite
requires a separately installed Playwright/Chromium; it is intentionally outside
application dependencies and the default unit-test command. Set `PLAYWRIGHT_MODULE`
to its absolute `index.mjs` path if it is not locally resolvable. Do not rebuild
`.next/` while tests are serving those builds.

This VM has user-local Playwright 1.58.2 / Chromium 145.0.7632.6 under
`~/.local/share/assettracker-tools/browser-testing/` and `~/.cache/ms-playwright/`.
Its minimal Ubuntu 26.04 install needed libraries/fonts extracted from Ubuntu
packages after matching their SHA-256 hashes to repository metadata. No system
packages or service were installed. The matching Chromium Ubuntu 24.04 build
runs with the following environment on this VM:

```bash
PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 \
LD_LIBRARY_PATH="$HOME/.local/share/assettracker-tools/browser-libs/usr/lib/x86_64-linux-gnu" \
FONTCONFIG_FILE="$HOME/.local/share/assettracker-tools/browser-libs/fonts.conf" \
PLAYWRIGHT_MODULE="$HOME/.local/share/assettracker-tools/browser-testing/node_modules/playwright/index.mjs" \
npm run test:browser
```

The suite starts two isolated loopback Node servers with no database connection.
It supplies synthetic GPS, cache records, and session/API fixtures, blocks external
requests, and closes servers/browser. The spreadsheet reader is now served locally.
Five service scenarios cover private-field-free legacy redirects, React QR
text/submission, GPS denial and staff fallback, staff cached record IDs/history/audit
counts, and unsafe versus valid Maps links.
These checks prove rendering behavior; PostgreSQL suites separately verify actual
authentication/authorization. Mobile GPS, email delivery, and physical label scanning
still require QA-01 acceptance. Six fast redirect/rendering/stable-identity/URL
regressions and three public-input tests run without Playwright in the default
tracker suite.

Shared-device Chromium scenarios also exercise legacy cache quarantine/export/
removal, empty-server startup, private DOM cleanup, failed sign-out/reload/retry,
denied storage without blocking a save, BroadcastChannel user switches, original-
owner draft export, late reads/imports/saves, restored-page events and paused-session
expiry. Frozen-page events are simulated; target-device acceptance is still QA-01.
See [the session/cache policy](SHARED-DEVICE-SESSIONS.md). Recovery Chromium checks
also cover confirmed copies across reload, owner-only listing, explicit choices,
stale/denied apply, failed/lost acknowledgements, late session responses and discard
that waits for a shared read. See [draft recovery](DRAFT-RECOVERY.md).

The browser suite also uploads synthetic XLSX/XLS/CSV through the actual Master,
West Texas, account, and audit inputs, and exercises the real local parser worker.
The default suite verifies vendor digest/SRI/version, leading-zero mappings, parser
limits, malformed archives and inconsistent deflate output, and worker termination.
See [the dependency review](DEPENDENCY-REMEDIATION.md) for current advisories,
import limits, and vendor update instructions. Do not edit or lint the pinned
third-party minified bytes as application code; keep attribution/license intact.

Import/report regressions also use actual browser functions with the server schema
and ordinary permission checker. Chromium uploads then applies West Texas/account
files, checks recorded PUT/PATCH payloads and downloads all three CSV reports.
See [import/report policy](IMPORTS-AND-EXPORTS.md) for accepted/skipped/no-op counts,
metadata/history preservation, CSV tab prefixes and desktop spreadsheet limits.

## Real PostgreSQL integration tests

`npm run test:integration` at the root runs both built Node servers using separate,
randomly named test databases and restricted application roles. It requires a
**disposable local PostgreSQL cluster** with a test administrator able to create
and drop databases/roles. Never point it at production. The helper requires a
loopback/private socket destination and the dedicated `assettracker_test_admin`
database name; it does not use a normal application `DATABASE_URL`.

Example private cluster with the VM's user-local tools (choose a fresh directory):

```bash
umask 077
mkdir -p /tmp/assettracker-pg-tests/socket
initdb -D /tmp/assettracker-pg-tests/data \
  -L "$HOME/.local/share/assettracker-tools/postgresql/usr/share/postgresql/18" \
  --auth-local=trust --auth-host=scram-sha-256 --no-locale --encoding=UTF8
pg_ctl -D /tmp/assettracker-pg-tests/data \
  -l /tmp/assettracker-pg-tests/server.log \
  -o "-h '' -p 55432 -k /tmp/assettracker-pg-tests/socket -c unix_socket_permissions=0700" -w start
createdb -h /tmp/assettracker-pg-tests/socket -p 55432 assettracker_test_admin
TEST_DATABASE_URL='postgresql://localhost:55432/assettracker_test_admin?host=/tmp/assettracker-pg-tests/socket' npm run test:integration
pg_ctl -D /tmp/assettracker-pg-tests/data -m fast -w stop
```

Local trust authentication here is limited to a private socket in a mode-0700
test directory. It is not a production configuration. Fixtures are dropped and
servers stopped after tests. The operator must stop the private test cluster.

Coverage includes repeatable/checksummed migrations, database role separation,
rejected HTTP bootstrap, concurrent operator provisioning, login/logout/account
updates, JSONB round trips/key-order comparisons, competing writes, rollback of
failed audit inserts, no orphan history on rejected updates, revision-protected
recovery, QR requests, staff proxy/status/tombstones, and readiness.

Account-security tests also exercise concurrent wrong-PIN lockouts, PIN-reset/login
races, all-session revocation, concurrent last-admin demotions, authorization after
waiting on a transaction lock, and account/audit/session rollback. Existing-row
upgrades test migration failure/retry without credential rewrites. Unit checks
cover chunked UTF-8 body limits and malformed cookies before database work.
The existing PIN policy/outer company authentication still needs an owner decision
under AUTH-01. Shared-device HTTP tests cover non-bearer contexts, missing/mismatched
headers, shared-cookie changes, stale logout acknowledgement, failed deletion,
revocation and logout account locking. Older tabs/integrations must reload/update
context headers, and legacy device caches need DATA-04-ROLLOUT cleanup.

Inventory coverage uses the same real PostgreSQL/runtime-role/server fixture.
It checks role/method versus forged labels, ordinary assignments/services/stock,
bulk and rental-stock bypasses, malformed/duplicate/dangling records, capacity and
unsafe URLs, history attribution/immutability, invalid historical recovery,
queued role changes, denied QR deletes, upstream timeout cleanup, and no-op audit
behavior. Actual browser functions are exercised for ordered PATCH saves,
paused/recoverable drafts, bounded queues, and stock/audit snapshot/Undo coverage.
Draft recovery integration verifies owner-only access (including administrators),
version CAS, streamed size limits, active-copy quotas, expiry, tombstones, regular
bulk denial, merged-schema rejection, stale revisions, atomic rollback, simultaneous
apply/no-op closure and authorization after a lock wait. Pure merge regressions
cover field overlap, absence/deletion/addition and whole audit/stock choices.
Public-request integration tests verify private/public response separation, fresh
inventory snapshots, old-label compatibility, stable IDs across renames, malformed
input, independent-process duplicate/rate races, conflicting status reopens,
trusted ingress headers, denied-attempt persistence, expiry, lookup errors and
atomic failure/retry of the requests migration on historical duplicates/bad GPS.
See [the public request policy](PUBLIC-REQUEST-SECURITY.md).

Full browser/mobile/printing acceptance still belongs to QA-01; Node/VM checks
do not stand in for physical-device testing. See [the policy](INVENTORY-PERMISSIONS.md).

## Backup tooling checks

The root operator commands `db:backup` and `db:restore` use the already installed
`psql`, `pg_dump` and `pg_restore`; no new npm dependency is required. They require
private service/passfiles and explicit environment configuration. See
[the recovery runbook](DATABASE-BACKUPS.md); never run a development drill against
production connections.

`tests/postgresql-backups.test.mjs` covers private-path/environment guards,
redacted diagnostics, cancellation and timeouts. The integration suite includes
`tests/integration/database-backups.test.mjs`: it creates isolated source/empty
recovery databases, dumps and restores every table, verifies permissions and starts
both existing application builds under restored runtime credentials. The fixture
uses a SELECT-only backup role and removes synthetic databases/roles afterward.
Tests reject corrupt/private-permission violations and unsafe/nonempty targets,
and exercise consistent dumps during continuing writes.

For operator-script-only changes, run the default and complete PostgreSQL suites
plus focused lint/syntax checks. Existing matching app builds can be used for the
HTTP drill when application source/dependencies have not changed; record that
choice instead of claiming a new build/browser run. Rebuild if runtime source or
installed dependencies change. Do not rebuild while integration tests serve `.next/`.

## Record browsing checks

`tests/record-list.test.mjs` checks list bounds, duplicate/unknown filters, real UTC
bounds, literal wildcard escaping and cursor binding. The real PostgreSQL suite's
`record-list.test.mjs` seeds more than 600 synthetic records with equal timestamps,
finds older pending work, visits every page without repeats, deletes an anchor and
inserts a newer row, and exercises search/category/date boundaries, both apps'
private validation and every-page authentication/revocation. Existing proxy tests
also reject bad filters before upstream access, redirects and oversized bodies.

The Chromium record-list suite uses actual Previous/Next/search/status controls,
keeps manual work visible, checks renamed-receiver associations, delays responses
to prove generation/session isolation, clears stale rows on outages, downloads a
100-record page CSV and verifies local calendar bounds across a 25-hour DST day.
The browser fixture supplies API responses; only PostgreSQL checks prove server
permissions, SQL and migrations. See [listing policy](RECORD-LISTS.md).

## Finishing implementation

Review diffs and `git diff --check`; run checks appropriate to the change. Update
journal/TODO/setup docs within the same implementation branch, commit and push,
then open/update one focused PR. Keep runtime secrets, test databases, dumps,
node_modules, `.next/`, legacy ignored build output, and VM-specific configuration
out of Git. Do not merge or deploy; the owner performs final review and merging.
