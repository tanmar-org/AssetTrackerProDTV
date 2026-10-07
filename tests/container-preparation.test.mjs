import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareContainers } from "../scripts/container-preparation.mjs";
import { managedEnvironment } from "../scripts/managed-runtime.mjs";
import { createLdapDirectory } from "./helpers/ldap-directory.mjs";
import { containerSettings, fakeImagePins } from "./helpers/container-fixture.mjs";

test("offline container preparation isolates credentials and rejects unsafe configuration", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-container-files-")), ldap = await createLdapDirectory();
  t.after(async () => { await ldap.close(); await rm(directory, { recursive: true, force: true }); });
  const fixture = await containerSettings(directory, ldap, fakeImagePins), output = path.join(directory, "prepared");
  await t.test("preparation uses fixed private Compose peers and independent secrets without contacting AD", async () => {
    assert.deepEqual(await prepareContainers(fixture.file, output), { prepared: true, mode: "fresh" });
    const staff = JSON.parse(await readFile(path.join(output, "staff-runtime.json"), "utf8"));
    const qr = JSON.parse(await readFile(path.join(output, "qr-runtime.json"), "utf8"));
    const worker = JSON.parse(await readFile(path.join(output, "reconciler-runtime.json"), "utf8"));
    assert.equal(staff.SERVICE_REQUEST_API_URL, "http://qr:5174/api/requests");
    assert.equal(qr.TRACKER_ASSET_API_URL, "http://staff:5173/api/service-assets");
    assert.equal(staff.ADMIN_SHARED_SECRET, qr.ADMIN_SHARED_SECRET); assert.equal(worker.ADMIN_SHARED_SECRET, staff.ADMIN_SHARED_SECRET);
    assert.notEqual(staff.LOGIN_PROXY_SECRET, qr.REQUEST_PROXY_SECRET); assert.notEqual(staff.LOGIN_PROXY_SECRET, staff.ADMIN_SHARED_SECRET);
    assert.equal(Object.keys(qr).some(key => key.startsWith("AD_")), false); assert.equal(Object.keys(worker).some(key => key.startsWith("AD_")), false);
    assert.match(await readFile(path.join(output, "vm.conf"), "utf8"), /proxy_pass http:\/\/staff:5173/);
    assert.equal((await stat(path.join(output, "tls.key"))).mode & 0o777, 0o600);
    assert.equal(ldap.model.requests.length, 0);
    assert.equal(JSON.parse(await readFile(path.join(output, "operator/database-plan/manifest.json"), "utf8")).status, "prepared");
  });
  await t.test("prepared paths cannot be overwritten", async () => { await assert.rejects(prepareContainers(fixture.file, output)); });
  await t.test("public/wildcard publishing, unsafe paths and mutable tags are refused", async () => {
    for (const changes of [{ vmAddress: "0.0.0.0" }, { vmAddress: "8.8.8.8" }, { installDirectory: "/etc/assettracker\nINJECTED=yes" }, { gatewayPort: 443 }]) {
      await writeFile(fixture.file, JSON.stringify({ ...fixture.settings, ...changes }));
      await assert.rejects(prepareContainers(fixture.file, path.join(directory, "bad")));
    }
    await writeFile(fixture.file, JSON.stringify(fixture.settings));
    await writeFile(fixture.settings.imagesFile, JSON.stringify({ ...fakeImagePins, appImage: "assettracker:latest" }));
    await assert.rejects(prepareContainers(fixture.file, path.join(directory, "bad")));
    await writeFile(fixture.settings.imagesFile, JSON.stringify(fakeImagePins));
  });
  await t.test("role/UID credential policy rejects alternate Compose hosts and native listener mismatch", async () => {
    const check = path.join(directory, "credential"); await mkdir(check, { mode: 0o700 });
    const runtime = JSON.parse(await readFile(path.join(output, "qr-runtime.json"), "utf8"));
    await writeFile(path.join(check, "runtime.json"), JSON.stringify(runtime), { mode: 0o600 });
    await managedEnvironment("qr", check, { staff: 5173, qr: 5174 }, { network: "compose" });
    await assert.rejects(managedEnvironment("qr", check));
    await writeFile(path.join(check, "runtime.json"), JSON.stringify({ ...runtime, TRACKER_ASSET_API_URL: "http://attacker.example:5173/api/service-assets" }));
    await assert.rejects(managedEnvironment("qr", check, { staff: 5173, qr: 5174 }, { network: "compose" }));
  });
  await t.test("world-readable operator settings are refused", async () => {
    await chmod(fixture.file, 0o644); await assert.rejects(prepareContainers(fixture.file, path.join(directory, "bad"))); await chmod(fixture.file, 0o600);
  });
});
