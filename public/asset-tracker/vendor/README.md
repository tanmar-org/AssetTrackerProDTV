# Local browser libraries

## Spreadsheet reader

`xlsx-0.20.3.full.min.js` is the unchanged SheetJS Community Edition **0.20.3**
full standalone build, downloaded from the publisher's authoritative HTTPS CDN.
The full build preserves XLS/XLSX/CSV and code-page support; the mini build omits
older XLS formats. The staff page and browser parser worker both load this local
file. They make no spreadsheet CDN request at runtime.

Upstream sources checked on 2026-10-05:

- [Official standalone/vendoring instructions](https://docs.sheetjs.com/docs/getting-started/installation/standalone/).
- [Standalone script](https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js).
- [Release archive](https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz).
- [Prototype-pollution advisory](https://cdn.sheetjs.com/advisories/CVE-2023-30533): fixed in 0.19.3.
- [Regular-expression denial-of-service advisory](https://cdn.sheetjs.com/advisories/CVE-2024-22363): fixed in 0.20.2.

The standalone bytes exactly matched `package/dist/xlsx.full.min.js` inside the
separately downloaded release archive; its package manifest reported 0.20.3.
Digests below pin the retrieved bytes for repeatability. They are our recorded
checksums, not an independently published signature.

| Artifact | SHA-256 |
| --- | --- |
| Standalone script | `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41` |
| Official release archive | `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8` |

The page uses SRI `sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT`.
The default test suite verifies exact script bytes, version, and page SRI, and
executes the actual parser against XLSX/XLS/CSV fixtures. Keep upstream minified
bytes intact; document and test a deliberate version change instead of editing
vendor code or loading a fallback CDN copy. `npm audit` does not assess this file.

`sheetjs-LICENSE.txt` is the upstream Apache-2.0 license copied from `package/LICENSE`
in the same archive. The script retains upstream copyright/license notices.
Production distribution must retain both files and this provenance record.

## Local QR and barcode generators

The inherited `qrcode.js` is Kazuhiko Arase's **qrcode-generator 1.4.4**;
`jsbarcode.min.js` is **JsBarcode 3.11.6** (all formats). On 2026-10-06 their
existing bytes exactly matched the official tagged artifacts at the pinned commits
below. Neither script was edited or upgraded during QA-02. The staff page loads
both locally for label previews/printing; they require no outside worker or CDN.

| Library | Exact upstream artifact | Commit |
| --- | --- | --- |
| qrcode-generator 1.4.4 (`js1.4.4`) | [js/qrcode.js](https://github.com/kazuhikoarase/qrcode-generator/blob/9bd2163ddc1628d1ec8ff22ea288a747275ef442/js/qrcode.js) | `9bd2163ddc1628d1ec8ff22ea288a747275ef442` |
| JsBarcode 3.11.6 (`v3.11.6`) | [dist/JsBarcode.all.min.js](https://github.com/lindell/JsBarcode/blob/5ed2a2b9da5f82da3c6159eb47a21d06f1cf797d/dist/JsBarcode.all.min.js) | `5ed2a2b9da5f82da3c6159eb47a21d06f1cf797d` |

| Local artifact | SHA-256 |
| --- | --- |
| `qrcode.js` | `18ae399f81182bc9de916e9c77b195df20cc58d6f2d55a62b085a299f1bf1780` |
| `jsbarcode.min.js` | `52e032534c3f98976ad95cb8c20baf80ed0cc83d42590602a8cf1db16e2e22ed` |
| `qrcode-LICENSE.txt` | `3a850fa5f08101db6f40676c2786e10bd2cd5fff7b12ffdf1e0c434d4e49d90c` |
| `jsbarcode-LICENSE.txt` | `e34674e4ef4ed987f7a21a3040a1bdce83f08cc07eedfacbba1ffe53b0633734` |
| `sheetjs-LICENSE.txt` | `4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64` |

The QR [MIT license](https://github.com/kazuhikoarase/qrcode-generator/blob/9bd2163ddc1628d1ec8ff22ea288a747275ef442/LICENSE)
and barcode [MIT license](https://github.com/lindell/JsBarcode/blob/5ed2a2b9da5f82da3c6159eb47a21d06f1cf797d/MIT-LICENSE.txt)
were copied unchanged from those same commits. Preserve upstream copyright notices
and all three distribution licenses. The licenses are locally served public files,
not credentials or application configuration.
Exact `.gitattributes` entries disable line-ending conversion for these six pinned
files. The barcode MIT license's original CRLF endings are retained; only that
file's whitespace policy accepts CR-at-EOL. First-party files retain normal checks.

## Integrity and lint policy

Root `npm run lint` runs `scripts/verify-vendors.mjs` before ESLint. It checks each
of the three script SHA-256 pins and three license pins, requires regular files,
and checks exactly one matching script tag with SHA-384 SRI per library in
`index.html`. `npm run vendor:verify` runs the same offline check separately.
The staff page now has SRI for both label generators as well as SheetJS.

Only these three exact JavaScript paths are excluded from application lint rules.
The staff app, parser worker, tests/helpers and new code in this directory remain
linted. Both app lint commands fail on any warning. Do not run bare ESLint and
interpret its vendor exclusions as proof that integrity verification ran.
The default suite verifies tampering failures, license/SRI/symlink failures,
first-party coverage and actual npm warning gates. Chromium exercises real
QR/barcode label generation and local spreadsheet parsing with outside requests
blocked. Actual printer cutting/dimensions/scanning still require QA-01 acceptance.

For an intentional update, review authoritative release bytes and security
advisories, retain the matching upstream licenses, update the script/worker paths
if needed, and update SHA-256 pins, page SRI, exact lint exclusions and this
provenance together. Run both apps' lint/build/type checks plus vendor/import/label
regressions. Never edit third-party bytes to satisfy first-party style rules, ignore
`vendor/**`, or add a runtime CDN fallback. Digests detect unexpected edits relative
to this reviewable allowlist; they are neither an upstream signature nor a security
advisory scan. A reviewed version is not a claim of universal safety.
