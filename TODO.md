# Project TODO

Use stable IDs in journal entries and PR descriptions. Checked items are completed;
unchecked items are unresolved. Recommendations remain proposals unless an owner
decision is recorded explicitly. The owner reviews and merges all changes from
`Dev/` branches.

## Implementation order and why

1. **Finish the source-map dependency patch (DEP-01-SOURCE-MAP).** A known affected
   QR package has a compatible security update. Remove that avoidable dependency
   risk before extending workflows; owner merge and GitHub rescan follow the PR.
2. **Make conflicting/unsaved edits easier to recover (DATA-01).** If two employees
   edit the same server revision, the second save currently pauses and requires
   exporting/reconciling a snapshot. Closing that tab can lose unsaved work. Add
   clear conflict/recovery choices while preserving both the committed records and
   the employee's draft; durable recovery must preserve shared-device privacy.
3. **Add complete backups and prove restoration (DATA-03).** Inventory downloads
   omit users, request records, logs and server history. Back up both PostgreSQL
   databases and test restoring synthetic copies before importing real records.
4. **Verify imports and spreadsheet exports (DATA-05).** A full account can block
   imported assignments, and exported text may be interpreted as a spreadsheet
   formula. Show accurate accepted/skipped counts and keep exported values inert
   so staff can trust the records and reports they use to make decisions.

Lint cleanup, company access decisions, approved email delivery, HTTPS/domains,
service supervision, old-label continuity and actual device acceptance remain
release requirements. The order above is implementation planning, not deployment
approval; unresolved owner/operational items remain listed below.

## Development foundation — first PR

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
  both apps; source-map-js is patched in the current branch below. GitHub's main
  alert will require owner merge/rescan.
  One underlying unpatched development-only
  braces advisory remains as five affected chain packages per full audit. See
  [current evidence and scope](docs/DEPENDENCY-REMEDIATION.md); DEP-01 remains open.
- [x] DEP-01-PRODUCTION — Reconcile known runtime advisory sources and install
  patched lockfiles. Both lockfiles/installs now use source-map-js@1.2.2 and
  production npm scans report zero. GitHub main alert closure awaits merge/rescan;
  scanner results exclude vendor assets/application flaws and need regular rechecks.
- [x] DEP-01-SOURCE-MAP — Correct the QR runtime source-map-js@1.2.1 alert
  [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q).
  Updated only QR's transitive entry to compatible patched 1.2.2; tracker already
  pins it. Both apps check malformed/nested offsets, bounded sparse-map conversion,
  and valid PostCSS mapping. Implemented on `Dev/qr-source-map-security` for review.
  PostCSS consumes maps for CSS processing; application request/import code does
  not pass submitted records into it. HTTP exploitability is not established.
- [ ] DEP-01-SOURCE-MAP-MERGE — Owner merges the patch and GitHub rescans main to
  resolve alert 162. Do not manually dismiss it as a substitute for patched code.
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
- [ ] AUTH-01 — Decide company authentication requirements (existing PINs versus
  company SSO/outer access policy). Shared-device sign-out/cache code is DATA-04.
  Per-account lockout is enforced below; broader login traffic/unknown-account abuse
  controls remain a deployment requirement. Inventory permissions remain SEC-03.
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
  conflict resolution. Browser-storage failures must not silently prevent server
  persistence; test offline/reconnect, full storage, and simultaneous users.
- [x] DATA-01-REJECTION — Ordinary edits queue separately using acknowledged
  revisions. Validation/permission/conflict failures pause retry/polling and retain
  the local draft for snapshot export/manual reconciliation. Queue order remains
  in memory (32-operation limit); durable offline edits, conflict UI, and storage
  failures remain under DATA-01. Actual browser-function regressions pass.
- [ ] DATA-02 — Make state/history/log writes consistent; protect recovery with
  expected revisions and coordinate QR status with tracker updates. Test concurrent
  recovery/save and failures between related writes.
- [x] DATA-02-TRACKER — PostgreSQL state/history/audit writes share one transaction;
  recovery uses expected revisions and the same lock. Concurrent save/restore,
  zero-row update, and audit-failure rollback tests pass. Coordination with the
  separate QR database remains open under DATA-02.
- [ ] DATA-03 — Implement complete, restorable database backups for both apps,
  including rental stock, users, requests, logs, and history. Verify operator
  database backups/restoration in an isolated environment; inventory exports are
  not complete database backups.
- [x] DATA-03-SNAPSHOT — Browser inventory snapshots and new Undo entries include
  rental stock/audit, and clear resets stock with inventory. Restore/Undo are admin
  actions; older missing collections receive a clearing warning. Export labels
  describe inventory scope accurately. Actual browser-function regressions pass.
- [x] DATA-04 — New inventory/Undo/audit/imports/preferences stay in tab memory;
  startup requires fresh authenticated inventory, with no samples or automatic
  legacy upload. Lock scrubs private DOM, cancels work, and ignores late results.
  Cross-tab changes and server context headers prevent old-tab writes under new
  cookies. Failed sign-out stays locked across reload until acknowledgement.
  Same-owner draft recovery is export-only with sync paused; legacy records have
  administrator export/removal controls. Implemented on
  `Dev/shared-device-sessions` in
  [PR #24](https://github.com/tanmar-org/AssetTrackerProDTV/pull/24), merged by
  the owner; see [policy](docs/SHARED-DEVICE-SESSIONS.md).
- [ ] DATA-04-ROLLOUT — Export/reconcile/remove older caches on previously used
  devices, deploy server/UI together and reload old tabs/integrations. Confirm
  shared-device acceptance in target browsers. New memory-only drafts do not survive
  reload; durable recovery/conflict UI remains DATA-01.
- [ ] DATA-05 — Report import success/skips accurately, including capacity-blocked
  West Texas assignments; preserve required fields and history; neutralize exported
  CSV formulas. Test representative workbooks, leading-zero IDs, and report exports.
- [ ] DATA-06 — Add pagination/filtering so older pending QR requests and activity
  records remain accessible. Define audit/history retention and full-state storage
  scaling; 25 snapshots and a 500-row response are not complete history/backup.

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
- [ ] HOST-04 — Provision production services, least-privilege credentials, startup/
  restart supervision, health checks, monitoring, backup retention, and a documented
  rollback process. VM tools alone do not constitute a production deployment.
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
- [ ] MIG-01 — Obtain authorized production exports separately from source; migrate
  both databases and reconcile counts, identifiers, stock, users, history, and requests.
  Remove sample data, use new sessions, and plan original-domain/printed-label continuity
  plus rollback before changing live URLs.
  Browser sample initialization/automatic old-cache upload were removed under
  DATA-04; authorized exports, reconciliation, and cutover remain outstanding.
- [ ] QA-01 — Add meaningful API/permission/concurrency/import/backup tests; validate
  iPad/phone GPS and email flows, Brother label dimensions/cutting and actual scanning,
  staff workflows, production-like deployment, and owner acceptance before cutover.
- [ ] QA-02 — Repair inherited lint/type-check setup and source errors. Root lint
  must exclude nested generated bundles and use an intentional vendor-file policy;
  finish the remaining staff lint work. Native runtime types and separate app
  TypeScript scopes pass. The QR form rewrite removed both effect-state errors;
  QR lint now passes with 3 inherited image warnings. Record the current root totals
  in the journal and pass the remaining check without suppressing application failures.
