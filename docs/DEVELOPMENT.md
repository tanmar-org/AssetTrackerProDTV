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
On 2026-10-05 both builds/type checks passed. Inherited lint issues remain under
QA-02: root vendor errors/browser warnings and QR effect-state errors/image warnings.
Changed server/helper code passes focused lint checks.

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
The existing PIN policy/outer company authentication and shared-device cache
behavior still need owner decisions/further implementation; see AUTH-01/DATA-04.

Inventory coverage uses the same real PostgreSQL/runtime-role/server fixture.
It checks role/method versus forged labels, ordinary assignments/services/stock,
bulk and rental-stock bypasses, malformed/duplicate/dangling records, capacity and
unsafe URLs, history attribution/immutability, invalid historical recovery,
queued role changes, denied QR deletes, upstream timeout cleanup, and no-op audit
behavior. Actual browser functions are exercised for ordered PATCH saves,
paused/recoverable drafts, bounded queues, and stock/audit snapshot/Undo coverage.
Full browser/mobile/printing acceptance still belongs to QA-01; Node/VM checks
do not stand in for physical-device testing. See [the policy](INVENTORY-PERMISSIONS.md).

## Finishing implementation

Review diffs and `git diff --check`; run checks appropriate to the change. Update
journal/TODO/setup docs within the same implementation branch, commit and push,
then open/update one focused PR. Keep runtime secrets, test databases, dumps,
node_modules, `.next/`, legacy ignored build output, and VM-specific configuration
out of Git. Do not merge or deploy; the owner performs final review and merging.
