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
| Initial admin | Root `npm run admin:provision` | Tracker only; AD-mode app record or hidden local PIN |
| AD identity links | Root `npm run auth:link-ad` | Tracker operator connection; reviewed directory/GUID mapping |

The shared `packages/database/` module owns a bounded pool of four connections per
Node process. Its query facade accepts native PostgreSQL statements and bound `$1`
parameters. Transactions hold one client through commit/rollback and release it
on every path. This is not a D1 emulator or a SQL translation layer.

## Data layout and compatibility

Use two databases with separate application roles. Tracker tables are `app_users`,
`app_sessions`, `app_change_log`, `app_state`, `app_state_history`,
`app_inventory_drafts`, `app_service_operations`, and `app_login_rate_limits`.
The requests database contains `service_requests`, `request_rate_limits`, and
`service_request_operations`. Each has operator-owned `schema_migrations`.

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
in history or audit writes rolls back the state change. QR status/history now use
durable intent, versioned receipts and a VM reconciler for recovery; there is still no transaction spanning both databases. Read
[QR operations](QR-OPERATIONS.md) for pending/review states and deployment.

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
  app_users, app_sessions, app_change_log, app_state, app_state_history,
  app_inventory_drafts, app_service_operations, app_login_rate_limits
  TO assettracker_runtime;
```

Apply equivalent database/schema access in the requests database, granting data
access only on `service_requests`, `request_rate_limits`, and
`service_request_operations` to its own runtime role. Do not grant runtime
access to `schema_migrations`. Review grants when future migrations add tables.
Use authenticated local/socket access or loopback with SCRAM; never expose
PostgreSQL publicly or reuse the test cluster's trust authentication in production.

## Application configuration

Each app's `.env.local` contains **only runtime settings** from its `.env.example`:

- `DATABASE_URL`: that app's restricted PostgreSQL connection.
- `ADMIN_SHARED_SECRET`: the same newly generated server-only credential in both apps.
- `SERVICE_REQUEST_API_URL`: tracker-only, the trusted QR server's `/api/requests` URL.
- `TRACKER_ASSET_API_URL`: QR-only, the trusted tracker `/api/service-assets` URL.
- `LOGIN_PROXY_SECRET`: tracker-only; authenticate the reverse proxy's overwritten
  client-IP/secret headers for shared staff login limits. See
  [staff login ingress and limits](STAFF-AUTHENTICATION.md).
- `AUTH_MODE`, `AD_DIRECTORY_ID`, `AD_LDAP_URL`, `AD_BASE_DN`, `AD_BIND_DN`,
  `AD_BIND_PASSWORD`, `AD_CA_FILE`: tracker-only AD selection/private directory
  settings. `AUTH_MODE=ad` requires all settings, certificate/hostname validation
  and a restricted reader. Use the [AD setup and explicit linking runbook](STAFF-AUTHENTICATION.md).
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
Any existing user blocks bootstrap; HTTP setup remains unavailable. In AD mode,
provisioning prompts only for an app username and creates no chosen PIN. Follow
the AD runbook to explicitly link the reviewed administrator GUID. Existing users
must be linked in place, preserving IDs, roles and draft ownership. Configure the
same `AD_DIRECTORY_ID` in protected `.env.migrate` for `auth:link-ad`; the reader
password is unnecessary for that command.

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

Local PIN login holds a PostgreSQL user-row lock through verification and session
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

Local mode retains the 4–8 digit PIN policy; both modes retain 12-hour sessions.
Tracker migration 0006 supplies shared login limits. Migration 0007 adds explicit
directory/GUID links and provider-specific session metadata to existing tables;
existing table grants cover the new columns. AD verifies credentials/status
before taking the account/linked-user locks for session issuance. AD mode rejects
PIN login/sessions and delegates password/unlock operations to directory admins.
Approval is cached in SQL for at most 60 seconds; expired approval requires an AD
check, and outages fail closed without extension. Company AD setup and acceptance
remain AUTH-01-ROLLOUT. See [staff login policy](STAFF-AUTHENTICATION.md) for private
TLS settings, identity links, revocation limits, recovery and trusted internet ingress.
Shared-device code now uses tab memory, server-bound session contexts, acknowledged sign-out/retry, and
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
`/api/health` checks the selected database and required application tables, returning a
small no-cache 200/503 response without connection details. Use it for readiness.
For AD mode it checks local configuration/CA and required identity/session columns,
without contacting AD; 200 does not establish directory availability.
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

## Inventory draft recovery rollout

Tracker migration `0003_inventory_drafts.sql` adds account-owned recovery copies.
Apply it with the migration owner and add `app_inventory_drafts` to the existing
tracker runtime role grants before shipping the updated server/UI. Readiness checks
access to the new table. Reload older staff tabs (asset version 64). Copies have
seven-day visibility, five-active/20-retained-ID account quotas, and are included
in complete tracker database backups. Successful owner recovery requests remove
expired rows; scheduled expiry cleanup and backup retention remain operator work.
See [draft recovery](DRAFT-RECOVERY.md) for privacy, permissions, and offline limits.

## Complete backup and recovery rollout

Root `npm run db:backup` and `npm run db:restore` are operator-only commands with
explicit protected libpq service/passfiles. They do not load application URLs or
private application environment files automatically. Backups include both complete
application databases; restoration verifies new empty recovery databases, revokes
old sessions and grants restricted runtime access. See
[the recovery runbook](DATABASE-BACKUPS.md) for preparation, execution and failure
handling. Schema changes must update the supported-table catalog and recovery drill.

This development implementation does not provision production database services,
schedule backups, transfer archives off this VM, encrypt them or enforce retention.
Complete DATA-03-ROLLOUT, including private environment/role recovery and an operator
drill, before real data cutover. There is no global transaction between the two
restored databases; retain the originals and review both apps before approved cutover.

## Import/report corrections

Reload staff tabs for asset version 64. Import previews/Apply now recheck capacity,
keep skipped rows free of side effects, retain mapped metadata and assignment
history, and report local outcomes pending sync confirmation. Ordinary account
imports apply one receiver per operation under the existing server permission
policy. CSV reports protect formula-like text/leading-zero or long numeric IDs
using quoted fields with in-field tabs. See
[the import/report policy](IMPORTS-AND-EXPORTS.md); verify actual target spreadsheet
behavior before deployment and use JSON/database backups for exact recovery.

## Retained request and activity browsing

Apply tracker `0004_activity_pagination.sql` and requests
`0003_request_pagination.sql` with their operator connections before shipping the
matching applications/staff assets (version 65), then reload open staff tabs.
They add ordered indexes only;
no rows/tables/credentials change and existing runtime table grants still apply.
Both applications import the shared listing contract from root `lib/record-list.ts`;
retain the repository layout when installing/building the QR application.

Staff request search/status and administrator activity search/type/date filters
now run before pagination. GET defaults/maxes to 100 rows, with opaque next cursors;
older API callers expecting every retained record in one response must follow
pages. The staff UI does that on demand. Search may still scan retained records;
measure production-like performance under DATA-06-SCALE. The proxy rejects redirects
and responses above two MiB within its existing five-second authorization bound.
Internal endpoints must be configured directly, not as redirecting URLs.

No retention purge, archived-data service or production migration is executed by
this development change. Snapshot/live-page limits and scoped UI counts/CSV are
explained in [record browsing policy](RECORD-LISTS.md). Complete recovery remains
[paired PostgreSQL backups](DATABASE-BACKUPS.md).

## QR coordination upgrade

Apply tracker `0005_service_operations.sql` and requests
`0004_operation_receipts.sql` with their respective owners and explicitly grant
runtime access on `app_service_operations` / `service_request_operations`.
Both health checks require these tables. Ship compatible apps/UI together, reload
staff tabs (version 66), and update private integrations: the old direct QR
PATCH/DELETE endpoint is closed. Run root `npm run service:reconcile -- --watch`
as a separately supervised restricted VM process using the private tracker runtime
environment. No production process is installed by the implementation. See
[QR operation policy](QR-OPERATIONS.md) for intent/receipt semantics, manual retries,
rent conflicts, shutdown, retention and restored-operation approval. Updating the
supported backup catalog means new backup sets require the current migrations;
older archives need a separately reviewed upgrade plan before this restore tool
can accept them. Do not edit recorded migration checksums or bypass verification.

## Staff login traffic upgrade

Apply tracker `0006_login_rate_limits.sql` using its migration owner and grant the
tracker runtime SELECT/INSERT/UPDATE/DELETE on `app_login_rate_limits` before
shipping the updated staff server. Readiness and login fail closed without the
new table/grants. Add SELECT to the backup role's explicit grants as well. Complete
archives/restore drills include these counters; old archive schemas need a reviewed
upgrade plan and cannot bypass checksum/catalog verification.

Production internet ingress must configure a fresh server-only `LOGIN_PROXY_SECRET`
and overwrite both trusted login headers, with the staff Node backend inaccessible
from the internet. Blank permits local development using global/username limits
only. See [staff authentication](STAFF-AUTHENTICATION.md) for the exact protocol,
fixed-window limits and remaining AD integration. No AD settings or production
services are changed by merging this code.

## Existing Nginx Proxy Manager ingress

Use [the HTTPS ingress runbook](HTTPS-INGRESS.md) and `npm run ingress:prepare`
to stage the existing proxy and private VM TLS gateway, independent staff/QR
header credentials and the deployment-only public QR destination. Node ports
stay on loopback; no DNS/service/certificate change is made by preparation.

## Supervised services

Use [production service preparation](PRODUCTION-SERVICES.md) for reviewed systemd
units, role-isolated JSON credentials, least-privilege startup checks, restart/stop
handling and private readiness monitoring. This is preparation only; production
PostgreSQL, identities, data, certificates and actual activation remain operator work.
