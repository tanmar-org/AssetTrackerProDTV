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
    // Keep the exact upstream minified artifact; digest/import regressions verify
    // it instead of applying our application coding rules to third-party bytes.
    "public/asset-tracker/vendor/xlsx-0.20.3.full.min.js",
  ]),
]);

export default eslintConfig;
