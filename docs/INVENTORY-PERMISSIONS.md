# Inventory permissions and validation

This describes the implemented policy for owner review. It preserves regular
staff's everyday editing tools while requiring administrators for replacements
and destructive operations. It is enforced by server roles, HTTP methods, and
persisted record differences; browser button visibility and action labels do not
provide authority. Company authentication decisions remain under AUTH-01.

| Operation | Regular staff | Administrator |
| --- | --- | --- |
| Read inventory | Yes | Yes |
| Add/edit one account | Checked PATCH | PATCH or PUT |
| Add/edit one receiver, assign/move/unassign it | Checked PATCH, with related history/service changes | PATCH or PUT |
| Create/edit/complete/cancel/reopen one manual service request | Checked PATCH | PATCH or PUT |
| Run/update structured audit research | PATCH; does not authorize bulk inventory changes | PATCH or PUT |
| Issue one rental-manager batch of known receivers | PATCH with its history | PATCH or PUT |
| Release stock on an On Rent transition; complete an exhausted batch | Checked deterministic reconciliation | Yes |
| Remove stock, change batch metadata, or rewrite prior batches | No | PUT |
| Import/replace inventory, restore a snapshot, Undo, or clear inventory | No full replacement | PUT |
| Delete a local service request | No | PUT |
| Restore server history | No | `/api/recovery` POST |
| Read/update QR request status | Session-protected proxy GET/PATCH | Yes |
| Delete QR requests | No | Proxy DELETE |

## API contract and trust boundaries

`/api/app-state` GET returns validated state and its revision. PUT and PATCH accept
`{ state, baseRevision, action? }`; revisions must be nonnegative safe integers.
PUT is administrator-only, including the initial inventory insert. PATCH requires
an existing document and allows one logical everyday operation. Multiple receiver
changes, account-plus-unrelated-receiver edits, changing an assignment's receiver
identity, and deletions/restores are rejected. Issuing one stock batch is an explicit
exception for multiple associated receiver-history entries.

PATCH descriptions are generated from actual differences. `action` is a bounded
administrator description on PUT, not a capability. No-op saves return the existing
revision/metadata and create no history/audit entries. Denied ordinary operations
record a server-generated denial. Newly appended history receives the current
session's name; stored attribution remains authoritative even if a browser holds
an earlier display name. Other existing history fields cannot be rewritten through
PATCH. Only deterministic 20-events-per-receiver/20,000-total pruning is allowed.

Account authorization lock `728303` precedes state lock `728302`. Writes and
recovery recheck the actor after acquiring the account lock and hold it through
commit, so queued privilege/session changes cannot use stale authorization. State,
prior history, and audit share one transaction with revision predicates. The proxy
uses the account lock through its upstream response and a five-second timeout;
its target and bearer credential come only from server configuration. Public QR
submission abuse/asset lookup remains SEC-05/QR-01, outside this staff policy.

## State schema and bounds

The only top-level collections are `master`, `accounts`, `assignments`,
`activations`, `receiverEvents`, `auditState`, and `rentalStock: { batches }`.
Unknown fields/collections are rejected rather than silently omitted. Each
record uses known typed fields, bounded strings, safe record IDs, and valid ISO
dates. Receiver/account/card/RID/serial identifiers remain text, preserving leading
zeroes. Rent/condition/request/batch/issue status values are explicit enums.

The server enforces:

- Unique IDs per collection, case-insensitive asset/account numbers, and one
  assignment per receiver; all live assignment/service/history/stock references
  must point to existing receivers/accounts where applicable.
- At most 20 assigned receivers per account, including Off Rent receivers.
- One active rental batch; unique batch numbers, consistent item/receiver/removal
  sets, original counts, and completion status/dates. Regular users cannot alter
  previous stock metadata/removal history to bypass the policy.
- Structured audit snapshots with unique issue IDs and consistent comparison
  counts. These are historical comparisons, not automatically verified live state.
- HTTPS Google Maps links only in service history; no script URLs or arbitrary
  external domains. Legacy public/static-page injection remains SEC-04.

Inventory request bodies have an 8-MiB streaming byte limit. General inventory,
assignment, history, stock-item, and audit-issue limits are 20,000 records;
accounts/manual requests allow 10,000 and stock batches 1,000. Audit results allow
10,000 accounts but at most 20,000 total issues. Notes cap at 2,048 characters;
other fields use smaller explicit limits in `lib/inventory-state.ts`. Access and
proxy update bodies retain 4 KiB. These are server bounds, not capacity forecasts.

Validation applies to reads, admin replacements, ordinary edits, and recovery.
Errors identify the field path without echoing rejected values. There is no new
SQL migration for this change. Existing data/history that violate these checks
must be reconciled explicitly under MIG-01 before import/restore; incompatible
recovery cannot silently overwrite current inventory. No live data was inspected
or repaired by this implementation.

## Browser saves and inventory snapshots

The staff UI sends admin replacements through PUT. Regular edits capture one
snapshot after each browser event and send PATCH requests in order using the last
acknowledged revision. The in-memory queue is bounded at 32 operations; an overflow
pauses syncing while retaining the current local draft. Transient service failures
retry. Validation, permission, and revision failures pause retry/polling and retain
local data instead of automatically replacing it with the shared copy.

When syncing is paused, use **Settings → Download Snapshot** before reloading,
then have an administrator reconcile the snapshot with current shared data. On
session expiry, sign in again to access the retained draft; sync remains paused.
Queue order is memory-only and is not restored after reload. Durable offline edits,
conflict-resolution UI, storage-quota failures, and shared-device cache policy
remain DATA-01/DATA-04 tasks; this is not an automatic merge or a complete backup.

Exports and new Undo entries include audit and rental stock. Admin clear resets
stock with the other inventory collections, avoiding dangling links. An older
snapshot/Undo entry may omit stock or audit; the UI warns that restoring clears
missing collections. The format remains compatible with existing schema-version-1
exports, with explicit handling of those omissions. Database users, sessions,
server logs/history, and the separate QR database still require operator backups
and isolated restore verification under DATA-03.

Ship the staff UI and server together and reload older clients: a regular client
that still sends PUT will receive 403. Production deployment remains a separate,
owner-authorized task.
