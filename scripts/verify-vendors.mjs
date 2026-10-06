import {verifyVendors} from "./vendor-integrity.mjs";

// Lint's exact exclusions are valid only while these upstream bytes, licenses
// and browser integrity attributes match. No network or advisory submission.
try{
  const result=await verifyVendors();
  process.stdout.write(`Verified ${result.scripts} vendor scripts, SRI and ${result.licenses} licenses.\n`);
}catch{
  process.stderr.write("Vendor verification failed. Review local artifacts, licenses and page integrity before lint.\n");
  process.exitCode=1;
}
