import { prepareIngress } from "./ingress-preparation.mjs";

// Staging only: no shell commands, service reload, DNS write or network request.
// Never print configuration/error objects that could include settings or secrets.
try {
  if (process.argv.length !== 4) throw new Error("Usage: npm run ingress:prepare -- /private/settings.json /private/new-output-directory");
  const result = await prepareIngress(process.argv[2], process.argv[3]);
  console.log(`Prepared ${result.files} protected files. Nothing installed or activated.`);
  console.log(`Source-IP allowlist: ${result.sourceRestricted ? "included" : "not supplied; TLS and ingress secrets remain mandatory"}.`);
} catch {
  console.error("Ingress preparation failed. Check arguments, protected paths and settings against docs/HTTPS-INGRESS.md.");
  process.exitCode = 1;
}
