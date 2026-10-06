# Paused inventory drafts and conflict review

When two employees save against the same revision, the first save commits and the
second pauses. The second employee's draft remains visible in their tab. The app
attempts to save an account-owned recovery copy after a permanent rejection or
queue overflow, and after further edits while paused. Normal saves still use the
ordered PATCH queue for regular users and PUT for administrators.

## Staff workflow

1. Open **Settings → Review Paused Edits**. Check the status: only **Recovery copy
   confirmed** protects those acknowledged edits across reload. A failed save or
   newer unconfirmed edits require **Download Snapshot** before leaving.
2. Choose **Save and Review My Draft**. This pauses automatic inventory saving,
   saves a private copy, and asks the server for a fresh comparison. After a reload,
   choose **Open for Review** beside one of your saved copies. Nothing is replayed
   automatically. Opening another copy first saves the current tab's draft. Opening
   the same copy explicitly replaces tab contents after a warning; export first
   if it may omit newer work.
3. Review **Original**, **Your draft**, and **Shared now**. Other employees' edits
   to fields you did not change are preserved. Different values changed by both
   people require an explicit choice. You can also choose the shared value for a
   nonconflicting edit to discard that part of your draft.
4. **Apply Reviewed Choices** checks the draft version, current inventory revision,
   schema and current role again. If shared inventory changed since comparison,
   apply stops and the draft remains available for a fresh review. Successful apply
   writes inventory/history/audit and closes the copy in one transaction.
5. **Discard Draft and Load Shared** explicitly discards this tab's work and copy.
   It loads shared inventory before deleting the copy; a read/deletion failure
   retains the local work. **Discard Copy** removes another saved copy without
   writing shared inventory. Changed copies cannot be silently discarded using
   a stale version.

Download Full Comparison exports all original/draft/shared values in a reviewed
change list; table cells truncate after 600 characters. The UI shows at most 200
choices and disables apply for larger comparisons: download the comparison and
inventory snapshot for administrator reconciliation. Exports contain private data
and require appropriate handling on the staff device.

Regular users retain existing permissions: one everyday logical operation at a
time, including linked assignment/history/stock changes already allowed by the
inventory policy. Saving a recovery copy never authorizes bulk replacement. A
mixed/bulk apply is rejected and audited; the copy stays active. The employee may
explicitly discard other changes from the comparison to retain one operation, or
export for administrator reconciliation. Administrators cannot read other users'
drafts through these endpoints; they can review an intentionally shared export.

## Persistence and shared-device boundaries

The server stores copies in tracker table `app_inventory_drafts`. No operational
payload is written into browser localStorage/sessionStorage. Copies are authorized
by the current cookie's user ID, including list/read/update/delete/preview/apply;
supplied ownership fields are rejected. Mutations require matching session context.
Account lock 728303 is taken before inventory lock 728302, and authorization is
rechecked after waiting and held through commit.

Each tab creates its own UUID. Copy updates use an expected version; inventory
application uses the fresh expected revision and choices recomputed on the server.
Record arrays join by stable ID. Add/delete conflicts review whole records; audit
and rental stock review whole collections to preserve their linked structure.
New local receiver events stay ahead of existing shared history, preserving the
everyday append/prune policy and server-owned attribution. Local array-only
reordering is not a recoverable inventory change. Invalid merged
links, duplicate identifiers, capacity violations or malformed data are rejected.

An interrupted acknowledgement can leave the copy committed while its local
version remains zero. The tab retains its ID. Refresh Saved Drafts and explicitly
open that server copy after the warning; export first if newer edits are needed.
This does not silently retry/replay an uncertain inventory operation.

Session lock scrubs comparison tables, lists, status and payloads from active UI,
aborts outstanding requests and cancels draft timers. Memory quarantine retains
the original owner's baseline/copy/version only for same-owner reauthentication.
Saved server copies are offered only after verified sign-in/current inventory.
Sign-out discards tab memory; account-owned server copies remain until explicitly
closed or expired. Another employee cannot acquire those copies by using the same
browser. A submitted operation may commit before its response is interrupted.

## Limits and rollout

- Copies expire **seven days after creation**, including subsequent edits. Expiry
  makes them inaccessible; successful owner requests clean up expired rows. There
  is no scheduled purge yet, so inactive users' expired physical rows may remain.
  Operator retention/backups must account for this; expiry is not secure erasure.
- Maximum **five active copies**, and **20 retained IDs** per account within the
  seven-day window. Closed copies erase their payloads/labels immediately and
  retain version/ID tombstones to reject delayed resurrection. Reaching the total
  ID limit requires expiry; discarding frees only an active-copy slot.
- Each baseline/draft is bounded to **8 MiB**; the streamed checkpoint request is
  at most **16 MiB + 4 KiB**. Apply/other mutations have an 8-MiB request budget,
  and the final inventory also stays within 8 MiB.
- Fully offline edits cannot reach PostgreSQL and remain tab-only until exported
  or a connection returns. No durable device cache, service worker, automatic
  replay, or transactional cross-database QR reconciliation is implemented.
- Draft copies and 25 inventory history versions are not complete backups.

Before approved deployment, apply tracker migration `0003_inventory_drafts.sql`
using the operator connection, grant the runtime role data access on the new table,
ship server/UI together, and reload staff tabs (static asset version 63). Tracker
readiness checks the new table. See [self-hosting](SELF-HOSTING.md). No production
database, service, or browser profile is modified by merging this change.

Regression coverage includes pure three-way merge rules, real PostgreSQL ownership/
CAS/quota/expiry/authorization/rollback/concurrency, and Chromium reload recovery,
choices, stale comparisons, denied apply, unavailable/lost acknowledgements, late
session responses and safe discard. Real mobile/device acceptance remains QA-01.
