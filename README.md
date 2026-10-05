# TanMar Receiver Control — AssetTrackerPro

Source handoff for TanMar's DIRECTV asset tracker and QR service-request application, updated September 27, 2026.

The tracker comes from published **version 58**; the companion service app comes from **version 8**. This handoff branch replaces the old three-file prototype; the previous version remains in Git history.

## Included

- Account capacity totals, per-account empty spaces and consolidation estimates.
- Accounts, Master Registry, activations, history, rental stock, audits/imports, reports, backup/restore and user administration.
- Brother QL-820NWB receiver/service and barcode labels, including select/deselect visible.
- Server APIs, schemas, SQL migrations, graphics, QR/barcode libraries and dependency lockfiles.
- The separate QR service app in `service-request/`.

This is a source-code handoff. Production databases, users, credentials, GPS records and inventory exports are not included. Fresh local setup uses empty databases and the application's existing sample records.

Read [the IT handoff guide](docs/IT-HANDOFF.md) for architecture, hosting, migration and limitations, and [validation results](docs/VALIDATION.md) for checks performed.

| Location | Purpose |
| --- | --- |
| `public/asset-tracker/` | Tracker interface, labels, graphics and QR/barcode libraries |
| `app/api/`, `lib/pin-auth.ts` | Tracker APIs, PIN authentication and sessions |
| `db/`, `drizzle/` | Tracker database schema and migrations |
| `worker/index.ts` | Cloudflare Worker entry point |
| `service-request/` | Separate QR service form, API, schema and Worker |
| `.dev.vars.example` | Server settings template without credentials |

## Local setup

Use **Node.js 22.13 or newer** on Linux, or Windows with **WSL2**. Both applications use Vinext/Vite and Cloudflare D1. Opening `index.html` directly does not supply the backend.

```bash
git clone --branch it-handoff/2026-09-23 https://github.com/eam42079-pixel/AssetTrackerPro.git
cd AssetTrackerPro
npm ci
cp .dev.vars.example .dev.vars
```

Generate a random local secret and set `ADMIN_SHARED_SECRET` to the same value in both apps' `.dev.vars` files. Keep it out of Git and browser JavaScript. The tracker template points to the service app at `http://localhost:5174/api/requests`.

Initialize and start the tracker:

```bash
npx wrangler d1 migrations apply DB --local --config wrangler.local.json --persist-to .wrangler/state
npm run dev -- --host 127.0.0.1 --port 5173
```

In a second terminal:

```bash
cd AssetTrackerPro/service-request
npm ci
cp .dev.vars.example .dev.vars
# Set ADMIN_SHARED_SECRET to the same local value used by the tracker.
npx wrangler d1 migrations apply DB --local --config wrangler.local.json --persist-to .wrangler/state
npm run dev -- --host 127.0.0.1 --port 5174
```

Open `http://localhost:5173/` and create the first administrator with a new test PIN. Use an isolated browser profile. The QR form is at `http://localhost:5174/`; it reads the full receiver details from a generated service-label URL for the test email, displays only the asset number, and requires location permission. Phone scans need a reachable HTTPS service address instead of localhost.

## Build

Run in each application directory:

```bash
npx vinext build
```

The output includes `dist/server/index.js` and client assets. `wrangler.local.json` is for local databases, not production deployment. Logical binding declarations are retained in `.openai/hosting.json` without live project IDs.

## Handoff changes

Removed the embedded browser access token. Tracker request actions now use a signed-in session and a server proxy, configured with `ADMIN_SHARED_SECRET` and `SERVICE_REQUEST_API_URL`. The exported service no longer accepts the old browser token. Set the public QR destination in `public/asset-tracker/config.js`.

This branch does not change the currently hosted applications. Review the IT guide before moving production.
