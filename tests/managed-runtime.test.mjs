import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { managedEnvironment, servicePorts, verifyCleanRelease } from "../scripts/managed-runtime.mjs";

const run = promisify(execFile), ports = { staff: 5173, qr: 5174 };
const common = { DATABASE_URL: "postgresql://restricted:synthetic-password@127.0.0.1/test", ADMIN_SHARED_SECRET: "s".repeat(43) };
const settings = {
  staff: { ...common, SERVICE_REQUEST_API_URL: "http://127.0.0.1:5174/api/requests", LOGIN_PROXY_SECRET: "l".repeat(43),
    AUTH_MODE: "ad", AD_DIRECTORY_ID: "synthetic", AD_LDAP_URL: "ldaps://dc.example.test:636", AD_BASE_DN: "DC=example,DC=test",
    AD_BIND_DN: "CN=Reader,DC=example,DC=test", AD_BIND_PASSWORD: ' synthetic "reader" $password\\007! ' },
  qr: { ...common, TRACKER_ASSET_API_URL: "http://127.0.0.1:5173/api/service-assets", REQUEST_PROXY_SECRET: "q".repeat(43) },
  reconciler: { ...common, SERVICE_REQUEST_API_URL: "http://127.0.0.1:5174/api/requests" },
};
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-managed-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, "runtime.json"),
    save: value => writeFile(path.join(directory, "runtime.json"), JSON.stringify(value), { mode: 0o600 }) };
}
test("managed credentials isolate QR/reconciler and preserve exact reader password characters", async t => {
  const f = await fixture(t);
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=synthetic-ca",
    "-keyout", path.join(f.directory, "key.pem"), "-out", path.join(f.directory, "ad-ca.pem")]);
  await chmod(path.join(f.directory, "ad-ca.pem"), 0o600);
  for (const role of ["staff", "qr", "reconciler"]) {
    await f.save(settings[role]); const env = await managedEnvironment(role, f.directory, ports);
    assert.equal(env.NODE_ENV, "production"); assert.equal(env.DATABASE_URL, common.DATABASE_URL);
    for (const key of ["CREDENTIALS_DIRECTORY", "NODE_OPTIONS", "LD_PRELOAD", "TEST_DATABASE_URL", "DATABASE_OWNER_URL"]) assert.equal(env[key], undefined);
    if (role === "staff") { assert.equal(env.AD_BIND_PASSWORD, settings.staff.AD_BIND_PASSWORD); assert.equal(env.AD_CA_FILE, path.join(f.directory, "ad-ca.pem")); }
    else for (const key of ["AUTH_MODE", "AD_BIND_PASSWORD", "AD_CA_FILE", "LOGIN_PROXY_SECRET"]) assert.equal(env[key], undefined);
  }
});
test("managed settings reject PIN fallback, extra credentials, secret reuse and public private-API destinations", async t => {
  const f = await fixture(t);
  for (const [role, value] of [
    ["staff", { ...settings.staff, AUTH_MODE: "pin" }],
    ["qr", { ...settings.qr, AD_BIND_PASSWORD: "wrong-service" }],
    ["reconciler", { ...settings.reconciler, DATABASE_OWNER_URL: "operator" }],
    ["qr", { ...settings.qr, REQUEST_PROXY_SECRET: common.ADMIN_SHARED_SECRET }],
    ["qr", { ...settings.qr, TRACKER_ASSET_API_URL: "https://tracker.example.test/api/service-assets" }],
    ["qr", { ...settings.qr, TRACKER_ASSET_API_URL: "http://127.0.0.1:5173/api/service-assets?token=private" }],
    ["reconciler", { ...settings.reconciler, SERVICE_REQUEST_API_URL: "http://127.0.0.1:5174/api/requests/item" }],
    ["qr", { ...settings.qr, DATABASE_URL: "postgresql://runtime@127.0.0.1/test" }],
  ]) { await f.save(value); await assert.rejects(managedEnvironment(role, f.directory, ports)); }
  assert.throws(() => servicePorts({ ASSETTRACKER_STAFF_PORT: "0" }));
  assert.throws(() => servicePorts({ ASSETTRACKER_QR_PORT: "5173" }));
});
test("managed credential reads refuse exposed or symlinked files", async t => {
  const f = await fixture(t); await f.save(settings.qr); await chmod(f.file, 0o644);
  await assert.rejects(managedEnvironment("qr", f.directory, ports));
  const real = path.join(f.directory, "real.json"); await writeFile(real, JSON.stringify(settings.qr), { mode: 0o600 });
  await rm(f.file); await symlink(real, f.file); await assert.rejects(managedEnvironment("qr", f.directory, ports));
});
test("managed release refuses dotenv owner/runtime files and a different Node pin", async t => {
  const f = await fixture(t); await mkdir(path.join(f.directory, "service-request"));
  await writeFile(path.join(f.directory, ".nvmrc"), process.versions.node);
  await writeFile(path.join(f.directory, ".env.example"), "DATABASE_URL=\n");
  await verifyCleanRelease(f.directory);
  for (const sub of ["", "service-request/"]) {
    const file = path.join(f.directory, `${sub}.env.migrate`); await writeFile(file, "synthetic private owner value");
    await assert.rejects(verifyCleanRelease(f.directory)); await rm(file);
  }
  await writeFile(path.join(f.directory, ".nvmrc"), "0.0.0"); await assert.rejects(verifyCleanRelease(f.directory));
  assert.ok((await readFile(path.join(f.directory, ".env.example"), "utf8")).includes("DATABASE_URL="));
});
