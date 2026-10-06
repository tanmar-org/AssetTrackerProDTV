# Retained request and activity browsing

Staff can now find QR requests and administrator activity beyond the former newest
500-record limit. Filtering runs in PostgreSQL before selecting a page; the browser
keeps one page of up to 100 server records rather than downloading entire databases.
No stored record is removed by this change.

## Staff behavior and scope

Activations search/status filters apply to all non-deleted retained QR requests.
Search uses metadata saved at submission: asset/model/type, serial/RID/card,
account/location/office, action/status/error, contacts/worksite and notes. A current
receiver may display a renamed asset number; the saved metadata still determines
matches. New QR requests keep stable receiver association. Historical rows without
IDs retain the existing number fallback.

Previous/Next QR page controls replace the remote page. Matching manual requests
from the already loaded inventory appear on every page, explicitly labeled; they
are not another QR page and are not read from the QR database. Summary tiles count
the loaded QR page plus all manual inventory requests, including manual records
outside the visible filter. They are not totals for the full request database.
Receiver History contains retained inventory events, manual requests and the
currently loaded QR page; its label/help no longer claims complete QR history.
Search Activations to find older QR work.

Administrator activity supports server search (username/action), category and
inclusive From / inclusive Through calendar-day selections. These use the staff
device's timezone, matching the earlier UI convention. The browser sends an
exclusive next-day boundary and advances a calendar day across daylight saving
changes. The API uses real UTC instants, including historical ISO timestamps with
or without milliseconds. Categories preserve the existing rules: `Denied:` prefix
first, then actions containing user/administrator/PIN/access, then data changes.

Changing filters, refreshing, revisiting a view or finishing a QR status/delete
operation resets to the first page. Navigation operates on live records; each page
is a fresh statement, not a consistent historical snapshot. Inserts before the
current anchor do not shift the next page; status changes, deletes or out-of-order
historical imports can change matches. Refresh starts from the newest retained work.

Rows clear while loading and on failures, with a retry message instead of stale
results. Filter generations reject responses from superseded searches in the same
login; session epochs reject prior-login results. Locking cancels debounce timers,
clears rows/cursors/filter values and scrubs private DOM. Search state is tab-only.

Activity **Export This Page (CSV)** downloads only the loaded matching page and
keeps the shared CSV protections. It is not a full audit export or backup. Complete
recovery uses [paired PostgreSQL archives](DATABASE-BACKUPS.md).

A previously missing `formatHistoryDate` helper is also restored. Nonempty
activity, user-status and recovery lists now format dates with the year and seconds
in the device timezone; invalid dates return a safe fallback rather than crashing
rendering. Nonempty activity rendering has default and Chromium regression coverage.

## Private GET contract

| Endpoint | Authentication | Filters |
| --- | --- | --- |
| Staff `/api/service-requests` | Current staff cookie/session context; account-lock recheck | `q`, `status` |
| QR `/api/requests` | Internal server-only bearer secret | `q`, `status` |
| Staff `/api/activity` | Administrator cookie/session context | `q`, `type`, `from`, `through` |

All three accept optional `limit` (integer 1–100, default 100) and `cursor`.
Search `q` is a literal case-insensitive substring of at most 128 characters;
SQL wildcard `%`, `_` and backslash characters remain literal. Request status is
`all`, `Pending`, `Completed` or `Cancelled`. Activity type is `all`, `data`, `user`
or `denied`. Activity bounds use canonical `YYYY-MM-DDTHH:mm:ss.sssZ` instants;
`from` is inclusive and `through` is exclusive and must be later than `from`.
Unknown/duplicate query keys, invalid enums/dates, oversized search/query/cursors
and malformed or mismatched cursors produce 400 after authentication. Public callers
cannot use validation or cursor knowledge to obtain private records.

Responses retain `requests` or `activity` and add `page: { limit, nextCursor }`.
A null next cursor means no further matching rows existed when that statement ran.
Send the returned opaque cursor with the same filters/page size for the next page;
changing filters requires starting again. Cursors encode a version, filter digest,
last timestamp and ID, with strict size/shape bounds. They are not secrets,
signatures, credentials or snapshot tokens; forged cursor anchors merely select
another position among records the caller was already authorized to read.

Queries bind values and order by stored timestamp descending, then ID descending.
The extra one-row fetch detects another page without a full count query. Original
ISO text ordering is preserved for compatibility; migrations do not normalize
historical timestamps/IDs. Reconcile non-UTC/malformed/oversized historical values
through MIG-01 before importing; malformed dates can fail date queries with a
redacted availability error. No API logs raw SQL errors or credential details.

The proxy accepts only this listing contract, forwards to its fixed configured
endpoint, rejects redirects and reads at most two MiB while holding its existing
account-authorization lock within a five-second upstream timeout. Historical rows
with excessively large metadata can exceed that budget and require operator
reconciliation; the browser cannot override the limit.

## Migration and remaining work

Apply tracker `0004_activity_pagination.sql` and requests
`0003_request_pagination.sql` with operator connections, then ship both apps and
staff assets together (version 65), then reload open staff tabs. Existing migration
checksums and rows are
preserved. Ordered timestamp/ID indexes support page navigation; QR also has a
status-first partial index excluding tombstones. No new runtime table grants or
backup table-catalog changes are needed. Restore verification includes the indexes
and new migration history.

Substring/date/category filtering can still scan many rows. The bounded page and
existing PostgreSQL statement timeout protect response size/long queries but do
not establish production capacity; representative sizing/search measurement is
DATA-06-SCALE. Retention/archival policy is DATA-06-RETENTION: no automatic purge is
introduced and the existing 25 inventory snapshots are not complete history.
QR status and tracker history remain in separate databases, but staff transitions
now use durable intents, receipts and server-owned recovery under DATA-02. See
[QR operations](QR-OPERATIONS.md) for the separate bounded operation queue, retries,
conflict review and version66 rollout. Request-page history scope remains as above;
committed receiver events and private operation records preserve confirmed changes.
