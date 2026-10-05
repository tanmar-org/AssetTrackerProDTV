# Project journal

## Current handoff

- Repository: https://github.com/tanmar-org/AssetTrackerProDTV
- Baseline reviewed: `main` at `b3d86eb3eb05134e42c6f475e5a3dbe47df6a7e5`.
- Development branch: `Dev/safe-service-rendering`, based on merged
  `main` at `68e74ab`.
- Publication status: foundation [PR #3](https://github.com/tanmar-org/AssetTrackerProDTV/pull/3)
  and Dependabot [PR #2](https://github.com/tanmar-org/AssetTrackerProDTV/pull/2)
  and credential-removal [PR #4](https://github.com/tanmar-org/AssetTrackerProDTV/pull/4)
  and SEC-02 provisioning
  [PR #6](https://github.com/tanmar-org/AssetTrackerProDTV/pull/6)
  were merged by the owner.
- PostgreSQL preference documentation
  [PR #7](https://github.com/tanmar-org/AssetTrackerProDTV/pull/7) was merged by the owner.
- Active working copy on the hosting VM:
  `/home/itadmin/projects/AssetTrackerProDTV-security-cleanup`.
- Owner reviews and merges all PRs. Agents may push `Dev/` branches and open PRs.
- Current phase: the owner merged the native Node/PostgreSQL migration in
  [PR #11](https://github.com/tanmar-org/AssetTrackerProDTV/pull/11). Account lifecycle
  and concurrency corrections in
  [PR #17](https://github.com/tanmar-org/AssetTrackerProDTV/pull/17) are also merged
  by the owner. Inventory permissions/schemas in
  [PR #19](https://github.com/tanmar-org/AssetTrackerProDTV/pull/19) are also merged.
  SEC-04 safe service rendering is implemented on `Dev/safe-service-rendering`
  for owner review.
  Production deployment has not started.
- Next task: remaining dependency/QR security work,
  and AUTH-01/DATA-01/DATA-04 access/conflict/cache requirements. Production domains/services/backups/data cutover remain
  under HOST-03/HOST-04/MIG-01. SEC-01-OWNER still needs owner confirmation.

## 2026-10-05 — Repository access and read-only review

### Access and scope

Created a dedicated server SSH key and repository-specific SSH alias. The owner
added the public key with write access. Verified and cloned `main`; the worktree
was clean. Repository-local SSH configuration uses the server's dedicated key.
Never commit private keys or copy their contents into this journal.

Reviewed both applications' APIs, authentication, frontend behavior, SQL migrations,
build scripts, configuration, dependency lockfiles, and handoff documentation.
The review did not change code, install dependencies, or deploy either application.

### Architecture and outside dependencies

| Dependency | Actual use | Proposed direction |
| --- | --- | --- |
| Cloudflare Workers | Runs both web applications and their HTTP APIs; injects runtime bindings. | Port API execution and configuration to the VM's Node runtime. |
| Cloudflare D1 | Separate tracker and QR-service databases. Tracker contains users, sessions, logs, state/history; QR DB contains requests and GPS/contact fields. | Locally managed database; PostgreSQL recommended, SQLite a smaller alternative. Owner has not selected the database yet. |
| Worker `ASSETS` binding | Serves bundled static files and images. | Local static asset serving. |
| Worker `IMAGES` binding | Image-optimization endpoint in both Workers; current pages use ordinary image tags. | Remove unused endpoint or replace locally if needed. |
| Vinext/Vite/Cloudflare plugin/Wrangler | Current build and local Worker/D1 development toolchain; artifact validation expects Sites manifests and Worker exports. | Adopt a conventional Node deployment target; preserve existing UI where practical. |
| Original Sites access policy | Handoff describes an outer restriction that is not transferred with source. ChatGPT auth helpers are present but unused by active routes. | Company-controlled staff access; keep public QR access separate. |
| jsDelivr/SheetJS `0.18.5` | Browser-loaded spreadsheet parser for XLSX imports and audits. | Upgrade and vendor a verified local copy. |
| Google Fonts | Layouts import Geist fonts. Pinned Vinext supports development CDN loading and production download/self-hosting. Exported cache CSS contains old absolute paths. | Explicit local fonts and portable asset paths. |
| Google Maps | Optional links to view submitted coordinates; no Maps API integration found. | Can remain optional. |
| Device geolocation | QR form requires location permission and a secure browser context. | HTTPS plus a defined GPS failure/permission-denial workflow. |
| Device email client | Service request and deactivation flows open `mailto:` drafts; no automatic delivery. | Approved company mail service with server-side sending and delivery tracking. |
| npm registry | Download source dependencies for builds; not a business API used by customers. | Controlled installs/builds using reviewed lockfiles. |

No active DIRECTV API, AI API, payments, queues, or object-storage integration was
found. Both R2 settings are null. Application activation/deactivation status changes
do not perform operations at DIRECTV. Production databases, users, credentials,
and inventory exports were excluded from the handoff; sample records remain.

### Findings to carry forward

Stable task IDs and acceptance criteria are in `TODO.md`:

- **VIS-01 / SEC-01:** repository visibility must match the owner's private-source
  intent; an account-password value exists in browser JavaScript. Redact its value
  from every report. Rotation belongs to the credential owner if it is real.
- **DEP-01 / DEP-02:** known vulnerable dependency versions and externally loaded
  SheetJS require remediation and a coordinated compatibility check.
- **SEC-02:** empty-database administrator creation is publicly accessible and
  uses a non-atomic count/create flow.
- **SEC-03:** permissions depend partly on client-supplied action labels;
  `rentalStock` is omitted from regular-user save checks.
- **SEC-04:** legacy static service form inserts URL values into `innerHTML`.
- **SEC-05 / QR-01:** public submissions trust receiver/account fields from QR
  URLs; links expose and can retain outdated metadata. Missing abuse controls and
  incomplete field/location validation; duplicate detection is not atomic.
- **AUTH-01:** PIN resets retain sessions, the last admin can be demoted, and
  migrations differ from runtime auth constraints.
- **DATA-01 / DATA-02:** conflicting browser saves can discard edits; recovery
  lacks equivalent revision protection; related state/log and QR/tracker changes
  are not consistently atomic.
- **DATA-03 / DATA-04:** backup omits rental stock and entire database categories;
  Undo omits audit state and does not restore rental stock. Browser storage failures
  can interrupt saves, and sign-out leaves operational caches behind.
- **DATA-05:** import success counts can conceal capacity-blocked assignments;
  CSV exports do not neutralize formulas.
- **DATA-06:** QR listing and activity retrieval stop at 500 rows without pagination;
  shared recovery retains only 25 snapshots and is not a complete backup.
- **MAIL-01 / MAIL-02:** test email draft requires manual Send; no automatic
  Monday report or scheduler is implemented.
- **HOST-01–HOST-04 / MIG-01 / QA-01:** choose and implement the self-hosted runtime,
  configuration/domains/HTTPS, process supervision and backups; validate real-data
  migration, printed-label continuity, hardware, mobile behavior, and meaningful
  regression coverage before cutover.

### Dependency evidence

The owner explicitly approved sending dependency names and exact versions to npm's
advisory service. The query checked 580 distinct package names; both application's
dependency graphs were identical. Eighteen names matched 74 unique published
advisories: **3 critical, 39 high, 25 moderate, 7 low**. Counts deduplicate advisory
URLs across ranges and across the two applications. They describe version matches,
not 74 independently proven exploitable application flaws. Development-only,
Windows-specific, and unused-feature conditions require reachability assessment.

Affected names: `@babel/core`, `esbuild`, `brace-expansion`,
`baseline-browser-mapping`, `braces`, `browserslist`, `fast-uri`, `fflate`,
`image-size`, `js-yaml`, `nanoid`, `next`, `postcss`, `react-server-dom-webpack`,
`sharp`, `undici`, `vite`, `ws`. SheetJS is loaded outside the lockfiles and has
separate prototype-pollution and denial-of-service advisories.

Machine-readable evidence is in
[the dependency review](docs/reviews/2026-10-05-dependencies.json).

Primary references:

- [Workers](https://developers.cloudflare.com/workers/) and [D1](https://developers.cloudflare.com/d1/).
- [Vinext upstream](https://github.com/cloudflare/vinext); the font behavior above
  was additionally checked in the locked `vinext@0.0.50` npm package source.
- [React server-function advisory](https://github.com/advisories/GHSA-wx67-qw84-cm4g).
- [Next image-processing advisory](https://github.com/advisories/GHSA-2xp9-vwfh-vxw4).
- [SheetJS prototype pollution](https://cdn.sheetjs.com/advisories/CVE-2023-30533)
  and [SheetJS denial of service](https://cdn.sheetjs.com/advisories/CVE-2024-22363).

### Review validation and limits

Browser JavaScript syntax checks passed. All four tracker migrations and all three
QR-service migrations applied to separate, temporary in-memory SQLite databases.
No duplicate HTML IDs or missing literal tracker ID references were found.
Small isolated checks confirmed that backup excludes rental stock, Undo snapshots
exclude audit state, and CSV formulas are exported without neutralization.
These checks do not validate actual D1 behavior, a production migration, or device
printing. No application build or browser/device test was run during the review.

## 2026-10-05 — Development foundation, checks complete

The owner authorized the documentation/comment pass, installation of useful VM
development tools, and the first PR. Created `Dev/project-foundation` from the
reviewed main branch. Added `AGENTS.md`, this journal, the TODO list, and a development
guide. The first PR documents existing behavior and limitations; corrective work
is tracked separately.

Passwordless sudo is unavailable. Installed official SHA-256-verified Node
**v24.21.0** (npm **v11.19.0**/npx) and GitHub CLI **v2.102.0** in the user's
`~/.local/share/assettracker-tools/`, with links in `~/.local/bin/` already on PATH.
No root-level server services were provisioned. Project-local author identity is
`Codex <codex@localhost>` to distinguish automated commits from the owner's identity.
CLI PR commands require separate API authentication, while Git push uses the SSH
deploy key. Use an authorized GitHub integration or CLI account for PR operations.

Both connected GitHub metadata and an unauthenticated GitHub repository API request
confirmed `private: false` / public visibility. No visibility change was made.

Installed both applications using `npm run install:ci`: 503 packages per app,
successful exits, original lockfiles unchanged. npm emitted inherited package
deprecation/install-script notices; both applications subsequently built successfully.

Added explanatory comments in 17 source/test files: Worker binding bridges, D1
adapter limitations, PIN/session/account boundaries, public setup/request trust,
revision/history/recovery behavior, browser cache/Undo/backup scope, QR metadata,
CSV/import handling, GPS/mail drafts, and the limits of existing smoke coverage.
Known issues are linked to stable TODO IDs. Compiler AST comparison against the
baseline confirmed executable syntax unchanged in every commented file.

Validation completed on 2026-10-05 (America/Chicago): both `npm test` commands
passed, including builds, Worker artifact checks, and one smoke test per application.
Browser syntax and diff whitespace checks passed. Both lint and TypeScript checks
failed on inherited issues; QA-02 tracks source/type/configuration remediation.
See [the exact validation record](docs/reviews/2026-10-05-validation.md).
No tracked font-cache files or lockfiles changed during the installs/builds.

Committed the foundation as `4c72138`. Automatic approval review rejected the
branch push because GitHub confirmed a public destination while the owner's stated
intent was private, and the new documentation includes internal architecture and
security findings. No push or PR creation succeeded. Asked the owner to make the
repository private or explicitly approve public publication of this payload.

The owner subsequently stated: "I approve pushing these documents to the public
repository." This explicitly authorizes publication of this foundation payload.
Repository visibility remains public; no settings were changed by the agent.

The prepared development branch has been pushed successfully.

[PR #3](https://github.com/tanmar-org/AssetTrackerProDTV/pull/3) opened on 2026-10-05,
targeting `main` from `Dev/project-foundation`. Foundation task PR-01 is complete.
The owner performs final review and merging (OWNER-01); deployment and functional
corrections remain separate tasks. The prior build/test results still apply because
the final update only records PR status and its link.

## 2026-10-05 — Dependabot PR #2 review

Reviewed [PR #2](https://github.com/tanmar-org/AssetTrackerProDTV/pull/2) at
`2d3ae20d72c54abafd258edf616416837f40862d` in a separate `Dev/review-dependabot-next`
checkout. It changes only the QR service's package manifest and lockfile, upgrading
Next.js from 16.2.6 to 16.3.8 and related dependencies. Its locked install, build,
Worker artifact validation, and existing smoke test passed. Lint still reports the
same two effect errors/three image warnings; TypeScript still reports the same four
Cloudflare type diagnostics as the earlier baseline. No application code changed.

Recommendation: owner may merge PR #2 as a limited dependency update. DEP-01 remains
open because the tracker and other affected dependencies still need remediation.
This smoke coverage does not establish production readiness. No merge was performed.

## 2026-10-05 — Merged baseline and SEC-01 code correction

The owner confirmed PRs #2 and #3 were merged. Fetched `origin/main` and verified
both merge commits; current baseline is `0c0a6f3`. The QR service now uses Next.js
16.3.8; the root tracker remains at 16.2.6. OWNER-01 is complete and DEP-01 remains
open for broader updates.

Created `Dev/remove-public-account-password` in a separate worktree so the existing
unstaged authentication-comment edit in the foundation checkout is preserved.
Removed the account-password field from the public deactivation-email formatter.
The draft retains its request text, address, receiver/card/serial/RID and account
identifiers. Added a comment explaining the public-code/email trust boundary.
No credential value was copied into this journal, fixtures, or PR text.

Added `tests/deactivation-email.test.mjs` and expanded the root test command to run
all tracker test files after the build. The tests exercise the actual formatter
with synthetic receiver data, preserve required identifiers, reject the credential
field in source, and check the generated public asset. Failure assertions use
booleans rather than printing drafts. The first two regression checks failed on
the baseline and passed after removal.

Validation: locked install passed (503 packages, lockfiles unchanged); `npm test`
passed its build, Worker artifact validation, and all four tests. Browser syntax,
new-test ESLint, and diff whitespace checks passed. A one-time in-memory comparison
against the old credential confirmed it absent from all 72 public source/build
assets; its value was neither printed nor saved. The QR application is unchanged
by this correction and was already built/tested in the PR #2 review. Baseline
lint/type issues remain tracked under QA-02.

SEC-01-CODE is complete. Asked the owner whether the historical value was real,
already rotated, or only a test value; confirmation is pending. SEC-01 and
SEC-01-OWNER remain open until credential exposure and the provider authentication
workflow are resolved. Git history and previously deployed copies are not erased
by this code change; production deployment remains outside this task.

Pushed the branch and opened
[PR #4](https://github.com/tanmar-org/AssetTrackerProDTV/pull/4), targeting `main`.
Owner review/merge and SEC-01-OWNER confirmation remain pending. The next corrective
priorities are controlled administrator provisioning and explicit server permissions,
alongside the remaining dependency work. No production deployment was performed.

## 2026-10-05 — SEC-02 controlled administrator provisioning

The owner merged PR #4 and authorized continued correction. Fetched merged main
at `7063cdb` and created `Dev/controlled-admin-provisioning` in the clean correction
worktree. The original checkout's unrelated authentication-comment edit remains intact.

Removed initial administrator creation from HTTP entirely. `/api/auth` rejects
`action: "setup"` with 403 before database work and only permits explicit login.
GET reports `needsProvisioning`; the public UI shows a contact-administrator message
and hides its form while users are absent. Existing account login/session behavior
is preserved. Added a CSS rule so the form's grid styling does not override `hidden`.

Added `npm run admin:provision` and operator helper scripts. The command is local-D1
only, prompts for username/PIN/confirmation, hides PIN echo, and shares the existing
PIN validation/PBKDF2 implementation. Only salted hashes reach a mode-0600 temporary
SQL file, which is removed afterward. Credentials are not passed as arguments or
environment variables. Wrangler logs and raw error details are suppressed.

The conditional INSERT creates a user only when no user exists, so concurrent
attempts cannot both bootstrap. A following lookup of the attempt's random user ID
reports success. The real local Wrangler check showed metadata lacks affected-row
counts; the command and a regression test now use ID-based confirmation instead.
Existing users, including inactive/regular users, prevent repeat provisioning.
No web setup token or alternate public creation route was introduced.

Validation:

- Tracker build and Worker artifact checks passed; all **14 tests** passed. New
  coverage includes rejected setup on fresh/initialized databases, normal login
  and session resolution, inactive-user bootstrap refusal, invalid actions/PINs,
  UI gating, Wrangler result handling, and two simultaneous threads using separate
  SQLite connections to confirm exactly one initial administrator.
- All four migrations applied to temporary local D1 databases. Interactive CLI
  creation succeeded with synthetic credentials and hidden PIN input; a second
  run refused without changes, and a read confirmed one original test administrator.
  Noninteractive input and `--remote` were rejected; temporary SQL files were removed.
- Changed route/scripts/tests passed ESLint; browser/CLI syntax and diff whitespace
  checks passed. TypeScript still reports the same 11 inherited diagnostics under
  QA-02. Lockfiles and QR application code are unchanged.

README, the development guide, IT handoff, agent instructions, and TODO list now
describe operator provisioning. CLI/test commands explicitly enable TypeScript
stripping so the shared helper works with the declared Node 22.13+ minimum.
No live database or production account was created or altered. The production
provisioning adapter must be ported with the selected backend under HOST-02.

SEC-02 implementation is complete and pushed in
[PR #6](https://github.com/tanmar-org/AssetTrackerProDTV/pull/6), targeting `main`.
Pending: owner review/merge, then
continue explicit server permissions (SEC-03), account lifecycle hardening (AUTH-01),
and dependency cleanup. Credential rotation/validity under SEC-01-OWNER still awaits
owner confirmation.

## 2026-10-05 — PostgreSQL migration preference

The owner confirmed the need to replace Workers/D1 and expressed a preference for
PostgreSQL. Use a VM-hosted PostgreSQL database as the migration planning target;
Node/Next.js remains the recommended runtime, with the final layout and operational
design still pending under HOST-01. This is a recorded preference, not a completed
hosting migration. Verified PR #6 is merged and fetched main at `52d401d` before
creating `Dev/postgresql-migration-plan` for this documentation update.

PostgreSQL is suitable for the reviewed workload: its transactions allow related
inventory/history/audit writes to commit together, and JSONB can preserve the
current state document during an incremental migration. Moving the document into
PostgreSQL alone will not correct application permissions, revision conflicts,
or backup coverage. Plan to retain the current UI, port both apps' direct D1 SQL
calls and operator provisioning, and validate migrations with synthetic data.
Define production backups and verify restoration before cutover.

Updated agent instructions, TODO status, the development guide, and this handoff.
No application code, dependency versions, installed services, or databases changed.
Validation is documentation diff review and `git diff --check`; no runtime tests
are required for this documentation-only update. Owner review/merge remains required.

Pushed this documentation update and opened
[PR #7](https://github.com/tanmar-org/AssetTrackerProDTV/pull/7), targeting `main`.
No migration implementation or production deployment is included.

References: [PostgreSQL transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
and [JSON/JSONB storage](https://www.postgresql.org/docs/current/datatype-json.html).

## 2026-10-05 — Native Node/PostgreSQL implementation

The owner merged PR #7 and requested continued implementation without separate
PRs for minor documentation edits. Fetched main at `13467e6` and created
`Dev/node-postgresql`. Documentation now travels with the corresponding code;
the original checkout's unrelated edit remains intact.

Replaced both Vinext/Worker build/start paths with native Next.js/Node. Removed
Worker/Sites configuration/plugins, Wrangler, unused D1/Drizzle adapters/examples,
and unused ChatGPT authentication templates. Both apps use Next.js 16.3.8 and React
19.3.0; lockfiles were regenerated intentionally for the replacement runtime.
This removes unused runtime/tool dependencies, not a claim that DEP-01 is complete.
System fonts remove Google Fonts fetching and obsolete generated font-cache paths.

Added a shared `@tanmar/database` package with bounded PostgreSQL pools, native
parameterized SQL, and transactions on one checked-out client. Ported all active
SQL calls and configuration to separate PostgreSQL URLs and Node server env vars.
Removed request-time DDL; operator-managed migrations are checksummed, atomic,
serialized, and refuse the other app's history. Retained the old `drizzle/`
directories as explicitly historical D1 records for later authorized export mapping.

The tracker keeps its operational state in JSONB, preserving its API fields and
leading-zero text identifiers. JSONB can reorder object keys, so edit comparisons
now canonicalize keys to avoid falsely counting unchanged rows as changes. State,
history, and audit updates share a transaction/advisory lock and keep conditional
revision writes. Recovery requires the reviewed revision and commits all related
writes together; the browser sends its current revision. Separate QR/tracker
coordination remains open under DATA-02.

Ported administrator provisioning to PostgreSQL, with hidden PIN prompts, bound
parameters, no temporary SQL files, and a table lock before inspecting emptiness.
HTTP setup remains rejected and any existing user blocks repeat provisioning.
Native `/api/health` endpoints check database/schema availability without revealing
connection details. Staff QR operations still use a server proxy/shared credential;
removed the obsolete Sites cross-origin allowlist. Permission, QR metadata, abuse,
email, and authentication lifecycle issues remain in TODO.md.

Installed user-local PostgreSQL 18.6 server/client/libpq development binaries from
Ubuntu packages, checked SHA-256 against repository metadata, and added local tool
wrappers. The isolated test cluster uses a private Unix socket with no TCP listener;
no sudo, system service, production database, or live export was used. Both Node
servers were exercised against random test databases and restricted runtime roles.

Updated README files, contributor instructions, development/self-hosting guides,
TODOs, and this handoff within the implementation branch. Original IT handoff and
validation documents are labeled historical. Production services, HTTPS, backups,
restore verification, existing printed labels, and real-data migration remain
separate required work; this PR is not production deployment.

Final validation:

- Both `npm run install:ci` commands passed with **369 packages each**. The shared
  file dependency is packaged into each app (not symlinked); verified the QR
  PostgreSQL driver resolves from its own node_modules. Refresh/rebuild both
  apps after shared-package changes. Removed the old Sites-specific npm cache
  override; npm advisory submission stays disabled and Next telemetry is disabled.
- Both `npm test` builds passed on native Node: **6 tracker tests** and **1 QR
  test** passed. Real PostgreSQL integration passed **17 reported tests** (the
  parent plus 16 scenarios), with no failures/skips. No Worker build was used.
- Both application TypeScript checks passed. Focused server/scripts/helper lint
  passed; the changed tracker browser file retains 4 inherited warnings. Full
  root lint retains 2 vendor errors/147 warnings; QR lint retains 2 effect-state
  errors/3 image warnings. QA-02 remains open for those failures.
- Native migration CLI applied the schema and repeated safely. Interactive
  provisioning created one synthetic administrator with hidden PIN input; a
  second run refused with exit 1 and left the original row unchanged. PIN arguments
  and noninteractive input were rejected. Browser/CLI syntax and diff checks passed.
- Integration fixtures and runtime roles were removed (both remaining counts 0);
  the disposable CLI database was dropped. The user-local PostgreSQL test cluster
  at `/tmp/assettracker-postgresql-development/data` is stopped and has no TCP
  listener. Only its empty test-admin database remains for future development.

Removed the former Worker/Vinext/Drizzle tooling from both lockfiles. The pg driver
retains its optional `pg-cloudflare` compatibility dependency, but its installed
stream selector uses native Node networking here; it creates no Worker/D1 binding
or hosted dependency. Do not mistake a transitive package name for active hosting.

HOST-01/HOST-02 and DATA-02-TRACKER implementation criteria are met; owner PR review
and merging remain pending. Physical devices/printing, production data, backup
restoration, final domains/HTTPS, and production service operation were not tested
or changed. Continue SEC-03/AUTH-01 and dependency remediation before deployment.

Pushed `Dev/node-postgresql` and opened
[PR #11](https://github.com/tanmar-org/AssetTrackerProDTV/pull/11), targeting `main`.
The implementation, regression tests, and related documentation are together in
this PR. The owner performs final review and merging; no deployment was performed.

## 2026-10-05 17:14 CDT — AUTH-01 account lifecycle and concurrent access

The owner merged PR #11 and authorized continued correction. Created
`Dev/account-security` from merged main `93ed64c`. This PR focuses on account
security; inventory permissions/schemas remain SEC-03. The original checkout's
unrelated authentication-comment edit remains preserved.

Login now locks its PostgreSQL user row through PIN verification, failure-counter
updates, and session insertion. Twelve concurrent wrong-PIN requests across two
separate Node servers produce exactly five failures and seven locked responses;
valid PINs cannot bypass the active 15-minute lockout. Successful login clears the
counter/lock and prunes that account's expired sessions. Hash comparisons use
Node's constant-time primitive. Legacy display-name aliases remain available when
unambiguous, without failed/successful login silently renaming accounts or reading
all accounts' hashes. Ambiguous aliases require administrator correction.

User administration now serializes mutations with transaction advisory lock
`728303`, revalidates the actor's session after waiting, and preserves at least one
active administrator. Account writes, session revocation, and their audit inserts
commit together; failed audit writes roll everything back. PIN resets, role
changes, and activation changes revoke all target sessions. Reactivation does not
revive old sessions. Self PIN/role changes clear the cookie and reload the sign-in
gate. Unlock alone retains sessions. Omitted PATCH fields preserve existing values;
invalid role/boolean/PIN types are rejected rather than silently coerced.

Access APIs require small JSON objects, with a streaming 4-KiB byte limit even
without Content-Length. Malformed JSON/types/cookies receive controlled denials;
raw PostgreSQL errors and submitted secrets are not returned. Actual uniqueness
violations produce conflicts; unrelated database failures return unavailable.

Added tracker migration `0002_access_constraints.sql` for PIN hash/salt/session
hash format, the 0–4 failure-counter bound, and a session-user index. The previous
checksummed migration is unchanged. Apply root `npm run db:migrate` with the schema
owner before running this version. Incompatible existing/imported rows fail the
whole migration and require explicit operator reconciliation; credentials are
never automatically rewritten. No new table grants or QR schema changes are needed.

Validation:

- Tracker native build and **9 unit/HTTP regression tests passed**. QR native build
  and **1 HTTP regression test passed**. Both TypeScript checks passed.
- **32 PostgreSQL integration checks passed**, including the existing 16 runtime
  scenarios and 14 account scenarios, plus their two parent tests. New coverage
  includes cross-process lockout, reset/login races, multi-session revocation,
  active-admin retention under competing demotions, stale queued authorization,
  account/audit/session rollback, expired-session cleanup, strict input/permissions,
  legacy aliases, hash/counter constraints, and existing-row migration failure/retry.
- Changed server/helper/test files pass focused ESLint; browser syntax and diff
  whitespace checks pass. Inherited full-lint failures remain recorded under QA-02;
  no unrelated suppression or dependency upgrade was introduced.
- Refreshed the QR application's 369 installed packages to match the owner's
  already-merged PRs #8/#9/#10. Its lockfile remains unchanged by this task; advisory
  submission was disabled. Both apps' shared database package source is unchanged.

AUTH-01-ACCOUNTS, AUTH-01-LOCKOUT, and AUTH-01-CONSTRAINTS implementation checks are
complete. AUTH-01 itself remains open for company SSO/outer access decisions,
broader traffic/unknown-account abuse controls, and shared-device sign-out/cache
policy (DATA-04). These changes retain the existing 4–8 digit PIN/12-hour session
policy; they do not complete inventory permissions, public QR abuse controls,
dependency remediation, or deployment readiness. SEC-03 is the next correction.

All disposable integration databases and runtime roles were removed (remaining
counts: 0 and 0); the private PostgreSQL test cluster is stopped. No production
service, account, database, or deployment was changed.

Pushed `Dev/account-security` and opened
[PR #17](https://github.com/tanmar-org/AssetTrackerProDTV/pull/17), targeting `main`.
Implementation, regression tests, and documentation share this PR. The owner
performs final review and merging.

## 2026-10-05 17:51 CDT — SEC-03 inventory permissions and schemas

The owner merged PR #17 and authorized the next correction. Created
`Dev/inventory-permissions` from merged main `8f25043`. Preserved the original
checkout's unrelated authentication-comment edit. Refreshed both installs against
already-merged lockfiles without modifying dependencies or submitting advisory
metadata. The implemented role policy preserves regular everyday tools while
reserving replacements and destructive operations for administrators; a concise
policy preference question was optional, and implementation proceeded using this
stated assumption for owner review. The exact policy is in
[INVENTORY-PERMISSIONS.md](docs/INVENTORY-PERMISSIONS.md).

Replaced the client-action-label/record-count heuristic with administrator-only
PUT and server-checked ordinary PATCH. Ordinary edits operate on one account or
receiver/service subject, or issue one rental batch with its associated history.
Bulk changes, full replacements/initial imports, deletion, restore/Undo, and stock
removal/metadata/history changes require administrator authority. Stock release
and batch completion only follow checked rent-state reconciliation. Audit research
snapshots can change without authorizing unrelated inventory bulk edits. Regular
request logs derive from actual differences, not submitted labels. No-op saves
create no revision, history, or audit event.

Added `lib/inventory-state.ts` and `lib/inventory-permissions.ts`. Full schemas
validate known fields/types/enums, bounded strings/arrays/8-MiB bodies, safe record
IDs, leading-zero text identifiers, duplicate IDs/asset/account numbers, assignment
uniqueness, existing links, 20-receiver account capacity, rental batch/item/removal
counts, structured audit counts/issue IDs, valid ISO dates, and safe Maps URLs.
Reads, all saves, and recovery apply the same checks; no new SQL migration is
required. Incompatible source records/history must be reconciled explicitly under
MIG-01. No live data was fetched or automatically changed.

State/recovery take account authorization lock `728303` before state lock `728302`,
rechecking the actor after waiting and holding access through the transaction.
Queued replacement/recovery/delete tests prove a demoted actor cannot use stale
authority. QR proxy reads/status updates remain available to staff; deletion now
requires an administrator. Bound its body/fields and upstream timeout (five seconds),
keep the server credential private, and hold the account lock through the response.
Tracker/QR atomic coordination still remains DATA-02.

The browser sends regular PATCH snapshots separately, captures after synchronous
UI reconciliation, and advances only acknowledged revisions. A 32-operation queue
bounds memory. Validation/permission/revision errors pause retries and polling,
retain the local draft, and explain snapshot export/manual reconciliation instead
of overwriting it with another server revision. Queue order remains memory-only;
reload durability, complete offline conflict resolution, storage quota failures,
and shared-device cleanup remain DATA-01/DATA-04. Browser fields align with server
length limits. Staff UI/server must ship together; older regular PUT clients need
a reload before use.

Inventory exports/new Undo entries now include rental stock and audit. Undo is an
admin replacement; clear resets stock too, avoiding dangling links. Older exports/
Undo entries warn about clearing missing stock/audit collections. Export UI describes
an inventory snapshot, not a complete database backup; operator backup/restore of
users, sessions, logs/history, and QR requests remains DATA-03. Changed formatter/
state/authorization code has focused review comments.

An initial integration run caught a repeated stock-release failure after the server
corrected synthetic history authors. Stored event attribution now overrides a
browser's earlier name, and new events receive the current actor, while all other
old history fields stay immutable to regular PATCH. This also prevents account
renames/server stamping from breaking later legitimate operations.

Validation:

- Both native builds and TypeScript checks passed. Tracker **21 unit/HTTP checks**
  and QR **1 HTTP check** passed. Browser queue/export/Undo tests execute the actual
  source functions in a simulated DOM context; full mobile/browser acceptance is
  still QA-01, not implied by these results.
- **49 PostgreSQL integration checks passed**: existing runtime/account coverage,
  16 inventory scenarios, and their three parent tests. Inventory checks cover
  role/method versus labels, ordinary assignments and stock, 40-receiver issuance,
  all stock releases, admin removal/clear, rejected stock/bulk/history bypasses,
  malformed IDs/links/types/capacity/URLs, incompatible recovery, queued privilege
  changes, denied QR forwarding, timeout cleanup, and no-op audit integrity.
- Changed server/helpers/tests pass focused ESLint; browser ESLint has the same
  four inherited warnings and no errors. Browser syntax, diff checks, and original
  checkout preservation checks passed. Recorded full-lint issues remain QA-02;
  no unrelated suppression or package upgrade was introduced by this branch.
- After introducing no-op responses, the competing-write fixture now supplies two
  genuine changes at each revision. Unchanged retries no longer count as writes;
  competing changes still accept exactly one revision and reject the other.
- Disposable databases and runtime roles were removed (remaining counts 0/0).
  The private PostgreSQL test cluster is stopped; no TCP listener, production
  service, live database, or deployment was changed.

SEC-03, DATA-01-REJECTION, and DATA-03-SNAPSHOT implementation criteria are met;
owner review/merge remains pending. DATA-01/DATA-03 remain open for durable conflict
handling and complete database backups/restoration. Next priorities include SEC-04
legacy-page injection, DEP-01/DEP-02 dependencies, SEC-05 public QR controls, company
access/cache policy, and authorized source-data reconciliation before deployment.

Pushed `Dev/inventory-permissions` and opened
[PR #19](https://github.com/tanmar-org/AssetTrackerProDTV/pull/19), targeting `main`.
Implementation, regression tests, and documentation share this PR. The owner
performs final review and merging; no production deployment was performed.

## 2026-10-05 18:24 CDT — SEC-04 safe public and staff rendering

The owner merged PR #19 and authorized continued corrections. Confirmed GitHub
merge, fetched main `68e74ab` (also includes the owner's merged Dependabot PR #18),
and created `Dev/safe-service-rendering`. Refreshed the root install to the merged
lockfile; no dependency versions/lockfiles or security-advisory submissions changed.
The original checkout's unrelated authentication-comment edit remains intact.

Preserved the legacy static form URL for printed-label continuity. Replaced its
URL-to-innerHTML interpolation with fixed `dt`/`dd` elements and textContent.
Receiver/account values, leading-zero identifiers, GPS controls, and encoded mail
drafts remain available. This form still does not persist requests; silently
redirecting it to the separate QR form would change its workflow. No credential
was added to any draft. Private URL metadata remains QR-01 work.

Reviewed staff renderers beyond current server schemas because browser caches,
old imports, and the separate QR response can contain older unchecked values.
Escaped record IDs in dashboard/account/master/service/label/move controls,
status/history attributes, and cached audit count values. Added safeMapsLink with
the server's bounded HTTPS Google Maps destination policy before service/event
anchors; unsafe destinations receive no anchor while valid GPS links remain.
Validated configured QR destinations as HTTP/HTTPS without credentials; invalid
settings use the existing label-generation error. Updated the script/entry URL
versions for staff reloads. Added focused trust-boundary comments.

Added five default-suite regressions executing the actual legacy script and staff
functions, including a strict DOM that rejects HTML sinks, valid mail drafts with
encoded delimiter-like text, leading-zero identifiers, malicious fields, map
allowlists, and configured QR destination safety. Added an optional reusable
`npm run test:browser` suite for both actual Node-served pages in Chromium.

Installed Playwright 1.58.2 / Chromium 145.0.7632.6 as user-local development tools.
The VM's Ubuntu 26.04 name required the matching Ubuntu 24.04 browser platform
override. Downloaded missing browser libraries/fonts from configured Ubuntu
repositories, verified each SHA-256 against package metadata, and extracted them
under user-local tools. Initial browser checks failed because the minimal VM had
no font configuration; a private font configuration resolved the browser crash.
No system package installation, service, production configuration, or live database
was changed. Development instructions record the exact local test environment.

Validation:

- Both native builds and TypeScript checks passed; **26 tracker unit/HTTP checks**
  and **1 QR HTTP check** passed.
- **5 Chromium checks passed** (four scenarios plus parent): malicious legacy
  label parameters/GPS controls, React QR text/submission, cached staff IDs/history/
  audit counts, and rejected versus valid service Maps links. Synthetic sessions,
  API responses, and GPS isolate rendering; no production data, external app API,
  CDN script, real device GPS, or email delivery was used. Actual database permissions
  remain covered by the existing integration suite, which this browser-only change
  did not rerun. Physical mobile/printing/email acceptance remains QA-01.
- Changed tests/legacy script/entry component pass focused ESLint. Staff app.js
  retains four inherited warnings and no errors. JavaScript syntax and whitespace
  checks passed; inherited full-lint failures remain QA-02.

SEC-04 implementation criteria are met; owner review/merge remains pending.
SEC-05/QR-01/MAIL-01 still require public request validation/abuse controls,
server receiver lookup, private metadata removal, and server email. Next priorities
are DEP-01/DEP-02 dependencies and public-request security. No deployment performed.
