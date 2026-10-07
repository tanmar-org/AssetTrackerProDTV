# Project TODO

Use stable IDs in journal entries and PR descriptions. Checked items are completed;
unchecked items are unresolved. Recommendations remain proposals unless an owner
decision is recorded explicitly. The owner reviews and merges all changes from
`Dev/` branches.

## Implementation order and why

1. **Prepare internet staff authentication (AUTH-01).** Owner confirmed AD-only
   infrastructure, private VM-to-AD connectivity and password-only sign-in with
   no MFA. Owner merged shared login traffic protection in PR #33 at `1650417`.
   Private, certificate-validated LDAPS authentication and explicit stable identity
   linking are implemented in [PR #34](https://github.com/tanmar-org/AssetTrackerProDTV/pull/34)
   merged by the owner at `b2c63a9`. Real TLS/reader/one reviewed identity now pass
   owner-authorized read-only checks. Domain-root continuation references exposed
   a compatibility issue, corrected in owner-merged PR #35 at `00b9b3f`.
   An empty private preview now has separate restricted PostgreSQL databases and
   an explicit reviewed administrator GUID link. Owner normal-password sign-in
   succeeds with active admin access and a later real directory-status recheck.
   Owner sign-out/relogin also pass, with the original session removed and a fresh
   AD session retaining admin access. Owner merged HTTPS ingress preparation in
   PR #36 at `b67f962` and service preparation in PR #37 at `90de7e5`. Next finish
   production Docker configuration, backend certificate trust and launch-data
   decisions, then recovery-admin and real policy acceptance. Guarded fresh
   database setup is merged in PR #38 and Docker packaging in PR #39.
   Owner selected both public names and confirmed an existing reverse proxy;
   public DNS is unresolved. Nginx Proxy Manager and an existing wildcard certificate
   are confirmed; source-IP restriction is optional per owner direction. Protected
   ingress preparation and real synthetic proxy validation are complete; deployment
   configuration and acceptance remain pending. Production service preparation is
   merged in PR #37; final-head hosted run 37547589869 passed 334 checks
   with zero failures/skips and zero remaining fixtures.
   Preserve existing app roles, recovery ownership and shared-device sign-out.
   Internet staff access is not enabled; public customer QR access remains separate.
2. **Retain automated validation (QA-01-CI).** Owner merged PR #32 at `396be11`.
   Both full hosted runs passed 250 checks plus builds/types/lint. Keep the same
   complete checks for authentication changes; required branch rules remain an
   owner setting.
3. **Prepare remaining deployment decisions and acceptance.** Set
   approved email delivery, HTTPS/domains, service supervision and recovery
   operations; reconcile real records and old labels, then test actual devices.
   Scheduled encrypted off-server backups/retention/alerts remain DATA-03-ROLLOUT.

Automated-check review, company access decisions, approved email delivery, HTTPS/domains,
service supervision, old-label continuity and actual device acceptance remain
release requirements. The order above is implementation planning, not deployment
approval; unresolved owner/operational items remain listed below.

## Development foundation — first PR

- [x] UI-01 — Use the owner's "Saved" wording for inventory save status.
  Status/footer/Settings now use Loading, Saving, Saved and Save unavailable;
  related import, recovery and activity wording no longer calls inventory storage
  "cloud". Implemented on `Dev/saved-status`; JavaScript asset version 69 avoids
  stale script caching. Save/revision/session logic is unchanged. Lint and existing
  save/import/shared-device checks pass. Owner merged
  [PR #42](https://github.com/tanmar-org/AssetTrackerProDTV/pull/42) at `81f7c1a`;
  both hosted validation jobs passed. Owner deployed the reviewed staff image;
  its receipt and independent HTTPS checks confirm exact new static files,
  healthy staff/QR responses and private-route denial. Live rollout is complete.

- [x] DOC-01 — Add agent instructions with `Dev/` branches, agent pushes/PRs,
  owner-only final review/merging, human-review comments, and documentation upkeep.
- [x] DOC-02 — Record architecture, service dependencies, source review, and
  dependency evidence in the project journal and this prioritized list.
- [x] TOOL-01 — Install checksum-verified user-local Node LTS/npm and GitHub CLI.
- [x] TOOL-02 — Install both applications from their existing lockfiles; document
  versions, setup commands, and authentication limitations.
- [x] DOC-03 — Add explanatory comments to reviewed authentication, persistence,
  QR/email, and frontend flows without changing executable behavior.
- [x] QA-00 — Run baseline builds/tests and relevant static checks. Record failures
  and limitations honestly rather than silently fixing unrelated application code.
- [x] PR-01 — Commit and push `Dev/project-foundation`; open a PR against `main`.
  Branch is committed and pushed with explicit owner approval of public publication.
  [PR #3](https://github.com/tanmar-org/AssetTrackerProDTV/pull/3) was merged by the owner.
- [x] OWNER-01 — Owner performs final review and merges the foundation PR.

## Before public deployment — security and dependency blockers

- [ ] VIS-01 **Owner action** — Make repository visibility match the stated private
  intent. GitHub reported public visibility on 2026-10-05. Confirm the desired
  setting explicitly before changing repository access. The owner separately
  approved publishing this foundation PR publicly; that does not change visibility.
- [ ] SEC-01 **Credential owner + development** — Remove the account-password
  value from public JavaScript and coordinate rotation if real. Do not copy the
  value into docs, issues, logs, fixtures, or PR descriptions. Verify the public
  bundle and approved service-request workflow no longer expose it.
  Browser/draft removal and regression coverage passed on
  `Dev/remove-public-account-password` in
  [PR #4](https://github.com/tanmar-org/AssetTrackerProDTV/pull/4);
  credential validity/rotation awaits owner
  confirmation. Removal alone does not erase historical exposure.
- [x] SEC-01-CODE — Remove the embedded credential from the browser/email template;
  preserve receiver details and pass source, generated-draft, and built-asset checks.
- [ ] SEC-01-OWNER — Owner confirms whether the exposed credential was real and
  rotates it if necessary. Confirm an approved provider-authentication channel
  rather than adding credentials back into public code or email drafts.
- [ ] DEP-01 — Remediate locked dependency advisory matches in both apps together.
  Review production reachability, pin compatible patched versions, regenerate
  lockfiles intentionally, and pass builds and meaningful regression checks.
  Baseline: 18 package names, 74 unique advisories; see the dated review artifact.
  Owner merged [PR #2](https://github.com/tanmar-org/AssetTrackerProDTV/pull/2),
  upgrading the QR service's Next.js to 16.3.8; later owner merges also repaired
  framework/tool transitive packages. npm reports zero production findings for
  both apps; source-map-js is patched on main and GitHub reports alert 162 fixed.
  One underlying unpatched development-only
  braces advisory remains as five affected chain packages per full audit. See
  [current evidence and scope](docs/DEPENDENCY-REMEDIATION.md); DEP-01 remains open.
- [x] DEP-01-PRODUCTION — Reconcile known runtime advisory sources and install
  patched lockfiles. Both lockfiles/installs now use source-map-js@1.2.2 and
  production npm scans report zero. GitHub main alert 162 is fixed;
  scanner results exclude vendor assets/application flaws and need regular rechecks.
- [x] DEP-01-SOURCE-MAP — Correct the QR runtime source-map-js@1.2.1 alert
  [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
  Updated only QR's transitive entry to compatible patched 1.2.2; tracker already
  pins it. Both apps check malformed/nested offsets, bounded sparse-map conversion,
  and valid PostCSS mapping. Implemented on `Dev/qr-source-map-security` in
  [PR #25](https://github.com/tanmar-org/AssetTrackerProDTV/pull/25), merged by the owner.
  PostCSS consumes maps for CSS processing; application request/import code does
  not pass submitted records into it. HTTP exploitability is not established.
- [x] DEP-01-SOURCE-MAP-MERGE — Owner merged PR #25 at `9710f13`; GitHub
  reports alert 162 fixed at 2026-10-06 01:19:36 UTC. No manual dismissal.
- [x] DEP-01-QR-BRACES-EXPANSION — Update the QR lint tree's brace-expansion to
  compatible 1.1.21/5.0.12; tracker already has them. Installs/builds/checks pass.
- [ ] DEP-01-DEVELOPMENT — Resolve the unpatched braces@3.0.3 chain when an
  appropriate patch/replacement is available. It handles ESLint developer root-dir
  glob configuration, with no HTTP/file-import path identified in this application.
  Do not force an incompatible framework/lint downgrade or suppress the advisory.
- [x] DEP-02 — Replace CDN-loaded SheetJS 0.18.5 with verified local full 0.20.3,
  retained Apache license/provenance, digest regression and page SRI. Parsing uses
  a local browser worker with file/time/ZIP/worksheet/cell limits. XLSX/XLS/CSV,
  leading-zero/formatted identifiers, Master/West Texas/account/audit mappings,
  malformed inputs and actual browser upload previews pass with outside requests
  blocked. Implemented on `Dev/dependency-remediation` in
  [PR #21](https://github.com/tanmar-org/AssetTrackerProDTV/pull/21), merged by
  the owner.
  See [dependency/import limits](docs/DEPENDENCY-REMEDIATION.md).
- [x] SEC-02 — Replace public first-admin setup with controlled provisioning.
  Admin creation must be atomic and unavailable to unauthenticated users after
  provisioning; test fresh DB, concurrent requests, and already-initialized DB.
  Implemented on `Dev/controlled-admin-provisioning`: HTTP setup always returns
  403; the local operator command inserts only into an empty user table. Build and
  all 14 tests passed, plus fresh/repeated local D1 CLI checks.
  [PR #6](https://github.com/tanmar-org/AssetTrackerProDTV/pull/6) was merged by the owner.
  The PostgreSQL operator adapter is now ported under HOST-02; HTTP bootstrap stays closed.
- [x] SEC-03 — Enforce explicit server permissions and record schemas. Include
  rental stock, bulk edits, restore/clear operations, assignment uniqueness, account
  capacity, and identifier/link validation. Client action labels must not grant
  authority; test regular-user bypass attempts and permitted edits.
  Implemented on `Dev/inventory-permissions`: admin-only replacements/recovery/
  deletion; ordinary PATCH checks actual account/receiver/service/stock changes.
  Typed/bounded records, stock links/counts, unique assignments, 20-receiver capacity,
  and safe identifiers/Maps URLs are enforced on reads/saves/recovery. See
  [the implemented permission policy](docs/INVENTORY-PERMISSIONS.md).
  [PR #19](https://github.com/tanmar-org/AssetTrackerProDTV/pull/19) was merged by
  the owner; initial import requires reconciled data under MIG-01.
- [x] SEC-04 — Safely render the legacy static service form while preserving old
  label URLs. URL details use fixed DOM elements/textContent; staff cached/API IDs,
  status/history attributes, and audit counts are escaped. Maps anchors require
  bounded HTTPS Google Maps URLs; QR destinations reject executable/credential URLs.
  Five unit regressions and four Chromium scenarios plus their parent passed,
  covering legacy, React QR, and staff pages. Implemented on
  `Dev/safe-service-rendering` in
  [PR #20](https://github.com/tanmar-org/AssetTrackerProDTV/pull/20), merged by
  the owner. Its legacy mail-only/private-query limitations were
  subsequently corrected under SEC-05/QR-01-METADATA; automatic delivery remains
  MAIL-01.
- [x] SEC-05 — Public request POST rejects private/unknown metadata and enforces
  streamed 8-KiB JSON, text/GPS/time bounds, authenticated current-asset lookup,
  database-shared global/receiver/client rate budgets, and atomic pending uniqueness
  including status reopens/renames. Direct staff mutations are bounded too.
  Implemented on `Dev/public-request-security` in
  [PR #23](https://github.com/tanmar-org/AssetTrackerProDTV/pull/23); see
  [policy/migration/ingress requirements](docs/PUBLIC-REQUEST-SECURITY.md).
  Configure trusted production ingress and reconcile any historical duplicates/bad
  GPS before migration; these controls do not prove identity/ownership/location.
- [ ] AUTH-01 — Implement internet staff sign-in with on-premises AD. Owner
  confirmed no existing AD FS/Entra/SSO, private AD reachability, and no MFA on
  2026-10-06. Use direct private LDAPS with certificate/hostname verification;
  retain app-managed access/admin roles, stable user IDs/recovery ownership,
  revocation and shared-device sign-out (DATA-04). Implementation alone does not
  authorize production configuration; owner-directed read-only acceptance is below.
- [x] AUTH-01-ACCESS — Owner chose internet access for staff, with on-premises AD.
  This records the access requirement; no live access or authentication was changed.
- [x] AUTH-01-POLICY — Owner answered no existing identity service, yes private
  VM-to-AD connectivity, no MFA and explicitly requested no MFA. Use AD
  username/password for the planned integration. Earlier broker/MFA suggestions
  are superseded; do not add a broker or MFA requirement without an owner change.
- [x] AUTH-01-INTEGRATION — Implement opt-in private LDAPS credential verification,
  password UI and explicit operator directory/objectGUID links to existing users.
  Mandatory CA/hostname validation, structured binary filters, five-second I/O,
  disabled/locked/expired/must-change checks, shared 60-second approval cache and
  credential/configuration-specific revocation preserve app IDs/roles/drafts.
  Browser roles/activation remain app-managed; AD credentials/unlocks/linking do
  not pass through user management. AD mode has no PIN fallback or automatic
  username/email linking. Migration 0007/readiness, complete backup metadata and
  recovery runbooks included on `Dev/ad-password-signin` in
  [PR #34](https://github.com/tanmar-org/AssetTrackerProDTV/pull/34). Implementation is tested
  against synthetic TLS/LDAP/SQL/Chromium only. Owner merged PR #34 at `b2c63a9`;
  final hosted run 37528356444 passed all 303 checks and both builds/types/lint.
- [ ] AUTH-01-ONBOARDING — Include explicit AD identity review in Settings user
  creation and existing-account linking, so administrators do not need a VM command
  for each employee. Implemented on `Dev/ad-user-onboarding` in
  [PR #43](https://github.com/tanmar-org/AssetTrackerProDTV/pull/43): exact read-only LDAPS
  lookup, display-name/username review, five-minute session/config/target-bound
  proof and fresh GUID check; account/link/audit writes are atomic. Existing
  records/permissions are preserved; initial bootstrap and replacements remain
  operator-only. Owner merged PR #43 at `148b623`; both final-head hosted jobs
  passed. Owner activated the staff-only Docker update; its receipt and independent
  HTTPS checks verify exact reviewed assets. Existing-user linking exposed a
  confusing shared creation form/default permission; AUTH-01-LINK-UI addresses
  that feedback. Completion requires the nominated user's link/sign-in acceptance.
- [ ] AUTH-01-LINK-UI — Make the existing-user Link AD account row action open a
  separate confirmation dialog, immediately find the saved AD username and clearly
  show the preserved permission/access. Never put an existing administrator into
  the creation form with a Regular User default. Implemented on `Dev/ad-link-dialog`
  in [PR #44](https://github.com/tanmar-org/AssetTrackerProDTV/pull/44); local checks
  pass. Owner merge/rollout acceptance remains. The server's
  reviewed identity proof/authorization and linking API remain unchanged.
- [x] AUTH-01-DOMAIN-SCOPE — Require critical AD DOMAIN_SCOPE on every identity/status
  search, preventing normal domain-root partition references without following
  referrals or relaxing rejection of unexpected references/unsupported controls.
  Implemented on `Dev/ad-domain-scope` in
  [PR #35](https://github.com/tanmar-org/AssetTrackerProDTV/pull/35), merged by the
  owner at `00b9b3f`. Final hosted run 37537506761 passed all 306 checks. Synthetic
  wire and HTTP/cache regressions accompany separate successful read-only real
  reader/GUID acceptance. No directory write or user-password login in that task.
- [x] AUTH-01-PREVIEW — Prepare an isolated empty preview of exact owner-merged main:
  socket-only authenticated PostgreSQL, separate owner/runtime roles and reviewed
  administrator GUID link; both Node listeners remain loopback-only for SSH access.
  Builds, effective role restrictions, readiness, locked AD UI and synthetic
  localhost Secure-cookie handling pass. Settings/identity/logs are private outside
  Git. Owner personal-password login now passes below; no internet/production cutover.
- [x] AUTH-01-FIRST-LOGIN — Owner signed in using their normal AD password. Read-only
  preview evidence confirms one active AD session, the reviewed identity link,
  active app administrator role and a successful later directory-status recheck.
  No password, bearer token or token hash was read/logged for acceptance.
- [x] AUTH-01-SESSION-ACCEPTANCE — Owner confirms sign-out and sign-in worked.
  Read-only SQL confirms the original session row is gone, exactly one later
  unexpired AD session exists and the reviewed identity/active admin role remain.
  Real policy changes, recovery admins and internet cutover remain rollout work.
- [ ] AUTH-01-ROLLOUT — Operator approves/configures actual private LDAPS endpoint,
  scope, trusted CA, restricted reader and required attribute permissions. Migrate,
  map reviewed GUIDs to existing app IDs, verify working linked recovery admins,
  validate real lockout/expiry/reset/disablement/outage/replication behavior and
  preserved roles/draft ownership. Configure trusted HTTPS ingress and block direct
  backend access before internet cutover. Do not paste reader/user passwords into
  chat or commit them. Preview setup is complete; production configuration/cutover
  is separate and remains unperformed.
  Follow [the AD setup and acceptance runbook](docs/STAFF-AUTHENTICATION.md).
  Owner supplied the target directory and nominated the initial administrator.
  Owner-exported public CA now passes strict controller chain/hostname verification
  from both OpenSSL and Node (TLS 1.3); it is saved outside Git. Reader creation
  was shown in a screenshot; owner entered its password privately. The owner's
  retry now passes reader bind and domain-base verification. One eligible nominated
  account plus three partition references exposed the domain-scope bug above;
  the corrected production adapter successfully rereads that account by GUID with
  all required attributes. The empty private preview now has an explicit reviewed
  administrator link and successful owner personal-password login with a later
  directory-status recheck. Owner sign-out/relogin now pass with old-session removal
  and a fresh AD session. Real policy changes, intended production mappings and
  working recovery admins remain unverified. Staff/QR HTTPS hostnames are approved;
  Nginx Proxy Manager and its existing wildcard are confirmed. Public DNS is
  unresolved; source-IP filtering is optional per owner direction. No public ingress
  was configured. Actual
  infrastructure/account identifiers are kept in protected VM notes outside Git.
- [x] AUTH-01-TRAFFIC — PostgreSQL counters limit eligible sign-ins before account
  lookup/PIN hashing/directory work: 300 global, 60 authenticated client, 30 canonical username
  per fixed 60-second window across processes. Return noncacheable 429/Retry-After;
  missing counter schema or configured ingress fails closed. Unknown accounts,
  success, incorrect credentials and account-read failures consume reservations.
  Tracker migration 0006, runtime/backup grants and production trusted ingress
  are required before rollout. Implemented on `Dev/ad-authentication` in
  [PR #33](https://github.com/tanmar-org/AssetTrackerProDTV/pull/33), merged by the
  owner at `1650417`; 269 local and hosted checks pass, including final hosted run
  37522346339. See [staff login policy](docs/STAFF-AUTHENTICATION.md). This does not enable AD or
  establish internet deployment readiness.
- [x] AUTH-01-ACCOUNTS — Account updates, session revocation, and audit writes commit
  together. PIN resets, role changes, and activation changes revoke all target
  sessions. Recheck administrator access inside the serialized mutation; retain at
  least one active admin under concurrent demotions. Implemented/tested on
  `Dev/account-security` in
  [PR #17](https://github.com/tanmar-org/AssetTrackerProDTV/pull/17), merged by the owner.
- [x] AUTH-01-LOCKOUT — Serialize login attempts with a PostgreSQL row lock through
  session issuance. Five concurrent failures trigger the existing 15-minute
  lockout; login/reset races cannot leave an old-PIN session valid. Bound access
  JSON to 4 KiB and reject malformed input/cookies; prune expired account sessions.
- [x] AUTH-01-CONSTRAINTS — Add tracker migration `0002_access_constraints.sql`
  for hash/salt/token format and failure counters, plus a session-user index.
  Existing-row migration and rollback tests pass. Incompatible imports require
  explicit reconciliation, not automatic credential rewrites.

## Data preservation and correctness

- [ ] DATA-01 — Preserve pending edits on revision conflicts and provide explicit
  conflict resolution. Implemented server-confirmed recovery below; fully offline
  drafts still require an export before tab closure. Automatic offline replay and
  larger/multiple-operation guided reconciliation remain future work.
- [x] DATA-01-REJECTION — Ordinary edits queue separately using acknowledged
  revisions. Validation/permission/conflict failures pause retry/polling and retain
  the local draft for snapshot export/manual reconciliation. Queue order remains
  in memory (32-operation limit). Fully offline edits remain tab-only; conflict
  review/server-confirmed copies are implemented below. Browser regressions pass.
- [x] DATA-01-REVIEW — Add explicit original/draft/shared comparison and choices;
  preserve unedited shared fields, require refreshed revision/version, enforce
  existing ordinary permissions, and commit state/history/audit/copy closure
  atomically. Export full comparisons; reject partial reviews above 200 choices.
  Implemented on `Dev/inventory-conflict-recovery` in
  [PR #26](https://github.com/tanmar-org/AssetTrackerProDTV/pull/26),
  merged by the owner at `0f7ab73`.
- [x] DATA-01-COPIES — Paused edits attempt owner-only PostgreSQL copies (five
  active, 20 retained IDs, seven-day expiry). Copy CAS, closed-ID tombstones,
  lost-acknowledgement handling, reload listing, discard and session cleanup are
  covered. Failed/unconfirmed copies explicitly require an exported snapshot.
  No device-wide operational cache or automatic replay is introduced. See
  [recovery policy](docs/DRAFT-RECOVERY.md).
- [ ] DATA-01-OFFLINE — Decide whether full offline recovery is needed beyond
  exported snapshots; any durable device storage requires a reviewed shared-device
  privacy design. Do not imply that server copies can protect disconnected edits.
- [x] DATA-02 — State/history/audit and revision-protected recovery are atomic in
  the tracker; QR transitions use durable intents, immutable versioned receipts,
  server history completion, retries and explicit rent-conflict review. Independent
  processes, lost responses and failed second writes are covered. Eventual
  consistency still requires available services and conflict resolution. See
  [QR operations](docs/QR-OPERATIONS.md); reconciler deployment remains HOST-04.
- [x] DATA-02-TRACKER — PostgreSQL state/history/audit writes share one transaction;
  recovery uses expected revisions and the same lock. Concurrent save/restore,
  zero-row update, and audit-failure rollback tests pass. Coordination with the
  separate QR database is implemented under DATA-02-QR.
- [x] DATA-02-QR — Save intent before QR mutation; retain actor/approver/stable
  receiver association, request CAS and replayable receipts. Finish inventory,
  history, derived stock, audit and done state together. Provide staff queue,
  safe Retry/history-only review and `service:reconcile` CLI/watch. Restore pauses
  unfinished actions for administrator approval; both proof tables are backed up.
  Legacy direct QR mutations are closed; compatible apps/UI must ship together.
  Implemented on `Dev/qr-history-coordination` in
  [PR #30](https://github.com/tanmar-org/AssetTrackerProDTV/pull/30), merged by the owner
  at `3123095`.
- [ ] DATA-03 — Complete backups and operational recovery for both apps. Operator
  tooling and isolated restoration are implemented below; production scheduling,
  off-server storage and operator acceptance remain open. Inventory exports are
  not complete database backups. See [the recovery runbook](docs/DATABASE-BACKUPS.md).
- [x] DATA-03-TOOLS — Create private paired PostgreSQL archives and matching snapshot
  evidence. Restore only into new empty owner-selected `assettracker_restore_*`
  databases, check both schemas/records, revoke old sessions and grant restricted
  runtime access. Source databases are not modified; no web endpoint runs backups.
  Implemented on `Dev/postgresql-backup-restore` in
  [PR #27](https://github.com/tanmar-org/AssetTrackerProDTV/pull/27),
  merged by the owner at `bafe966`.
- [x] DATA-03-RESTORE-DRILL — Restore synthetic inventory/stock/audit, users, history,
  drafts, requests/GPS and rate counters; verify actual app health/login/read paths
  under restricted runtime roles. Damaged archives, nonempty/live targets, unsafe
  roles/permissions, wrong migrations and failed verification are rejected.
  Continuing source writes retain consistent per-database snapshot evidence.
- [ ] DATA-03-ROLLOUT **Operator + owner** — Approve and configure encrypted off-server
  storage, schedule, retention, private credentials/configuration recovery and
  failure alerts. Perform and time an operator recovery drill before real cutover;
  review restored account changes and separate-database consistency. No production
  job or destination is configured by the implementation PR.
- [x] DATA-03-SNAPSHOT — Browser inventory snapshots and new Undo entries include
  rental stock/audit, and clear resets stock with inventory. Restore/Undo are admin
  actions; older missing collections receive a clearing warning. Export labels
  describe inventory scope accurately. Actual browser-function regressions pass.
- [x] DATA-04 — New inventory/Undo/audit/imports/preferences stay in tab memory;
  startup requires fresh authenticated inventory, with no samples or automatic
  legacy upload. Lock scrubs private DOM, cancels work, and ignores late results.
  Cross-tab changes and server context headers prevent old-tab writes under new
  cookies. Failed sign-out stays locked across reload until acknowledgement.
  Same-owner memory drafts remain paused until export or explicit DATA-01 review;
  legacy records have
  administrator export/removal controls. Implemented on
  `Dev/shared-device-sessions` in
  [PR #24](https://github.com/tanmar-org/AssetTrackerProDTV/pull/24), merged by
  the owner; see [policy](docs/SHARED-DEVICE-SESSIONS.md).
- [ ] DATA-04-ROLLOUT — Export/reconcile/remove older caches on previously used
  devices, deploy server/UI together and reload old tabs/integrations. Confirm
  shared-device acceptance in target browsers. New memory-only drafts do not survive
  reload. Confirmed server copies and explicit review are DATA-01-COPIES/REVIEW.
- [x] DATA-05 — Master/West Texas previews and Apply share row validation, duplicate
  handling and capacity planning. Skipped rows have no side effects; Apply rechecks
  current state. Preserve source metadata, textual IDs and move/assignment history;
  regular account imports apply one receiver under existing server permissions.
  TQ distinguishes changed/unchanged/skipped/ignored rows. All three CSV downloads
  quote fields and protect formula/control/full-width prefixes and numeric text.
  Implemented on `Dev/import-export-correctness` in
  [PR #28](https://github.com/tanmar-org/AssetTrackerProDTV/pull/28);
  merged by the owner at `bc9f0af`.
  See [policy and spreadsheet limits](docs/IMPORTS-AND-EXPORTS.md). Actual desktop
  spreadsheet/device acceptance remains QA-01; reports are not lossless backups.
- [ ] DATA-06 — Retained record browsing is implemented below; audit/history
  retention and full-state storage scaling remain separate open decisions.
- [x] DATA-06-LISTING — Server search/status filters and bounded timestamp/ID pages
  reach older QR requests; administrator activity supports server search/type/date
  filters. Staff Previous/Next controls retain one 100-row page and ignore late
  filter/session results. Tiles/history/CSV explicitly describe their limited scope.
  New ordered indexes preserve all rows; proxy input, redirects and response bytes
  are bounded. Implemented on `Dev/request-activity-pagination` in
  [PR #29](https://github.com/tanmar-org/AssetTrackerProDTV/pull/29), merged by the owner.
  See [record browsing policy](docs/RECORD-LISTS.md).
- [ ] DATA-06-RETENTION **Owner + operator decision** — Decide audit/request/history
  retention, archive access, and legal/business preservation needs. No purge policy
  is enabled; the existing 25 inventory snapshots are not complete audit recovery.
- [ ] DATA-06-SCALE — Measure representative inventory sizes and filtered-list
  performance; plan JSONB/full-state growth and search indexing from actual evidence.
  Bounded responses do not prove bounded database scans or production capacity.

## Hosting, QR, email, and migration

- [x] HOST-01 **Architecture** — Native Next.js/Node for both apps, preserving the
  existing UI; separate locally hosted PostgreSQL databases/runtime roles for staff
  and public QR data. This follows the owner's PostgreSQL preference. Production
  configuration, services, and cutover remain under HOST-03/HOST-04/MIG-01.
- [x] HOST-02 — Port Worker entry/runtime bindings and direct D1 SQL calls to the
  PostgreSQL target. Replace Worker/Sites build validation and static/image serving;
  port the trusted operator provisioning command; run both apps on the VM without
  Cloudflare application/database bindings. Never restore public bootstrap as a shortcut.
  Implemented/tested on `Dev/node-postgresql` in
  [PR #11](https://github.com/tanmar-org/AssetTrackerProDTV/pull/11), merged by the owner.
- [ ] HOST-03 — Configure domains, HTTPS, internal request endpoint, new shared
  credential or replacement auth, public QR destination, CORS, and local fonts.
  Remove localhost/old-host assumptions; verify generated URLs and font assets.
  Native static serving/system fonts and removal of the old Sites CORS allowlist
  are complete. Production domains, HTTPS, secrets, and QR destination remain open.
- [x] HOST-03-NAMES — Owner selected separate public staff and QR hostnames and
  confirmed an existing reverse proxy. Actual names remain in protected VM notes.
  This records decisions only; it does not provision DNS, TLS or internet access.
- [x] HOST-03-INGRESS — Prepare Nginx Proxy Manager/private VM TLS gateway files,
  separate authenticated client-IP credentials, both-hop private-route denial and
  the deployment-only QR HTTPS destination. Owner-specific protected files are
  staged outside Git in [PR #36](https://github.com/tanmar-org/AssetTrackerProDTV/pull/36);
  owner merged it at `b67f962`; final hosted run 37544501862 passed all 320
  checks with zero skips/failures and zero remaining SQL fixtures. Source-IP
  restriction is optional, TLS/secrets mandatory. See [the runbook](docs/HTTPS-INGRESS.md).
- [ ] HOST-03-INGRESS-ROLLOUT — Install the reviewed VM
  leaf/key and trusted issuer bundle, configure actual NPM hosts and private Compose
  services/gateway with matching credentials, set public DNS to the existing proxy entry
  point and complete HTTPS/header/route/phone acceptance during approved deployment.
  Owner installed the protected Docker files and initialized both fresh schemas
  on October 7, 2026. The private gateway is running; independent verified-TLS
  checks return staff/QR 200, missing-hop 403 and private-route 404. Both names
  remain unresolved through the VM resolver. Actual NPM/DNS and browser/phone
  acceptance remain pending.
  Both names subsequently resolve to NPM through the VM resolver, but normal
  forwarding returns 502 while the private apps return 200. Owner requires empty
  Advanced tabs. The standard-proxy implementation accepts no-SNI HTTPS, requires
  the explicit trusted proxy TCP peer and supplies application credentials locally.
  It preserves route/method/body limits and verified AD without NPM files/snippets.
  Owner merged [PR #41](https://github.com/tanmar-org/AssetTrackerProDTV/pull/41)
  at `5414d3f` and activated the gateway-only update; normal NPM HTTPS and route/
  peer checks pass. A fresh read-only browser reaches the staff sign-in page
  without script/resource errors. The owner's Safari cannot resolve the hostname;
  both names remain NXDOMAIN in public DNS while internal VM DNS reaches NPM.
  Public records/client DNS, real AD sign-in and phone acceptance remain pending.
  Owner then confirmed successful corporate DNS wildcard lookup from the Mac and
  the correct NPM host settings. Public NXDOMAIN alone does not explain that
  internal test. Safari and Chrome both fail; awaiting the Mac HTTP/TLS check to
  isolate system lookup/cache, routing/proxy or certificate behavior. Avoid
  changing server topology or declaring a browser-specific cause without evidence.
  Mac curl then failed with resolver code 6; owner confirmed DNS cache/resolver
  refresh restored loading. Corporate wildcard and standard NPM settings work
  internally. Actual production AD sign-in/logout/relogin and phone acceptance
  remain pending; public DNS is separate future internet-client work.
  Owner subsequently confirmed production AD sign-in, sign-out and sign-in again
  on the deployed staff host. Internal loading/session acceptance is complete;
  receiver-specific phone QR and external-client acceptance remain open.
- [x] HOST-04-PREPARE — Supply six reviewed systemd units/timer, distinct non-login
  UIDs, isolated JSON credentials, least-privilege startup checks, worker shutdown
  and private readiness monitoring. Native unit/gateway validation and real
  restricted-PostgreSQL startup/stop tests pass. A transient user-systemd smoke
  also verifies credential delivery and crash restart. See [service setup](docs/PRODUCTION-SERVICES.md).
  Owner merged [PR #37](https://github.com/tanmar-org/AssetTrackerProDTV/pull/37)
  at `90de7e5`; its final-head hosted run 37547589869 passed all 334 checks,
  both builds/types/zero-warning lint and zero remaining synthetic fixtures.
  Production installation, actual UID/sandbox/boot acceptance and alert delivery
  remain HOST-04; no production service or database was installed.
- [x] HOST-04-DATABASE-PREPARE — Guarded fresh paired database preparation,
  role-isolated random credentials, explicit runtime/SELECT-only backup grants,
  checksummed owner migrations, real wrong-password/startup checks and partial
  failure containment. Prepared on `Dev/production-database-provisioning` for
  owner review in [PR #38](https://github.com/tanmar-org/AssetTrackerProDTV/pull/38).
  Owner merged it at `1d1187a`; final hosted run 37549509046 passed all 349
  checks with zero failures/skips and zero remaining SQL fixtures.
  See [database setup](docs/PRODUCTION-DATABASES.md). Staging is
  offline; initialization requires an approved deployment and new target names.
  No production database/import/administrator/service is created by this work.
- [x] HOST-04-DOCKER — Owner chose Docker Compose for portable production,
  superseding native systemd as the deployment plan. Prepare immutable images,
  isolated app/operator credentials, socket-only persistent PostgreSQL, private
  TLS gateway and a verified two-stack move/restore drill, plus isolated recovery
  failure containment. Implemented on `Dev/docker-portable-deployment` in
  [PR #39](https://github.com/tanmar-org/AssetTrackerProDTV/pull/39); see [Docker setup](docs/DOCKER-DEPLOYMENT.md)
  and [datacenter moves](docs/DATACENTER-MOVE.md). Owner merged it at `418469c`;
  final-head `c6b90cd` hosted run 37554932618 passed all 370 regression checks,
  builds/types/zero-warning lint and both SQL/container cleanup gates with zero
  failures/skips. No production activation.
- [x] HOST-04-DOCKER-BUILD — Allow explicit `docker:build -- --sudo` from the
  operator's terminal, elevating only Docker and preserving user-owned private
  image manifests. Verify authorization before creating output. CLI regressions
  cover direct/sudo use, refusal before elevation and failed-build publication;
  the hosted container drill exercises the real sudo path. Implemented on
  `Dev/docker-sudo-release-build`; final hosted evidence is recorded on its PR.
- [x] MIG-01-LAUNCH **Owner decision** — Owner will provide inventory data in a
  spreadsheet for the initial load. The source has now been received and reviewed
  privately; prepared preview copies pass the actual bounded reader. Scope/data
  decisions, field mapping, reconciliation and the approved load remain MIG-01.
- [x] HOST-03-TLS-CHOICE **Owner decision** — Keep the existing wildcard
  certificate in NPM for public staff/QR HTTPS; use a locally generated self-signed
  certificate for the private VM gateway. No owner certificate/key transfer is
  required. AD retains its verified LDAPS trust. A matching two-host certificate,
  public NPM trust copy and complete private Docker stage now exist outside Git;
  hostname/key checks, role/file isolation and Compose validation pass. NPM trust
  installation is no longer needed for the owner's subsequently selected standard
  NPM mode. Public routing and acceptance remain HOST-03-INGRESS-ROLLOUT.
- [ ] HOST-04 — Provision production web and QR reconciliation services
  (`service:reconcile -- --watch`), least-privilege credentials, startup/
  restart supervision, health checks, monitoring, backup retention, and a documented
  rollback process. Owner started the reviewed Docker stack on October 7, 2026;
  database/staff/QR/reconciler/gateway reported healthy, and the reviewed initial
  AD administrator was created and explicitly linked. Real staff-container LDAPS
  TLS and backend HTTPS checks pass; the first local paired baseline backup is
  recorded outside Git. Actual public/browser acceptance, boot/restart acceptance,
  scheduled encrypted off-server backups and monitoring/alerts remain open.
- [ ] QR-01 — Complete printed-label/domain continuity, reprint historical labels
  carrying private URL metadata, confirm the contact-staff fallback policy, and
  test mobile HTTPS/GPS behavior. GPS stays required; automatic email is MAIL-01.
- [x] QR-01-METADATA — New QR links contain only a stable receiver ID; server lookup
  resolves current receiver/account details without returning private metadata.
  Old React asset-number links still resolve current inventory. The legacy static
  form redirects without forwarding private parameters or opening a mail-only draft.
  Browser history queries are replaced and public pages use no-referrer. Staff
  request association uses stable IDs across renames and number reuse. Already
  printed private URLs/history/logs need separate continuity/reprinting work.
- [ ] MAIL-01 — Add approved server-side delivery for saved QR requests (their
  public test drafts were removed for privacy), with configurable recipients,
  retries/idempotency, and delivery status. Verify failure handling and full internal email content without exposing it to customers.
- [ ] MAIL-02 **Requirements decision** — Confirm Monday report contents, recipients,
  America/Chicago schedule, and retry behavior; implement and test scheduling if needed.
- [ ] MIG-01 — Obtain the owner's inventory spreadsheet outside source control;
  inspect its sheets/columns, map identifiers and assignments, preview duplicate/
  invalid/capacity-blocked rows and reconcile counts/leading-zero IDs before the
  approved initial import. A spreadsheet supplies inventory, not both databases'
  users/history/requests. Do not assume historical database records are included.
  Remove sample data, use new sessions, and plan original-domain/printed-label continuity
  plus rollback before changing live URLs.
  Browser sample initialization/automatic old-cache upload were removed under
  DATA-04; authorized exports, reconciliation, and cutover remain outstanding.
  Source review is complete outside Git. Original oversized sheet dimensions
  block parsing; values-only preview copies preserve mapped identifiers and pass
  the actual worker/planner. Resolve regional versus complete-registry scope,
  duplicate cross-account assignments and permanent-field disagreements, account
  name/Office ambiguity, shared card/serial values and missing rent evidence before
  Apply. Access-card status is not currently mapped. Private review artifacts
  retain source rows and conflicting values; no live import has occurred.
- [ ] QA-01 — Add meaningful API/permission/concurrency/import/backup tests; validate
  iPad/phone GPS and email flows, Brother label dimensions/cutting and actual scanning,
  staff workflows, production-like deployment, and owner acceptance before cutover.
- [x] QA-01-CI — Add automated GitHub PR checks for both apps' zero-warning lint,
  types/builds and synthetic regression suites. Implemented on `Dev/github-validation`
  in [PR #32](https://github.com/tanmar-org/AssetTrackerProDTV/pull/32); the full
  hosted runs pass; owner merged at `396be11`. Includes actual PostgreSQL
  permission/concurrency/backup drills and Chromium, with no production secrets/VM
  runner. See [CI operations](docs/CONTINUOUS-INTEGRATION.md). CI status alone does
  not enforce branch protection or replace owner review/actual-device acceptance.
- [x] QA-02 — Both apps pass lint with zero errors/warnings and require
  `--max-warnings=0`. Root verifies pinned local QR/barcode/SheetJS bytes, licenses
  and page SRI before exact upstream exclusions; first-party rules stay enabled.
  Removed unused staff helpers/state reads and made checkbox selection explicit;
  QR branding uses original local unoptimized images with explicit dimensions.
  Meaningful tamper/warning-gate and actual browser label/image checks pass.
  Builds and separate TypeScript scopes pass. Implemented on `Dev/lint-baseline` in
  [PR #31](https://github.com/tanmar-org/AssetTrackerProDTV/pull/31), merged by the
  owner at `eac2bba`. Vendor versions/bytes and lockfiles are unchanged.
