# Public receiver requests

Scanning a service label opens the public QR application. A visitor provides
contact/worksite information, an error code, and a GPS reading. The request is
saved for authenticated staff review. It does **not** generate a QR image, send
email, or confirm that service has been performed. Label generation happens in
the staff application. Automatic email delivery remains MAIL-01.

## Asset and privacy boundary

New labels contain only `?id=<receiver record ID>` at the configured QR URL.
The record ID survives asset-number changes. It is a public reference, **not** a
secret, bearer capability, proof of ownership, or authentication mechanism.

The browser calls QR `GET /api/asset?id=...`. The QR server calls the configured
tracker `GET /api/service-assets` using the server-only shared bearer credential.
The tracker validates one committed inventory snapshot and returns that receiver
and its current assignment/account. Public responses contain only `id` and
`assetNumber`; serial/RID/card/account details never return to the public page.

`POST /api/requests` looks up the receiver again and stores an internal metadata
snapshot. Client-supplied private metadata/unknown fields are rejected. Staff
list/status/delete APIs retain bearer authentication and the tracker session/role
proxy. Public success returns only a new random request reference, status, and
timestamp; duplicate errors do not expose an existing request reference.

The lookup is a snapshot at submission, not a transaction across both databases.
Inventory assignments can change afterwards. Staff receiver association uses the
stable ID through renames and does not match a deleted ID to another receiver
reusing its asset number. Legacy rows without IDs retain the old number fallback.
DATA-02 still covers coordination
between tracker inventory and the separate request database.

## Printed-label compatibility

Old React links using `?a=<asset number>` still resolve against current inventory.
Extra historical metadata is discarded by the browser, and its history entry is
replaced with the stable ID after successful lookup. Old asset-number links cease
resolving if that number is changed or removed; new ID links survive renaming.

The historical staff path `/asset-tracker/service-request.html` now redirects to
the configured QR application, forwarding only a validated `id` or `a`. It no
longer displays private receiver/account details or creates a mail-only draft.
Malformed labels, unsafe destinations, and a direct self-redirect fail with a
contact-staff message. Both public pages use a no-referrer policy.

This intentionally changes the old mail-only workflow to the saved-request
workflow. Staff should monitor the request list; there is no automatic email alert
yet. Review this behavior before cutover. Previously printed URLs, photographs,
old browser history, and existing server logs cannot be erased by these changes.
Reprint old labels and plan original-domain routing under QR-01/MIG-01. An old
domain served by another provider will not change just because this PR is merged.

## Validation and GPS

Public POST and private PATCH accept JSON objects only, with an 8-KiB streamed
UTF-8 byte limit, including requests without Content-Length. Invalid encoding,
malformed JSON, arrays/null, unsupported fields, coerced types, and controls in
single-line fields are rejected. Bounds are:

| Field | Accepted value |
| --- | --- |
| Receiver ID / legacy asset number | One selector, matching inventory's bounded identifier syntax |
| Requester/operator name, Rig/Frac, Lease | Nonempty text, at most 120 characters |
| Callback phone | Nonempty text, at most 40 characters |
| Error code | Nonempty text, at most 80 characters |
| Latitude / longitude | Finite numbers in [-90, 90] / [-180, 180] |
| GPS accuracy | Finite number from 0 to 10,000 meters |
| GPS captured time | Canonical UTC ISO timestamp, at most 15 minutes old or 5 minutes ahead |
| Staff notes | At most 2,048 characters; tabs/newlines allowed |

GPS is still a **client claim**. These limits cannot verify physical presence,
the caller's identity, the truth of their contact details, or receiver ownership.
GPS capture starts when the visitor selects Share GPS Location. It requires
HTTPS/localhost and device permission. Denied/unavailable/timed-out readings keep
submission disabled and direct the visitor to contact TanMar; staff can use their
existing manual workflow. A no-GPS public submission is not implemented. Mobile
HTTPS/device acceptance and the final fallback/contact policy remain QR-01/QA-01.

## Shared abuse controls

PostgreSQL `request_rate_limits` counters are atomic and shared by all QR Node
processes. They count failed attempts too, saturate rather than growing forever,
and expire at fixed window boundaries. Subsequent requests remove expired rows.

| Budget | Submit POST | Public asset GET |
| --- | --- | --- |
| Whole application | 30/minute and 200/hour | 120/minute and 1,200/hour |
| Resolved receiver ID | 5 attempts/10 minutes | Covered by global/client budgets |
| Client IP, when trusted ingress configured | 10 attempts/10 minutes | 30/minute |

Counters store HMAC digests keyed with the server secret, never raw IPs, label
identifiers, contact information, or credentials. `429` responses include the
remaining window time in Retry-After. Rotating the shared secret starts new digest
keys; old buckets expire normally. Cross-site browser fetches are rejected and
public APIs expose no CORS permission. Direct HTTP clients remain possible.

Global ceilings bound lookup work and arbitrary bucket allocation, including
unknown assets. They can also temporarily block legitimate visitors during a
deliberate flood or unusual workload. Fixed windows allow bursts around a window
boundary. These are resource/abuse controls, not comprehensive bot detection or
network DDoS protection; tune budgets using operational evidence before cutover.
No CAPTCHA or outside worker/service is required by this implementation.

### Trusted client IP in production

Set a separately generated `REQUEST_PROXY_SECRET` in the QR server and the HTTPS
reverse proxy. The proxy must **overwrite**, rather than append or preserve,
incoming `X-Request-Proxy-Secret` and `X-Request-Client-IP` headers. The first holds
that secret and the second contains exactly one actual client IP. Limit the QR
Node listener to loopback/private access. If another proxy precedes this proxy,
configure its trusted address ranges before deriving the real client IP.

When REQUEST_PROXY_SECRET is configured, missing/forged credentials or an invalid
IP fail closed with 503 before consuming counters. The application never uses
unverified X-Forwarded-For. If the setting is absent, local development uses only
global and per-receiver budgets; per-client limits are unavailable. Configuring and
testing authenticated ingress is a HOST-04 production requirement. Keep proxy
credentials out of public config, browser code, logs, and Git.

## Database migration and configuration

Apply `requests/0002_public_request_security.sql` with an operator connection
before running the new QR server. It adds nullable `asset_id` for legacy rows,
GPS range constraints, two partial unique indexes for non-deleted pending requests
(normalized asset number and stable ID), and the rate-limit table. Existing
records retain historical metadata; the migration neither deletes duplicates nor
guesses a legacy receiver ID. Runtime roles need SELECT/INSERT/UPDATE/DELETE on
**both** `service_requests` and `request_rate_limits`, not schema privileges.

Use authorized exports/operator access for preflight, never live data in tests:

```sql
SELECT upper(asset_number) AS asset, count(*)
FROM service_requests
WHERE status = 'Pending' AND deleted_at IS NULL
GROUP BY upper(asset_number) HAVING count(*) > 1;

SELECT id FROM service_requests
WHERE NOT (latitude BETWEEN -90 AND 90 AND longitude BETWEEN -180 AND 180
  AND gps_accuracy BETWEEN 0 AND 10000);
```

Reconcile any findings with the owner before migration, preserving required
history/audit evidence. Invalid coordinates/duplicates cause the checksummed
migration transaction to roll back completely. Do not bypass indexes, alter an
applied migration, silently cancel rows, or fabricate a GPS reading.

The ID index prevents another pending request after a receiver is renamed. The
normalized-number index also covers older pending rows without IDs and reuse of
an old asset number; staff must resolve an earlier pending request first. New
submissions use atomic INSERT ON CONFLICT, and a conflicting staff reopen returns
409 while preserving the previous status/notes. Completed/cancelled/tombstoned
rows free the pending slot.

Configure matching `ADMIN_SHARED_SECRET` values (use a newly generated high-entropy
credential) and QR `TRACKER_ASSET_API_URL=http://127.0.0.1:5173/api/service-assets`.
Tracker `SERVICE_REQUEST_API_URL=http://127.0.0.1:5174/api/requests` remains its staff
proxy destination. Both are fixed operator settings; label callers cannot change
their destination. Lookup has a five-second timeout, an 8-KiB response bound, and
rejects redirects and invalid response schemas. Missing configuration/database/
lookup fails closed with fixed errors, never driver/credential/private data.

Keep both Node ports private. The public reverse proxy should deny external access
to tracker `/api/service-assets` and QR staff-only methods on `/api/requests`.
Bearer guards remain mandatory even on internal paths. Add ingress body/header/
request timeouts and monitoring under HOST-04. QR readiness checks its new schema,
runtime grant and presence of lookup configuration; it does not probe upstream
availability or constitute a full health/monitoring system.

Development verification is documented in [DEVELOPMENT.md](DEVELOPMENT.md).
Use synthetic databases and the optional Chromium suite; a merge alone runs no
migration, starts no production service, and changes no live label destination.
