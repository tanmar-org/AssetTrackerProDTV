import { servicePorts } from "./managed-runtime.mjs";

// Container-local HTTP readiness, no credential/body output or mutation. Docker
// health status is an observation; it does not restart dependency outages.
try {
  const role = process.argv[2], ports = servicePorts();
  if (!["staff", "qr"].includes(role) || process.argv.length !== 3) throw new Error("Invalid role.");
  const response = await fetch(`http://127.0.0.1:${ports[role]}/api/health`, { signal: AbortSignal.timeout(5000), redirect: "error" });
  const ok = response.status === 200 && response.headers.get("cache-control")?.includes("no-store");
  await response.body?.cancel(); if (!ok) throw new Error("Not ready.");
} catch { console.error("Container readiness failed."); process.exitCode = 1; }
