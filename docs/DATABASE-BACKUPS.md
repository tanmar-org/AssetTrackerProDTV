# Complete database backups and recovery

Inventory downloads omit accounts, sessions, QR requests, rate counters, change
logs, server history and account-owned draft copies. The root operator commands
back up both PostgreSQL databases, including every current application table and
`schema_migrations`. They are separate from either web server. Tracker archives
also include `app_login_rate_limits` from migration 0006: short-lived hashed
username/client selectors, counters and expiry timestamps, never submitted PINs or
AD passwords. Treat these pseudonymous records as private metadata. Add the new
table to explicit SELECT grants for the backup role. The current catalog expects
migration 0006; older archives require a reviewed schema upgrade before this
restore tool can accept them.

This implementation has passed synthetic recovery drills. No production backup
job, off-server storage, encryption service or retention schedule is configured.
Complete DATA-03-ROLLOUT before importing live records or deploying.

## Prepare private operator access

Use the reviewed code checkout with exactly the migrations applied to the source.
Install `psql`, `pg_dump` and `pg_restore` matching the server's PostgreSQL major
version; the VM's user-local PostgreSQL 18.6 tools support the current test server.
The commands refuse mismatched major versions and unsupported application schemas.

Provision a separate restricted backup login for each database. As its schema
owner, grant CONNECT on that database, USAGE on `public`, and SELECT on its
application tables **and `schema_migrations`**. See
[the table list](SELF-HOSTING.md#data-layout-and-compatibility). Do not grant DDL,
write privileges, superuser access or membership in an owner role. Provisioning
production roles remains an operator deployment task.

Create a private operator directory outside the repository and all web roots,
owned by the user running these commands, mode `0700`. Put `pg_service.conf`, a
libpq passfile and a copy of [.env.backup.example](../.env.backup.example) there,
each mode `0600`, owned by that user. Symlinked files, shared permissions and
repository paths are rejected. Never commit them. Example service entries,
with deployment-specific values substituted:

```ini
[tracker_backup]
host=127.0.0.1
port=5432
dbname=assettracker
user=tracker_backup_reader

[requests_backup]
host=127.0.0.1
port=5432
dbname=assettracker_requests
user=requests_backup_reader
```

Passwords belong in the protected passfile, with entries matching each service's
host, port, database and user. Enter real values privately; avoid wildcard
entries, password literals in shell history, and connection URLs in arguments.
Use interactive `psql` `\password` when assigning role passwords. PostgreSQL
documents [service files](https://www.postgresql.org/docs/18/libpq-pgservice.html)
and [password files](https://www.postgresql.org/docs/18/libpq-pgpass.html).

Set absolute `PGSERVICEFILE` and `PGPASSFILE` paths, both service names, and an
absolute `BACKUP_DIRECTORY` outside every web root. Existing backup directories
must already have private ownership/permissions; new directories are created
with mode `0700`. `BACKUP_TIMEOUT_SECONDS` defaults to 600 and accepts 1–7200.
Use adequate disk space and an operator account separate from the web process.
The commands construct their own libpq environment, excluding inherited
`PGPASSWORD`, connection overrides and application database URLs.

## Create and keep a backup set

From the root of the reviewed checkout, run:

```sh
node --env-file=/absolute/private/backup.env scripts/backup-databases.mjs
```

Alternatively, `npm run db:backup` uses already configured environment variables.
It does not automatically load `.env.local` or `.env.migrate`. Neither command
accepts database URLs or credentials as command arguments.

Each successful set is a private `backup-<timestamp>-<UUID>/` directory containing
`tracker.dump`, `requests.dump` and `manifest.json`. The manifest records migration
checksums, database encoding/locale/collation, schema definitions, archive SHA-256,
and every table's row count and order-independent content fingerprint. Metadata
and its dump use the same exported read-only snapshot, even during source writes.
The two databases have separate snapshots; pause both writers during final cutover
if the owner needs a coordinated inventory/request checkpoint. PostgreSQL explains
[consistent dumps and exported snapshots](https://www.postgresql.org/docs/18/app-pgdump.html).

Files are mode `0600`; set directories are `0700`. Both archives must finish,
pass archive-list checks and be synced to storage before the complete directory
is published by rename. Failures remove the working directory where possible;
process/VM crashes can leave `.partial-*` directories. Never use those as backups.
Record the exit status and successful set name; do not treat a failed run as proof
of protection. Errors are redacted because PostgreSQL diagnostics can contain
private rows or SQL.

Copy the **entire published directory** to an approved encrypted destination
outside this VM, preserving private access. Same-VM copies cannot recover from
VM/disk loss. Archives contain private inventory, PIN/session hashes, contacts
and GPS. SHA-256 detects corruption against the manifest; it provides neither
encryption nor proof of authenticity. Restore only trusted operator-produced
sets. MD5 table fingerprints compare restored content, not adversarial authenticity.

## Restore into new, empty recovery databases

Keep applications pointed at their original databases and recovery services
offline. This command never overwrites the original databases. Provision two
new empty databases and two fresh runtime logins. Both database and runtime-role
names must match `assettracker_restore_` followed by 1–40 lowercase letters,
digits or underscores; use distinct names for each app. For example:

```sql
CREATE ROLE assettracker_restore_tracker_runtime LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE assettracker_restore_requests_runtime LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
```

Assign passwords interactively. Runtime roles must have no role memberships or
database ownership. Create each database using `TEMPLATE template0`, owned by its
separate migration/operator owner, with **encoding and locale settings matching
the source manifest**. Do not run application migrations first: restoration needs
empty databases and imports their schema itself. Revoke PUBLIC access on each new
database immediately; grant the operator access, keeping application processes
offline. No default privilege grants or connected non-owner users are allowed.

Put destination owner connections in a protected recovery service/passfile pair.
Use a private copy of [.env.restore.example](../.env.restore.example), substituting
those service names, the fresh runtime role names and the published set directory.
The service's login must be the selected database's actual owner; runtime
credentials cannot run restoration. Before execution, verify those private
service entries point to the intended new databases:

```sh
node --env-file=/absolute/private/restore.env scripts/restore-databases.mjs
```

`npm run db:restore` is equivalent when the environment is already configured.
The restore command checks both archives and manifests before destination writes,
then checks both new databases, roles, ownership, permissions and locale settings.
An advisory lock (`728304`) serializes cooperating restore operators on each
destination. It refuses source names, ordinary database names, nonempty targets,
wrong code/migration history, changed collations, unsafe roles and modified archives.

Archives restore with ownership/ACL replay disabled, in one transaction per
database, with errors stopping the operation. The command does not use `--clean`
or `--create`, and never drops a database. See
[PostgreSQL restore options and trusted-archive requirements](https://www.postgresql.org/docs/18/app-pgrestore.html).
It checks schema, migration history, row counts and content fingerprints against
the source snapshot before allowing runtime access. After **both** verify, it
deletes restored tracker sessions, pauses unfinished QR intents for administrator
review (`blocked` / `restore_review`), records the restore in the audit log, and
grants only operational table access to each fresh runtime role. The operator
still owns the schema; runtime roles cannot read `schema_migrations` or run DDL.

A successful restore intentionally differs from the backup by revoked sessions,
the new audit entry, and paused unfinished QR intents. Staff must sign in again.
The two source snapshots can straddle a QR transition; keep the reconciler paused
for restored work until an administrator inspects and approves each intent. The
versioned QR receipt prevents blind reapplication. See [QR operations](QR-OPERATIONS.md).

Account/PIN data otherwise survives: review restored accounts, roles, lockouts and subsequent credential
changes before cutover, because a historical backup can revive older account data.

There is **no transaction spanning both databases**. A late failure can leave a
partially restored pair. The command attempts to revoke the selected runtime
roles' CONNECT privileges on both targets after a late failure. If connectivity
or operator rights are lost, verify those revocations privately; keep services
offline regardless. Cancellation/timeouts stop child processes. Preserve failed
targets for diagnosis and provision fresh empty targets for another attempt;
there is no automatic wipe or retry.

## Accept recovery before cutover

Using separate temporary configuration and loopback ports, start both apps under
the new runtime roles. Check both `/api/health` responses, administrator login,
inventory/revision/stock/audit/history, owned drafts and staff access to QR requests.
Verify old sessions fail and permissions remain restricted. Review inventory/QR
relationships across the two snapshots and any changes made after the backup.
Record counts, recovery time, app checks and operator approval in the private
recovery record. Switch services/domains only under the owner's approved cutover
plan; leave the originals intact for rollback.

The synthetic regression drill exercises this workflow, including actual HTTP
readiness/login/draft/request reads, corrupted archives, nonempty targets, unsafe
permissions, verification failures and concurrent source writes. It uses no live
records and does not schedule backups or authorize a production restore.

## Remaining operational work

DATA-03-ROLLOUT requires an approved encrypted off-server destination, private
credential/configuration recovery, backup schedule, retention policy, failure
alerts and periodic timed restore drills. A proposed starting schedule is daily
backups with a drill before deployment and after material schema changes; choose
retention and recovery objectives with the owner. Nothing is scheduled by this PR.

These are application logical backups, not point-in-time recovery or a server
image. PostgreSQL cluster roles/passwords, server settings, private environment
files, application binaries, external provider state and domain/proxy configuration
need their own protected recovery plan. This implementation supports the current
application tables/migrations; additional schemas, functions, extensions, large
objects or new tables cause explicit refusal until the backup support and drill
are updated. For much larger databases, reassess fingerprint resource use and
physical/WAL backup requirements rather than extending timeouts blindly.
