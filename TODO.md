# Project TODO

Use stable IDs in journal entries and PR descriptions. Checked items are completed;
unchecked items are unresolved. Recommendations below are not approved architecture
decisions. The owner reviews and merges all changes from `Dev/` branches.

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
  upgrading the QR service's Next.js to 16.3.8. Broader remediation remains open.
- [ ] DEP-02 — Replace CDN-loaded SheetJS `0.18.5` with a patched, verified local
  asset or maintained alternative. Test XLSX/XLS/CSV imports with representative
  files and bounded malformed input; no spreadsheet-reader runtime CDN dependency.
- [x] SEC-02 — Replace public first-admin setup with controlled provisioning.
  Admin creation must be atomic and unavailable to unauthenticated users after
  provisioning; test fresh DB, concurrent requests, and already-initialized DB.
  Implemented on `Dev/controlled-admin-provisioning`: HTTP setup always returns
  403; the local operator command inserts only into an empty user table. Build and
  all 14 tests passed, plus fresh/repeated local D1 CLI checks.
  [PR #6](https://github.com/tanmar-org/AssetTrackerProDTV/pull/6) awaits owner review.
- [ ] SEC-03 — Enforce explicit server permissions and record schemas. Include
  rental stock, bulk edits, restore/clear operations, assignment uniqueness, account
  capacity, and identifier/link validation. Client action labels must not grant
  authority; test regular-user bypass attempts and permitted edits.
- [ ] SEC-04 — Retire or safely rebuild the legacy static service form. URL and
  stored values must render as safe text/validated attributes; test HTML injection
  and unsafe links on both public and authenticated pages.
- [ ] SEC-05 — Add public-request abuse controls, size/field limits, asset lookup,
  valid coordinate/time bounds, and atomic duplicate prevention. Test malformed,
  oversized, repeated, unknown-asset, and concurrent submissions.
- [ ] AUTH-01 — Decide company authentication requirements; revoke sessions on PIN
  reset, preserve at least one active admin, bound login attempts, and align migration
  constraints with runtime rules. Test account lifecycle and shared-device sign-out.

## Data preservation and correctness

- [ ] DATA-01 — Preserve pending edits on revision conflicts and provide explicit
  conflict resolution. Browser-storage failures must not silently prevent server
  persistence; test offline/reconnect, full storage, and simultaneous users.
- [ ] DATA-02 — Make state/history/log writes consistent; protect recovery with
  expected revisions and coordinate QR status with tracker updates. Test concurrent
  recovery/save and failures between related writes.
- [ ] DATA-03 — Implement complete, restorable database backups for both apps,
  including rental stock, users, requests, logs, and history. Correct export claims
  and fix Undo's audit/rental-stock coverage. Verify restore in an isolated environment.
- [ ] DATA-04 — Define browser cache/offline policy and remove sensitive operational
  caches on sign-out or isolate them by authorized user. Test shared-device behavior.
- [ ] DATA-05 — Report import success/skips accurately, including capacity-blocked
  West Texas assignments; preserve required fields and history; neutralize exported
  CSV formulas. Test representative workbooks, leading-zero IDs, and report exports.
- [ ] DATA-06 — Add pagination/filtering so older pending QR requests and activity
  records remain accessible. Define audit/history retention and full-state storage
  scaling; 25 snapshots and a 500-row response are not complete history/backup.

## Hosting, QR, email, and migration

- [ ] HOST-01 **Architecture decision** — Owner confirms the runtime/database plan.
  Recommendation: Node/Next.js plus local PostgreSQL; SQLite is a smaller alternative.
  Preserve UI and separate staff/private and customer/public access boundaries.
- [ ] HOST-02 — Port Worker entry/runtime bindings and direct D1 SQL calls to the
  selected backend. Replace Worker/Sites build validation and static/image serving;
  port the trusted operator provisioning command; run both apps on the VM without
  Cloudflare application/database bindings. Never restore public bootstrap as a shortcut.
- [ ] HOST-03 — Configure domains, HTTPS, internal request endpoint, new shared
  credential or replacement auth, public QR destination, CORS, and local fonts.
  Remove localhost/old-host assumptions; verify generated URLs and font assets.
- [ ] HOST-04 — Provision production services, least-privilege credentials, startup/
  restart supervision, health checks, monitoring, backup retention, and a documented
  rollback process. VM tools alone do not constitute a production deployment.
- [ ] QR-01 — Replace private QR metadata with a stable asset/opaque label identifier.
  Resolve current receiver/account details server-side and keep them out of public
  URLs/responses. Define GPS-denied/unavailable flow and test mobile HTTPS behavior.
- [ ] MAIL-01 — Replace test `mailto:` drafts with approved server-side delivery,
  configurable recipients, retries/idempotency, and delivery status. Verify failure
  handling and full internal email content without exposing it to customers.
- [ ] MAIL-02 **Requirements decision** — Confirm Monday report contents, recipients,
  America/Chicago schedule, and retry behavior; implement and test scheduling if needed.
- [ ] MIG-01 — Obtain authorized production exports separately from source; migrate
  both databases and reconcile counts, identifiers, stock, users, history, and requests.
  Remove sample data, use new sessions, and plan original-domain/printed-label continuity
  plus rollback before changing live URLs.
- [ ] QA-01 — Add meaningful API/permission/concurrency/import/backup tests; validate
  iPad/phone GPS and email flows, Brother label dimensions/cutting and actual scanning,
  staff workflows, production-like deployment, and owner acceptance before cutover.
- [ ] QA-02 — Repair inherited lint/type-check setup and source errors. Root lint
  must exclude nested generated bundles and use an intentional vendor-file policy;
  resolve the QR page's effect-state lint errors. Provide Cloudflare runtime types
  while that runtime remains, remove implicit-any errors, and scope each app's
  TypeScript project correctly. Pass both checks without suppressing real failures.
