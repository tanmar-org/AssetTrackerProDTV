import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "dist/**",
    ".sites-runtime/**",
    "service-request/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Exact upstream artifacts have digest/SRI/license verification before lint.
    // Keep this allowlist narrow: new vendor-directory application code is linted.
    // See scripts/vendor-integrity.mjs and vendor/README.md; never ignore vendor/**.
    "public/asset-tracker/vendor/qrcode.js",
    "public/asset-tracker/vendor/jsbarcode.min.js",
    "public/asset-tracker/vendor/xlsx-0.20.3.full.min.js",
  ]),
]);

export default eslintConfig;
