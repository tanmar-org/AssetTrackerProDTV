import { initializeDatabases, prepareDatabases } from "./database-provisioning.mjs";

// Default is offline staging. --initialize is a separate operator action that
// creates NEW databases; it neither imports records nor starts/deploys services.
// Fixed diagnostics protect administrator URLs, passwords and private paths.
const controller = new AbortController();
const interrupt = () => controller.abort();
process.on("SIGINT", interrupt); process.on("SIGTERM", interrupt);
try {
  const args = process.argv.slice(2), initialize = args[0] === "--initialize";
  if (initialize) args.shift();
  if (args.length !== 2) throw new Error("Invalid arguments.");
  if (initialize) {
    await initializeDatabases(...args, { signal: controller.signal });
    console.log("Initialized two fresh databases with restricted runtime and backup roles. No inventory or administrators imported; no services activated.");
  } else {
    await prepareDatabases(...args);
    console.log("Prepared nine protected database credential/plan files. No database connection or change made.");
  }
} catch {
  console.error("Database preparation failed. Inspect protected settings, the plan status and docs/PRODUCTION-DATABASES.md privately; do not retry against partial targets.");
  process.exitCode = 1;
} finally {
  process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
}
