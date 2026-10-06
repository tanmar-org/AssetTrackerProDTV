import { checkSourceMapSecurity } from "./helpers/source-map-checks.mjs";

// Check the staff framework's installed dependency independently of the QR app.
checkSourceMapSecurity(new URL("../package.json", import.meta.url));
