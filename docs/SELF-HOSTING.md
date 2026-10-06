# Node/PostgreSQL architecture and setup

Both applications use native Next.js on Node. The staff server serves the existing
`public/asset-tracker/` UI and APIs; the QR server serves the React form and request
API. PostgreSQL replaces D1. Neither application needs Cloudflare credentials,
Worker bindings, Sites hosting metadata, Wrangler, or Vinext.

| Component | Development default | Database access |
| --- | --- | --- |
| Staff tracker | Loopback port 5173 | Tracker database/runtime role |
| Public QR service | Loopback port 5174 | Separate requests database/runtime role |
| Staff request proxy | Configured QR `/api/requests` URL | Server-only shared credential |
| Operator migrations | `npm run db:migrate` in each app | Separate schema-owner connection |
| Initial admin | Root `npm run admin:provision` | Tracker only; hidden interactive PIN |

The shared `packages/database/` module owns a bounded pool of four connections per
Node process. Its query facade accepts native PostgreSQL statements and bound `$1`
parameters. Transactions hold one client through commit/rollback and release it
on every path. This is not a D1 emulator or a SQL translation layer.

## Data layout and compatibility

Use two databases with separate application roles. Tracker tables are `app_users`,
`app_sessions`, `app_change_log`, `app_state`, and `app_state_history`. The requests
database contains `service_requests` and `request_rate_limits`. Each has operator-owned `schema_migrations`.

Operational inventory remains one JSONB state document with explicit record and
relationship validation on reads/saves/recovery. Native JSONB may reorder keys;
server edit comparisons canonicalize object keys. The payload includes rental
stock; normalizing inventory into relational tables remains future work. Read
[inventory permissions](INVENTORY-PERMISSIONS.md) for the admin PUT/ordinary PATCH
contract, bounds, stock/history policy, snapshots, and legacy-data reconciliation.

IDs and canonical ISO date strings remain text for compatibility with existing
clients and later authorized D1 import. Usernames have a case-insensitive unique
index, account roles/active flags are constrained, and sessions reference users.
Request coordinates use double precision. Preserve leading-zero identifiers as
text. No data is automatically copied from existing D1 databases.

State saves and recovery share account-authorization and state transaction locks,
in that order, rechecking roles/sessions after waiting. The revision predicate
also protects updates outside that lock; rejected updates create no history/audit.
Recovery additionally requires the revision the administrator reviewed. A failure
in history or audit writes rolls back the state change. The two databases still
do not provide atomic coordination between inventory and QR status (DATA-02).

## Database ownership and permissions

For development, use an isolated PostgreSQL 18 server with synthetic data. For
production, provisioning the service and credentials is an operator task under
HOST-04, following owner review. The user-local test cluster is not production.

Create separate migration owners and runtime roles; no runtime role should be a
superuser, database creator, role creator, or schema owner. Use `createuser
--pwprompt` or `psql`'s `\password` to set secrets interactively, never a password
literal in a command line, shell history, or this repository. Create the tracker
database owned by its migration owner and the requests database by its own owner.

Each app's `.env.migrate` contains its owner `DATABASE_URL`; `npm run db:migrate`
loads this file and applies only that app's checksummed migrations from `migrations/`.
An advisory lock and transaction serialize migration runners. Repeated migrations
are safe; changed applied files or the other app's migration history are rejected.
Do not edit an applied migration: add a new numbered file for schema changes.

After migrating, grant only the explicit application tables to its runtime role.
The following example runs as the **tracker schema owner in the tracker database**;
replace database/role names with the operator's configured names:

```sql
REVOKE ALL ON DATABASE assettracker FROM PUBLIC;
GRANT CONNECT ON DATABASE assettracker TO assettracker_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO assettracker_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_users, app_sessions, app_change_log, app_state, app_state_history
  TO assettracker_runtime;
```

Apply equivalent database/schema access in the requests database, granting data
access only on `service_requests` and `request_rate_limits` to its own runtime role. Do not grant runtime
access to `schema_migrations`. Review grants when future migrations add tables.
Use authenticated local/socket access or loopback with SCRAM; never expose
PostgreSQL publicly or reuse the test cluster's trust authentication in production.

## Application configuration

Each app's `.env.local` contains **only runtime settings** from its `.env.example`:

- `DATABASE_URL`: that app's restricted PostgreSQL connection.
- `ADMIN_SHARED_SECRET`: the same newly generated server-only credential in both apps.
- `SERVICE_REQUEST_API_URL`: tracker-only, the trusted QR server's `/api/requests` URL.
- `TRACKER_ASSET_API_URL`: QR-only, the trusted tracker `/api/service-assets` URL.
- `REQUEST_PROXY_SECRET`: QR-only; authenticate the production reverse proxy's
  overwritten client-IP/secret headers. See [the ingress policy](PUBLIC-REQUEST-SECURITY.md).

Keep `.env.migrate` owner credentials separate from the web process environment
and production service account. Protect private files and backups; do not commit
them or put server secrets in `NEXT_PUBLIC_` values/browser configuration. Node
CLI environment variables take precedence over private files; verify the selected
database before running operator commands. No connection URL or PIN is printed.

The browser calls its same-origin staff proxy, so the old Sites CORS allowlist is
removed. Direct cross-origin browser staff reads are not enabled. Public request
POST remains public, with server asset lookup, bounded validation, shared rate
budgets and atomic duplicate prevention. Production ingress still needs setup.
See [public request security](PUBLIC-REQUEST-SECURITY.md).
Set the non-secret label destination in `public/asset-tracker/config.js` to the
approved reachable QR HTTPS URL before printing real labels (HOST-03/QR-01).

## Provision

Follow the root README to install both lockfiles and configure each private file.
Apply migrations in both apps, then provision the first tracker administrator in
a terminal. The operator command hides PIN echo and uses bound parameters; it
writes no temporary SQL file. A table lock precedes the empty-user check, because
a conditional INSERT alone cannot serialize concurrent PostgreSQL provisioners.
Any existing user blocks bootstrap; HTTP setup remains unavailable.

## Account security and upgrades

Run root `npm run db:migrate` with the tracker schema-owner connection before
running this version. Migration `0002_access_constraints.sql` adds hash/salt/token
format checks, a 0–4 failure-counter bound, and a session-user lookup index. It
requires no new table grants and does not rewrite credentials or copy D1 data.
If existing/imported rows violate these checks, the migration rolls back and the
operator must reconcile those rows through the authorized migration plan; do not
bypass constraints or edit an applied migration. The tracker account migration
is separate from QR
`requests/0002_public_request_security.sql`. Before applying the QR migration,
review its duplicate/GPS preflight and new runtime grant in
[the public request policy](PUBLIC-REQUEST-SECURITY.md).

Login holds a PostgreSQL user-row lock through PIN verification and session
insertion. Five failed attempts lock that account for 15 minutes, including
concurrent requests across Node processes. Expired sessions for the account are
pruned on successful login. Access endpoints require JSON objects of at most
4 KiB; PINs remain strings to preserve leading zeroes. Unambiguous legacy display
names can still resolve to normalized login aliases, without renaming on login.
Correct ambiguous aliases through user administration before importing accounts.

Account changes serialize administrator checks and preserve at least one active
administrator. PIN resets, role changes, and activation changes revoke all sessions
for the target, requiring a fresh login; reactivation never revives old sessions.
Resetting your own PIN/changing your own role clears your cookie and locks the
staff sign-in gate. Unlocking alone does not revoke sessions. Account changes,
revocation, and audit writes share one transaction; audit failure cancels the change.

These protections retain the existing 4–8 digit PIN policy and 12-hour sessions.
Company SSO/outer access controls, broader traffic throttling, and durable conflict
resolution remain AUTH-01/DATA-01 tasks before deployment. Shared-device code now
uses tab memory, server-bound session contexts, acknowledged sign-out/retry, and
administrator cleanup of quarantined legacy storage. Ship server/UI together,
reload old tabs and update staff integrations to supply the session context header.
Export/reconcile/remove older device caches before handoff under DATA-04-ROLLOUT.
See [shared-device policy](SHARED-DEVICE-SESSIONS.md). Inventory permissions/schemas are
implemented under SEC-03; reconcile incompatible source data/history under MIG-01.

## Build and run

Run `npm test` and `npm run typecheck` in each app. Build artifacts are in `.next/`;
public assets are served directly from each `public/` directory. Builds use system
fonts and require no Google Fonts download. Keep the complete repository layout
and both installed lockfiles, including the relative database package.

Run `npm start` for each built application. Defaults bind only loopback. A later
production setup must add approved HTTPS domains/reverse proxy, restricted service
users, startup/restart supervision, logging/monitoring, and environment handling.
`/api/health` checks the selected database and an application table, returning a
small no-cache 200/503 response without connection details. Use it for readiness.
Phone GPS and Secure session cookies require proper HTTPS outside local testing.

## Cutover remains separate

Before public deployment, resolve the remaining security/dependency items in
TODO.md. Obtain authorized exports from both original databases, reconcile data
and legacy constraints, clear old sessions, verify complete database backups and
restoration, and plan printed-label/domain continuity and rollback. No exports,
live records, domains, or production services are changed by this implementation.

References: [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting),
[node-postgres transactions](https://node-postgres.com/features/transactions), and
[PostgreSQL roles](https://www.postgresql.org/docs/current/sql-createrole.html).

## Service-form compatibility and safe links

New QR links contain only a stable receiver ID. The separate QR server resolves
current inventory through a private tracker endpoint and returns only ID/asset
number to the visitor. Public submissions save a request for staff review; they
no longer open an email draft. Automatic delivery remains MAIL-01.

Existing `/asset-tracker/service-request.html` links now redirect to the configured
QR application using only a validated ID or legacy asset number. Old React links
can still resolve by asset number. No private historical metadata is forwarded.
Both public pages use no-referrer; the current QR page replaces its history query.
Printed old private URLs, prior logs, renamed old asset-number labels and original
hostnames require QR-01/MIG-01 cutover planning. Staff must monitor saved requests
until email delivery is implemented. Review this workflow before deployment.

Staff pages escape cached/API values and only show GPS anchors for bounded HTTPS
Google Maps URLs (`maps.google.com`, or `google.com` / `www.google.com` paths beginning
with `/maps`), without credentials or nondefault ports. Configured QR destinations
must be HTTP/HTTPS without embedded credentials; invalid settings produce the
existing label-generation error. Set approved reachable HTTPS URLs before printing
real labels and have staff reload existing tabs after shipping updated scripts.

See [public request security](PUBLIC-REQUEST-SECURITY.md) for validation/rate budgets,
trusted ingress headers, duplicate/GPS migration preflight, role grants, and GPS
fallback limits. No production configuration or database is changed by a merge.

## Local spreadsheet assets

Serve `public/asset-tracker/vendor/xlsx-0.20.3.full.min.js`, its license/provenance,
and `public/asset-tracker/spreadsheet-worker.js` with the rest of the staff UI.
The script and browser worker are local application assets; no hosted parsing
service is required. If adding a content security policy, allow same-origin scripts
and workers so imports remain functional. The worker preflights ZIP expansion,
limits parsing, and is terminated on completion/failure or after 15 seconds.

Both production npm advisory checks report zero findings and the current lockfiles
pin patched source-map-js 1.2.2. GitHub's main alert requires owner merge/rescan;
the remaining unpatched lint dependency affects development configuration. Review
[the current dependency assessment/import limits](DEPENDENCY-REMEDIATION.md),
refresh advisory checks as part of release preparation, and retain the pinned
vendor digest/SRI/license checks. Larger/wider source workbooks need intentional
splitting/reconciliation before import; no live data was fetched for these tests.
