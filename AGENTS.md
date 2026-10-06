# Instructions for agents and contributors

## Start here

Read this file, [the project journal](<project journal.md>), [TODO.md](TODO.md),
and [the development guide](docs/DEVELOPMENT.md) before changing code. Consult
[the IT handoff](docs/IT-HANDOFF.md) for the exported application's architecture.
The journal records current evidence; older handoff statements may be stale.

## Branches, pull requests, and ownership

- Make every repository change on a branch beginning with **`Dev/`**, for example
  `Dev/fix-request-validation`. Branch from the current `origin/main`; inspect the
  working tree first and preserve unrelated work.
- Agents are authorized to commit, push their `Dev/` branches, and create or update
  pull requests targeting `main` as part of an assigned task.
- **The project owner performs final review and merging.** Do not merge a PR,
  enable automatic merging, push directly to `main`, or bypass branch protections.
- Keep each PR focused and reviewable. Describe the resulting behavior, relevant
  risks, validation performed, and checks that could not be completed.
- Bundle minor documentation and journal updates with the implementation they
  describe. The owner requested no separate PR for each small documentation edit.
- Explain the next priority in plain language: the concrete failure/example,
  why it comes next, the intended improvement, and remaining limits. Do not give
  only a TODO ID or a short technical label; retain the ID for project tracking.
- Do not deploy to production or modify live databases as part of a development
  task unless the owner explicitly authorizes that action.

## Comments and human review

- All new or changed code must have appropriate comments that help human review.
  Explain intent, assumptions, trust boundaries, persistence semantics, and
  non-obvious tradeoffs. Avoid comments that merely repeat the next statement.
- As existing code is examined for a task, add missing comments around meaningful
  behavior. Prefer a focused section or function comment to comments on every line.
- Keep comments accurate when changing behavior. Label known limitations as
  limitations; do not describe client-side checks as server-enforced security.
- Comment-only work must preserve executable code. Verify the diff and use
  appropriate syntax/build checks without mixing in unrelated fixes.

## Application map and constraints

- Root application: static staff UI in `public/asset-tracker/`, server APIs in
  `app/api/`, shared sessions in `lib/pin-auth.ts`, AD adapter/login in
  `lib/ad-auth.ts` and `lib/ad-login.ts`.
- Public QR application: `service-request/`, especially `app/page.tsx` and
  `app/api/requests/route.ts`.
- Both applications build/run with native Next.js on Node and PostgreSQL, using
  separate database URLs and runtime roles. No Worker/D1 binding is required.
  `packages/database/` supplies a shared parameterized-query/transaction facade;
  SQL uses PostgreSQL `$1` placeholders with no D1/SQLite translation.
- The tracker retains operational collections as a JSONB state document. State,
  history, and audit writes share a transaction/advisory lock; recovery requires
  an expected revision. The QR application has its own request database.
- Inventory PUT is administrator-only replacement; PATCH permits checked everyday
  edits using actual persisted differences, never client action labels. Use
  `lib/inventory-state.ts` for reads/saves/recovery schemas and
  `lib/inventory-permissions.ts` for ordinary changes. Include rental stock in
  validation/export/Undo/clear. See [inventory policy](docs/INVENTORY-PERMISSIONS.md).
- State/recovery take account lock `728303` before state lock `728302`, recheck
  sessions/roles after waiting, and hold authorization through commit. Preserve
  this lock order. QR proxy deletion requires an admin; its upstream call is
  bounded to five seconds and uses the same account-authorization lock.
- QR status/archive use durable tracker intent before any QR write, immutable
  UUID/versioned commands and a QR receipt committed with the transition. Finish
  server history/rent/derived stock/audit and done status in one tracker transaction;
  never manufacture QR history in the browser. Preserve actor/approver, accepted
  stable association, single unresolved intent/request and explicit rent-conflict
  review. Recheck active approving account/admin deletion before new upstream writes;
  already-applied proof may finish facts after logout/revocation. Receipt lookup and
  mutation share a five-second budget. Run root `service:reconcile` as a separate
  restricted VM process; reads do not drive mutations. Restored unfinished intents
  stay paused for admin approval. Update both new tables in backup catalogs/drills.
  Read [QR operations](docs/QR-OPERATIONS.md) before changing this protocol.
- Regular browser operations queue separately. A permanent rejection/conflict
  pauses sync and retains the draft for export; do not silently overwrite it or
  resume failed operations after loading another revision/user. Explicit recovery
  uses owner-only `/api/drafts`, copy-version CAS and a fresh inventory revision;
  reuse `lib/inventory-merge.ts` and `lib/inventory-store.ts`, with existing role
  checks and atomic state/history/audit/copy closure. See
  [draft recovery](docs/DRAFT-RECOVERY.md). New browser data is tab-memory-only; do not
  restore device-wide operational caching or auto-upload old caches. See
  [shared-device policy](docs/SHARED-DEVICE-SESSIONS.md): retain expired drafts
  only for same-user reauthentication/export/explicit review with sync paused; discard late
  responses/imports using session generations and cancel workers on lock.
- Staff mutations require `x-tracker-session-context` matching the real session
  cookie; the context is non-bearer and never grants access. Preserve checks on
  supplied read contexts too. Logout takes account lock `728303`; stale-context
  logout must not revoke/clear a newer shared cookie. Require acknowledged logout
  before unlocking the sign-in flow after a connection failure.
- Apply PostgreSQL migrations from `migrations/` with an operator connection;
  web requests never run DDL. `drizzle/` directories are historical D1 records,
  not the current migration source. Follow [self-hosting setup](docs/SELF-HOSTING.md).
- Complete database backups/restores use root operator commands and protected
  libpq service/passfiles outside the repository/web roots, not application URLs
  or web endpoints. Restore only to new empty `assettracker_restore_*` databases
  and fresh restricted roles. Preserve source snapshot verification, per-target
  restore lock `728304`, both-target preflight, old-session revocation and failure
  access guards. Read [the recovery runbook](docs/DATABASE-BACKUPS.md). Update the
  explicit supported-table catalog and isolated restore drill with schema changes;
  never silently omit tables or overwrite live databases. Tooling is not evidence
  of scheduled/off-server backups, encryption or point-in-time recovery.
- Initial administrator creation is operator-only: migrate the tracker database,
  then run `npm run admin:provision` in a terminal. Never reintroduce public HTTP
  bootstrap or pass PINs as command arguments. PostgreSQL bootstrap takes a table
  lock before checking for any existing user; a conditional INSERT alone can race.
  AD mode creates an unlinked app record without a chosen PIN; explicitly map its
  reviewed directory/GUID with operator `auth:link-ad` before first sign-in.
- Account mutations use transaction advisory lock `728303`, recheck the actor's
  session in that transaction, retain an active administrator, and commit account,
  session revocation, and audit changes together. PIN login locks the target user row
  through verification/session issuance; AD verifies first outside SQL locks, then
  takes account lock and linked-user row lock through issuance. Preserve those boundaries;
  a PIN reset must invalidate sessions even when a login races it.
- Staff sign-in reserves shared PostgreSQL traffic budgets before account lookup
  or credential verification, in a separate committed transaction. Preserve global,
  trusted-client and canonical-username ceilings, bounded bucket cardinality and
  fail-closed ingress/schema errors. Never trust plain forwarded IP headers. See
  [staff authentication](docs/STAFF-AUTHENTICATION.md). Owner chose internet access,
  private on-premises AD and no MFA. Opt-in AD mode requires verified private LDAPS,
  mandatory CA/hostname validation, structured/binary equality filters, bounded
  five-second I/O, computed AD account flags and explicit operator directory/GUID
  links. Every identity/status search requires the critical AD DOMAIN_SCOPE
  control with no value, restricting it to one naming context; preserve rejection
  of unsupported controls and unexpected referrals without following/fallback.
  Never auto-link by username/email, store/log passwords, mutate AD, add a
  PIN fallback or reintroduce public bootstrap. Preserve existing IDs/roles/drafts.
  AD status approval is cached at most 60 seconds in SQL across processes; outages
  must not extend it, and late checks must not resurrect/revoke newer credential
  epochs. Runtime config changes bind/invalidate sessions. Real AD setup/acceptance
  and internet ingress remain rollout work, not evidence from synthetic tests.
- Spreadsheet imports use pinned local SheetJS 0.20.3 and the same-origin
  `spreadsheet-worker.js` browser worker. Keep vendor bytes/license/SRI/digests
  consistent; never restore a runtime CDN fallback. Preserve file/time/ZIP/range/
  cell limits and formatted/leading-zero identifiers. See
  [dependency/import evidence](docs/DEPENDENCY-REMEDIATION.md). Worker parsing runs
  on the staff device and is unrelated to Cloudflare/server workers.
- QR/barcode generation uses pinned local qrcode-generator 1.4.4 and JsBarcode
  3.11.6. Root `npm run lint` verifies all three vendor scripts, page SRI and their
  licenses before excluding only those exact upstream JavaScript files. Never
  ignore the whole vendor directory or edit upstream bytes to satisfy application
  rules. Update provenance/pins/licenses/SRI together for a reviewed version change;
  run label/import regressions. See [vendor provenance](public/asset-tracker/vendor/README.md).
  Both app lint commands use `--max-warnings=0`; preserve that gate and first-party
  checks. `npm run vendor:verify` performs the offline integrity check separately.
- Import Center previews and Apply share `planReceiverImport`; recheck current
  tab capacity before any registry/account/history side effect and keep skipped
  preview rows skipped. Preserve nonempty metadata, text IDs and assignment history.
  Single-account imports remain bound to their preview account; regular users
  import one receiver per operation under existing server permissions. Counts
  describe local changes until sync acknowledgement. See
  [import/report policy](docs/IMPORTS-AND-EXPORTS.md). All CSV report paths must use
  `csvCell` with quoted fields and protected text prefixes; never use formula-based
  identifier wrappers or claim universal spreadsheet/machine round-trip safety.
- Public labels contain only a stable receiver ID; legacy asset-number links use
  current server lookup. The old static page redirects to the configured QR app,
  discarding private parameters and mail-only behavior. Public responses contain
  only ID/asset number; never expose private snapshots or accept them in POST.
  See [public request policy](docs/PUBLIC-REQUEST-SECURITY.md).
- QR submissions use 8-KiB streamed JSON bounds, field/GPS/time validation,
  PostgreSQL rate counters shared by all processes, and unique pending indexes.
  Preserve atomic INSERT/reopen conflicts and the fail-closed authenticated lookup.
  Never trust forwarded client IPs without authenticated, overwritten ingress
  headers. Production ingress/configuration and mobile acceptance remain required.
- Escape all cached/imported/API values used in staff HTML, including IDs and
  enum/class attributes; server schemas do not validate older browser caches or
  separate QR responses. Use `safeMapsLink` before Maps anchors: escaping an href
  alone cannot block executable schemes. Regression checks live in
  `tests/service-rendering.test.mjs` and the optional real-browser suite.
- QR/request and admin activity lists use the shared Node `lib/record-list.ts`
  contract: max 100 rows, bound literal search, strict enums/dates and filter-bound
  timestamp/ID cursors. Authenticate every page; preserve account-lock proxy
  rechecks, five-second/two-MiB upstream bounds and redirect rejection. Browser
  filter generations and session epochs discard late results; lock cancels timers
  and scrubs page state. Counts include the loaded QR page/all manual work, receiver
  history includes only loaded QR rows, and activity CSV exports one page. See
  [record browsing policy](docs/RECORD-LISTS.md). Pagination is not retention,
  complete history, snapshot consistency or a database backup.
- Public submissions save requests for staff review; no email draft/delivery is
  attempted. GPS remains required, with a contact-staff fallback on failure.
  Automatic server email and a Monday reporting job are not implemented.
- An account-password value was removed from a public template under SEC-01.
  Never reintroduce credentials in browser code or email drafts, or copy historical
  values into documentation, logs, tests, issues, or PR bodies. Removal does not
  erase Git history or rotate a live credential; track owner rotation under SEC-01.
- Repository privacy is intended by the owner, but GitHub reported public
  visibility on 2026-10-05. Treat VIS-01 as an owner action; do not silently change
  repository visibility or permissions.

## Documentation is part of the task

- Update `TODO.md` and `project journal.md` with each substantive task. Record
  decisions, files/areas changed, tests and exact outcomes, remaining blockers,
  branch/PR references, and the next useful action.
- Keep setup, architecture, configuration, and operational instructions current
  when their behavior changes. Historical handoff/validation records are evidence,
  not proof that a new change passed.
- Use stable TODO IDs when reporting progress. Mark an item done only when its
  completion criteria are met; distinguish proposed decisions from approved ones.
- Use dated journal entries with the owner's America/Chicago time context.

## Verification and secrets

- GitHub [repository validation](.github/workflows/validation.yml) runs on PRs to
  main and main pushes, using disposable GitHub-hosted runners and synthetic
  PostgreSQL/browser fixtures. Keep its read-only permissions, pinned actions,
  loopback test service, zero-warning lint and full regression coverage. Do not
  add production secrets, deploy steps or a runner on the hosting VM. See
  [CI operations](docs/CONTINUOUS-INTEGRATION.md). Passing checks do not merge a PR
  or enforce branch protection; the owner retains those decisions.
- See `docs/DEVELOPMENT.md` for installation and validation commands. Run checks
  appropriate to the change; record pre-existing failures rather than hiding them.
- Never use production data for tests. Keep `.dev.vars`, credentials, database
  files, exports, backups, `node_modules`, and build artifacts out of Git.
- Use isolated test databases and freshly generated local secrets when needed.
  Do not fetch, migrate, overwrite, or delete live data without explicit scope.
- Dependency advisory matches identify affected versions, not proven exploitability
  of every advisory in this application. Review runtime reachability and update
  related packages together. Do not automatically run `npm audit fix --force`.
- Preserve lockfiles for installs. Regenerate them intentionally when replacing
  the runtime/dependency set, and validate both apps. Keep dependency remediation in focused tasks;
  do not mix package upgrades into unrelated fixes or documentation/comment work.
- Add meaningful regression tests when fixing permissions, persistence,
  concurrency, or other consequential behavior. Documentation-only edits do not
  require tests that restate their contents.
