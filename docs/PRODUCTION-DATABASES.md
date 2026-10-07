# Fresh production PostgreSQL provisioning

`npm run db:prepare` stages private credentials without a database connection.
The separate `--initialize` operation creates two **new** databases, applies the
current checksummed migrations as their distinct owners and grants explicit
application-table access. It imports no inventory, requests, users or sessions;
it creates no administrator/AD mapping and starts no service. Review/merge of the
code does not authorize running it against production.

This closes the manual role/grant setup gap. Runtime roles cannot own databases,
create schemas, access migration history or modify the other app's database.
Separate backup roles have SELECT on all supported tables and migration history;
only operator roles own schemas. The reconciler uses the tracker runtime role.
The explicit table catalog is shared with complete backup tooling; future schema
changes must update it and the grants on existing installations separately.

## Private settings and staging

Store this JSON outside all Git/web roots in a protected operator directory.
Example values are placeholders, not this VM's selected production configuration:

```json
{
  "administratorUrl": "postgresql://postgres@localhost:5432/postgres?host=/run/postgresql",
  "namespace": "assettracker_production"
}
```

The maintenance database must be `postgres`; the server must be PostgreSQL 18,
socket-only (`listen_addresses = ''`) and accessed by an explicit administrator
with superuser rights. This initial provisioning authority is never given to an
application or backup role. URI host must be `localhost` with exactly one absolute
`host` socket parameter; TCP/public hosts and additional connection overrides are
rejected. The namespace is `assettracker_` plus 1–30 lowercase letters, digits or
underscores. Derived names are `<namespace>_<tracker|requests>` and
`<namespace>_<app>_<owner|runtime|backup>`.

Run as the operator identity that owns the private files. For the peer-authenticated
`postgres` example, this means the PostgreSQL OS account with access to an installed,
root-owned release/Node binary; an ordinary interactive VM user cannot impersonate
that peer account. A separately approved password-authenticated DBA account may
instead be supplied in protected JSON. Never put its password in command arguments,
shell history, a repository file or chat. JSON serialization preserves characters.

Require settings mode 0600, a fresh output directory under an operator-owned 0700
parent, canonical absolute paths, and no group/world-writable non-sticky ancestor.
Existing output is never replaced. Empty sandbox-reserved `.git` directories are
allowed; real Git directories/worktree pointers are refused.

```bash
npm run db:prepare -- /private/operator/database-settings.json /private/operator/database-plan
```

Nine files are created: six owner/runtime/backup connection JSONs, `pg_service.conf`,
`pgpass` and an atomic `manifest.json`. Files are mode 0600, directory 0700. Each role
gets a unique random 256-bit ASCII password. The manifest has no connection URL or
password. Staging writes nothing to PostgreSQL and installs/enables nothing.

## Server authentication and approved initialization

Install/supervise PostgreSQL separately during an approved deployment. The user-local
preview/test clusters are not production. Use private persistent storage/socket paths
compatible with service filesystem protection and confirm reboot/disk/backup behavior.
Configure socket access for the intended service OS users and SCRAM authentication;
do not expose the database via public TCP.

The command reads actual `pg_hba_file_rules`, rejects errors and local trust/MD5/plain
password/broad peer rules, and requires a local SCRAM rule. It permits peer only for
one explicitly named DBA matching the supplied administrator username. For the
example above, a narrowly scoped `local all postgres peer` followed by applicable
SCRAM rules is allowed; `local all all peer` is refused. HBA rule ordering remains
the operator's responsibility. Add narrowly scoped rules for each role/database and
reject that app's roles on other databases before broader rules if needed. The command
revokes PUBLIC on the two new databases; it does **not** alter CONNECT grants on
existing maintenance/other databases or rewrite HBA. Validate that wider cluster
policy separately. [PostgreSQL password authentication](https://www.postgresql.org/docs/18/auth-password.html)
explains SCRAM and peer/password selection.

After owner approval of the deployment/database/data plan:

```bash
npm run db:prepare -- --initialize /private/operator/database-settings.json /private/operator/database-plan
```

Before any creation, both target database names and all six role names must be
absent. Concurrent initializers serialize their role reservation; a losing attempt
cannot revoke the winner's roles. Existing names are never adopted, migrated,
rotated or dropped. This command is not the upgrade/import/restore tool.

All six roles start NOLOGIN with no elevated flags or memberships. Database
connections start disabled; PUBLIC access is revoked before enabling them.
Migrations run under each actual owner with transaction-scoped SET ROLE. Explicit
DML grants go only to its runtime role; backup gets SELECT; no default grants
silently authorize future tables. Before enabling logins, every role must reject a wrong password with PostgreSQL
SQLSTATE 28P01 while still NOLOGIN; trust/peer/reject rules fail differently. Only
once both schemas/grants and these authentication checks pass are logins enabled. Real connections for all six roles, wrong-password rejection and the service
launcher's read-only runtime permission check must then pass before the manifest
becomes `initialized`. Wrong-password checks also catch a password-bypassing rule
still active when the strict HBA file has not been reloaded; this tool never reloads
server configuration. Revalidate actual HBA after any later policy change.

Only SCRAM verifiers are submitted in password DDL, so plaintext generated passwords
are absent from SQL statement logs; the credential JSON/passfile remain secret.
Verifiers are also sensitive and DBA logs/catalog access must stay protected.
ASCII-only generated passwords avoid normalization ambiguity. The format follows
[PostgreSQL's SCRAM implementation](https://github.com/postgres/postgres/blob/REL_18_STABLE/src/common/scram-common.c)
and [CREATE ROLE's verifier storage](https://www.postgresql.org/docs/18/sql-createrole.html).

## Failures, credentials and cutover

An ordinary initialization failure disables only this attempt's created roles and
terminates their sessions. Partial databases and credentials remain for diagnosis;
no automatic deletion, overwrite or retry occurs. `failed-offline` reports successful
containment; `failed-operator-action-required` means the DBA must verify/disable those
roles manually. SIGINT/TERM requests stop at the next bounded stage and run containment.
A killed process, database outage or filesystem failure can prevent cleanup/status
recording; `initializing` or otherwise interrupted plans require private DBA review,
not an assumption that every role is disabled. These multi-database operations are
not globally atomic. Preserve artifacts and verify actual catalogs before proceeding.

Combine only each app's runtime DATABASE_URL with its allowed
[service JSON fields](PRODUCTION-SERVICES.md). Keep owner JSON, backup files and this
plan outside releases and away from application UIDs. Owner credentials are for
operator migrations/provisioning/linking only. For future migrations, supply that
owner URL privately to the existing CLI; do not add `.env.migrate` to a managed web
release. Install root-owned runtime credential sources separately for systemd.

The two backup services are `tracker_backup` and `requests_backup`; their protected
service/passfiles work with [paired backup/restore commands](DATABASE-BACKUPS.md).
Successful local dumps do not configure schedules, encryption, retention or off-server
copies. Restrict the backup OS identity and complete a recovery drill before cutover.

The owner's empty-versus-existing-data decision governs the next step. Empty launch
still needs reviewed AD administrator provisioning/linking and recovery access.
Existing data requires authorized exports, explicit reconciliation/import and new
sessions; never copy the preview automatically. Backend TLS, NPM/DNS, actual system
service/reboot acceptance, mobile GPS and deployment approval remain separate.
