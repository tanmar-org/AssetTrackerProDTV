# IT handoff — TanMar Receiver Control

Updated September 27, 2026. This is the current source with the export changes below, not a completed transfer of production hosting or databases.

## Provenance

| Component | Published version | Source commit |
| --- | --- | --- |
| Tracker | 58 | `69e6390c9bd5524d9efa332eee93054ea8254b53` |
| QR service | 8 | `e0f97544b17ffb19ac90086674182ff6d6238596` |
| Previous GitHub prototype | July 10, 2026 | `70785910a2d93b0f7aad4b0e24a59e3afc101240` |

Both source versions had successful production deployments when retrieved.

- Tracker: https://directv-asset-tracker-eric.evo3453.chatgpt.site
- QR service: https://tanmar-receiver-service.evo3453.chatgpt.site

Production runtime secrets and database contents were not retrieved. A clean source snapshot was used rather than importing hosting Git history, which contains an embedded browser token.

## Architecture

The tracker is an HTML/CSS/JavaScript interface served by Vinext. `/` redirects to `/asset-tracker/index.html`. Server routes run in a Cloudflare Worker with a D1 binding named `DB`.

The QR service is a separate Vinext/React app and Worker with its own D1 database, also bound as `DB`. Its public form displays the asset number and collects requester name, callback phone, operator, rig/frac, lease, error code and GPS. Submit records the request and, during testing, opens the full original email draft, including serial number, card number, RID, account number and receiver rent status from the scanned label. The tester must tap Send. For production, IT must replace the draft with server-side email and look up account number, receiver identifiers and rent status from the private tracker registry before sending. This code does not yet send email automatically or include an automatic Monday email job.

The current test email retains the original subject (`<asset number> / Service Request`), recipient currently configured as `earrieta@tanmarcompanies.com`, opening request to reactivate or refresh, on-screen error code, operator name, rig/frac, lease, receiver asset/model/type/serial/RID/access card, rent status, account number/name, recorded location, office/yard, GPS coordinates and accuracy, map link and capture time. Requester name and callback phone are also included. The form itself displays only the asset number. For the later production flow, resolve receiver and account fields by asset number inside the trusted server, send the full email to staff, and return only a confirmation to the customer. The current mailto test draft is visible on the scanning device.

| Tracker endpoint | Function |
| --- | --- |
| `/api/auth` | First-admin setup, sign in, current session, sign out |
| `/api/users` | User administration |
| `/api/app-state` | Shared state with revision conflict checks |
| `/api/activity` | Change-log access |
| `/api/recovery` | State-history recovery |
| `/api/service-requests` | Session-protected proxy to the QR service |

The service's `/api/requests` accepts public submissions. Listing, changing and deleting requests require the shared server credential. Keep the two databases separate.

## Account capacity

The Accounts page shows totals across all accounts, independent of search: 20 paid spaces per account, active assigned receivers, active On Rent and Off Rent receivers, and empty spaces. Each account row also shows its empty spaces. Unassigned receivers do not occupy paid spaces. These are calculated from the existing shared accounts, assignments and registry; no database migration is required.

The consolidation estimate uses `ceil(onRent / 20)` as the minimum number of accounts, assuming all active Off Rent receivers are deactivated and remaining units can move between accounts. Five accounts with 90 active and 80 On Rent produce 100 paid spaces, 10 currently empty spaces, 10 deactivation candidates, 20 empty spaces after deactivation and one potentially closable account. No account is automatically closed or receiver automatically deactivated. Verify provider, location and service constraints before acting. No dollar saving is estimated without an account rate.

Unknown rent statuses, missing/duplicate assignments and accounts over capacity suppress the closure estimate and show a review message. Verified the 90/80 case, 81-receiver rounding, full/empty accounts, unassigned units and invalid-data cases. Live and handoff preview builds passed.

## Configuration

| Setting | Where | Value |
| --- | --- | --- |
| `DB` | Each Worker's runtime bindings | A separate D1 database per application |
| `ADMIN_SHARED_SECRET` | Both server runtimes; `.dev.vars` locally | Same newly generated secret |
| `SERVICE_REQUEST_API_URL` | Tracker server runtime | Service application's full `/api/requests` URL |
| `serviceRequestUrl` | `public/asset-tracker/config.js` | Public QR service base URL; localhost in this handoff |
| Temporary test email recipient | `service-request/app/page.tsx`, `TEST_RECIPIENT` | Remove the client email draft when IT configures server sending |
| Production email sender and recipient | Server integration to be configured by IT | Keep credentials and receiver lookup server-side; never put private receiver data in the QR URL or customer response |

The tracker label screen and legacy static service form also contain recipient text. Search `public/asset-tracker/` and `service-request/app/` when changing addresses. The tracker deactivation recipient is a device preference.

Keep `.dev.vars`, database dumps, application backups and secrets out of source control. No automatic deployment workflow was added.

## Databases and migration

Tracker migrations are in root `drizzle/`; service migrations are in `service-request/drizzle/`. Apply each set to its own database. README local setup commands were exercised on isolated databases.

The tracker keeps operational data as a JSON payload in `app_state`, with a revision and snapshots in `app_state_history`. Users, hashed PINs, sessions and change logs have separate tables. The service database stores `service_requests`, including GPS and soft-deletion timestamps.

For IT hosting:

1. Provision test databases, runtime bindings and HTTPS endpoints.
2. Create a test administrator. Protect the first-admin setup page before exposing an empty production database.
3. Back up and export original data through an authorized application/database workflow. Transfer data separately from this public code repository.
4. Restore into test hosting and compare counts, identifier fields and assignments. Use new sessions rather than copying active tokens.
5. Verify labels, audits/imports, device access and QR submissions before changing production URLs.
6. Coordinate final data transfer and endpoint cutover, including continuity for already printed QR labels.

The app's Download Backup includes `master`, `accounts`, `assignments`, `activations`, `receiverEvents` and `auditState`. It is not a complete database backup: it omits users, sessions, change logs, server history, the separate QR database and rental-stock batches. Rental-stock batches are included in the cloud state and cached in browser storage, but are omitted from Download Backup; use the database state when preserving them during migration. Device-local undo history and preferences are also separate.

## Hosting

The server relies on Cloudflare Worker APIs and D1. Static GitHub Pages, IIS, a conventional Node server or SQL Server is not a drop-in replacement. IT can retain Worker/D1 hosting under its own account or plan an explicit backend port.

Local Wrangler files use placeholder database IDs and are not production deployment configurations. Hosting manifests retain logical bindings but have the original live project IDs removed.

The current Sites tracker also has an outer platform access policy that does not move with the code. The application PIN/session gate remains. IT should select its own outer access control or SSO approach. Sessions last 12 hours and use Secure, HttpOnly, SameSite=Strict cookies. PINs use salted PBKDF2; five failed attempts cause a 15-minute lockout.

The import UI loads SheetJS XLSX from a CDN. Review/vendor that dependency if external network access is unavailable. QR and barcode libraries are included locally.

## Labels and QR continuity

Version-58 code uses a 62 mm roll with a 150 mm cut for receiver/service labels (DK-2212), and a 29 mm roll with a 90 mm cut for barcodes (DK-2211). Browser scale, orientation, margins, headers/footers and Brother cutting settings must match the driver; the app cannot set all driver options automatically.

Changing `config.js` changes newly generated QR labels. The original full QR payload is restored for testing so the full email has its receiver/account fields. The form shows only the asset number; printed label text still includes card, RID and serial. Existing labels printed before tracker version 56 work with a fresh scan. Labels generated by version 56 contain only the asset number and must be regenerated for the full test email. A missing-data check prevents silently creating another incomplete email. When IT enables server lookup and sending, replace this test payload with an asset identifier and keep private fields on the server.

## Export changes and remaining review

- Removed the actual browser token and removed acceptance of the legacy browser sync token from the service API.
- Routed tracker service actions through a session-protected same-origin proxy; only the server sends the credential upstream.
- Made the upstream URL a server setting and the public QR destination a non-secret browser setting.
- Added local configuration templates and detached manifests from the live projects.
- Preserved imports and label dimensions, and added the service-request migration for requester name and phone.

The live apps now have the compact requester form and restored full test email. The legacy token still exists in the live tracker client; retire/rotate it during a coordinated live update after deploying the new proxy configuration. Revoking it first would break current request synchronization.

The repository is public. Restrict access if company policy requires private source. This handoff is not a full security audit. Review public-submission abuse controls, first-admin setup, roles, backup coverage and assumptions inherited from Sites before production migration.

## Validation

The correction was checked from generated QR URL through parsed receiver data to the email body: all original email lines match, with requester contact added; the form omits receiver metadata; the SQL insert preserves serial, card, RID, account and status. Both corrected Sites builds and deployments succeeded. See [VALIDATION.md](VALIDATION.md) for the initial handoff checks. Physical printing, iPad behavior and production migration were not tested during this handoff.
