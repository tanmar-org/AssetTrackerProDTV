import { launchService } from "./service-launcher.mjs";

// Existing VM/systemd invocation remains loopback-only.
if (process.argv.length !== 3) { process.exitCode = 1; }
else await launchService(process.argv[2]);
