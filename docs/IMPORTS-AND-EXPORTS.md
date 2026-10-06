# Inventory imports and spreadsheet reports

Imports change the current tab's draft first. Accepted/updated/skipped totals
refer to those local changes; the sync indicator confirms the server save.
Server validation, role checks and expected revisions still apply. A rejected or
conflicting save pauses sync and keeps the draft for explicit recovery/export.
Resolve or export a paused draft before applying another import.

## Master Registry and West Texas

Import Center requires an administrator. XLSX/XLS parsing uses the pinned local
reader and bounded browser worker; see [parser limits](DEPENDENCY-REMEDIATION.md).
Master uses named columns. West Texas reads A:N: B asset number, C card, D serial,
E RID, F type, G model, H account number, I account name, M office and N notes.
Account headers carry forward within a group. A new account number resets the
carried name, preventing a blank name from inheriting another customer's name.
Missing names generate `Account <number>` only when creating a new account.

Preview and Apply share the same row planner. Invalid/missing identifiers,
oversized/invalid mapped text, duplicate assets and capacity-blocked rows are
shown as skipped. Identifier values remain text, including formatted leading
zeroes. Duplicate handling uses the first valid occurrence; a capacity-blocked
occurrence also reserves its asset's place so a conflicting later row cannot
silently redirect it. Account/asset matching is case-insensitive, consistent with
server uniqueness. Original existing account numbers are preserved.

West Texas simulates assignments/moves in file order, including capacity used or
freed by earlier accepted rows. A receiver already in its target account needs
no extra slot. New destinations have a maximum of 20 receivers too. A move out
later in the workbook does not retroactively make an earlier skipped row eligible:
review/reorder the source and prepare a new preview when necessary.

Apply considers only preview-eligible rows and rechecks them against current tab
state. If an account became full meanwhile, its newly blocked row makes **no**
registry, account, assignment, metadata or history change. A preview-skipped row
stays skipped even if room later opens. Server changes made by other employees
are handled by the existing revision-conflict/recovery workflow.

Accepted rows create/update nonempty model, card, RID, serial, type and notes;
West Texas also uses nonempty account name and office. Blank cells preserve
existing values, condition, rent status and account location. West Texas moves
retain assignment IDs, update assignment time and append receiver history with
source/destination account context. New assignments append history. Existing
history is retained subject to the existing 20-events-per-receiver limit.

Master totals distinguish new, updated, unchanged and skipped records. West Texas
completion distinguishes new assignments, moves, receivers already in the target,
skips and new registry receivers. Skips from preview and from the fresh Apply
check are both counted. No-op/all-skipped imports do not manufacture a save.
Preview displays at most 200 rows, with an explicit truncation message; totals
cover the entire file. Collection/payload bounds remain server-enforced and can
still reject a large combined import. Split large files and reconcile exports
rather than assuming local preview guarantees acceptance.

## Single-account imports and TQ

Single-account CSV/Excel imports remain bound to the account used for preview.
An account change during reading or before Apply requires a new preview. Capacity
and existing assignments are checked again before adding/updating registry data.
A receiver assigned elsewhere is skipped; use Move explicitly.

Regular users can import one eligible receiver per operation, matching the
server's existing everyday-edit policy. Administrators may import up to the
remaining account capacity. Previews and completion explain blocked/skipped rows,
and new assignments append receiver history. The server remains the authority;
this UI change does not expand permissions.

TQ imports affect rent status only. Completion distinguishes changed, unchanged,
skipped and company-wide ignored receivers. Duplicate source rows are explicitly
skipped; receivers removed after preview are counted as skipped at Apply. Existing
stock reconciliation/history behavior and missing off-rent timer repair are retained. A no-op report does not create
an inventory save unless stock reconciliation itself changes data.

## CSV reports

Account reports, audit discrepancy reports and activity downloads share one CSV
cell encoder. Every field is quoted and internal quotes are doubled. Formula-like
prefixes (`=`, `+`, `-`, `@` and their full-width variants), including leading
whitespace/control variants, receive a tab **inside** the quoted field. Leading
control characters receive the same protection. Numeric text with leading zeroes
or at least 16 digits is also protected to reduce spreadsheet conversion/loss of
precision; actual numeric counts remain numeric-looking fields. Original inventory,
notes and identifiers are not rewritten. No formula-based identifier wrapper is
emitted.

The in-field tab follows the Excel-oriented approach documented by
[OWASP's CSV injection guidance](https://community.owasp.org/attacks/CSV_Injection).
Spreadsheet behavior varies, and saving/editing/reimporting a report can change
its protections or formatting. These reports are for human viewing, not lossless
machine interchange: a CSV parser will see the protective tab as part of the
field. Target Excel/other spreadsheet acceptance remains QA-01. Automated checks
verify output bytes, field boundaries and text values, not desktop Excel behavior.

Use the JSON inventory snapshot for exact operational values and
[complete PostgreSQL backups](DATABASE-BACKUPS.md) for users, requests, logs,
history and disaster recovery. Neither a spreadsheet report nor an inventory
snapshot is a complete database backup. Reload staff tabs after shipping asset
version 64 with the matching server/UI.

## Verification

Default regressions exercise the actual browser functions together with the
server inventory validator and everyday permission checker. They cover full/new
accounts, aged previews, file-order moves, duplicates/invalid fields, nonempty
metadata updates, grouped names, leading-zero IDs, history, one-receiver ordinary
imports, paused drafts and all three CSV paths. Chromium uses real local parser
workers/file inputs, Apply buttons, recorded PUT/PATCH requests and downloaded
CSV files with outside traffic blocked. Real PostgreSQL tests cover server
permissions, revisions, persistence and recovery separately. No live records are
used for these checks.
