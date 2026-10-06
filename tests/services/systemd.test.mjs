import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { renderIngress } from "../../scripts/ingress-preparation.mjs";

const run = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
test("systemd validates every supplied unit, command and timer without installing it", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-managed-units-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const nginx = (await run("sh", ["-c", "command -v nginx"])).stdout.trim();
  const units = (await readdir(path.join(root, "deploy/systemd"))).filter(name => /\.(service|timer)$/.test(name));
  for (const name of units) {
    const source = await readFile(path.join(root, "deploy/systemd", name), "utf8");
    // Resolve deployment-only executables to the same real tools on this test
    // host. Keep all settings/dependencies; analyze never starts the services.
    const rendered = source.replaceAll("/opt/assettracker/node/bin/node", process.execPath)
      .replaceAll("/opt/assettracker/current", root.replace(/\/$/, "")).replaceAll("/usr/sbin/nginx", nginx);
    await writeFile(path.join(directory, name), rendered);
  }
  await run("systemd-analyze", ["verify", "--man=no", ...units.map(name => path.join(directory, name))]);
  assert.equal(units.length, 6);
});
test("dedicated non-root gateway main config passes actual Nginx certificate/include preflight", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-gateway-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ["gateway", "runtime", "state"]) await mkdir(path.join(directory, name), { mode: 0o700 });
  const gateway = path.join(directory, "gateway"), cert = path.join(gateway, "server.pem"), key = path.join(gateway, "server.key");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=synthetic-gateway",
    "-keyout", key, "-out", cert]);
  const files = await renderIngress({ staffHostname: "tracker.example.test", qrHostname: "qr.example.test", vmAddress: "127.0.0.1",
    vmCertificate: cert, vmCertificateKey: key, npmTrustedCa: cert, vmQrInclude: path.join(gateway, "vm-qr-upstream.conf") }, "/private/staging-only");
  for (const name of ["vm.conf", "vm-qr-upstream.conf"]) await writeFile(path.join(gateway, name), files[name], { mode: 0o600 });
  const main = (await readFile(path.join(root, "deploy/nginx/gateway-main.conf"), "utf8"))
    .replaceAll("/run/assettracker-gateway", path.join(directory, "runtime"))
    .replaceAll("/var/lib/assettracker-gateway", path.join(directory, "state"))
    .replaceAll("/etc/assettracker/gateway", gateway);
  const config = path.join(gateway, "main.conf"); await writeFile(config, main, { mode: 0o600 });
  await run(process.env.NGINX_BINARY || "nginx", ["-t", "-p", path.join(directory, "state"), "-c", config, "-e", "stderr"]);
});
