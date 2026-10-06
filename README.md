# TanMar Receiver Control — AssetTrackerPro

Staff inventory/account management and a separate public QR service-request app.
Both applications now build and run with **Next.js on Node.js and PostgreSQL**.
Cloudflare Workers, D1, Vinext, Wrangler, and Sites bindings are not required.

Start with [AGENTS.md](AGENTS.md), [the project journal](<project journal.md>),
[TODO.md](TODO.md), and [the development guide](docs/DEVELOPMENT.md). Work on `Dev/`
branches; the owner reviews and merges. Keep documentation updates in the same PR
as their implementation.

## Included

- Accounts, capacity totals, Master Registry, activations, rental stock, history,
  audits/imports, reports, labels, user administration, and recovery.
- Brother QL-820NWB receiver/service and barcode label UI.
- Session-protected staff APIs and a separate public QR form/request API.
- PostgreSQL migrations, operator-only administrator provisioning, graphics,
  QR/barcode libraries, and dependency lockfiles.
- Public asset lookup, bounded/rate-limited requests, and atomic pending uniqueness;
  see [public request security](docs/PUBLIC-REQUEST-SECURITY.md).
- Recoverable staff QR transitions, durable receipts and a local VM reconciliation
  command; see [QR operations](docs/QR-OPERATIONS.md).

Production records, database credentials, users, and inventory exports are not
included. Browser sample initialization was removed. A code migration is not a production
cutover: review the unresolved security, dependency, backup, and acceptance items
in TODO.md before deployment.

| Location | Purpose |
| --- | --- |
| `public/asset-tracker/` | Staff interface, labels, graphics, QR/barcode libraries |
| `app/api/`, `lib/` | Staff APIs, PostgreSQL connection, PIN sessions |
| `service-request/` | Public QR Next.js app and its separate request database |
| `packages/database/` | Shared native PostgreSQL query/transaction facade |
| `migrations/` | Current PostgreSQL tracker/request schema migrations |
| `drizzle/`, `service-request/drizzle/` | Historical D1 migration records |
| `.env.example` in each app | Non-secret server configuration template |

## Local setup

Use Node.js 22.13+ (the reviewed VM uses the version in `.nvmrc`) and PostgreSQL 18.
Follow [self-hosting setup](docs/SELF-HOSTING.md) to create isolated databases and
separate migration/runtime roles. Opening `index.html` directly supplies no backend.

From the repository root:

```bash
npm run install:ci
cp .env.example .env.local
cp .env.example .env.migrate
```

Set `.env.local` `DATABASE_URL` to the tracker runtime connection; set `.env.migrate`
`DATABASE_URL` to the tracker migration-owner connection. Keep files private and
ignored. Set a fresh `ADMIN_SHARED_SECRET` matching the QR service, and the tracker
`SERVICE_REQUEST_API_URL` to the QR server's `/api/requests` endpoint.

```bash
npm run db:migrate
npm run admin:provision
npm run dev
```

In a second terminal, install and configure the companion app:

```bash
cd service-request
npm run install:ci
cp .env.example .env.local
cp .env.example .env.migrate
# Configure separate database URLs, matching secret, and TRACKER_ASSET_API_URL.
npm run db:migrate
npm run dev
```

The provisioning command prompts for username and PIN in a terminal, hides PIN
input, and refuses if any user already exists. The website only permits login.
Ports default to 5173 (staff) and 5174 (QR), bound to loopback. Open
`http://localhost:5173/` and `http://localhost:5174/` with synthetic data. Sessions use
Secure cookies; phone GPS and real staff access require correctly configured HTTPS.

Staff inventory loads from the authenticated server; unsaved edits stay only in
the current tab. Download a snapshot before reloading/closing/signing out. Older
browser records require administrator export/reconciliation/cleanup. See the
[shared-device policy](docs/SHARED-DEVICE-SESSIONS.md), including the context header
required for staff API mutations and failed-sign-out retry behavior.

## Build and verify

Run in each app directory:

```bash
npm test
npm run typecheck
npm run lint
```

`npm test` builds native Next.js and exercises its production Node server. To run
both apps against real isolated PostgreSQL databases, follow the integration test
setup in [the development guide](docs/DEVELOPMENT.md). Both apps require lint with
zero warnings. Root lint first verifies the exact local vendor bytes, licenses and
page integrity attributes; first-party code remains checked.
GitHub runs both apps' checks plus real PostgreSQL/backup and Chromium regressions
on PRs to main and main pushes. See [CI operations](docs/CONTINUOUS-INTEGRATION.md)
for check names, isolation, reruns and the separate owner-controlled merge rules.

After a build, `npm start` runs the corresponding Node server on its loopback port.
`/api/health` checks PostgreSQL connectivity and the application's schema. Process
supervision, production domains, HTTPS, backup/restore, and live-data migration
remain separate tasks. The original hosting handoff and validation documents are
historical evidence, not current setup instructions.

Spreadsheet reading is served locally from the pinned SheetJS asset. Imports use a
bounded browser parser worker; no runtime spreadsheet CDN is required. See the
[dependency review and import limits](docs/DEPENDENCY-REMEDIATION.md). npm currently
reports zero production findings at the recorded check time. Both current lockfiles
use patched source-map-js 1.2.2, and GitHub reported alert 162 fixed after the owner
merged PR #25. An unpatched lint-only dependency remains
DEP-01. Scanner results are not production acceptance.
