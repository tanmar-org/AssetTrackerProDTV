# Shared-device sessions and browser data

The staff page starts with empty inventory and an inert workspace. It opens only
after server sign-in and a successful authenticated inventory read. A failed first
read offers retry/sign-out; it does not open older browser records. An empty server
stays empty until an administrator adds/imports reconciled data. Sample records
and automatic uploads from device-wide caches have been removed.

## Current data and unsaved work

Inventory, audit results, rental stock, Undo, import previews, and manual email
preferences stay in tab memory. New operational data is not written to
localStorage/sessionStorage. Confirmed saves remain in PostgreSQL; browser memory
and inventory exports are not database backups.

Keep a tab with unsaved work open. Before closing, reloading, or signing out, use
**Settings → Download Snapshot**. A before-unload prompt warns about pending work,
but browser/OS termination can still lose it. Paused drafts now attempt an
account-owned server copy; **Recovery copy confirmed** protects only acknowledged
edits across reload. **Settings → Review Paused Edits** offers explicit three-way
comparison and apply/discard. See [draft recovery](DRAFT-RECOVERY.md) for seven-day
expiry, quotas, role checks and lost-acknowledgement handling. Fully offline edits
still need an export; this is not an offline-capable application.

On session expiry, verification failure, another tab's user switch, or a frozen
page leaving the screen, the page clears private display and locks. An unsaved
draft can remain quarantined in memory for the original employee's stable user ID.
After that employee signs in again, the draft is available for export or explicit
review with sync paused. It is never automatically replayed against the new session/revision.
A different employee must confirm discarding it or cancel so its owner can export.
The memory quarantine does not survive reload/tab closure; confirmed server copies
remain accessible only to their owner. It is a workflow boundary,
not protection from someone controlling the browser or its developer tools.

Sign-out locks immediately, clears inventory/Undo/previews/selections, resets
hidden dialogs/forms/mail drafts, removes print frames, cancels parser workers,
aborts staff requests, and cancels save/poll timers. Every awaited staff response
and file import also checks its session generation, so a late result cannot refill
the display or change the next employee's workspace. A submitted save may already
have committed before sign-out; clearing the tab does not undo a server commit.
Sign-out does not delete account-owned recovery copies.

## Confirming sign-out and changes in other tabs

Sign-out requires a successful server acknowledgement. A connection failure keeps
the page locked with **Retry Connection** and hides login. A small non-bearer
pending marker survives reload; this tab also uses window.name if browser storage
is unavailable. After confirmation, a marker prevents an old cookie/late login
response from automatically reopening this tab. A deliberate successful login
clears it. If older storage cannot be erased, the gate tells the operator to clear
this site's browser data before handoff.

BroadcastChannel and storage events notify other tabs of login/logout. Session
identity is also checked every 12 seconds and on focus, including while inventory
sync is paused; failed verification locks the display. A restored frozen page must
verify access again. Events/timers are best effort on suspended devices; server
authorization remains required for every request.

GET/POST `/api/auth` returns `sessionContext`, a domain-separated SHA-256 digest
of the current cookie token. It cannot authenticate, is distinct from the stored
token hash, and exposes no PIN or bearer token. All staff mutations, including
users, recovery, inventory, and QR proxy mutations, require
`x-tracker-session-context` matching the actual HttpOnly cookie. Reads check the
header when supplied. A valid cookie and current role are still required.
Same-user re-login creates a different context too: an old tab cannot write under
a newer shared cookie. DELETE `/api/auth` requires context when a cookie is present;
a stale context receives `sessionChanged: true` without deleting/clearing the new
cookie. Logout takes account advisory lock `728303`, as staff writes do, so a save
commits before logout or rechecks a revoked session afterwards.

Ship the server/UI together and reload all older tabs. Older integrations that
mutate staff APIs must fetch the context after login and supply this header.
Do not log cookies/PINs or substitute the context for real authentication. Login
traffic policy and company SSO/outer access controls remain AUTH-01.

## Older browser caches and rollout

Historical `atp.*` records and the old manual-email preference are quarantined:
they are not rendered, used for Undo, or uploaded. An authenticated administrator
can use **Settings → Export Older Data** to download raw key/value records for
manual reconciliation, then **Remove Older Data**. This raw export preserves
unknown old formats; it is not directly accepted by Restore App Data. Regular
employees should ask an administrator to review unowned older records.

Explicit sign-out warns before discarding unsaved work/older data and removes
known application keys, preserving unrelated browser storage. Export relevant
older data before signing out. Complete this cleanup on each previously used
device before handoff; ignored legacy caches still exist on disk until removed.
Browser-managed downloads, previous printouts, other origins/profiles, HTTP caches,
and old copied exports require their own retention/cleanup policy. No live data,
browser profiles, or production services were changed by this implementation.

Real PostgreSQL regressions verify cookies, context mismatch/non-bearer behavior,
shared-cookie switches, revocation and logout locking. Optional Chromium tests
exercise storage quarantine/export/removal, DOM cleanup, denied storage, failed
logout/reload/retry, other tabs, original-owner draft export, late reads/imports/
saves, failed initial reads, frozen-page events, and paused-session expiry. Mobile
browser/physical-device acceptance remains QA-01.
