import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { chmod, cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { verifyRuntimeDatabase } from "../../scripts/managed-runtime.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { unusedPort } from "../helpers/next-server.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url)), run = promisify(execFile);
test("managed service startup and shutdown with actual restricted PostgreSQL roles", { timeout: 30000 }, async t => {
  const shutdown = [];
  const tracker = await createPostgresFixture("tracker"), qr = await createPostgresFixture("requests");
  t.after(async () => { for (const stop of shutdown.reverse()) await stop(); await tracker.close(); await qr.close(); });
  const role = new URL(tracker.url).username; assert.match(role, /^assettracker_runtime_[a-f0-9]{32}$/);
  await t.test("restricted roles pass but operator connections fail before application startup", async () => {
    await verifyRuntimeDatabase(tracker.url); await verifyRuntimeDatabase(qr.url);
    await assert.rejects(verifyRuntimeDatabase(tracker.ownerUrl), /runtime permissions/);
  });
  await t.test("DDL or migration grants are rejected even on a nominal runtime role", async () => {
    for (const [grant, revoke] of [
      [`GRANT CREATE ON SCHEMA public TO "${role}"`, `REVOKE CREATE ON SCHEMA public FROM "${role}"`],
      [`GRANT SELECT ON schema_migrations TO "${role}"`, `REVOKE SELECT ON schema_migrations FROM "${role}"`],
    ]) {
      await tracker.database.prepare(grant).run();
      try { await assert.rejects(verifyRuntimeDatabase(tracker.url), /runtime permissions/); }
      finally { await tracker.database.prepare(revoke).run(); }
    }
  });
  await t.test("non-inherited membership cannot conceal later privileged SET ROLE access", async () => {
    for (const predefined of ["pg_read_all_data", "pg_monitor"]) {
      await tracker.database.prepare(`GRANT ${predefined} TO "${role}" WITH INHERIT FALSE`).run();
      try { await assert.rejects(verifyRuntimeDatabase(tracker.url), /runtime permissions/); }
      finally { await tracker.database.prepare(`REVOKE ${predefined} FROM "${role}"`).run(); }
    }
  });

  // Run the actual launcher/Next CLI against built apps. A disposable release
  // symlinks only immutable builds/dependencies; no config is written to source.
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-managed-services-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = path.join(directory, "release"); await mkdir(path.join(release, "scripts"), { recursive: true });
  await mkdir(path.join(release, "service-request"));
  for (const file of ["managed-runtime.mjs", "run-managed-service.mjs", "reconcile-service-operations.mjs"])
    await cp(path.join(root, "scripts", file), path.join(release, "scripts", file));
  for (const file of ["lib", "node_modules", ".next", "public"]) await symlink(path.join(root, file), path.join(release, file));
  for (const file of ["node_modules", ".next", "public"]) await symlink(path.join(root, "service-request", file), path.join(release, "service-request", file));
  await writeFile(path.join(release, ".nvmrc"), process.versions.node);
  const ports = { staff: await unusedPort(), qr: await unusedPort() }, secret = "s".repeat(43);
  const ca = path.join(directory, "synthetic-ca.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=synthetic-ca",
    "-keyout", path.join(directory, "synthetic.key"), "-out", ca]);
  const passwordUrl = value => { const url = new URL(value); url.password = "synthetic-test-password"; return url.href; };
  const settings = {
    staff: { DATABASE_URL: passwordUrl(tracker.url), ADMIN_SHARED_SECRET: secret, LOGIN_PROXY_SECRET: "l".repeat(43),
      SERVICE_REQUEST_API_URL: `http://127.0.0.1:${ports.qr}/api/requests`, AUTH_MODE: "ad", AD_DIRECTORY_ID: "synthetic",
      AD_LDAP_URL: "ldaps://dc.example.test:636", AD_BASE_DN: "DC=example,DC=test", AD_BIND_DN: "CN=Reader,DC=example,DC=test", AD_BIND_PASSWORD: "synthetic-reader-only" },
    qr: { DATABASE_URL: passwordUrl(qr.url), ADMIN_SHARED_SECRET: secret, REQUEST_PROXY_SECRET: "q".repeat(43),
      TRACKER_ASSET_API_URL: `http://127.0.0.1:${ports.staff}/api/service-assets` },
    reconciler: { DATABASE_URL: passwordUrl(tracker.url), ADMIN_SHARED_SECRET: secret, SERVICE_REQUEST_API_URL: `http://127.0.0.1:${ports.qr}/api/requests` },
  };
  const processes = [];
  async function launch(kind, values = settings[kind]) {
    const credentials = path.join(directory, `${kind}-${processes.length}`); await mkdir(credentials, { mode: 0o700 });
    await writeFile(path.join(credentials, "runtime.json"), JSON.stringify(values), { mode: 0o600 });
    if (kind === "staff") { await cp(ca, path.join(credentials, "ad-ca.pem")); await chmod(path.join(credentials, "ad-ca.pem"), 0o600); }
    const child = spawn(process.execPath, [path.join(release, "scripts/run-managed-service.mjs"), kind], { cwd: release,
      env: { ...process.env, CREDENTIALS_DIRECTORY: credentials, ASSETTRACKER_STAFF_PORT: String(ports.staff), ASSETTRACKER_QR_PORT: String(ports.qr),
        DATABASE_OWNER_URL: "synthetic-owner-must-not-forward", AUTH_MODE: "pin", DATABASE_URL: "must-not-use-parent" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { output += value; });
    const exited = once(child, "exit");
    const stop = async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    };
    processes.push(child); shutdown.push(stop);
    return { child, exited, output: () => output, stop };
  }
  async function ready(port, process) {
    for (let i = 0; i < 70; i++) {
      if (process.child.exitCode !== null) throw new Error("Synthetic managed app exited.");
      try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
        await r.arrayBuffer(); if (r.status === 200) return; } catch { /* Wait for synthetic listener only. */ }
      await delay(50);
    }
    throw new Error("Synthetic managed app did not become ready.");
  }
  await t.test("managed apps start on loopback with private JSON settings and no PIN fallback", async () => {
    const staff = await launch("staff"), requests = await launch("qr"); await ready(ports.staff, staff); await ready(ports.qr, requests);
    const status = await (await fetch(`http://127.0.0.1:${ports.staff}/api/auth`)).json();
    assert.equal(status.authMode, "ad"); assert.equal(status.needsProvisioning, true);
    assert.equal((await fetch(`http://127.0.0.1:${ports.staff}/api/app-state`)).status, 401);
    assert.ok(!staff.output().includes("synthetic-reader-only") && !requests.output().includes("synthetic-owner-must-not-forward"));
  });
  await t.test("operator DB configuration is refused with fixed errors and no secret echo", async () => {
    const rejected = await launch("qr", { ...settings.qr, DATABASE_URL: passwordUrl(qr.ownerUrl) });
    assert.deepEqual(await rejected.exited, [1, null]);
    assert.match(rejected.output(), /Managed service could not start/); assert.ok(!rejected.output().includes("synthetic-test-password"));
  });
  await t.test("actual reconciler watch process receives TERM and finishes without a forced kill", async () => {
    const worker = await launch("reconciler");
    for (let i = 0; !worker.output().includes('"processed"') && i < 70; i++) await delay(50);
    assert.match(worker.output(), /"processed"/);
    await worker.stop(); assert.equal(worker.child.exitCode, 0); assert.equal(worker.child.signalCode, null);
  });
});
