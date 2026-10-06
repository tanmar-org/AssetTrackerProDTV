# Recoverable staff QR actions

Completing, cancelling, reopening or deleting a **saved public QR request** is a
staff action. Public scanning/submission and staff label generation remain separate
flows. This policy covers consistency between the request database and the tracker.
Manual inventory requests still use the normal inventory save transaction.

## Acceptance and recovery

The browser supplies an operation UUID, the displayed request version and its
inventory revision. The tracker rechecks the real session/context and role after
taking account lock `728303`, then checks current inventory under lock `728302`.
It privately loads the authoritative request and validates anticipated history
before committing a durable intent in `app_service_operations`. No cookie, PIN,
session token or bearer credential is stored with an operation.

Only **after that commit** may the coordinator change the QR database. Its private
versioned command contains the same immutable UUID, request ID, expected version,
status and notes. QR receipt lookup and mutation share one five-second attempt
budget; redirects are rejected and internal JSON is capped at 32 KiB. Request
versions prevent stale transitions. A QR transaction commits its transition and
`service_request_operations` receipt together. Reusing the UUID returns the original
receipt/time; changing its payload is rejected. Permanent version/missing-request/
pending-uniqueness failures also get receipts and do not mutate the request.

The tracker reads that proof and commits current inventory, receiver history,
normal derived rental-stock release, audit and operation completion together.
An interrupted response, process exit or failed tracker commit leaves a durable
intent and/or QR receipt for the next attempt. Completed operations are never
applied again. There is **no transaction spanning both databases**: a QR change can
be visible before tracker history finishes. Recovery provides eventual consistency
when both services are available and any recorded conflict is resolved.

## Staff behavior

The Services view shows a **QR Synchronization** queue (100 rows per page), with
Unfinished/All/Saved/Rejected filters, literal search, Previous/Next and View record.
The request row disables further actions while its intent is unresolved. Staff
must save or review local inventory drafts before submitting a QR action. The
browser does not create QR history or rent changes locally; it refreshes server
inventory after acknowledgement and preserves edits started during that request.

| Phase | Meaning and action |
| --- | --- |
| Waiting (`pending`) | Intent accepted; QR confirmation or tracker history is incomplete. Retry safely or let the VM reconciler retry. |
| Approval needed (`blocked`) | The approving account is inactive/lacks required access, or restore requires review. An administrator can inspect and approve retry. |
| Rent status review (`needs_review`) | QR change is confirmed, but receiver rent status/timer changed while waiting. Review before recording history. |
| Saved (`done`) | Receipt and matching tracker history/audit are committed. Replays return this result. |
| Rejected (`failed`) | QR refused this specific versioned intent. Refresh the request and review before submitting a new action/UUID. |

A confirmed completion never overwrites a rent state/timer that changed while it
waited. The initiating account or an administrator may explicitly choose **Record
history; keep current rent status**, supplying a fresh inventory revision. This
records the confirmed request event and preserves current rent fields. A stale
review is rejected. It cannot force another QR write or override current rent.

Receiver association is resolved once at acceptance: stable ID first, legacy asset
number only when the old request has no ID. Renaming or reusing numbers cannot
redirect later history. If the associated receiver is absent/deleted, the receipt,
authoritative request snapshot and audit remain in the operation record, with
`historyScope: operation`; no receiver is invented. Current inventory history
keeps its existing 20-per-receiver/20,000-total bounds. The operation/receipt tables
are retained without automatic purging; archiving/storage sizing remains DATA-06.

Only the initiating account or an administrator may retry/review. Delete acceptance
and unconfirmed delete retry require an administrator. Before a new QR write, the
coordinator rechecks the current approving account under the account lock.
Deactivation/demotion blocks unconfirmed work. An administrator may reapprove,
preserving original actor and new approver separately. Logout alone does not cancel
an already accepted asynchronous action. An already committed QR receipt can finish
factual history after logout/deactivation, without initiating another QR mutation.

Unconfirmed commands stay only in tab memory and reuse their UUID/body. Session
lock clears them, queue/detail DOM, filters and late responses. Server queue entries
survive reload/logout. Lost acknowledgement is not proof that no intent exists:
inspect the queue before creating another action. Offline browser edits still need
the existing export/draft-recovery flow; the queue is not general offline storage.

## Private API contract

- Tracker `PATCH /api/service-requests`: JSON `{id, status, notes, operationId,
  expectedVersion, baseRevision}`; status is Pending/Completed/Cancelled.
- Tracker `DELETE /api/service-requests?id=...`: JSON `{operationId,
  expectedVersion, baseRevision}`, administrator only.
- Both require the real session cookie/context, an 8-KiB streamed JSON body and
  fresh inventory/request versions when accepting a new intent. Unknown fields
  are rejected. Notes are preserved text up to 2,048 characters. Same-owner replay
  of an identical accepted UUID ignores a now-outdated inventory revision.
- Responses with `accepted: true` contain the operation: 200 Saved, 202 unfinished
  or review needed, 409 permanently Rejected. A 409 without acceptance is a failed
  preflight/conflict; an outage with no acknowledgement may be ambiguous.
- Tracker `GET /api/service-operations`: authenticated bounded pages; optional
  `status=active|all|pending|blocked|needs_review|done|failed`, `q`, `limit` (max 100),
  filter-bound `cursor`. Default API status is all; the UI defaults to active.
- Tracker `GET /api/service-operations?id=<UUID>`: private summary and request
  snapshot/receipt. POST with `{id, mode: "retry"}` retries; POST with
  `{id, mode: "history-only", baseRevision}` explicitly reviews a rent conflict.
- QR `GET /api/requests/item?id=...` privately loads one live request. QR
  `GET /api/requests/operations?id=<UUID>` reads a receipt; PATCH on that endpoint
  accepts `{operationId,id,kind,expectedVersion,status,notes}` (kind status/delete,
  null status for delete). All require the configured server bearer credential.
- Old direct QR PATCH/DELETE `/api/requests` return 410 after bearer authentication.
  Public POST/private paged GET remain. Reload old staff tabs and update private
  integrations rather than restoring unversioned writes.

## VM reconciliation and rollout

Apply tracker `0005_service_operations.sql` and requests
`0004_operation_receipts.sql` as their migration owners. Grant explicit runtime
SELECT/INSERT/UPDATE/DELETE on the corresponding new table. Deploy compatible QR
and tracker builds/UI together and reload staff tabs (asset version 66). Read
[self-hosting](SELF-HOSTING.md) and [backups](DATABASE-BACKUPS.md). No web request runs
DDL. Older uncoordinated mutations cannot be retroactively made recoverable; review
historical status/history mismatches during MIG-01.

From the repository root, with private tracker runtime environment:

```bash
npm run service:reconcile
npm run service:reconcile -- --watch
```

The command loads ignored `.env.local` if present and requires tracker runtime
`DATABASE_URL`, `SERVICE_REQUEST_API_URL` and matching `ADMIN_SHARED_SECRET`.
One pass processes up to 10 due entries; watch repeats after a 15-second pause.
Failures back off up to 300 seconds; rent conflicts and restore review stay paused.
Logs contain aggregate counts or fixed errors, never request details/driver output.
SIGTERM/SIGINT finish the in-flight bounded attempt, stop between operations and
close the database pool. Multiple processes are safe but share the account lock;
the batch size is not permission to perform ten concurrent remote writes.

HOST-04 must install/supervise this process as a restricted service user, keep its
environment private, restart it on failure and monitor readiness, old unfinished
entries, repeated failures and conflicts. This PR supplies the command; it installs
no production service/schedule. Manual Retry works independently. The loopback test
cluster and browser are development tools, not deployment or mobile acceptance.

Both new tables are included in explicit paired backups and isolated restoration.
Since the two snapshots may capture different moments, restore pauses all unfinished
tracker intents with `restore_review` before granting runtime access. The reconciler
skips them until administrator approval. Inspect matching receipt/request/inventory;
Retry can then finish from proof or safely attempt a versioned command. If rent
differs it pauses again for explicit history review. Completed historical operations
are not automatically recreated if inventory recovery later removes their events.

## Verification

Default tests exercise immutable commands/snapshot bounds, stable associations,
ordinary permissions, rent/stock/history retention and absent receivers. Real
PostgreSQL/HTTP tests use separate restricted roles and independent Node processes,
lose acknowledgement after QR commit, fail tracker audit, invoke a fresh CLI
process, check logout/deactivation/demotion and administrator approval, test rent
conflicts, missing receivers, competing versions/reopens, archival, restored pause,
streamed bounds and paged operation history. Backup drills retain proof and verify
the restore guard. Chromium checks actual controls, no local QR save, UUID reuse,
reload, review, truthful error handling, draft preservation and private DOM cleanup.

The QR uniqueness rejection uses a savepoint inside its receipt transaction; review
the [PostgreSQL savepoint contract](https://www.postgresql.org/docs/18/sql-savepoint.html)
and [transaction/row locks](https://www.postgresql.org/docs/18/explicit-locking.html)
when changing these boundaries. Do not remove version/receipt protection, make
browser list reads drive mutations, blindly replay restored work, or purge proof
without a reviewed retention policy.

The [managed service runbook](PRODUCTION-SERVICES.md) supplies the reconciler
systemd unit with a separate non-login UID and tracker-runtime-only credential
file. The supervisor forwards shutdown signals and allows bounded work to finish;
no AD reader, ingress or migration credential is supplied to that worker.
