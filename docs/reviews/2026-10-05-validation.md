# Development foundation validation — 2026-10-05

Baseline: `main` at `b3d86eb3eb05134e42c6f475e5a3dbe47df6a7e5`.
Branch: `Dev/project-foundation`. VM tools: Node v24.21.0, npm v11.19.0,
GitHub CLI v2.102.0. The first PR changes documentation and code comments.

| Check | Tracker/root | QR service |
| --- | --- | --- |
| `npm run install:ci` | PASS: 503 packages, exit 0 | PASS: 503 packages, exit 0 |
| `npm test` | PASS: build/artifact validation and 1 test, exit 0 | PASS: build/artifact validation and 1 test, exit 0 |
| `npm run lint` | FAIL: 9 errors, 1,825 warnings, exit 1 | FAIL: 2 errors, 3 warnings, exit 1 |
| `./node_modules/.bin/tsc --noEmit --incremental false` | FAIL: 11 diagnostics, exit 2 | FAIL: 4 diagnostics, exit 2 |

Both install commands preserved their committed lockfiles. npm warned about deprecated
inherited esbuild-kit packages and package install-script approvals; the installed
Linux dependencies were sufficient for both verified builds. No tracked font-cache
files changed. The Worker build/test commands ran outside the restricted execution
sandbox because local runtime startup and font downloads may require that context.

The root lint command also scans the nested QR build's generated JavaScript.
Repeating it with `npm run lint -- --ignore-pattern '**/dist/**'` removed generated
bundle findings but still failed with **4 errors and 150 warnings**: two errors in
the vendored barcode library and two QR React effect-state errors. Root lint includes
the QR sources as well. The QR-only lint reports those two effect errors and three
ordinary-image warnings. No lint autofix or suppression was applied.

Type diagnostics concern missing `D1Database`/`Fetcher` declarations, unresolved
`cloudflare:workers`, and implicit-any callbacks. Root TypeScript configuration
includes the nested service source. These inherited checks need repair (QA-02);
a successful Vite bundle does not establish type correctness.

Additional checks passed:

- TypeScript compiler AST comparison of all 17 changed JS/TS/TSX/MJS source/test
  files against baseline HEAD, ignoring comments and source positions. Executable
  syntax was identical. The temporary comparison script lives outside the repository.
- `node --check public/asset-tracker/app.js` and
  `node --check public/asset-tracker/service-request.js`.
- `git diff --check`.
- Earlier read-only review: four tracker and three QR SQL migrations applied to
  separate in-memory SQLite databases; tracker HTML IDs/literal references checked.

The existing tests cover a built tracker redirect and rendered QR development
metadata. They do not prove authentication, D1 API correctness, concurrency,
security, imports, backup recovery, GPS/email, mobile usage, or label printing.
Those checks belong to the corrective tasks and QA-01. No production services or
databases were contacted, migrated, or deployed by this foundation task.

Detailed command logs are temporary VM files under `/tmp/assettracker-*-*.log`;
this record preserves outcomes independently of those logs.
