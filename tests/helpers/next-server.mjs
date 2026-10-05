import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the production Node build over real HTTP, not a Worker export or mock.
// Bind only loopback; use an available ephemeral port for independent test runs.
export async function startNext(directory, env = {}) {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const child = spawn(process.execPath, [
    resolve(directory, "node_modules/next/dist/bin/next"), "start",
    "--hostname", "127.0.0.1", "--port", String(port),
  ], { cwd: directory, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1", ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-3000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-3000); });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  const url = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Next.js failed to start.");
      try {
        const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1000) });
        await response.arrayBuffer();
        return { url, close };
      } catch { await delay(100); }
    }
    throw new Error("Next.js did not become ready.");
  } catch (error) {
    await close();
    // Output is from a synthetic local environment, never a production server.
    throw new Error(`${error.message}\n${output}`);
  }
}
