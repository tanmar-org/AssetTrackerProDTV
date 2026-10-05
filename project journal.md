# Project journal

## Current handoff

- Repository: https://github.com/tanmar-org/AssetTrackerProDTV
- Baseline reviewed: `main` at `b3d86eb3eb05134e42c6f475e5a3dbe47df6a7e5`.
- Development branch: `Dev/remove-public-account-password`, based on merged
  `main` at `0c0a6f3`.
- Publication status: foundation [PR #3](https://github.com/tanmar-org/AssetTrackerProDTV/pull/3)
  and Dependabot [PR #2](https://github.com/tanmar-org/AssetTrackerProDTV/pull/2)
  were merged by the owner. The credential-removal PR is being prepared.
- Active working copy on the hosting VM:
  `/home/itadmin/projects/AssetTrackerProDTV-security-cleanup`.
- Owner reviews and merges all PRs. Agents may push `Dev/` branches and open PRs.
- Current phase: first corrective change, SEC-01 credential removal. Developer
  foundation is complete; production deployment has not started.
- Next task: owner reviews the corrective PR and resolves SEC-01-OWNER; continue
  dependency/security remediation and agree on the hosting architecture using
  the prioritized [TODO list](TODO.md).

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

Pending: push the branch, open the owner-reviewed PR, and record its URL.
