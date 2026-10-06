# Project journal

## Current handoff

- Repository: https://github.com/tanmar-org/AssetTrackerProDTV
- Baseline reviewed: `main` at `b3d86eb3eb05134e42c6f475e5a3dbe47df6a7e5`.
- Development branch: `Dev/https-ingress-preparation`, based on `origin/main` at
  `00b9b3f` (owner merged PR #35). AD sign-in, explicit identity linking, bounded
  session rechecks and domain-scope searches are merged. An isolated empty preview
  now runs from a separate protected checkout of that exact merge. Its fresh
  administrator is explicitly linked to the nominated, reverified directory GUID.
  Private socket-only PostgreSQL uses SCRAM and separate owner/runtime roles;
  web listeners are loopback-only for SSH access. Owner normal-password sign-in
  now succeeds with a matching reviewed identity, active admin role and later
  successful directory recheck. Owner sign-out/relogin also pass: the original
  session is gone and one fresh AD session retains admin access. Real policy
  changes, recovery admins, data reconciliation and internet ingress remain AUTH-01-ROLLOUT.
  Operational notes stay on this Dev branch to bundle with the
  next substantive code task; no documentation-only PR or production cutover.
  Owner has selected public staff/QR hostnames and confirmed an existing reverse
  proxy (Nginx Proxy Manager) with an existing wildcard certificate. Public A/AAAA
  queries report NXDOMAIN for both names. Owner asked to proceed without a source
  address; it is optional in protected ingress staging, with TLS/secrets mandatory.
  NPM/private gateway preparation now passes real synthetic proxy validation and
  owner-specific files are staged outside Git. Backend certificate/actual NPM/DNS
  setup and production activation remain separate deployment work.
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
  SEC-04 safe service rendering in
  [PR #20](https://github.com/tanmar-org/AssetTrackerProDTV/pull/20) is merged by
  the owner. Local bounded spreadsheet parsing/dependency corrections are
  merged by the owner in
  [PR #21](https://github.com/tanmar-org/AssetTrackerProDTV/pull/21). Public-request
  security and QR metadata removal in
  [PR #23](https://github.com/tanmar-org/AssetTrackerProDTV/pull/23) are also merged
  by the owner. Shared-device session/cache corrections (DATA-04) in
  [PR #24](https://github.com/tanmar-org/AssetTrackerProDTV/pull/24) are also merged.
  QR source-map dependency correction (DEP-01-SOURCE-MAP) in
  [PR #25](https://github.com/tanmar-org/AssetTrackerProDTV/pull/25) is merged by
  the owner. GitHub reports alert 162 fixed. DATA-01 explicit conflict review and
  account-owned server recovery copies are implemented in
  [PR #26](https://github.com/tanmar-org/AssetTrackerProDTV/pull/26), merged by
  the owner. Complete operator backups and isolated verified restoration are
  implemented in [PR #27](https://github.com/tanmar-org/AssetTrackerProDTV/pull/27),
  merged by the owner. DATA-05 import counts/capacity/metadata/history and protected
  spreadsheet reports are implemented in
  [PR #28](https://github.com/tanmar-org/AssetTrackerProDTV/pull/28), merged by the owner.
  Bounded request/activity browsing (DATA-06-LISTING) in
  [PR #29](https://github.com/tanmar-org/AssetTrackerProDTV/pull/29) and recoverable
  QR transitions/history (DATA-02) in
  [PR #30](https://github.com/tanmar-org/AssetTrackerProDTV/pull/30) are merged by
  the owner. QA-02's zero-warning lint/vendor baseline in
  [PR #31](https://github.com/tanmar-org/AssetTrackerProDTV/pull/31) is merged by
  the owner. QA-01-CI automated validation is merged in
  [PR #32](https://github.com/tanmar-org/AssetTrackerProDTV/pull/32). The full hosted
  check passed; owner merged PR #32 at `396be11`. No application runtime code,
  migration, dependency version or lockfile changes are included in the CI task.
  Production deployment has not started; scheduled/off-server backups are not configured.
- Current AUTH-01 direction: owner confirmed internet staff access, AD-only
  infrastructure, private VM-to-AD connectivity and explicitly no MFA. Plan direct
  private, certificate-validated LDAPS username/password verification; existing
  app permissions and stable identity ownership must survive the transition.
  Shared login traffic counters are merged in PR #33; opt-in AD sign-in is now
  merged in PR #34. Separate owner-directed read-only checks now verify trusted
  TLS, the real reader and one nominated identity. The empty private preview is
  configured for AD, with an explicit reviewed admin link and verified owner
  personal-password login; public access is closed.
  Earlier broker/MFA recommendations are superseded by these confirmed choices.
  Public customer QR access remains separate.
  Prepare actual directory acceptance and trusted HTTPS ingress,
  without exposing either app before deployment approval. GitHub check results
  do not configure branch protection or replace owner review/actual-device checks.
  DATA-03-ROLLOUT still requires approved encrypted off-server storage, schedule,
  retention, private configuration recovery, alerts and a real operator recovery drill.
  Fully offline drafts still require exports; server recovery copies expire after
  seven days. Development-only dependency work, AUTH-01-ROLLOUT real AD setup, QR-01 real
  label/mobile acceptance, MAIL-01 approved delivery, HOST-03/HOST-04/MIG-01
  production services/data cutover and SEC-01-OWNER rotation remain open.

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

Pushed `Dev/safe-service-rendering` and opened
[PR #20](https://github.com/tanmar-org/AssetTrackerProDTV/pull/20) against `main`.
Implementation, regression tests, and documentation share this PR. GitHub's push
notice reports four default-branch advisory matches (two high/two moderate);
no fresh advisory/reachability assessment was performed during this rendering task.
DEP-01/DEP-02 remain open. All temporary rendering-test servers/browser processes,
including the failed font-diagnostic runner, were stopped. Owner reviews/merges.

## 2026-10-05 18:47 CDT — DEP-01 assessment and DEP-02 local spreadsheet reader

The owner merged PR #20 and authorized continued corrections. Confirmed its merge,
fetched main `e0a137f`, and created `Dev/dependency-remediation`. Preserved the
original checkout's unrelated authentication-comment edit. The owner previously
approved npm advisory submission of package names/exact versions; refreshed both
assessments using that authorization, without transmitting source or credentials.

Both production-only npm assessments report zero known findings. Full audits
initially showed five tracker and six QR affected package entries. Six underlying
brace-expansion advisories affected the QR lint tree's two older versions. Updated
only those QR lockfile packages within their existing ranges: 1.1.14 → 1.1.21 and
5.0.6 → 5.0.12; tracker already used the patched versions. Reinstalled QR using the
lockfile. No runtime framework/driver dependency version changed.

One underlying braces@3.0.3 advisory remains, with no published fix. It propagates
to five development-only chain package entries per full audit via Next ESLint /
fast-glob / micromatch. Reviewed the installed Next lint helper: it processes a
configured developer root-directory glob; this repository supplies no such pattern,
and HTTP routes/file imports do not use it. Kept DEP-01 open, recorded exact evidence,
and did not apply npm's incompatible Next-14 ESLint-config downgrade or suppress
warnings. Current scope/sources are in [DEPENDENCY-REMEDIATION.md](docs/DEPENDENCY-REMEDIATION.md)
and [the dated report](docs/reviews/2026-10-05-dependency-remediation.json).

Replaced the runtime jsDelivr SheetJS 0.18.5 tag with local full SheetJS 0.20.3,
verified through official documentation as the current release beyond the two
reported fixes. Downloaded its official HTTPS standalone script and release archive;
script bytes matched the archive member exactly, and the package version matched.
Recorded SHA-256, page SRI, retained the upstream Apache license/notice bytes,
and documented that these are our reproducibility digests rather than an independent
publisher signature. The artifact remains unchanged and is verified by tests instead
of application-style lint rules. npm audits do not include browser vendor assets.

Added a same-origin **browser Web Worker on the staff device** for parsing; it is
not a hosted worker service. Limit files to 10 MiB, parsing to 15 seconds, ZIP entries
to 2,048, declared and actual streamed expansion to 32 MiB/entry and 64 MiB total,
worksheets to 32 with 20,001 rows/256 columns, populated cells to 200,000, and text
cells to 8,192 characters. Reject unsupported/encrypted/ZIP64/split/overlapping ZIP
archives and truncated/oversized inputs; do not offer a partial import. XLSX ZIP
preflight inspects actual deflate output, so false expansion metadata cannot bypass
the byte limits. Parser success/failure/timeout terminates the worker. Remove formula
source, generated rich HTML, and hyperlink objects; imports preserve literal values.

Master, West Texas A:N/grouped account, and audit preamble/header mappings remain.
Account imports now actually read the XLS/XLSX formats advertised by the existing
picker in addition to CSV. CSV scanning enforces limits while accumulating records
and rejects unfinished quotes, preserving aliases and leading-zero values. An exact
200,000-field boundary test ensures a trailing newline is not counted as a phantom
field. Spreadsheet parse raw-text mode plus formatted-cell conversion preserve
leading zeros for CSV strings and Excel number formats. Apply semantics, report
counts/capacity corrections, and CSV-export formula neutralization remain DATA-05.

Validation:

- Both native builds and TypeScript checks passed. **35 tracker unit/HTTP checks**
  and **1 QR HTTP check** passed. Nine new default-suite tests load the actual vendor
  and worker, exercise XLSX/XLS/CSV mappings, leading zeros, safe content, invalid
  archives/ZIP declarations/lying compressed expansion, size/range/text/cell limits,
  CSV quoted content/exact boundaries, and worker termination.
- **11 Chromium checks passed** (nine scenarios plus two parents). Actual local
  Web Worker parsing and Master/West Texas/account/audit file-input previews work
  with all external requests blocked; earlier public/staff injection checks pass.
  Synthetic sessions/API/GPS isolate browser behavior, with no live database or
  real email delivery. PostgreSQL permission tests were not rerun because runtime
  database dependencies/routes did not change. Physical iPad/mobile/label acceptance
  remains QA-01.
- Both full lint commands ran and retained known failures: tracker **2 vendor
  errors/147 warnings**; QR **2 effect errors/3 image warnings**. Focused changed
  source/helpers/tests pass; app.js retains four inherited warnings and no errors.
  No unrelated application errors were suppressed. JS syntax/whitespace checks pass.
- Initial failures were test-harness assumptions (cross-context async scheduling
  and the account preview's actual record path); corrected tests now exercise the
  implementation's actual timing/structure. No assertion was weakened.

DEP-02 and the production/QR brace-expansion subtasks meet their implementation
criteria; owner review/merge pending. DEP-01 remains open for the unpatched lint
chain and future advisory tracking. Next substantial work is SEC-05/QR-01 public
submission validation/abuse controls and stable server asset lookup/private metadata
removal. Production configuration, data reconciliation, backups, and company access
remain deployment work. No production service/database/deployment was changed.

Pushed `Dev/dependency-remediation` and opened
[PR #21](https://github.com/tanmar-org/AssetTrackerProDTV/pull/21), targeting `main`.
All implementation, evidence, comments, and documentation share this PR. Rendering/
spreadsheet test servers and browser threads closed after tests; the private
PostgreSQL test cluster was not started or changed. The owner performs final review
and merging. GitHub's push notice still reflects the default branch before this
QR lockfile correction; the fresh npm evidence above is scoped separately.

## 2026-10-05 19:22 CDT — Public request validation, privacy, and abuse controls

Owner confirmed PR #21 merged; fetched `origin/main` at `7829525` and created
`Dev/public-request-security` in the existing clean security working copy. The
owner asked to continue after the explanation of public QR submissions. Changes
remain for owner review/merge; no deployment, live database, email transmission,
public hostname change, or original-provider configuration was performed.

### Implemented behavior

- Tracker `/api/service-assets` returns one validated committed inventory snapshot
  only with the server bearer credential. QR `/api/asset` exposes just receiver
  ID/asset number. Submission performs lookup again and stores private receiver/
  account metadata internally, rejecting caller-supplied snapshots/unknown fields.
  Redirects, malformed/oversized lookup responses, and a stalled lookup fail closed.
- Public POST and private PATCH use streamed 8-KiB JSON bounds and strict fields.
  GPS must have finite bounded numeric coordinates/accuracy and a fresh canonical
  timestamp; null/string coercion and stale/impossible readings are rejected.
  Staff notes stay bounded and support multiline text; raw errors remain private.
- `requests/0002_public_request_security.sql` adds stable IDs, coordinate checks,
  unique partial pending indexes by normalized number/ID, and shared rate counters.
  Atomic insert and conflicting reopen retain exactly one pending request through
  concurrency/renames. Legacy rows keep their historical metadata and null IDs.
  Duplicate/bad-coordinate historical rows stop migration atomically for operator
  reconciliation; no automatic deletion/cancellation or fabricated location.
- Atomic counters persist denied attempts across Node processes; global, resolved
  receiver, and optional authenticated-proxy client budgets bound abuse. Expired
  buckets are removed and digests hide raw IPs/labels. Retry-After reports the
  remaining window. Unverified forwarded headers are ignored. Configured ingress
  headers fail closed if missing/forged. Rate ceilings are not identity checks or
  comprehensive network/bot protection; configure/tune production ingress.
- New QR labels use only the stable receiver ID and remove old query/fragment
  metadata. Old React asset-number links resolve current inventory; the historical
  static page redirects with only a validated ID/asset number. No private snapshot
  is displayed/forwarded. QR history queries are replaced; both pages use
  no-referrer. Staff association uses stable IDs through renames and number reuse.
- Public submissions now confirm saving for staff review, without opening a private
  test email draft. No automatic alert/delivery is implemented (MAIL-01); staff
  must monitor saved requests. GPS capture is explicitly requested by the visitor;
  denied/unavailable GPS disables submission and directs them to contact staff.
  Mobile HTTPS/fallback acceptance and old printed URLs/domains remain QR-01/QA-01.
- Added `TRACKER_ASSET_API_URL` and optional `REQUEST_PROXY_SECRET` configuration.
  Readiness checks the new schema, rate-table grant and lookup-setting presence.
  Added comments, policy/migration/preflight/grant/ingress guidance, and updated
  AGENTS/README/development/self-hosting/TODO/current handoff in this same task.

### Validation evidence

Both webpack production builds and TypeScript checks passed. The final root suite
passed **39** checks; QR smoke suite passed **1**. The complete PostgreSQL suite
passed **63** checks (59 scenarios plus four parent tests). After the final strict
null-note change and adding a stalled-lookup case, the public-request suite passed
**14** checks (13 scenarios plus parent), including five-second timeout behavior.
The optional Chromium suite passed **12** checks (ten scenarios plus two parents);
its final service/rendering subset passed **6** (five scenarios plus parent).
All fixtures are synthetic and external browser traffic is blocked.

Coverage includes private/public response separation, changed inventory metadata,
leading zeroes, legacy links, malformed/oversized/unknown/forged input, independent
server duplicate races, reopen races/rollback, receiver/global/client budget
persistence and expiry, invalid proxy headers, and migration rollback/retry.
New input/redirect/stable-association regressions run in the default tracker suite.
The helper supports preselected loopback ports for the reciprocal private endpoints.

Changed tracker/server/test files pass focused lint with the same four inherited
staff warnings. **QR full lint now passes** with three inherited image warnings;
removing the auto-GPS/state effects eliminated its two prior errors. Root full lint
still fails with **2 inherited vendor errors / 147 warnings** under QA-02; none
were suppressed. Dependency versions/lockfiles/vendor bytes were unchanged.
`git diff --check` passed. The QR build retains its existing multiple-lockfile
workspace-root warning.

Initial sandbox-only attempts failed to parse TypeScript --showConfig and showed
file-only test successes without executing registered subtests. Those results were
discarded. All reported successful verification used the VM tool permissions needed
for child processes/local servers and showed actual named scenarios. Preserve this
verification distinction for future work. Disposable databases/roles were removed;
the private test cluster is stopped after validation.

### Remaining work

Review this PR's saved-request/legacy redirect behavior before merging. Before
cutover, apply authorized requests migrations after duplicate/GPS preflight, grant
the new rate table, configure both private URLs and authenticated ingress, and
confirm live inventory/label/domain continuity. Printed private URLs/prior logs
cannot be erased by browser query cleanup. Stable IDs and GPS remain public/client
claims; no caller identity or physical-presence guarantee is made.

Next useful implementation: shared-device cache/sign-out handling (DATA-04).
Remaining dependency/lint work, approved email delivery settings, mobile/printing
acceptance, backups/services/domains, and live exports remain separately tracked.
  SEC-01-OWNER credential-rotation confirmation is still outstanding.

Publication: implementation commit `f3f46f5` pushed to
`Dev/public-request-security`; opened and attached
[PR #23](https://github.com/tanmar-org/AssetTrackerProDTV/pull/23) for owner review.
The PR is open and no merge/deployment was performed. Test cleanup confirmed zero
disposable databases/runtime roles before stopping the private cluster.

## 2026-10-05 — Shared-device sessions, memory-only data, and confirmed sign-out

### Scope and decisions

The owner confirmed merging PR #23 and authorized continuing. GitHub reported its
merge commit as `160e10902cac24f084a5d02cc9ed1080814360b8`; branched
`Dev/shared-device-sessions` from that fetched main. This task implements DATA-04
and records DATA-04-ROLLOUT separately. No production access/deployment, dependency
upgrade, SQL migration, or changes in the original checkout were performed.

The staff UI now starts empty/inert, opens only after authenticated server inventory
loads, and never seeds sample data or uploads device-wide records automatically.
New operational state, audit, stock, Undo, imports and email preferences live only
in tab memory. Denied browser storage does not prevent a server save attempt.
Historical `atp.*`/email-preference keys remain quarantined until explicit admin
export/removal or confirmed discard on sign-out. Raw legacy exports preserve old
formats for reconciliation; they do not directly restore current inventory.

Sign-out immediately locks/scrubs private tables, hidden dialogs/forms/mail drafts,
Undo and print frames; cancels workers, requests, save/poll timers; and checks every
awaited staff response/import against its session generation. Failed server logout
stays locked across reload with retry and a non-bearer marker (window.name fallback
if storage is denied). Success requires an actual acknowledgement; cleanup failures
remain visible. Already-submitted saves may have committed before sign-out.

Other tabs receive login/logout events and the UI verifies sessions on focus/every
12 seconds even while a draft is paused. A restored frozen page verifies access
again. Expiry/switch/verification failure can quarantine unsaved work in memory
for only the same stable user ID after reauthentication, with sync paused for
snapshot export. Another user must confirm discard or cancel. This does not make
unsaved work durable across reload/tab closure or protect against someone who
controls browser developer tools; DATA-01 durable recovery/conflict UI remains open.

GET/POST auth returns a domain-separated, non-bearer session context. Staff mutations
require its header alongside the actual valid cookie and current role; supplied
read contexts are checked too. Old tabs cannot write under newer shared cookies,
including same-user re-login. Stale-context logout acknowledges the old UI's lock
without deleting/clearing a different newer cookie. Matching logout takes account
advisory lock `728303`, preserving write/revocation ordering. Ship server/UI together,
reload old tabs and update integrations; older mutations without context receive
401 (logout without context and a cookie receives 400).

Updated AGENTS, TODO, README, development/self-hosting/inventory policy and added
`docs/SHARED-DEVICE-SESSIONS.md`. Staff assets now use version 62. Existing test
fixtures use synthetic contexts and server snapshots instead of implicit device
cache bootstrap. No credentials, live exports or database contents enter Git.

### Verification

Root native webpack production build and TypeScript check passed. The default
tracker suite passed **39** checks. The full real PostgreSQL suite passed **68**
checks (63 scenarios plus five parents), including new context/non-bearer checks,
shared-cookie switches, stale logout, failed deletion rollback, and logout locking.
The optional real Chromium suite passed **22** checks (19 scenarios plus three
parents), including nine shared-device scenarios alongside rendering/import tests.
After the final gate/cleanup adjustment, the gate/queue subset passed **7** checks
and the complete Chromium suite again passed **22**. Changes afterwards are comments
and documentation only.

Browser coverage exercises older-data export/removal, no sample/old-cache upload,
private DOM cleanup, failed logout/reload/retry, denied storage and save attempts,
actual cross-tab events, original-owner paused-draft export, late read/import/save
results, failed initial inventory reads, frozen-page events and paused-session
expiry. Recovery verifies the actual shared cookie before rendering a retained
draft, including a newer login overtaking its auth response. APIs/GPS/data are
synthetic and all outside browser traffic is blocked.
Frozen-page events are simulated; actual iPad/mobile acceptance remains QA-01.
QR source/dependencies were unchanged; its existing build served the rendering and
PostgreSQL suites. No claim of a new QR build/audit is made for this task.

Focused changed-source/test lint passed with **0 errors / 4 inherited staff
warnings**. Full root lint still reports **2 inherited vendor errors / 147 warnings**
under QA-02, with no suppression. `git diff --check` passed. An initial Chromium
case failed because its selector checked the error field instead of the loading
status description; corrected the test and reran the complete suite successfully.
The integration runs printed generic idle-connection notices during fixture teardown;
all assertions passed. Cleanup counts and private-cluster shutdown are recorded
with publication below. Verification used child-process/socket permissions and
executed actual named subtests, not sandbox file-only successes.

### Remaining work

Review the memory-only/acknowledged-sign-out policy before merge. Before deployment,
export/reconcile/remove older device caches and reload old clients/integrations under
DATA-04-ROLLOUT. Pending drafts need snapshot export before reload/tab closure;
DATA-01 explicit reconciliation/durable recovery is the next useful implementation.
Company access/login traffic policy, operator backups/services/domains, live-data
migration, old labels, delivery settings and mobile/printing acceptance remain open.
The owner alone reviews/merges; no production service or live database was changed.

Publication: implementation commit `ba5a8a7` pushed to
`Dev/shared-device-sessions`; opened and attached
[PR #24](https://github.com/tanmar-org/AssetTrackerProDTV/pull/24) for owner review.
The PR remains open; no merge/deployment was performed. Cleanup confirmed zero
disposable databases and runtime roles; the private PostgreSQL test cluster was
stopped. Publication references are bundled into this same PR.

Publication follow-up: GitHub surfaced open high runtime alert 162 for the QR
lockfile's `source-map-js@1.2.1` (GHSA-68fv-2mgg-jv7q; patched 1.2.2).
Fresh production npm queries still return zero for both apps; that does not cover
GitHub's reviewed finding. The tracker lock already pins 1.2.2, but its local
installed copy was older; restored the root install from the unchanged lockfile
with `npm run install:ci`. QR's lock/installed 1.2.1 requires the next focused
DEP-01-SOURCE-MAP correction. HTTP exploitability is not established. Updated
current dependency/setup/TODO statements rather than treating the alert as fixed
or repeating an unqualified clean-runtime claim. See the linked advisory and
`docs/DEPENDENCY-REMEDIATION.md`; package upgrades remain outside this PR.

After restoring the tracker install from its lockfile, `npm test` again passed the
production build and all **39** regressions; type checking passed. Complete
PostgreSQL and Chromium reruns again passed **68** and **22** checks, respectively;
focused changed-file lint remained **0 errors / 4 inherited warnings**. Final
cleanup again confirmed zero disposable databases/runtime roles and stopped the
private test cluster. No lockfile/package changes were made by the reinstall.

## 2026-10-05 — Patch QR source-map dependency and explain upcoming priorities

### Scope and resulting behavior

Owner confirmed merging PR #24 and asked for clearer explanations of future
priorities. GitHub confirmed merge commit
`2719ba3472352c29b44512990385efa39dc9093d` at 2026-10-06T01:08:01Z. Fetched main,
created `Dev/qr-source-map-security`, and preserved the unrelated original checkout.

GitHub alert 162 still marks QR source-map-js@1.2.1 as affected by
GHSA-68fv-2mgg-jv7q. Verified the reviewed advisory, upstream 1.2.2 release, registry
version and archive integrity. Updated the QR lockfile's version/resolved/integrity
entry alone via a targeted package-lock-only update within existing ^1.2.1 ranges.
No new direct dependency, override, framework downgrade, unrelated package update,
SQL migration or production change. Installed QR from the updated lock; staff's
unchanged lock and installed copy already use 1.2.2. Both now resolve patched 1.2.2.

Source-map-js relates generated CSS/code positions to original files for debugging
and tooling. Next's PostCSS dependency and Tailwind consume maps in CSS processing.
The known malformed indexed-map offsets can amplify synchronous work and block
processing. Repository API/spreadsheet paths do not pass customer/inventory/workbook
records to PostCSS or source-map consumers; an HTTP exploit is not established.
Removing the affected transitive runtime dependency avoids carrying this known flaw
into deployment. It does not change QR generation/submission or grant permissions.

Added shared regressions registered separately in each app's default suite. Resolve
through the app's actual installed PostCSS package; check huge/malformed/nested
section rejection, sparse valid mappings past a tiny generated file without work
amplification, and normal CSS map/source-content preservation. Risky conversion runs
in a child bounded to 64-MiB old space and three seconds, protecting the runner from
a future regression. Comments describe input boundaries and why isolation matters.

Updated AGENTS to retain the owner's preference: explain the concrete problem,
why a task comes next, intended improvement, and remaining limits. Added a plain-
language implementation order to TODO and refreshed dependency/setup/journal docs.
Current dependency evidence is `docs/reviews/2026-10-05-source-map-remediation.json`.

### Validation and remaining limits

Both native webpack builds passed. Staff default suite: **42** checks; QR suite:
**4** checks. New dependency subset passed **6** checks across both installs.
Optional Chromium suite passed **22** checks with synthetic data/GPS, API fixtures
and outside traffic blocked. Both standalone TypeScript checks pass. Staff's first
standalone check overlapped build replacement of .next/types and saw missing
intermediate files; reran after the successful build, then documented the required
ordering. Do not treat that timing failure as a source-code type error.

New regression/helper code passes focused lint with no findings. QR full lint
passes with **0 errors / 3 inherited image warnings**. Root full lint retains its
previous QA-02 vendor errors/warnings and was not rerun for this dependency-only
change; unchanged vendor code remains protected by existing integrity tests.
The QR build retains its known multiple-lockfile workspace-root warning. Installs
retain npm's unapproved optional unrs-resolver install-script notice; successful
build/type/lint/test results required no new script approval.

Fresh approved npm production scans report **0** findings for both lockfiles. Full
scans each report **5 high development-only chain package findings**, all stemming
from the existing unpatched braces advisory. GitHub's previously missed source-map
finding was reconciled explicitly; npm zero counts alone did not establish safety.
Alert 162 remains open on main until owner merge/rescan. Do not dismiss it manually
or describe production as patched before approved deployment.

No PostgreSQL suite rerun was needed: no route, database, auth, permission or
migration implementation changed; builds/HTTP/browser checks exercise the CSS
pipeline. The earlier PR #24's real PostgreSQL evidence remains historical (68
checks), not a claim of this run. The private synthetic test cluster remains stopped.
`git diff --check` passed; lockfile diff contains only the intended package entry.

### Next priorities, with reasons

DATA-01 comes next because simultaneous employees can save different edits against
one revision. The second save safely pauses today, but requires manual snapshot
export/reconciliation; closing/reloading the tab can lose unsaved work. Add clear
comparison/recovery choices that protect committed state and the employee's draft.
Any durable recovery design must keep drafts authorized to their owner rather than
reintroduce device-wide sensitive storage. This is needed before real staff rely
on the app during connection failures or concurrent editing.

Then DATA-03: inventory snapshots omit database users, QR requests, logs and history.
Create complete operator backups of both PostgreSQL databases and prove restoration
using synthetic copies before importing real records. A backup file alone is not
proof we can recover from an outage.

Then DATA-05: capacity-blocked imports can produce misleading success counts, and
spreadsheet exports can interpret text as formulas. Make accepted/skipped counts
accurate, retain leading-zero identifiers, and ensure exported text remains inert
so staff can trust imported inventory and reports.

Company access/login traffic policy, lint/development dependency work, approved
email delivery, HTTPS/domains/services, live export migration, old printed labels
and target-device acceptance remain release requirements. This task opens a focused
PR for the owner's review/merge; no production deployment or live data access.

Publication: implementation commit `c402e80` pushed to
`Dev/qr-source-map-security`; opened and attached
[PR #25](https://github.com/tanmar-org/AssetTrackerProDTV/pull/25). Publication
references are bundled into this same PR. Owner review/merge and GitHub's main
alert rescan remain pending; the branch is not merged or deployed.

## 2026-10-05 20:45 CDT — Account-owned draft recovery and explicit conflict review

### Baseline and result

Confirmed the owner's merge of PR #25 at `9710f13628701bcecdf6abae5537ce3ee05bf01d`
(2026-10-06 01:19:32 UTC). GitHub's API reports source-map alert 162 **fixed** at
01:19:36 UTC. No manual dismissal or dependency change was needed. Created
`Dev/inventory-conflict-recovery` from current origin/main; preserved unrelated
comment-only work in the original checkout.

Previously, a second employee's stale save paused with only tab memory and a
snapshot export for manual reconciliation. DATA-01-REVIEW now adds Settings review
of original/draft/current shared values and explicit choices. Unedited shared
fields survive; conflicting fields require a choice; a changed server revision
requires a new review. Saved copies are private to the current account, including
administrator API access, and never automatically applied after sign-in/reload.

DATA-01-COPIES adds tracker migration `0003_inventory_drafts.sql` and `/api/drafts`.
Paused/overflowed edits attempt a server checkpoint; later paused edits update it
using version CAS. Five active copies and 20 retained IDs per account, seven days
from creation, streamed 16-MiB + 4-KiB checkpoint bound, 8-MiB individual states.
Closed copies erase payloads and retain ID/version tombstones until expiry.
Lost acknowledgements retain the UUID for discovery; explicit reopening warns
before replacing tab work. Discard reads shared state before deleting the copy,
checks versions, and does not write inventory. No browser operational persistence
was introduced; unconfirmed/offline work explicitly requires an exported snapshot.

Apply takes account lock 728303 then inventory lock 728302 and rechecks the cookie,
context and role after waiting. `lib/inventory-merge.ts` recomputes choices on the
server. `lib/inventory-store.ts` supplies one commit path for normal saves/recovery;
state, history, audit and draft closure are atomic, including no-op behavior.
Ordinary users still receive existing single-operation checks and server-stamped
history attribution. Bulk/mixed changes are denied/audited and copies retained.
New history is ordered ahead of existing shared entries; this preserves actual
assignment/history workflows rather than creating apparent history rewrites.

Browser copies/baselines/comparison lists are bound to session generations, scrubbed
on lock and offered only after fresh authenticated inventory. Same-owner memory
reauthentication retains the baseline/version with sync paused. Recovery list
refreshes resume an ordinary pending save if their UI lock outlasts the save timer.
Comparison cells wrap/truncate to 600 characters; full JSON comparison export is
available. More than 200 choices disables UI apply and requires administrator
reconciliation of exports. Static asset version is 63. Readiness checks the new
table; runtime grants, self-hosting/setup/session docs and AGENTS are updated.

### Validation and limits

Final staff webpack build and standalone TypeScript passed. Staff default suite:
**48 passed**. Real HTTP/PostgreSQL suite: **78 passed**, including nine new draft
scenarios plus their parent check. Chromium: **30 passed**, including seven new
recovery scenarios plus their parent check. New merge/order and pending-save-timer
checks exercise actual implementation functions. Focused server/test lint passed
with no findings; browser syntax passed. Full staff lint retains **2 inherited
vendor errors / 147 warnings** (QA-02), with no suppression or vendor changes.

An earlier run of database/browser/compiler checks concurrently encountered one
HTTP ECONNRESET in a draft scenario (74 passed/2 failed including parent). No
assertion established a permission/state failure. A separate full database rerun
passed 76/76 before the final history/quota additions; final full run passed 78/78.
Cause of the connection reset is not proven; do not hide it behind automatic test
retries or loosen production limits. Some fixture teardown emitted the previously
seen generic idle PostgreSQL notice. Cleanup queries confirmed **0** leftover
fixture databases and **0** runtime roles; the private synthetic cluster is stopped.

Inspected a Chromium screenshot of the synthetic comparison panel. Browser tests
block outside traffic and use no live inventory. QR source/dependencies were not
changed or rebuilt; its existing build was exercised through integration/browser
checks, and prior QR default/build/type evidence remains historical. No new
advisory query was needed; the dependency security update is confirmed on main.
`git diff --check` passed.

Copies protect only server-acknowledged edits, not disconnected changes or newer
in-flight edits. Fully offline durability remains DATA-01-OFFLINE; exported snapshots
are the fallback. Large/multiple-operation reconciliation can still require an
administrator. Expiry enforces visibility; successful owner requests remove expired
rows, but there is no scheduled purge for inactive accounts yet. Server copies,
25 history versions and inventory snapshots are not complete disaster recovery.
No production database, configuration, domain, service or deployment was modified.

### Next useful implementation

DATA-03: complete operator backups of both PostgreSQL databases, including users,
requests, logs, history and owned copies. Restore synthetic backups into separate
databases and verify records/permissions so an outage has a tested recovery path
before real inventory cutover. Scheduling, destination, encryption/access and
retention still need the deployment configuration; no live restore is authorized.
Then DATA-05: fix capacity-blocked import counts and prevent spreadsheet formulas
from exported text while retaining leading-zero identifiers. These directly affect
whether staff can trust inventory/reporting after an import.

Publication: implementation commit `8417f24` pushed to
`Dev/inventory-conflict-recovery`; opened and attached
[PR #26](https://github.com/tanmar-org/AssetTrackerProDTV/pull/26). Publication
references are bundled into the same PR. Owner review/merge and any later approved
production rollout remain pending; this branch has not been merged or deployed.

## 2026-10-05, 21:15 CDT — Complete PostgreSQL backup and restore tooling

### Owner merge and scope

The owner reported PR #26 merged. GitHub confirmed merge at `0f7ab73` on
2026-10-06 01:49:37 UTC; fetched main and created `Dev/postgresql-backup-restore`
from that revision. Implemented DATA-03-TOOLS and DATA-03-RESTORE-DRILL. The parent
DATA-03 remains open for production operational rollout. No production database,
configuration, domain or service was changed.

### Resulting behavior

Root `db:backup` creates private custom-format archives for both databases,
including users/sessions, inventory/stock/audit, logs/history/drafts, QR requests,
rate counters and migration history. Protected libpq service/passfiles select
read-only source connections; inherited application URLs/password overrides do
not select them. Each archive and its schema/count/content evidence use one
exported source snapshot. Both checked/fsynced archives and the manifest publish
as one private directory; failed jobs do not intentionally publish incomplete pairs.

Root `db:restore` requires separately provisioned new empty
`assettracker_restore_*` databases, actual owner connections and fresh restricted
runtime roles. Both archives and targets are checked before restore writes. It
preserves source database contents, serializes cooperating restores with advisory
lock 728304 and restores each target transactionally without dropping/overwriting
existing databases. Exact migration, schema, row-count and content verification
precedes runtime access. Restored tracker sessions are removed and an operator
restore entry is added to the audit log. Both apps need fresh sign-in.

Private ownership/permissions, archive SHA-256, matching PostgreSQL major versions,
source encoding/locale/collation, restricted roles, empty targets and absence of
default grants are required. Unsupported extra tables/schemas/functions/extensions
fail explicitly. Cancellation/timeouts terminate subprocesses; SQL/connection/row
errors are redacted. A late failure attempts to revoke known runtime CONNECT grants;
there is no globally atomic operation across both databases. Keep destinations
and apps offline on failure, verify access privately and provision fresh targets.

Added three operator scripts, private configuration examples, package commands,
archive ignore rules, six default tests and eight integration scenarios plus their
parent. Extended the isolated fixture helper with unmigrated restore targets.
AGENTS, TODO, development/self-hosting guides and
[the complete operator runbook](docs/DATABASE-BACKUPS.md) describe the workflow and
remaining rollout. No npm dependencies or application/UI/API source changed;
existing user-local PostgreSQL tools were sufficient.

### Validation and practical limits

Final default suite: **54 passed / 0 failed**. Full HTTP/PostgreSQL suite:
**87 passed / 0 failed**, including **9** backup/recovery checks. The focused
backup suite also passed 9/9. The drill uses SELECT-only backup access, restores
all current tables, preserves leading-zero inventory/request IDs and PIN hashes,
starts both existing app builds under restored restricted runtime roles, verifies
health/login/inventory/drafts/requests and rejects old session cookies. Corrupted
archives, unsafe permissions/roles, wrong migrations, live/nonempty targets,
failed restore verification and continuing source writes are exercised.

Development testing caught and corrected repository-path normalization and a
PostgreSQL CHECK-definition comparison: redundant nested AND parentheses changed
on dump reparse, so comparison now uses the minimally parenthesized definition
that preserves precedence. No failing assertion was suppressed or limit relaxed.
A deliberate invalid test URL was refused by the local fixture guard before any
connection/cleanup SQL; that negative invocation correctly exited nonzero.
Final review tightened drill cleanup to run only after validated fixture creation
and only for its actually created backup role. Focused lint and operator syntax
checks passed. No rebuild or browser rerun was
needed for operator-only changes; unchanged matching builds were exercised through
actual restored-app HTTP checks. Previous full lint retains inherited vendor
findings under QA-02; dependencies were unchanged and no new advisory query ran.
Some fixture teardown emitted the previously seen generic idle-connection notice;
all checks passed. Cleanup found **0** remaining fixture databases and **0** fixture
runtime/backup roles. The synthetic cluster is stopped after verification.

Archives are private plaintext, not encrypted/signed. Fingerprints compare content,
not authenticity. A logical backup omits cluster roles/passwords, server/private
environment files, binaries and external configuration, and is not point-in-time
recovery. Each app has a separate snapshot; coordinated final cutover needs quiet
writers and relationship review. Restored account policy/credentials may predate
later changes and need operator review even though sessions are revoked. No live
backup job, retention, off-server copy, encryption or alerts were installed.

### Next useful implementation

DATA-05: when an account is full, West Texas import can count a blocked assignment
as accepted; reconcile accepted/skipped reporting with records actually added.
Preserve formatted/leading-zero identifiers and ensure CSV-exported staff-entered
text cannot execute as a spreadsheet formula. These affect the reliability of
inventory and reports before real records are imported. DATA-03-ROLLOUT and other
company access/mail/HTTPS/service/label/mobile/migration decisions remain required
before deployment. Owner reviews and merges this implementation PR.

Publication: implementation commit `2e65ea2` pushed to
`Dev/postgresql-backup-restore`; opened and attached
[PR #27](https://github.com/tanmar-org/AssetTrackerProDTV/pull/27). Publication
references are bundled into this same PR. Owner review/merge and production
operational rollout remain pending; no merge or deployment was performed.

## 2026-10-06, 09:25 CDT — Import correctness and protected CSV reports

### Owner merge and scope

The owner reported PR #27 merged. GitHub confirmed merge at `bafe966` on
2026-10-06 13:31:10 UTC (08:31 CDT). Fetched main and created
`Dev/import-export-correctness` from that revision. Completed DATA-05 implementation
and bundled its documentation. No production records/settings/services, migrations,
application dependencies or QR source were changed. Owner review/merge follows.

### Resulting behavior

Master and West Texas previews/Apply share row validation, duplicate handling and
capacity planning. Previously, a full account could prevent an assignment while
adding its receiver to Master and counting it as processed. Blocked rows now have
no registry/account/metadata/history side effects. Apply considers only preview-
eligible rows and checks them again against current tab capacity; skipped preview
rows do not silently become eligible. Moves reserve/free slots in file order;
already-assigned receivers need no extra slot, including full accounts. New
accounts have the same 20-receiver limit. Invalid mapped fields and duplicate
assets have explicit skip reasons; existing server validation remains authoritative.

Nonempty mapped receiver/account fields are retained, blank cells preserve existing
values, and textual/formatted leading-zero identifiers remain text. West Texas
name carry-forward resets at a new account group instead of inheriting the previous
customer's name. Office/notes are mapped; existing condition/rent/location survive.
Moves retain assignment IDs, refresh assignment time and append receiver history;
new assignments append history too. Counts distinguish new/updated/unchanged/skipped
Master records and assigned/moved/already-present/skipped West Texas rows. No-op
imports do not manufacture saves. Completion explicitly awaits sync confirmation;
conflicts still pause the draft for existing recovery/export.

Single-account previews stay bound to their target account across asynchronous
reading and Apply, checking current capacity and assignment before registry writes.
Regular users apply one eligible receiver per operation under the server's existing
ordinary permission policy; administrators can use remaining capacity. Imports do
not apply over a paused draft. TQ summaries separate updated/unchanged/skipped/
company-wide ignored rows and count duplicate/deleted receivers accurately. Existing
stock reconciliation and off-rent timer repair are retained without inventing
status-change history for a timer-only repair.

All three CSV downloads (account, audit, activity) use one quoted-field encoder,
doubling internal quotes and adding an in-field tab to formula/control/full-width
prefixes and leading-zero/long numeric text. Original inventory is unchanged.
This follows the Excel-oriented approach in
[OWASP CSV guidance](https://community.owasp.org/attacks/CSV_Injection); it is not a
universal spreadsheet or lossless machine interchange guarantee. Actual desktop
spreadsheet acceptance remains QA-01. JSON inventory snapshots and complete
PostgreSQL backups remain the exact-value/recovery paths.

Changed staff `app.js` and asset version 64, added eleven default regressions and
four Chromium scenarios, and updated the existing browser recovery test wait.
AGENTS, TODO, development/self-hosting guides and
[the import/report policy](docs/IMPORTS-AND-EXPORTS.md) describe fields, counts,
capacity ordering, server acknowledgement, report tabs and remaining limits.

### Validation and test synchronization correction

Fresh staff webpack build/default suite: **65 passed / 0 failed**. Standalone
staff TypeScript passed. Full HTTP/PostgreSQL suite: **87 passed / 0 failed**;
full Chromium suite: **34 passed / 0 failed**. Eleven new default scenarios exercise
actual browser functions with the server schema/everyday permission checker,
including new/existing full accounts, file-order moves, aged previews, duplicates,
metadata/grouped names/leading-zero IDs, history, target switches, ordinary one-
receiver permission, timer repair and all CSV encoders. Chromium uses actual local
workers/file inputs/Apply controls, records PUT/PATCH payloads and reads all three
actual downloaded CSV files. Outside traffic is blocked; fixtures are synthetic.

The initial full browser run was **32 passed / 2 failed**, counting the parent,
in an existing shared-device recovery scenario: its wait matched old error text
while a new login still hid that text and remained pending. An isolated run passed;
a temporary trace run also passed. Investigation found the wait ignored visibility
and login completion. The final test deliberately holds the login response and
asserts the old text is still present but hidden, then releases it and waits for
visible error plus completed login. Original identity/privacy/draft-owner assertions
remain unchanged; no runtime authentication code changed, retries were not added
and no assertion was relaxed. Removed temporary tracing; final full suite passed.

Focused changed-test lint, browser syntax and diff checks passed. Full root lint
retains **2 inherited vendor errors / 146 warnings** (one fewer warning after the
reviewed import rewrite); no suppression or third-party byte change. QR was not
rebuilt because its source/dependencies were unchanged; its matching existing build
was exercised through full browser/PostgreSQL checks. No new advisory query ran.
Some PostgreSQL teardown emitted the previously recorded generic idle-connection
notice; all scenarios passed. Cleanup confirmed **0** fixture databases and **0**
fixture runtime/backup roles, and the synthetic cluster is stopped.

### Remaining limits and next useful implementation

Local previews cannot promise server acknowledgement, collection-size acceptance
or the absence of another employee's concurrent revision. Preview renders up to
200 rows with a truncation notice; counts include every row. Spreadsheet consumers
see protective tabs, and saving/editing/reimporting can change protections or
formatting. Physical spreadsheet/mobile/device acceptance remains QA-01. No live
import or production rollout was performed.

Next DATA-06: both the QR-request GET and administrator activity GET use `LIMIT 500`
with newest-first ordering. Older pending work can disappear from the screen.
Add bounded server pagination/filtering and staff controls for pending requests
and older activity without bulk-loading private databases or changing permissions.
Audit/history retention and storage scaling remain separate DATA-06 decisions;
company access/mail/domains/services/off-server backup/cutover decisions still
need operational acceptance before deployment.

Publication: implementation commit `5280176` pushed to
`Dev/import-export-correctness`; opened and attached
[PR #28](https://github.com/tanmar-org/AssetTrackerProDTV/pull/28). Publication
references are bundled into this same PR. Owner review/merge and any later
production rollout remain pending; no merge or deployment was performed.

## 2026-10-06 09:50 CDT — Older QR requests and administrator activity (DATA-06-LISTING)

### Merged baseline and implementation

Confirmed owner merge of [PR #28](https://github.com/tanmar-org/AssetTrackerProDTV/pull/28)
at `bc9f0af` (09:25 CDT). Branched `Dev/request-activity-pagination` from that current
`origin/main`; the active worktree was clean. Preserved the original checkout's
unrelated authentication-file edits. No production configuration/database/service
or live label destination was changed.

Private request and administrator activity GET previously returned only the newest
500 rows; browser filters searched only that subset. Added a shared Node listing
contract, PostgreSQL search/status or search/type/date filters, stable timestamp/ID
cursors, and default/max 100-row pages. Queries bind literal search values, fetch
one extra row to detect another page and exclude request tombstones. Authentication
applies to every page; cursors bind filters/size/endpoint and confer no permissions.
Tracker `0004_activity_pagination.sql` and requests `0003_request_pagination.sql`
add ordered indexes without modifying earlier checksums, rows or grants.

The staff proxy validates the same allowlisted query before forwarding to its
configured endpoint, retains the account-lock session/role recheck and five-second
upstream authorization bound, rejects redirects, and caps streamed responses at
two MiB. Errors remain redacted. The separate QR database's public submission,
GPS/rate/unique-pending controls and private bearer boundary are unchanged.

Staff controls load one remote page, reset on filters/refresh/view changes/status
mutations and keep matching manual inventory requests on each page with an explicit
notice. Tiles count the loaded QR page plus all manual work. Request search matches
submission-time metadata even when current receiver association displays a rename.
Activity CSV exports only the current filtered page. Receiver-history labels/help
identify its loaded-QR scope. Date filters use local calendar days and advance to
an exclusive next day across DST. Debounced filters invalidate older responses
immediately; session lock clears timers, rows, cursors and private DOM. Asset
references advance to version 65.

### Rendering issue found during verification

Nonempty administrator activity revealed an inherited undefined
`formatHistoryDate` call. The summary updated but activity rows failed to render;
user status and recovery lists referenced the same missing helper. Restored a
commented year/second-inclusive local formatter with invalid-date fallback and
added an actual nonempty renderer/escaping regression. Chromium retains real
nonempty activity, navigation and downloaded CSV assertions.

The first default run was **68 passed / 1 failed** because the existing function-
extraction HTML safety fixture needed the new pager state/control helper. Updated
that fixture while retaining all original unsafe-map/HTML assertions. The first
full Chromium run was **34 passed / 5 failed / 1 cancelled**: the new fixture visited
the directory URL, which serves a 404, instead of the staff `index.html`. Corrected
only its route. The subsequent focused run exposed the real missing formatter;
fixed the application and added the regression. Final focused Chromium **6/6** and
full Chromium **40/40** passed; no retries or relaxed privacy/security assertions.

### Final validation

Both fresh webpack builds and both standalone TypeScript checks passed. Staff
full default suite **70 passed / 0 failed**, QR default **4 passed / 0 failed**, full
PostgreSQL/HTTP suite **95 passed / 0 failed**, full Chromium **40 passed / 0 failed**.
Tests use only synthetic local records. SQL scenarios exceed 600 rows with equal
timestamps, find oldest pending requests, visit all pages without repeats, insert
newer rows/delete anchors, check literal wildcard/quote searches, category and real
date boundaries, strict filters/cursor binding, both private endpoints, cookie/bearer
permissions and revocation. Proxy tests reject invalid filters before forwarding,
redirects and oversized bodies; existing timeout/lock rechecks still pass. Paired
backup/restore drills verify the new migrations and indexes with restricted roles.

Chromium checks actual Previous/Next controls, manual-row scope, filters/renames,
late same-login responses, lock cleanup, outage clearing, page CSV and a 25-hour
America/Chicago DST date selection. Outside traffic is blocked; API fixtures prove
UI behavior, while PostgreSQL proves server permissions/SQL.

Focused changed-code/test lint, browser syntax and diff checks passed. Full root
lint retains **2 inherited vendor errors / 146 warnings**; QR lint passes with its
**3 inherited image warnings**. No vendor edits, dependency changes or advisory
submissions. The QR build retains the multiple-lockfile workspace-root warning;
repository layout is documented and both builds pass. Some PostgreSQL teardown
emits the recorded generic idle-connection notice; all scenarios passed. Cleanup
confirmed **0** fixture databases and **0** fixture roles, then stopped the private
synthetic PostgreSQL cluster.

AGENTS, TODO, development/self-hosting/public-request/import guides and the new
[record browsing policy](docs/RECORD-LISTS.md) document the contract, migration,
UI/count/export scope, comments and verification. DATA-06-LISTING is implemented;
retention/archiving and measured storage/search capacity remain open subitems.
Pagination does not provide a snapshot, purge policy, complete QR receiver history
or a full audit/database export. Broad filters can still scan many records; imported
malformed/non-UTC/oversized historical values require MIG-01 reconciliation.

### Next useful implementation and publication

Next DATA-02: completing QR work currently updates its database before the browser
saves receiver history to the tracker. A failed second save/tab closure can leave
completed status without the corresponding history. Add a durable server operation,
retry/duplicate protection and explicit pending/failure handling, with permissions
preserved and interruptions tested between both writes. Keep the separate databases;
client sequencing alone cannot guarantee recovery. Afterward QA-02 should make
full lint useful again through a verified-vendor policy/application fixes.
Company access/mail/domains/services/off-server backup and real-device/cutover
acceptance remain deployment decisions.

Publication: implementation commit `dca0fe1` pushed to
`Dev/request-activity-pagination`; opened and attached
[PR #29](https://github.com/tanmar-org/AssetTrackerProDTV/pull/29). Publication
references and explicit staff-tab reload guidance are bundled into this same PR.
Owner final review/merge and production rollout remain pending; no merge or
deployment was performed.

## 2026-10-06 10:58 CDT — Recoverable QR status and receiver history (DATA-02)

### Baseline and implementation

Confirmed owner merge of [PR #29](https://github.com/tanmar-org/AssetTrackerProDTV/pull/29)
at `50b869e` (10:12:59 CDT). Branched `Dev/qr-history-coordination` from that
current `origin/main`; the active worktree was clean. The original checkout's
unrelated authentication-file edits are preserved. No live databases, provider
configuration, domains or production services were changed.

Previously completion changed the separate QR database before the browser saved
receiver history; deletion archived locally before contacting QR. A lost response,
failed second write or closed tab could leave either database out of step. Staff
mutations now commit a durable tracker intent before any QR write. They require an
immutable UUID, current request version and inventory revision, strict bounded
JSON and authoritative metadata preflight. The accepted actor/approver and receiver
association are retained independently of account changes; no session/bearer secret
is stored. Only one unfinished intent per request can proceed.

QR requests gain integer versions and a private item/operation protocol. A QR
transaction locks the operation UUID and request row, checks the expected version,
and commits the transition with its durable receipt. Replays return the original
receipt/completion time; changed payloads cannot reuse the UUID. Version conflicts,
missing requests and conflicting Pending reopens receive permanent rejection proof.
A savepoint retains that proof while rolling back a uniqueness-rejected reopen.
Old direct unversioned QR PATCH/DELETE now return 410 after bearer authentication.
Public submission, private paged listing, GPS/rate limits and privacy stay enforced.

The tracker finishes proven history, current inventory/rent, derived rental-stock
release, audit and done status together. It preserves unrelated edits and uses the
normal schema/ordinary permission checker even for administrator completion.
Failures retain intent; a later process fetches the committed QR receipt instead of
reapplying. Account lock precedes the operation/state locks; current approval is
checked before a new QR write, and receipt lookup/mutation share one five-second
budget with redacted bounded/redirect-safe responses. Already committed proof can
finish factual history after logout/deactivation without another QR mutation.

A receiver rent status/timer changed while waiting pauses completion for explicit
review. Owner/admin history-only review requires a fresh revision and preserves
current rent fields. Stable association survives renaming/number reuse; missing
receivers retain authoritative history/proof in the operation ledger and audit
without inventing a row. All operation/receipt records are retained; existing
receiver-event/snapshot bounds continue. There is no distributed transaction:
consistency is recoverable, with service availability/conflict resolution required.

### Staff interface, VM process and restoration

Staff QR controls now use the durable server path without generating local QR
history/rent saves. Unconfirmed retries reuse the tab-memory UUID/body. Local drafts
block new actions; edits begun during an attempt survive subsequent refresh. A
private paged synchronization queue provides Retry, View record, phase/filter/search
controls and explicit rent-conflict review. Pending work disables overtaking. A
known rejection refreshes state/lists and reports its reason; failed inventory
refresh after acknowledgement reports acceptance accurately. Session lock clears
commands, queue/detail DOM, filters and late responses. Assets advance to version66.

Root `service:reconcile` runs one bounded batch; `--watch` provides a separately
supervised VM process with backoff, aggregate/redacted logs and orderly shutdown.
No outside Worker is required, GET requests do not drive mutations, and no
production daemon/schedule was installed. Manual Retry also works. HOST-04 must
supervise/monitor the runtime command and unfinished/rejected/review-needed work.

Tracker migration `0005_service_operations.sql` and requests
`0004_operation_receipts.sql` add the intent/receipt tables, version and indexes;
earlier migrations/checksums are unchanged. Both health checks/runtime grants and
explicit backup catalogs include the new tables. Real paired backup/restore drills
retain their proof. Because snapshots can straddle a transition, restoration pauses
unfinished intents with `restore_review` before runtime grants; workers skip them
until administrator approval. Compatible apps/UI, both owner-run migrations and
explicit new-table grants are required together; old tabs/integrations must reload.
Older backups need a separately reviewed schema/tool upgrade plan.

### Validation and corrections

Final staff default **77 passed / 0 failed**, QR default **4 passed / 0 failed**;
full real PostgreSQL/HTTP **111 passed / 0 failed**; full Chromium **49 passed /
0 failed**. Both webpack builds and standalone TypeScript checks pass. Focused
changed-code/test lint, browser/operator syntax and diff checks pass. Root full
lint remains **2 inherited vendor errors / 146 warnings**, and QR full lint passes
with **3 inherited image warnings**. Vendor bytes/licenses, dependencies and
lockfiles are unchanged; no advisory submissions or tools were added. QR build
retains the documented multiple-lockfile workspace warning.

New SQL/HTTP cases use separate restricted roles and independent tracker/QR
processes: same-command replay, competing versions, multibyte notes, acknowledgement
lost after QR commit, failed tracker audit rollback, fresh CLI-process recovery,
logout/inactive-account/demotion/reapproval, rent conflicts/fresh review, renamed/
deleted receivers, overtaking denial, Pending uniqueness, archival, restored pause,
strict media/body/version selectors and more than200 paged operation records.
Backup drills verify both new tables and private restore guards. Chromium exercises
actual controls, UUID reuse, no browser QR save, reload, conflicts/rejections,
refresh outages, preserved local drafts, unsafe private details/maps and late lock
cleanup. Synthetic API fixtures prove UI behavior; SQL tests prove permissions.
Actual staff/mobile/label/production acceptance remains QA-01.

Initial protocol checks were **6/7**: explicit null notes were being coalesced to
empty text. Corrected both protocol and tracker parsing to reject null. First
affected SQL run **77/79** exposed a stub that committed HTTP200 before setting its
missing-receipt404; corrected the synthetic fixture while retaining the permission
assertions, then focused inventory **19/19** and full SQL **111/111** passed. The
first browser run **0/9** used a request without its display source label and
exposed legacy action classification: it fell through to the manual local-save
path. Classification now uses the actual server-loaded request collection. After
that, **7/9** passed; the final failure was an event listener registered after its
request already started. Registering the test listener before clicking retained
all privacy assertions; focused **9/9** and full **49/49** passed. No security or
recovery assertions were weakened.

Some fixture teardown emits the known generic idle-connection notice; every final
scenario passes. Cleanup confirmed **0** synthetic fixture databases and **0**
fixture roles, and stopped the private development PostgreSQL cluster. Documentation
is bundled: AGENTS/TODO/journal, the new [QR operation policy](docs/QR-OPERATIONS.md),
setup/grants, backups/restore, public-request/listing guidance and development tests.
DATA-02 is implemented; owner review/merge and production rollout remain separate.

### Next useful implementation and publication

Next QA-02: full root lint currently fails on two minified vendor-library errors
and reports146 warnings. This obscures whether a future application change adds a
real issue. Establish a verified-vendor lint policy without editing/suppressing
first-party code, fix application warnings and make the full check useful again.
Company access/email requirements, HTTPS/domains, web/reconciler supervision,
monitored encrypted off-server backups, real-data/old-label reconciliation and
physical-device acceptance remain deployment work.

Publication: implementation commit `beaef0a` pushed to
`Dev/qr-history-coordination`; opened and attached
[PR #30](https://github.com/tanmar-org/AssetTrackerProDTV/pull/30). Publication
references and a trailing-blank-line cleanup are bundled into this same PR.
Owner review/merge and production rollout remain pending. No merge or deployment
was performed.

## 2026-10-06 — QA-02 lint baseline (11:22 America/Chicago)

### Merge, scope and resulting behavior

Owner instructed “merged proceed.” GitHub confirmed PR #30 merged at
2026-10-06 11:05:37 CDT, merge `312309569d35d4bdd793ebf41394c3c249fa8892`.
Fetched `origin/main` and created `Dev/lint-baseline` from `3123095` with a clean
active worktree. The original checkout's unrelated `app/api/auth/route.ts` edit
was preserved. No merge, production deployment, database/provider/domain change,
secret retrieval or new dependency advisory submission was performed.

Inherited root lint reported **2 errors / 146 warnings**: the two errors and 143
warnings came from local upstream QR/barcode scripts; three warnings were staff
application code. QR lint reported three image warnings. Application rules remain
enabled. Both actual npm lint commands now use `--max-warnings=0` so warning-only
regressions fail, and root lint verifies vendor integrity before exact exclusions.
Bare ESLint alone does not perform that integrity check.

Reviewed existing `qrcode.js` against official qrcode-generator 1.4.4 tag `js1.4.4`
(commit `9bd2163ddc1628d1ec8ff22ea288a747275ef442`) and `jsbarcode.min.js` against
JsBarcode 3.11.6 tag `v3.11.6` (commit `5ed2a2b9da5f82da3c6159eb47a21d06f1cf797d`).
Public upstream artifact downloads exactly matched existing bytes. Added unchanged
MIT licenses from those same commits and page SRI for both label generators.
SheetJS 0.20.3 script/license/SRI remain unchanged. No script versions/bytes,
package dependencies or lockfiles changed. Vendor README records provenance/pins
and reviewed update steps; digests are an allowlist, not an upstream signature
or advisory assessment. New vendor-directory application files remain linted.

Removed the unused Undo state read and resulting dead helper, removed the unused
West Texas mapping helper (actual grouped A:N/shared planner retained), and made
label checkbox selection explicit with a review comment. Staff asset version is 67.
QR branding uses eager unoptimized Next Image with explicit dimensions and original
local URLs/bytes. Responsive logo CSS retains automatic height. There is no outside
image service or new runtime CDN. No application API/database/migration/auth
protocol was changed.

### Verification and corrections

Final staff default **84 passed / 0 failed** (including seven new integrity/lint
regressions); QR default **4 passed / 0 failed**; full Chromium **51 passed /
0 failed**. Both webpack production builds and standalone TypeScript checks pass.
Both full npm lint commands pass **0 errors / 0 warnings**, including final changed
browser tests. Diff checks pass. Exact pinned vendor scripts and both lockfiles
have no diff. PostgreSQL integration tests were not rerun: no server/database/SQL/
permission code changed. The private development PostgreSQL cluster stayed stopped;
PR #30's 111 passing integration checks remain historical evidence, not a fresh run.

New default tests reject edited script bytes, missing/replaced licenses, symlinks,
and missing/changed/duplicate script SRI. ESLint coverage tests retain first-party
files and actual warning rules; subprocess tests invoke both actual npm lint gates
with synthetic warning-producing code and require failure. Browser tests exercise
real SRI-loaded QR/barcode generation through checkbox controls, clearing/disabling
print controls, and all three original image URLs/intrinsic sizes on desktop and a
280-pixel viewport. Existing spreadsheet/security/session/recovery suites pass.
These prove browser rendering, not physical printing/scanning or mobile GPS.

The first cleanup lint identified `liveState` becoming unused after its only caller
was removed; the dead helper was removed, retaining the actual Undo comparison.
Restricted builds hit the documented TypeScript child-process parsing failure;
rerunning with appropriate local process permissions passed. QR build retains the
known multiple-lockfile workspace warning, separate from ESLint findings.
The staged diff check flagged the upstream barcode MIT license's CRLF endings.
Exact `.gitattributes` entries preserve all six pinned files without line-ending
conversion, accepting CR-at-EOL only for that original license. Upstream bytes
remain intact; the final staged diff check passes without a global suppression.
The initial full browser run had 49 passes / 2 failures (one new layout assertion and
its parent): its narrow-screen fixture reused intentionally oversized malicious
API text from security scenarios. Local layout inspection with ordinary synthetic
IDs confirmed the responsive logo works. The layout fixture now uses `TEST-01`
and restores the attack fixture afterwards; all existing malicious assertions
remain intact. Focused rendering **8/8** and final full Chromium **51/51** pass.

### Documentation, next work and publication

Bundled AGENTS, README, TODO, development guide, dependency follow-up and vendor
provenance with implementation and this journal. Current handoff now reflects
owner merges through PR #30; earlier validation entries remain dated evidence.
QA-02 is implemented for owner review/merge.

Next QA-01-CI: test evidence currently depends on manual VM execution. Add GitHub
PR checks for both apps' lint/types/builds and meaningful synthetic regressions so
future changes show failures before owner review/merge. Use isolated services,
never production credentials/data. No workflow or branch protection was installed
by this PR; checks do not replace owner review or physical acceptance.
Company access/email requirements, HTTPS/domains, VM web/reconciler supervision,
monitored encrypted off-server backups, real-data/old-label continuity, owner
credential rotation and actual device acceptance remain deployment work.

Publication: implementation commit `6144e72` pushed to `Dev/lint-baseline`; opened
and attached [PR #31](https://github.com/tanmar-org/AssetTrackerProDTV/pull/31).
Publication references are bundled into the same PR. Owner review/merge remains
pending; no merge or deployment was performed.

## 2026-10-06 — QA-01-CI automated PR validation

### Confirmed merge and scope

Owner said “merged.” GitHub confirmed PR #31 merged on 2026-10-06 at
11:28:50 CDT, merge `eac2bbaf34a22ae985a3d2ed7660afccace469cc`.
Fetched `origin/main`, confirmed the clean active worktree and created
`Dev/github-validation` from `eac2bba`. Preserved the original checkout's unrelated
`app/api/auth/route.ts` edit. No merge/deployment/production connection or settings
change was performed. Existing GitHub workflow history consists of dependency
update jobs; no project validation workflow existed in the repository.

Read-only GitHub settings confirmed Actions enabled, all actions allowed. Added
`.github/workflows/validation.yml`: PRs targeting main, main pushes and manual
runs execute `Validate applications` on disposable GitHub-hosted Ubuntu 24.04.
No path/draft filters, repository secrets, VM runner, write permission, deployment
step or automatic merging. New commits cancel outdated runs for the same PR/ref.
The owner can separately make the stable check required in main branch rules;
those rules/permissions were not changed by this task.

The check installs both existing lockfiles, validates workflow syntax, runs both
zero-warning lint gates, builds/tests each app, checks types after builds, then
runs the complete PostgreSQL/HTTP/backup and Chromium regression suites. Tests do
not rebuild while serving those artifacts. The pinned official PostgreSQL 18.6
service has a dedicated test administrator/database and runner-loopback port 55432.
Trust authentication is restricted to that disposable service so existing
passwordless restricted fixture roles work; this is not production configuration.
Signed PGDG Ubuntu packages install matching client 18 for real dumps/restores.
An always-after-integration check counts leftover generated fixture databases/
roles; GitHub destroys the service at job end/cancellation. Final Git cleanliness
checks reject rewritten sources/lockfiles. No database/build artifacts are uploaded.

### Reviewed tooling, local verification and documentation

Verified action commits through their official GitHub repositories: checkout v6
`d23441a48e516b6c34aea4fa41551a30e30af803`, setup-node v6
`249970729cb0ef3589644e2896645e5dc5ba9c38`. The official PostgreSQL 18.6 Docker Hub
manifest digest is `fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf`.
Playwright 1.58.2 stays test-only outside both application trees/lockfiles;
Chromium/system libraries install only on the ephemeral runner. Node follows
`.nvmrc`; automatic package caching is disabled and checkout credentials are not
persisted. GitHub/PostgreSQL/Playwright authoritative setup references are linked
in the new [CI operations guide](docs/CONTINUOUS-INTEGRATION.md).

Downloaded official actionlint 1.7.12 Linux amd64, matched the release asset SHA-256
`8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8`, and installed it
under `~/.local/share/assettracker-tools/actionlint-1.7.12/`, with a user-local
command link. The initial archive extraction requested `LICENSE` instead of the
actual `LICENSE.txt`; inspected the archive and installed the correct upstream
license. Tool version 1.7.12 and explicit workflow validation pass; diff checks
pass. No system package/service or production database was installed on this VM.
The workflow uses that same verified tool archive for its syntax check.

Bundled AGENTS, README, TODO, development/CI guidance and this journal. No runtime
code, database/migration or application dependency/lockfile changed. The observed
hosted results below establish fresh evidence separately from earlier VM totals.
Do not equate YAML validation with a successful hosted workflow.

### Next useful action

Asked the owner which staff access direction to prepare: company network/VPN,
internet protected by company SSO, or decide later. The existing PIN login is not
an outer company access policy. Prepare deployment ingress/login traffic controls
from that answer while retaining the separate public QR application. HTTPS/domains,
approved email delivery, supervised web/reconciler processes, monitored encrypted
off-server recovery, real-data/old-label continuity and physical-device acceptance
remain separate owner/operator deployment work.

### Observed hosted validation and publication (11:44 America/Chicago)

Implementation commit `b9db77c` pushed to `Dev/github-validation`; opened and
attached [PR #32](https://github.com/tanmar-org/AssetTrackerProDTV/pull/32).
[GitHub run 37497396747](https://github.com/tanmar-org/AssetTrackerProDTV/actions/runs/37497396747)
completed successfully on that implementation at 11:41:55 CDT (test completion).
Fresh hosted staff default **84/84**, QR default **4/4**, real PostgreSQL/HTTP
**111/111**, Chromium **51/51**; all four suites reported **0 failed, canceled
or skipped**. Both webpack builds, TypeScript scopes, zero-warning lint gates,
workflow syntax, clean-tree/diff checks and container teardown passed. The cleanup
query reported **0** remaining generated databases/roles. This is actual hosted
execution, not a restatement of prior VM test counts. No CI implementation change
was needed after the first run.

Publication references and observed results are bundled into this same PR; the
final documentation commit triggers another full check. Review the latest PR
commit's result, since the linked run above proves the implementation commit.
Owner review/merge and optional required-check rules remain separate. The hosting
VM's private PostgreSQL cluster stayed stopped; no deployment was performed.

## 2026-10-06 — Initial internet/AD review before owner clarification (America/Chicago)

Owner confirmed PR #32 merged and chose internet staff access, explaining there is
no company SSO and AD is on premises. GitHub confirmed merge
`396be11d149aa028d416f695ab27a50c944391eb` at 11:53:23 CDT. Fetched main and created
`Dev/ad-authentication` from that merge with a clean active worktree; the original
checkout's unrelated auth edit remains untouched. The final CI PR commit
`a0b793d` also passed hosted run 37498049069 (84 staff/4 QR/111 SQL/51 Chromium,
zero failures/canceled/skipped and zero leftover fixtures), as recorded in PR #32.

Reviewed current login/session/account code: authentication still verifies local
4–8 digit PINs in PostgreSQL, with per-user locks and 12-hour application sessions.
It has no AD/OIDC/LDAP integration. Application roles, active-account checks,
revocation locks, session contexts and recovery-copy ownership must remain enforced
when changing the identity source. Initial review proposed identity integration
and an MFA/access policy; existing PIN checks do not implement AD. The owner
subsequently chose no MFA, as recorded below.

Checked authoritative Microsoft AD FS and Keycloak documentation. AD FS supports
OpenID Connect; Keycloak supports AD/LDAP federation, OpenID Connect and MFA. If
there is no suitable existing identity service, recommend a self-hosted broker such
as Keycloak: browser HTTPS sign-in/MFA, private encrypted directory access, and
verified OIDC sign-in for the tracker. AD domain controllers remain private. This
is a proposal, not approval to install a broker, expose endpoints or change AD.
Provider operations add maintenance/backup responsibility. Existing Entra/AD FS
availability should be checked before adding another service.

Asked the owner about existing AD FS/Entra/other identity services, the VM's private
reachability to AD and current MFA. Those answers are needed before choosing the
integration; no time-based assumption was made. No AD credentials/server addresses
were requested, and no directory/network scan or connection was attempted. No
runtime code/dependency/migration/auth configuration or production setting changed.
Recorded confirmed requirements/open decisions in TODO and this handoff, to bundle
with the eventual implementation rather than opening a minor documentation PR.
Documentation diff checks pass; runtime tests were not rerun for these notes.

References: [Microsoft AD FS protocols](https://learn.microsoft.com/en-us/windows-server/identity/ad-fs/overview/ad-fs-openid-connect-oauth-flows-scenarios),
[Keycloak AD federation and authentication](https://www.keycloak.org/docs/26.8.0/server_admin/).

## 2026-10-06 — Shared staff login traffic protection (America/Chicago)

### Owner decisions and focused scope

Owner answered no existing identity service, yes private VM-to-AD connectivity,
no current MFA, and explicitly requested no MFA. Recorded AUTH-01-POLICY and
superseded the earlier broker/MFA proposal. Planned direct private LDAPS with
certificate/hostname verification, AD username/password UI and explicit immutable
objectGUID linking to existing app users. App IDs, permissions, draft ownership,
session contexts and revocation must survive the change. No broker/MFA installed;
no real AD address/password requested, scan/connection attempted or directory
setting changed. The adapter itself remains AUTH-01-INTEGRATION.

Chose AUTH-01-TRAFFIC as the first reviewable implementation step: current
per-account PIN lockout does not bound unknown-username lookups/legacy alias scans.
Internet AD login will also need a shared gate before directory work. Development
branch `Dev/ad-authentication` starts from the owner's merged PR #32 at `396be11`.
No separate minor documentation PR is planned.

### Implementation and operator requirements

- Added tracker `0006_login_rate_limits.sql` and Node helper
  `lib/login-rate-limit.ts`. Eligible staff sign-ins reserve one committed shared
  PostgreSQL budget before account lookup, PIN hashing or user-row locking:
  300 global / 60 authenticated client / 30 canonical username per fixed minute.
  Saturated counters and early stop bound arbitrary-selector allocation. Expired
  rows are pruned; all server processes share limits, including unknown users.
- Return noncacheable 429 with a bounded Retry-After and no new cookie. Success,
  incorrect credentials and later account lookup failure consume reservations;
  counter/schema failures return generic 503 without continuing authentication.
  Existing PIN lockout, permissions/session locks and shared-device behavior stay
  enforced. Browser-marked cross-site login fails before reservations.
- Added `LOGIN_PROXY_SECRET` and authenticated overwritten ingress headers.
  Configured missing/forged/invalid ingress fails closed; plain forwarded IPs are
  ignored. Blank is local development only, with global/username limits. Raw
  selectors/credentials are not stored; hashed keys remain private metadata.
- Added readiness's counter-table read, explicit restricted fixture grants,
  backup catalog/restore grants and seeded restore verification. Historical
  migrations were not edited. Operator must migrate/grant the new table, extend
  backup SELECT grants and configure trusted HTTPS ingress before rollout. Older
  archives require reviewed schema upgrades, not skipped checksum/catalog checks.
- Bundled owner decisions, instructions, TODO, README, setup/development/recovery
  guides and new `docs/STAFF-AUTHENTICATION.md`. No application dependency,
  lockfile, QR runtime/UI, production database/service or AD configuration changed.

### Validation on this VM

Both production builds and standalone TypeScript checks pass. The initial staff
build found an overly narrow inferred bucket-limit array type; fixed it with an
explicit number type before the successful build. Both lint gates pass with zero
warnings, including vendor byte/license/SRI validation; `git diff --check` passes.
Restricted Node execution misleadingly reported one test-file pass, so it was
repeated with child-process permissions and actual named scenarios verified.

- Staff default: **89/89** checks pass, including five new ingress/cross-site checks.
- QR default: **4/4** checks pass.
- New targeted real PostgreSQL/HTTP suite: **14/14** checks pass (13 scenarios
  plus the parent), then included in the full SQL run below.
- Full PostgreSQL/HTTP/backup suite: **125/125** checks pass. Independent pools
  and three real Node servers prove all ceilings, concurrent admissions, expiry,
  forged ingress rejection, canonical aliases, successful/incorrect/unknown
  credentials, committed account-outage reservations, bounded cardinality,
  missing counter schema/readiness and denial before account reads. Existing
  account, inventory/draft, QR and complete backup/restore regressions also pass.
- Chromium: **51/51** checks pass across existing staff and QR workflows.
- Total across the four complete suites: **269** checks, zero failures,
  canceled or skipped. The targeted 14 are already included, not counted twice.

Only the existing private socket-only PostgreSQL 18.6 cluster and synthetic
fixtures were used; cleanup query returned **0** remaining fixture databases/roles
and the cluster was stopped after verification. Generic idle-connection notices
occurred during intentional fixture teardown; all named scenarios and cleanup
passed. The original checkout's unrelated auth edit remains untouched.

### Next priority and limits

Published this login-protection PR for owner review; inspect fresh hosted checks
on its final commit. After owner merge, implement the bounded private LDAPS
adapter and password UI, explicitly map AD identities to app users and define
session invalidation/directory rechecks/operator recovery. This replaces the
local PIN identity check while keeping users' existing roles and saved work.
AD sign-in is not enabled by this task. Fixed-window budgets can admit boundary
bursts and temporarily delay legitimate users under abuse; they do not replace
edge limits or guarantee compliance with AD's lockout policy. No production
exposure, deployment, live migration or AD connection was performed.

### Publication and independent hosted evidence

Committed implementation `83d2882` and pushed `Dev/ad-authentication`; opened
[PR #33](https://github.com/tanmar-org/AssetTrackerProDTV/pull/33) targeting main and
attached it to this task. GitHub's GraphQL create endpoint failed twice and the
first REST attempt returned an empty response; read-only checks confirmed no PR
before each retry. The next REST attempt created one PR successfully. No duplicate
PR, merge, auto-merge or main push occurred.

[Hosted run 37521819264](https://github.com/tanmar-org/AssetTrackerProDTV/actions/runs/37521819264)
for implementation `83d2882` completed successfully: staff **89**, QR **4**, SQL
**125**, Chromium **51**, total **269**, zero failed/canceled/skipped. Verified
named scenario logs and **0** remaining synthetic fixture databases/roles. Both
builds/types/lint, workflow validation, repository cleanliness and teardown pass.
This is fresh hosted evidence, separate from the VM totals. The bundled final
documentation commit triggers a new full run; review its latest check result in
PR #33. The PR description records that final result after verification. Owner
retains final review/merge; production and AD remain untouched.

## 2026-10-06 — Private AD password sign-in (America/Chicago)

### Baseline and owner direction

Owner merged PR #33 at `16504178104b00d934a0af9c8569a2f58ed9edeb` on
2026-10-06 15:05 CDT. Its final implementation/documentation head `7f4382d`
passed [hosted run 37522346339](https://github.com/tanmar-org/AssetTrackerProDTV/actions/runs/37522346339):
269 checks, both builds/types/zero-warning lint and zero leftover fixtures.
Created `Dev/ad-password-signin` from current `origin/main`, retaining the original
checkout's unrelated auth-route comment edit. Owner's internet access, private
on-premises AD and explicit no-MFA decisions remain authoritative; no broker/MFA
was introduced. This task completes AUTH-01-INTEGRATION, with rollout still open.

### Implemented behavior and review boundaries

- Added `lib/ad-auth.ts`/`lib/ad-login.ts`: opt-in AD mode, mandatory private LDAPS
  CA/hostname verification, restricted reader search and separate user credential
  bind, structured equality filters with binary GUID bytes and a single five-second
  operation budget. Require computed lockout/password-expiry flags, valid account
  status/expiry and `pwdLastSet`; recheck metadata after user bind. Partial/unsafe
  settings and missing attributes/TLS/reader failures produce generic 503; failed
  credentials/missing/unlinked accounts share generic 401. No passwords persist.
- Tracker migration `0007_ad_identities.sql` adds constrained unique namespace/GUID
  mappings and provider-specific session metadata to existing tables. Existing
  users/IDs/roles/draft ownership are preserved; no new table grants, QR migration
  or automatic username/email mapping. Readiness checks columns and local config
  without contacting AD. Historical migration files remain unchanged.
- Added operator `auth:link-ad`, using `.env.migrate` owner connection and reviewed
  directory namespace/GUID. Exact expected old binding is required for replacements;
  change/revocation/audit commit atomically, duplicate/raced links roll back, identical
  links are no-ops. AD-mode first-admin provisioning creates only an unlinked app
  record without a chosen PIN. Public setup remains closed.
- AD-mode login commits the existing shared traffic gate before directory I/O,
  then rechecks app identity/active state under account and user-row locks before
  session issuance. AD sessions reject old PIN cookies, and PIN mode rejects AD
  cookies. App role/deactivation/relink/logout revocation remains enforced. AD
  password/unlock/link writes are rejected by browser user management.
- Session directory approval is cached in PostgreSQL for at most 60 seconds
  across processes. Required rechecks deny expired approval during outages without
  extending it; status/password changes revoke only matching credential/config
  epochs. Late successful replies cannot resurrect deleted sessions. Endpoint,
  scope, namespace, reader DN or CA changes invalidate existing AD cookies. AD
  replication and the cache interval remain real limits; LDAP/SQL have no global
  transaction and no instantaneous directory-change guarantee.
- Updated real staff UI to AD username/password entry, preserving dotted SAM
  names and password whitespace, clearing transient credentials and retaining
  shared-device/draft ownership behavior. Settings shows link status and app role/
  activation controls, without directory password/PIN/unlock controls. Reload tabs
  after shipping `app.js?v=68` with the API. Public QR behavior is unchanged.
- Complete backup drills now include AD mappings/session metadata; restoration
  revokes both providers' sessions. Updated agent instructions, TODO, README and
  authentication/setup/development/dependency/recovery runbooks together.

### Dependencies and validation on this VM

Pinned root `ldapts@9.2.0`, adding it and `strict-event-emitter-types@2.0.0` from
the lockfile. Fresh owner-approved production npm advisory screening returned
**zero findings**. QR dependencies/lockfile/vendor assets are unchanged; existing
development-only advisory remains DEP-01-DEVELOPMENT. No system package/service
or production database/configuration was installed.

Both final production builds, standalone TypeScript checks and zero-warning lint
gates pass; vendor bytes/licenses/SRI and operator help commands pass. Actual named
tests executed with child-process/local-socket permissions:

- Staff default: **102/102**, including real synthetic TLS/LDAP status, trust,
  exact binary GUID encoding and individual/aggregate time budgets.
- QR default: **4/4**.
- Full PostgreSQL/HTTP/backup: **142/142**, including 17 new AD checks with
  restricted runtime roles, independent Node processes, stable ownership, traffic
  gate, provider separation, status/password revocation/outage recovery, mapping
  CAS/uniqueness/audit rollback, app permissions and migration/readiness failures.
- Chromium: **55/55**, including four AD UI checks for submitted payloads,
  whitespace/non-numeric passwords, clearing/storage, outage locking and role UI.
- Total **303**, no failures, canceled or skipped checks; targeted subsets are
  included in these totals and never counted twice.

Initial synthetic LDAP response encoding and browser Settings navigation needed
fixture corrections before passing; binary GUID filters deliberately use Buffer
values to avoid UTF-8 conversion. Existing exact auth-status assertions gained the
new `authMode` field. No failing scenarios were removed or weakened.
Final review anchored initial session approval to directory verification before
SQL-lock waits; the added held-lock regression proves waits cannot extend it.
Rebuilt and repeated the staff/default and complete SQL gates after this correction.
All tests use fresh synthetic directory certificates/accounts and private socket-only
PostgreSQL 18.6. Cleanup query returned **0** fixture databases/roles; the cluster
was stopped. No real AD connection, network scan, credential request, directory
write, production service or live migration/deployment was performed.

### Next priority and limits

Push this implementation for owner review and independently verify its hosted
checks. After merge, prepare AUTH-01-ROLLOUT with the actual private LDAPS DNS
endpoint, approved CA/search scope/restricted reader and explicit reviewed account
GUID links. Validate actual policies/attribute access, disabled/locked/expired/reset
behavior, recovery admins, preserved app ownership and directory outages before
internet cutover. Synthetic tests cannot prove the company's AD behavior. HTTPS,
trusted ingress, service supervision, backups/alerts, real data/device acceptance
and approved mail delivery remain release work. AD mode is implemented but not
configured or live; no automatic PIN fallback is available during an AD outage.

### Publication and hosted validation

Committed implementation `d61dca6`, pushed `Dev/ad-password-signin` and opened
[PR #34](https://github.com/tanmar-org/AssetTrackerProDTV/pull/34) targeting main.
Attached it to this task; no main push, merge, auto-merge or deployment occurred.
This bundled documentation follow-up records the PR reference. The final-head
full hosted check and its exact results are recorded in the PR description after
verification; consult the latest `Validate applications` result, not an earlier
head or the VM-only totals. Owner retains final review and merging.

## 2026-10-06 — AD rollout preparation after owner merge (America/Chicago)

Owner merged PR #34 at `b2c63a92d97e1030195513b0b25577c77380bdd1` on
2026-10-06 15:48 CDT. Fetched current main and started `Dev/ad-rollout-preparation`
from that merge with a clean working tree. The merged tree matches the reviewed
AD implementation; no dependency reinstall or repeated runtime checks were needed
for these documentation-only merge notes. Preserve the original checkout's unrelated
auth comment edit. No documentation-only PR is being opened.

Final PR head `8902b9e` passed
[hosted run 37528356444](https://github.com/tanmar-org/AssetTrackerProDTV/actions/runs/37528356444):
staff 102, QR 4, PostgreSQL/HTTP/backup 142 and Chromium 55, **303 total**, zero
failed/canceled/skipped checks and zero remaining fixture databases/roles. Both
builds, TypeScript scopes, zero-warning lint, workflow verification, repository
cleanliness and teardown passed; named logs and the final PR head were verified.
The merge's separate main run
[37529218056](https://github.com/tanmar-org/AssetTrackerProDTV/actions/runs/37529218056)
was still running when preparation began; this note does not claim that result.

Reviewed the AD/setup/development runbooks. OpenSSL, DNS lookup, bounded-command
and PostgreSQL tools are already available on this VM. Requested the AD domain,
private controller/LDAPS hostname, port-636 availability, CA certificate location,
restricted reader-account availability and initial administrator usernames. No
passwords were requested; do not put reader credentials or real directory identity
details into public documentation. These facts are needed to select the intended
directory and validate trust instead of guessing from repository code.

AUTH-01-ROLLOUT is now the next operational task: establish the real private
connection/certificate, configure a restricted reader privately, approve exact
GUID-to-app-ID mappings and verify actual policies/recovery administrators before
staff internet cutover. The implementation remains unconfigured against company
AD. No actual directory connection/scan/write, live database/service configuration,
production migration or deployment has been performed. Merge notes remain local
on the Dev branch to bundle with the next substantive task; diff checks pass.

### Owner-supplied directory and read-only preflight

Owner supplied the AD domain/controller, expected port 636 and initial admin
username, and confirmed no dedicated reader exists. The CA response supplied a
controller hostname, not an exported certificate. With that target, performed
bounded DNS and strict TLS checks only. DNS resolves privately and TCP 636 presents
a certificate with the matching DNS SAN and currently valid dates. Strict chain
validation fails with OpenSSL error 20 (unable to get local issuer certificate);
this is reachability evidence, not a verified authenticated directory connection.
The presented issuer identifies an internal CA. Do not trust the leaf or bypass
verification to continue.

Saved the actual infrastructure/account identifiers and certificate observations
in mode-0600 private VM notes under the user's private tools area, outside Git.
These public journal notes intentionally omit those identifiers. No credentials
were supplied/sent, LDAP bind/search or AD write performed, CA trust edited, app
identity linked or live database/service configured. Next obtain the public
trusted CA bundle through Windows administration and create a dedicated non-admin
reader, with its password configured privately. Then verify the trusted connection,
required attribute access and the nominated user's reviewed GUID before explicit
app mapping. No new code/dependency changes or documentation-only PR.

The merged main run
[37529218056](https://github.com/tanmar-org/AssetTrackerProDTV/actions/runs/37529218056)
subsequently completed successfully on `b2c63a9`. The prior final PR's 303 named
checks remain the recorded detailed evidence; no new runtime checks were needed
for these local documentation updates. Diff checks pass.

### Owner-exported CA and verified TLS

Owner supplied the public root CA export from a trusted domain PC. Checked its
PEM format, CA constraints/signing usage, self-issued subject/issuer and current
validity; self-verification passes. Strict OpenSSL verification of the controller's
chain and DNS hostname passes with this CA. A separate Node TLS connection using
application-equivalent CA/servername/verification/minimum TLS 1.2 also reports
authorized=true. Both negotiate TLS 1.3. No credentials or LDAP bind/search sent;
this proves trusted TLS connectivity, not reader access or staff authentication.

Stored the public CA, candidate nonsecret directory settings and updated actual
identifiers/fingerprints in the protected VM area outside Git. No system trust or
application runtime environment changed. The reader screenshot shows a different
account name from the earlier suggestion in the default Users container; its
actual creation/DN still require verification. Private notes record the proposed
DN without publishing it.

Prepared a private local password-entry helper: interactive reader-DN review and
hidden password/confirmation, mode-0600 JSON in a mode-0700 directory, exclusive
creation and no password arguments, shell parsing or chat entry. It performs no
network operation or deployment. Checked help, Python syntax, file/directory modes
and refusal of non-TTY input. No actual reader secret has been saved/read yet.
Await owner entry before verifying reader bind/required attributes and the nominated
administrator's GUID. No repository code/dependency changes or new PR; these
documentation updates will be bundled with the next substantive task.

### Reader credentials entered; first bind rejected

Owner confirmed hidden local password entry completed. Verified private settings,
CA and reader-secret file permissions without printing the password. One bounded
reader bind over certificate-validated LDAPS returned InvalidCredentialsError.
Stopped after that attempt, before RootDSE/admin attribute/GUID reads. This does
not establish whether the cause is the account DN, password or account state.
No application identity/session/mapping, AD write or database/service change made.

Prepared read-only Windows account-status verification against the same controller;
actual identifiers remain in protected notes. Avoid repeated unchanged binds until
the account's exact DN, completion/enabled/unlocked status and password requirements
are verified. The private helper now supports explicit --replace for corrected
local entry, with atomic mode-0600 replacement. Synthetic checks passed for exact
whitespace/quote/backslash handling, file mode, overwrite refusal, mismatch
preservation and atomic replacement/temporary cleanup. Real credentials were not
changed by those checks. Repository code/dependencies remain unchanged; notes stay
bundled on the current Dev branch, without a documentation-only PR.

## 2026-10-06 — Correct AD domain-root searches after owner retry (America/Chicago)

### Real read-only acceptance and cause

Owner requested another reader verification attempt. Certificate-validated LDAPS
reader bind now passes; RootDSE confirms the configured default naming context.
A targeted search returned exactly one eligible nominated account with all six
required attributes, plus three continuation references. The adapter correctly
refused unexpected references, but the request did not limit normal AD domain-root
searches to their naming context. No referral was followed, user password tested,
directory account modified or application identity/session created.

Renamed the unpushed preparation branch to `Dev/ad-domain-scope`, retaining base
`b2c63a9` and bundling the accumulated merge/preflight notes with this correction.
Every identity/status search now sends critical `LDAP_SERVER_DOMAIN_SCOPE_OID`
(`1.2.840.113556.1.4.1339`, no value). This prevents ordinary partition references
while preserving rejection of unsupported controls, unexpected references,
ambiguity and missing attributes. No fallback, referral following, TLS relaxation,
dependency/schema change or new directory write was added. Microsoft documents
the control as limiting searches to one naming context without generating referrals;
the authentication runbook links that primary reference.

One additional bounded read through the corrected production `lookupAdGuid`
successfully returned the same reviewed GUID, DN and username with eligible status.
The real evidence, settings, CA and reader secret remain mode-0600 in a private
mode-0700 VM directory outside Git. Public notes omit actual company endpoints,
account identifiers and GUIDs. This is reader/identity evidence, not proof of the
nominated user's password or an application login. No live database migration,
mapping, service configuration or deployment occurred.

### Regression coverage and verification

The synthetic TLS/LDAP helper independently decodes wire controls and normally
returns three partition references for an unscoped domain-root search. Tests
demonstrate the original result shape and corrected GUID lookup, verify criticality
and absent control data, reject unsupported controls without fallback/user bind,
and retain malformed/ambiguous/unexpected-reference rejection. PostgreSQL/HTTP
checks prove unsupported controls and unexpected references cannot issue sessions
or extend stale approval, including requests through a second application process.
All automated fixtures use synthetic accounts/certificates/data, never company AD.

Both production builds, standalone TypeScript checks and zero-warning lint gates
pass. Actual named local checks passed with suitable child-process/socket permissions:

- Staff default: **104/104**.
- QR default: **4/4**.
- Complete PostgreSQL/HTTP/backup: **143/143**.
- Chromium: **55/55**.
- Total: **306**, zero failures/canceled/skipped checks. The focused 15-check AD
  subset is included in the staff total, not counted again.

Private PostgreSQL cleanup returned **0** remaining fixture databases/roles; the
socket-only test cluster was stopped after verification.
Updated AGENTS, development/authentication runbooks, TODO and this journal; no
documentation-only PR. The original checkout's unrelated auth comment remains.

### Next priority

After owner review/merge, prepare the intended protected application database and
configuration, then explicitly link the reviewed directory GUID to the correct
application user ID. A successful reader search alone grants no application role;
the mapping is what connects AD identity to retained app ownership/permissions.
Verify an actual personal-password login, another working recovery administrator,
session revocation and real account policies in a controlled HTTPS preview before
internet access. Approved hostnames/trusted ingress, production supervision,
scheduled off-server backups and real data/device acceptance remain rollout work.

### Publication and hosted validation

Committed implementation `2db20b1`, pushed `Dev/ad-domain-scope` and opened
[PR #35](https://github.com/tanmar-org/AssetTrackerProDTV/pull/35) targeting main.
Attached the PR to this task. This bundled follow-up records its reference; the
final-head hosted run and exact evidence are recorded in the PR description after
verification. Do not use an earlier head's result to approve the latest change.
Owner alone reviews/merges; no main push, auto-merge or deployment occurred.

## 2026-10-06 — Private first-login preview after owner merge (America/Chicago)

Owner merged PR #35 at `00b9b3feb14faaebda77398c9d89fbe44e77b81a` at 17:04 CDT.
Fetched main and created `Dev/ad-login-preview`, preserving the original checkout's
unrelated comment edit. The final prior PR head `c9429c6` passed all 306 named
hosted checks in [run 37537506761](https://github.com/tanmar-org/AssetTrackerProDTV/actions/runs/37537506761),
with no failed/canceled/skipped checks and zero remaining database/role fixtures.
The merge's [main run 37538251508](https://github.com/tanmar-org/AssetTrackerProDTV/actions/runs/37538251508)
also reports success; detailed counts above are from the inspected final PR log.

### Isolated preview and explicit identity ownership

The next task announced before merge was database configuration, explicit reviewed
administrator linking and an owner password sign-in. Prepared an empty, isolated
login preview; no existing application service/database was running. Requested
whether original operational records/users need eventual import. Preview setup
does not depend on that answer and does not retrieve source exports or replace
existing ownership. Later production linking must target the intended preserved
application IDs, rather than copying this preview administrator into an import.

Private preparation is under
`/home/itadmin/.local/share/assettracker-private/ad-login-preview/` (mode 0700),
with a separate detached checkout/build of exact owner-merged `00b9b3f`. Installed
both existing lockfiles without advisory submission and built both apps before
loading reader credentials. The development checkout can now change/rebuild
without disrupting the owner's preview. No tracked application code, dependency,
migration or public-label configuration was modified.

Initialized a separate PostgreSQL 18.6 cluster in that protected directory, not
the disposable regression cluster or a production service. Mandatory SCRAM applies
to its private mode-0700 Unix socket, port 55434, with no TCP listener. Generated
fresh passwords privately; the initialization passfile was removed after use.
Separate migration-owner and restricted runtime roles/database for each app use
the merged checksummed migrations and explicit supported-table grants. Runtime
checks confirm no superuser/create-role/create-database/replication/bypass-RLS,
schema CREATE, migration-history read, table ownership or cross-database CONNECT.
psql's interactive password command encrypts role passwords client-side while
receiving generated values through private stdin; no secret argv or SQL files.
See [PostgreSQL password authentication](https://www.postgresql.org/docs/18/auth-password.html)
for SCRAM and the operator password commands.

Rechecked the previously reviewed nominated identity by GUID through verified
LDAPS. Created only the new preview administrator, with no chosen PIN, and called
the existing explicit operator-linking helper using its new application ID and
the approved directory/GUID. Saved actual identity IDs privately, outside Git.
No AD account/password writes, name-based automatic linking or personal-password
verification occurred. Owner/operator configuration remains separate from web
process environment; each web process receives only its own restricted DB URL.
All preview processes use the operator's Unix user; production OS service-user
separation remains HOST-04, not an assurance provided by this preview.

### Runtime and acceptance evidence

Started transient user processes `assettracker-ad-preview-staff.service` and
`assettracker-ad-preview-requests.service`, bound to `127.0.0.1:5573` and
`127.0.0.1:5574`. They are temporary preview processes, not boot-enabled production
units. No firewall, public proxy, DNS, public port or existing production service
changed. Credentials and logs are protected outside the Git/web roots; stop/restart
instructions and the owner's actual SSH target are in the private preview README.

Read-only runtime checks pass: both readiness endpoints 200; the actual root
redirect/static staff page 200; unauthenticated inventory and user APIs 401;
auth status reports provisioned AD mode with no session; public setup action 403.
Initial probes used a nonexistent directory-index URL and wrong action name;
corrected probes use the merged entry redirect and actual setup action. Those
probe errors were not runtime defects and no application changes were needed.

Actual Chromium read-only inspection shows AD Password, enabled sign-in, empty
credential fields and an inert/locked workspace. A separate synthetic localhost
server verifies HttpOnly/Secure/SameSite-Strict cookie round-trip without weakening
the app cookie; see [localhost cookie handling](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).
External browser requests were blocked; no AD password submitted
or application session created. An initial label assertion used incorrect casing;
corrected it to the application's existing AD Password label before it passed.
These are preview acceptance checks, not a new full regression run. Both prior
306-check results remain historical evidence; no source changes require repeating
that suite. The protected preview checkout remains Git-clean.
Final private database evidence confirms one correctly linked active admin, zero
application sessions, zero inventory state rows and zero requests. Private file
modes and repository-diff checks found no leaked identifiers/credentials. Preview
remains running for the owner's sign-in; these notes are local and will be bundled
with the next substantive change, as requested.

### Next action and limits

Owner opens an encrypted SSH tunnel from their PC and loads the localhost preview
in Chrome/Edge, then signs in with the nominated AD username and normal domain
password. Readiness 200 alone does not prove that password or AD logon policies.
Once the owner verifies login, inspect resulting app role/session/logout behavior
without logging bearer tokens/passwords. Real policy/replication/disable/reset/outage
acceptance and another working recovery admin remain open. Internet cutover still
needs approved HTTPS hostnames, trusted ingress, production service supervision,
scheduled off-server backups and existing data/label/device reconciliation. Keep
this empty preview separate from production; bundle these operational notes with
the next substantive PR rather than opening a minor documentation PR.

## 2026-10-06 — Owner first AD login verified (America/Chicago)

Owner reports signing in successfully from their Mac. Read-only SQL acceptance
confirms one unexpired AD session linked to the explicitly reviewed preview user,
matching directory/GUID, active application administrator role, recorded last
login, and populated provider-specific configuration/password-version metadata.
The session was created at 17:36:35 CDT. Its directory approval was subsequently
refreshed at 17:37:35 CDT, proving a successful real directory-status recheck after
login rather than relying solely on the initial cached approval. Both preview
readiness endpoints still return 200. No password, bearer token, token hash or
actual identity ID was read into tool output; protected evidence remains outside Git.

Updated private owner-login evidence, the private preview README, TODO, current
handoff and authentication runbook. This confirms one actual password sign-in and
later normal directory recheck; it does not validate policy changes, logout,
recovery admins or production readiness. Requested owner sign-out and sign-in once
to verify browser/session lifecycle without forcibly ending their current session
or requesting their password. That result is pending. No application code change,
full regression rerun, minor documentation PR or internet deployment performed.

Next verify sign-out/relogin, then prepare approved staff/QR HTTPS hostnames,
production service isolation and protected configuration. HTTPS/trusted ingress
must replace the temporary SSH-only access before internet use. Preserve the empty
preview separately from any eventual original-data import; existing-user identity
and draft ownership require linking reviewed production IDs in place.

### Owner sign-out and second sign-in

Owner subsequently confirms both sign-out and sign-in worked. Read-only SQL
matches that report: the original session row identified by its known creation
time is absent; exactly one later unexpired AD session exists, created at
17:38:25 CDT, with the same reviewed identity link, populated AD session metadata
and active administrator role. Saved private lifecycle evidence without reading
tokens, token hashes or passwords, and marked AUTH-01-SESSION-ACCEPTANCE complete.
This does not establish disabled/reset/expiry/replication/outage policy behavior.

Requested the intended public staff and customer QR hostnames for the next
deployment preparation. Proper HTTPS/trusted ingress lets authorized users reach
the intended URLs without SSH while protecting sign-in and enforcing authenticated
client-IP limits. Hostnames remain pending; no DNS, certificates, reverse proxy,
internet listeners, production services or databases were configured. A second
working recovery admin, original-data decision and scheduled off-server backups
remain separate prerequisites. Operational docs stay bundled on the Dev branch.

## 2026-10-06 — Approved public names and existing-proxy preflight (America/Chicago)

Owner selected distinct public staff and customer QR hostnames, then confirmed
an existing reverse proxy sits in front of this VM. Renamed the current unpushed
Dev branch to `Dev/https-ingress-preparation`, preserving all bundled preview and
acceptance notes. Fetched main; it remains `00b9b3f`. The approved hostnames and
infrastructure plan are recorded privately outside Git.

Bounded system DNS queries cannot resolve either name. Separate public DNS-over-
HTTPS A and AAAA queries return NXDOMAIN for both, with the domain's Cloudflare
authority; its NS records identify Cloudflare nameservers. This is a read-only
DNS observation, not a DNS change or proof of a public IP/firewall route. Existing
VM listeners remain SSH and the two private loopback previews; neither Nginx,
Caddy nor Certbot is installed. No scan of the owner's proxy was attempted.

Requested proxy software, its private connection/source address and whether it
already manages HTTPS certificates. These determine the certificate location,
private proxy-to-VM path and client-IP trust contract; do not infer them from
Cloudflare DNS or blindly trust supplied forwarded headers. The existing proxy
must overwrite the staff/QR authenticated source-IP headers, while Node ports,
database and private app-to-app endpoints remain restricted. Prepare against
the owner's existing proxy rather than installing a competing public ingress.

No DNS records, certificates, secret values, proxy configuration, firewall rules,
public listener, application code, preview runtime or production service changed.
No minor documentation PR. Once the missing proxy details arrive, make the exact
configuration reviewable and validate routing/header behavior with synthetic
fixtures before activation. DNS must target the intended public proxy entry point;
TLS, private backend trust/access and public QR label destination must agree.

## 2026-10-06 — Existing NPM ingress preparation (America/Chicago)

Owner confirms Nginx Proxy Manager and an existing wildcard certificate, and
asks to proceed without requiring its private source IP. Source filtering is an
optional additional restriction; every backend route still requires its distinct
ingress credential over verified TLS. No assumption that internal HTTP protects
AD passwords or that a supplied forwarded header identifies the real visitor.

Added commented Nginx templates for both NPM hosts and a private VM TLS gateway,
an operator preparer, protected-file/config-injection checks and actual two-hop
Nginx/TLS regression fixtures. Node stays loopback-only. Both hops block staff
asset lookup and QR staff methods/private APIs; only public lookup/POST submission
are exposed. 8-KiB QR bodies and the staff recovery envelope are preserved. No
write retries or response cache. Query-bearing access logs are disabled for these
hosts; error logs still require protection. A reviewed original-peer policy avoids
NPM inherited private/CDN real-IP-header trust. DNS-only is the initial topology;
an additional CDN requires an explicitly validated trust chain to avoid shared
visitor budgets. An optional source rule also checks the original socket peer.

The preparer validates names/private IPv4/ports/paths, rejects directive injection,
unknown fields, real Git worktrees, symlink/readable inputs and existing output.
It writes eight mode-0600 files in a new mode-0700 directory, generates separate
256-bit secrets, prints neither and supplies only a public QR URL in browser
config. It never activates anything. Owner-specific review files were successfully
staged in the protected operator area. Backend certificate/key paths are staged
placeholders; no leaf/key/CA bundle was installed and no preview setting changed.
Initial sandbox root .git reservations exposed an overbroad staging guard; empty
non-repository reservations are ignored while actual Git HEAD/worktree pointers
still fail closed. Tests exercise the real alternate-worktree rejection.

Downloaded Ubuntu Nginx 1.28.3-2ubuntu1.11, verified signed repository SHA-256
metadata, and extracted a user-local test binary/wrapper. No system installation
or service. Added CI test-only Nginx/OpenSSL installation with package-service
startup blocked, followed by real loopback-only ingress checks. Added the HTTPS
runbook and updated setup/auth/public-request/development/CI/TODO handoffs; prior
owner login/logout evidence is bundled, not a separate documentation PR.

Local verification: zero-warning root lint/vendor check and actionlint/diff checks
pass. Full default staff suite passes 108 named checks (four new staging checks);
real proxy suite passes 10, with zero failures/cancellations/skips. Actual sockets
verify forged headers under inherited real-IP rules, both-hop route denial, QR
creation/lookup, QR ceiling/large staff body, untrusted backend TLS/wrong name,
source-rule forgery rejection and empty access logs. No company AD, production DB,
certificate or existing proxy was used for those regressions.

Opened [PR #36](https://github.com/tanmar-org/AssetTrackerProDTV/pull/36) from
`Dev/https-ingress-preparation` for owner review/merge. Hosted validation is
pending at this commit; inspect the final head before merging. Final hosted
evidence will be saved privately and reported in the handoff, then bundled into
the next substantive journal update rather than creating a documentation-only PR.

Next install/supervise the reviewed production services with matching protected
settings, provide the backend certificate and configure the two actual NPM hosts.
Both selected DNS names still require records pointing to the proxy public entry
point. Those steps make the approved URLs reachable; real HTTPS/AD/GPS acceptance,
recovery admins, original-data/old-label reconciliation and off-server backups
remain deployment prerequisites. No DNS/firewall/public listener, live database,
existing NPM or private preview service was changed during preparation.
