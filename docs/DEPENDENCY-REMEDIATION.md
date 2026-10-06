# Dependency review and local spreadsheet imports

Original dependency/import check on 2026-10-05 against merged main `e0a137f`. Evidence is in
[the refreshed advisory report](reviews/2026-10-05-dependency-remediation.json).
The original review remains historical evidence of the Worker/D1 dependency set.
Current source-map remediation is on `Dev/qr-source-map-security`, based on
`2719ba3` after owner merge of PR #24; see the current follow-up below.

Earlier publication finding on 2026-10-05 (America/Chicago): GitHub reported open high
runtime alert 162 for QR `source-map-js@1.2.1`. The reviewed
[advisory](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) describes indexed
source-map offset values blocking the event loop; versions below 1.2.2 are affected
and 1.2.2 is patched. At that check, tracker pinned 1.2.2 and QR still pinned 1.2.1.
Fresh production npm queries for both lockfiles still reported zero findings, so
those scanner results do not cover this GitHub finding. Application HTTP
reachability has not been established; do not equate a package match with a proven
application exploit. That finding was recorded with DATA-04 without bundling a
package upgrade into the session work.

## Current source-map correction

The QR lockfile now resolves `source-map-js` 1.2.1 → 1.2.2 within its existing
`^1.2.1` ranges. Only that entry's version/archive/integrity changed; no new direct
dependency, override, framework upgrade or forced audit fix was introduced. Its
integrity matches the verified registry release and the staff lockfile. Both
installed copies resolve to 1.2.2 after lockfile installs; staff's lock is unchanged.
GitHub alert 162 on main remains open until the owner merges/rescanning completes.
Do not manually dismiss it instead of updating the affected package.

`Next → postcss → source-map-js` makes this a runtime-classified transitive
dependency; Tailwind uses it too. PostCSS consumes source maps during CSS
processing. Repository API/import code has no source-map consumer and does not
feed customer submission/inventory/workbook data into PostCSS. This limits the
identified input path to framework/build CSS processing; it does not prove every
framework path safe or establish an HTTP exploit. Source maps relate generated
CSS/code positions to original files for tooling/debugging; they do not process
QR asset IDs or generate QR images.

Regressions resolve through each app's own PostCSS dependency. Malformed, enormous
and nested section offsets must reject. A valid offset far beyond a tiny generated
file must preserve its text without excessive work, checked in a child limited to
64-MiB old space and three seconds. Valid CSS maps retain original source text and
positions. These exercise patched behavior and ordinary compatibility rather than
only asserting a version string. Shared-device/persistence policy is unchanged.

Both production builds and TypeScript checks pass. Staff's default suite passes
42 checks, QR's passes 4, and optional Chromium passes 22. Changed regression code
passes focused lint; QR full lint passes with three inherited image warnings. Root
full lint's prior vendor errors/warnings remain QA-02; this task does not change
vendor files. PostgreSQL tests were not rerun: database/routes/authentication are
unchanged, and the patched CSS pipeline is exercised by builds/HTTP/browser checks.
Both production npm scans report zero; both full scans retain the same five
development-only chain findings for the single braces advisory. See
[current dependency evidence](reviews/2026-10-05-source-map-remediation.json).

## npm application dependencies

Both `npm audit --omit=dev --json` checks reported **zero known findings** after the
owner's earlier framework/transitive dependency merges. This describes the npm
runtime tree at the check time; it does not assess browser vendor assets, application
permissions, or future advisories.

The QR lockfile now updates `brace-expansion` 1.1.14 → 1.1.21 and 5.0.6 → 5.0.12
within the existing version ranges. The tracker already had those patched versions.
No framework downgrade or forced audit fix was used; installs/builds/types and
relevant regression checks passed with the existing Next/React versions.

One underlying [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
remains, with no published patch at review time. Each full npm audit represents it
as **five high-severity dependency-chain package findings**:

`eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch → braces@3.0.3`

All paths are marked development-only in both lockfiles. Source review finds
Next's ESLint helper consuming developer-provided `settings.next.rootDir` glob
configuration. This repository does not supply such a pattern; its HTTP routes
and browser file imports do not use this dependency chain. Keep lint/development
operations limited to reviewed configuration/source. This finding remains DEP-01
work until an appropriate patch or reviewed replacement is available; it was not
suppressed or declared fixed. npm's suggested ESLint-config downgrade to Next 14
would disrupt the current lint/framework setup and was not applied.

## Browser spreadsheet dependency

The former runtime CDN-loaded SheetJS 0.18.5 is replaced with the local full
0.20.3 build, checked against the official archive and pinned by digest/page SRI.
The [vendor provenance and license](../public/asset-tracker/vendor/README.md)
record official sources and the two addressed advisories. This keeps XLS support
and current import mappings. New versions need an intentional download/hash/license
review and the same regression checks; registry-only advisories cannot track it.

Parsing runs in a **browser Web Worker on the staff device**, loaded from the same
application. This adds no hosted worker service. The local library is also loaded
by the page for conversion utilities. Data is not uploaded for spreadsheet parsing.
The account picker now actually reads its advertised XLS/XLSX options as well as
CSV; aliases and leading-zero text/formatted Excel identifiers are preserved.
Master, West Texas A:N/grouped accounts, and audit heading/preamble mappings remain.

Limits reject oversized inputs with an error instead of offering a partial import:

| Resource | Limit |
| --- | --- |
| Input file | 10 MiB, nonempty |
| Parser time | 15 seconds, then terminate worker |
| ZIP archive entries | 2,048; single-disk ZIP without ZIP64/encryption |
| ZIP expansion | 32 MiB per entry / 64 MiB total; declared and actual streamed deflate output checked |
| Workbook sheets | 32 |
| Worksheet rows including headings/preamble | 20,001 |
| Worksheet/CSV columns | 256 |
| Populated workbook cells / CSV fields | 200,000 |
| Cell text | 8,192 characters |

XLSX archives are preflighted before SheetJS parsing; compressed-stream support
requires a current browser. Rows beyond the configured worksheet limit are detected
with original-range/sentinel checks. CSV scanning enforces limits as records grow.
Formula source, generated rich HTML, and hyperlink objects are omitted; displayed
text still passes through the staff UI's escaping. Spreadsheet values are not
executed as code or formulas by this importer. Existing CSV **export** formula
neutralization and import count/capacity corrections remain DATA-05.

Staff using larger/wider workbooks must export only the needed sheet/columns or
split files and review each preview. Initial server inventory still must satisfy
SEC-03 schemas/capacity under MIG-01. This work does not change production records,
workbook contents, server permissions, or the existing import apply semantics.

## Historical SheetJS validation and remaining checks

Both native builds and TypeScript checks passed. Tracker: 35 unit/HTTP checks;
QR: 1 HTTP check. Chromium: 11 checks (nine scenarios plus two parents), including
actual local Web Worker parsing and Master/West Texas/account/audit file-input
previews with external requests blocked. Tests use synthetic workbooks/GPS/session
and API fixtures; real database permissions remain the existing PostgreSQL suite.
That suite was not rerun because runtime database dependencies/routes did not change.

Focused changed-source/test ESLint checks pass. Full lint retains its known issues:
tracker 2 vendor errors/147 warnings; QR 2 effect-state errors/3 image warnings.
The new unchanged vendor bundle is explicitly excluded from application coding
rules and verified by digest/import regressions instead. QA-02 and physical iPad/
mobile/label acceptance remain separate work. No production deployment occurred.
