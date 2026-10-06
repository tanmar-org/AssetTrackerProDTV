import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareIngress, renderIngress } from "../scripts/ingress-preparation.mjs";

const settings = {
  staffHostname: "tracker.example.test", qrHostname: "qr.example.test", vmAddress: "10.0.0.20",
  vmCertificate: "/private/server.pem", vmCertificateKey: "/private/server.key", npmTrustedCa: "/private/ca.pem",
};
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-ingress-preparation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "settings.json"), output = path.join(directory, "rendered");
  await writeFile(input, JSON.stringify(settings), { mode: 0o600 });
  return { directory, input, output };
}

// These operator checks protect generated secrets and reject Nginx-code injection;
// real proxy behavior is tested separately with sockets and temporary certificates.
test("ingress staging writes protected matching secrets and a public HTTPS label destination", async t => {
  const { directory, input, output } = await fixture(t);
  // Empty reserved .git paths are not Git worktrees (the VM sandbox uses these).
  await mkdir(path.join(directory, ".git"));
  assert.deepEqual(await prepareIngress(input, output), { files: 8, sourceRestricted: false });
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  for (const name of ["staff-ingress.env", "qr-ingress.env", "vm.conf", "npm-staff.conf", "browser-config.js"])
    assert.equal((await lstat(path.join(output, name))).mode & 0o777, 0o600);
  const login = (await readFile(path.join(output, "staff-ingress.env"), "utf8")).trim().split("=")[1];
  const request = (await readFile(path.join(output, "qr-ingress.env"), "utf8")).trim().split("=")[1];
  assert.match(login, /^[A-Za-z0-9_-]{43}$/); assert.match(request, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(login, request);
  for (const name of ["vm.conf", "npm-staff.conf"])
    assert.ok((await readFile(path.join(output, name), "utf8")).includes(login));
  for (const name of ["vm.conf", "npm-qr-upstream.conf"])
    assert.ok((await readFile(path.join(output, name), "utf8")).includes(request));
  const browser = await readFile(path.join(output, "browser-config.js"), "utf8");
  assert.ok(browser.includes("https://qr.example.test/")); assert.ok(!browser.includes(login) && !browser.includes(request));
  await assert.rejects(prepareIngress(input, output), { code: "EEXIST" });
  assert.ok((await readFile(path.join(output, "vm.conf"), "utf8")).includes(login));
});
test("operator settings reject directive injection, public binds, duplicate names/ports and misspelled fields", async () => {
  for (const change of [
    { staffHostname: "tracker.test;return 200" }, { qrHostname: settings.staffHostname },
    { vmAddress: "0.0.0.0" }, { vmAddress: "203.0.113.10" }, { vmAddress: "::" },
    { vmCertificate: "/private/file;return 200" }, { npmTrustedCa: "/private/$variable" },
    { vmCertificateKey: "/private/../key" }, { gatewayPort: 443 }, { gatewayPort: 5173 },
    { qrPort: 5173 }, { proxySourceAddress: "10.0.0.1;allow all" }, { proxySourceAddress: "" },
    { unknownSetting: "ignored?" },
  ]) await assert.rejects(renderIngress({ ...settings, ...change }, "/private/output"));
});
test("source-IP restriction is optional but uses a validated single private address when supplied", async () => {
  const files = await renderIngress({ ...settings, proxySourceAddress: "10.0.0.10", vmQrInclude: "/etc/assettracker/gateway/vm-qr-upstream.conf" }, "/private/output");
  assert.ok(files["vm.conf"].includes('if ($realip_remote_addr != "10.0.0.10") { return 403; }'));
  assert.ok(files["vm.conf"].includes("include /etc/assettracker/gateway/vm-qr-upstream.conf;"));
  await assert.rejects(renderIngress({ ...settings, vmQrInclude: "/etc/gateway.conf;return 200" }, "/private/output"));
});
test("staging refuses readable settings, symlinks and output in another Git worktree", async t => {
  const { directory, input, output } = await fixture(t);
  await chmod(input, 0o644); await assert.rejects(prepareIngress(input, output), /mode 0600/);
  await chmod(input, 0o600);
  const link = path.join(directory, "settings-link.json"); await symlink(input, link);
  await assert.rejects(prepareIngress(link, output), /regular file/);
  const other = path.join(directory, "other-repo"); await mkdir(other, { mode: 0o700 });
  await writeFile(path.join(other, ".git"), "gitdir: /synthetic/worktree\n");
  await assert.rejects(prepareIngress(input, path.join(other, "rendered")), /Git worktrees/);
  await rm(path.join(other, ".git")); await mkdir(path.join(other, ".git"));
  await writeFile(path.join(other, ".git", "HEAD"), "ref: refs/heads/main\n");
  await assert.rejects(prepareIngress(input, path.join(other, "rendered")), /Git worktrees/);
  await chmod(directory, 0o755); await assert.rejects(prepareIngress(input, output), /mode 0700/);
});
