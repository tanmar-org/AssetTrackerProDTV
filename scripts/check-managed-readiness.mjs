import { servicePorts } from "./managed-runtime.mjs";

// No credentials and no mutations. A failed check reports unavailability without
// restarting a web app merely because its database/directory dependency is down.
try {
  const ports = servicePorts();
  const ready = await Promise.all(Object.values(ports).map(async port => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    const ok = response.status === 200 && response.headers.get("cache-control")?.includes("no-store");
    await response.body?.cancel(); return ok;
  }));
  if (!ready.every(Boolean)) throw new Error("Unavailable.");
  console.log("Staff and QR readiness passed.");
} catch {
  console.error("Staff or QR readiness failed. Check the private service status.");
  process.exitCode = 1;
}
