# Local spreadsheet reader

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
