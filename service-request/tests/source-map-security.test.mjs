import { checkSourceMapSecurity } from "../../tests/helpers/source-map-checks.mjs";

// Run against the QR app's own PostCSS/source-map dependencies after npm ci.
checkSourceMapSecurity(new URL("../package.json", import.meta.url));
