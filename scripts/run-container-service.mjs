import { launchService } from "./service-launcher.mjs";

// Listen on the container interface, never publish Node ports on the VM. Compose
// supplies exact staff/qr DNS names and isolated mounted per-role credentials.
if (process.argv.length !== 3 || !["staff", "qr", "reconciler"].includes(process.argv[2])) process.exitCode = 1;
else {
  // Fixed read-only credential mount; no secret value is embedded in image ENV.
  process.env.CREDENTIALS_DIRECTORY = "/run/assettracker-credentials";
  await launchService(process.argv[2], { network: "compose" });
}
