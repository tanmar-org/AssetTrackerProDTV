import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { managedEnvironment, servicePorts, verifyCleanRelease, verifyRuntimeDatabase } from "./managed-runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
let child, stopping = false;
const stop = signal => { stopping = true; child?.kill(signal); };
const term = () => stop("SIGTERM"), interrupt = () => stop("SIGINT");
process.on("SIGTERM", term); process.on("SIGINT", interrupt);
try {
  if (process.argv.length !== 3) throw new Error("Invalid role.");
  const role = process.argv[2], ports = servicePorts();
  await verifyCleanRelease(root);
  const env = await managedEnvironment(role, process.env.CREDENTIALS_DIRECTORY, ports);
  await verifyRuntimeDatabase(env.DATABASE_URL);
  if (!stopping) {
    const cwd = role === "qr" ? path.join(root, "service-request") : root;
    const args = role === "reconciler" ? ["--experimental-strip-types", "--max-old-space-size=256",
      path.join(root, "scripts/reconcile-service-operations.mjs"), "--watch"] : ["--max-old-space-size=512",
      path.join(cwd, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(ports[role])];
    child = spawn(process.execPath, args, { cwd, env, stdio: "inherit" });
    // systemd signals the supervisor first. Forward it, then let the worker
    // finish its bounded in-flight transaction; KillMode=mixed is the fallback.
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    process.exitCode = stopping ? 0 : result.code ?? 1;
  }
} catch {
  // Even JSON, TLS, filesystem and PostgreSQL failures must not echo credentials.
  console.error("Managed service could not start. Check private configuration, release and runtime grants.");
  process.exitCode = stopping ? 0 : 1;
} finally {
  process.off("SIGTERM", term); process.off("SIGINT", interrupt);
}
