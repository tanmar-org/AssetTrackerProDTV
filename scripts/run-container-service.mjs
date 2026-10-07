import { launchService } from "./service-launcher.mjs";

// Listen on the container interface, never publish Node ports on the VM. Compose
// supplies exact staff/qr DNS names and isolated mounted per-role credentials.
if (process.argv.length !== 3) { process.exitCode = 1; }
else await launchService(process.argv[2], { network: "compose" });
