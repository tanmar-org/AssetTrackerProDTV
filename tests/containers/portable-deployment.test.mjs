import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { prepareContainers } from "../../scripts/container-preparation.mjs";
import { createLdapDirectory } from "../helpers/ldap-directory.mjs";
import { containerSettings } from "../helpers/container-fixture.mjs";
import { unusedPort } from "../helpers/next-server.mjs";
import { sessionHeaders } from "../helpers/session-context.mjs";
import { inventory } from "../helpers/inventory-fixture.mjs";

const execute = promisify(execFile), repository = fileURLToPath(new URL("../../", import.meta.url));
async function run(command, args, options = {}) {
  const { stdout } = await execute(command, args, { cwd: repository, maxBuffer: 32 * 1024 * 1024, ...options }); return stdout;
}
// No production credentials or networks. Two project-scoped PG volumes stand in
// for separate datacenters; verified logical backups cross the boundary.
test("immutable Compose deployment persists and restores into an independent stack", { timeout: 1200000 }, async t => {
  await run("docker", ["info", "--format", "{{.ServerVersion}}"]); // Missing daemon fails, never silently skips.
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-container-drill-")), stacks = [];
  const ldap = await createLdapDirectory({ certificateHost: "directory.example.test", listenHost: "0.0.0.0" });
  t.after(async () => {
    // Delete only this test's two named stacks/private files. Never prune Docker
    // globally or use --volumes on an operator/production project.
    for (const stack of stacks.reverse()) {
      await stack.compose(["down", "--volumes", "--remove-orphans"]);
      await run("sudo", ["-n", "rm", "-rf", "--", stack.installed]);
    }
    await ldap.close(); await rm(directory, { recursive: true, force: true });
  });
  const imageDirectory = path.join(directory, "images");
  const canaries = [".env.container-build-canary", "service-request/.env.container-build-canary", "public/asset-tracker/container-build-canary.pem"];
  // These ignored synthetic inputs must never survive the deny-by-default build
  // context. Exclusive creation refuses any unrelated existing file.
  const createdCanaries = [];
  t.after(async () => { for (const filename of createdCanaries) await rm(filename, { force: true }); });
  for (const filename of canaries) {
    await run("git", ["check-ignore", filename]);
    const full = path.join(repository, filename);
    await writeFile(full, "SYNTHETIC BUILD CONTEXT SECRET", { flag: "wx", mode: 0o600 }); createdCanaries.push(full);
  }
  // Build through the real allowlisted context; public configuration changes
  // happen only in the builder, not in the preview/host checkout.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/build-container-images.mjs", "https://qr.example.test/", imageDirectory], { cwd: repository, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => { if (code === 0) resolve(); else reject(new Error("Synthetic container build failed")); });
  });
  const pins = JSON.parse(await readFile(path.join(imageDirectory, "images.json"), "utf8"));
  // Remove ignored canaries after building so native readiness is unaffected.
  for (const filename of createdCanaries) await rm(filename, { force: true });
  await t.test("build context excludes secret canaries, Git and fixtures; public QR URL exists only in image", async () => {
    const code = `import fs from 'node:fs'; console.log(JSON.stringify({
      excluded: ${JSON.stringify([...canaries, ".git", "tests"])}.every(name => !fs.existsSync('/opt/assettracker/'+name)),
      publicConfig: fs.readFileSync('/opt/assettracker/public/asset-tracker/config.js','utf8') }));`;
    const facts = JSON.parse(await run("docker", ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--entrypoint", "node", pins.appImage, "--input-type=module", "-e", code]));
    assert.equal(facts.excluded, true); assert.match(facts.publicConfig, /https:\/\/qr\.example\.test\//);
    assert.equal(await run("git", ["status", "--porcelain"]), "");
  });
  await t.test("exact release images survive Docker save/load with revision and platform intact", async () => {
    const archive = path.join(directory, "release-images.tar"), handle = await open(archive, "wx", 0o600);
    try {
      await new Promise((resolve, reject) => {
        const child = spawn("docker", ["image", "save", ...["app", "postgres", "operator", "gateway"].map(kind => pins[`${kind}Image`])], { stdio: ["ignore", handle.fd, "inherit"] });
        child.once("error", reject); child.once("exit", code => { if (code === 0) resolve(); else reject(new Error("Image export failed")); });
      });
      await handle.sync();
    } finally { await handle.close(); }
    await run("docker", ["image", "load", "--input", archive]);
    for (const kind of ["app", "postgres", "operator", "gateway"]) {
      const [info] = JSON.parse(await run("docker", ["image", "inspect", pins[`${kind}Image`]]));
      assert.equal(info.Id, pins[`${kind}Image`]); assert.equal(info.Config.Labels["org.opencontainers.image.revision"], pins.revision);
      assert.equal(`${info.Os}/${info.Architecture}`, pins.platform);
    }
    await rm(archive);
  });
  async function stack(kind) {
    const fixtureDirectory = path.join(directory, kind); await mkdir(fixtureDirectory, { mode: 0o700 });
    const suffix = randomBytes(6).toString("hex"), installed = `/tmp/assettracker-installed-${suffix}`, project = `assettracker_container_test_${suffix}`;
    const port = await unusedPort(), prepared = path.join(fixtureDirectory, "prepared");
    const fixture = await containerSettings(fixtureDirectory, ldap, pins, { namespace: kind === "source" ? `assettracker_dc_${suffix}` : `assettracker_restore_${suffix}`, installDirectory: installed, gatewayPort: port });
    await prepareContainers(fixture.file, prepared);
    await run("sudo", ["-n", process.execPath, "scripts/install-container-files.mjs", prepared]);
    // Synthetic AD is reachable only on this runner's host. Production Compose
    // has no extra_hosts/fixture mounts; real AD uses reviewed private routing.
    const overlay = path.join(fixtureDirectory, "test-overlay.yaml");
    await writeFile(overlay, `services:\n  staff:\n    extra_hosts: ["directory.example.test:host-gateway"]\n  operator:\n    volumes:\n      - type: bind\n        source: ${path.join(repository, "tests")}\n        target: /fixture\n        read_only: true\n`, { mode: 0o600 });
    const args = ["-n", "docker", "compose", "--project-name", project, "--env-file", `${installed}/compose.env`, "--file", "deploy/docker/compose.yaml", "--file", overlay];
    const value = { installed, prepared, project, port, certificate: await readFile(fixture.certificate),
      staff: JSON.parse(await readFile(path.join(prepared, "staff-runtime.json"), "utf8")), qr: JSON.parse(await readFile(path.join(prepared, "qr-runtime.json"), "utf8")),
      compose: commands => run("sudo", [...args, ...commands]),
      operator: commands => run("sudo", [...args, "run", "--rm", "--no-deps", "-T", "operator", ...commands]),
      fixture: mode => run("sudo", [...args, "run", "--rm", "--no-deps", "-T", "--entrypoint", "node", "operator", "--experimental-strip-types", "/fixture/containers/operator-fixture.mjs", mode]), args };
    stacks.push(value);
    await value.compose(["config", "--quiet"]);
    await value.compose(["up", "--detach", "--wait", "--wait-timeout", "120", "database"]);
    await value.operator(["seed"]); return value;
  }
  function request(stack, qr, pathname, { method = "GET", body, headers = {}, authenticate = true } = {}) {
    return new Promise((resolve, reject) => {
      const role = qr ? stack.qr : stack.staff, secretHeader = qr ? "x-request-proxy-secret" : "x-login-proxy-secret", ipHeader = qr ? "x-request-client-ip" : "x-login-client-ip";
      const outgoing = https.request({ hostname: "127.0.0.1", port: stack.port, servername: qr ? "qr.example.test" : "tracker.example.test", ca: stack.certificate,
        path: pathname, method, headers: { host: qr ? "qr.example.test" : "tracker.example.test", ...(authenticate ? { [secretHeader]: qr ? role.REQUEST_PROXY_SECRET : role.LOGIN_PROXY_SECRET, [ipHeader]: "192.0.2.17" } : {}),
          ...(body ? { "content-type": "application/json" } : {}), ...headers }, timeout: 15000 }, response => {
        let content = ""; response.on("data", chunk => { content += chunk; }); response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: content, json: () => JSON.parse(content) }));
      });
      outgoing.on("error", reject); outgoing.on("timeout", () => outgoing.destroy(new Error("Synthetic HTTPS request timeout"))); outgoing.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function login(stack) {
    const response = await request(stack, false, "/api/auth", { method: "POST", body: { action: "login", name: "j.doe", password: ldap.model.entries[0].password } });
    assert.equal(response.status, 200, response.text); assert.equal(response.json().authMode, "ad");
    return response.headers["set-cookie"][0].split(";")[0];
  }
  const source = await stack("source"); let cookie, backup, transferArchive;
  await t.test("restricted socket-only PG initializes; immutable nonroot services start healthy", async () => {
    await source.operator(["initialize"]); await source.fixture("seed");
    await source.compose(["up", "--detach", "--wait", "--wait-timeout", "180", "staff", "qr", "reconciler", "gateway"]);
    const ids = (await source.compose(["ps", "--quiet"])).trim().split("\n"), containers = JSON.parse(await run("docker", ["inspect", ...ids]));
    assert.equal(containers.length, 5);
    for (const container of containers) {
      const service = container.Config.Labels["com.docker.compose.service"];
      assert.equal(container.Image, service === "database" ? pins.postgresImage : service === "gateway" ? pins.gatewayImage : pins.appImage);
      assert.notEqual(container.Config.User, "0"); assert.equal(container.HostConfig.Privileged, false);
      assert.deepEqual(container.HostConfig.CapDrop, ["ALL"]); assert.ok(container.HostConfig.SecurityOpt.includes("no-new-privileges:true"));
      if (service !== "gateway") assert.ok(!container.HostConfig.PortBindings || Object.keys(container.HostConfig.PortBindings).length === 0);
      if (service === "database") assert.equal(container.HostConfig.NetworkMode, "none");
      else assert.equal(container.HostConfig.ReadonlyRootfs, true);
      assert.equal(container.Mounts.some(mount => mount.Source === "/var/run/docker.sock"), false);
    }
  });
  await t.test("HTTPS denies missing hop credentials and private routes; synthetic AD signs in", async () => {
    assert.equal((await request(source, false, "/asset-tracker/index.html", { authenticate: false })).status, 403);
    assert.equal((await request(source, false, "/api/service-assets")).status, 404);
    assert.equal((await request(source, true, "/api/health")).status, 404);
    cookie = await login(source);
    assert.ok(ldap.model.requests.some(entry => entry.type === "search")); assert.deepEqual(ldap.errors, []);
    const response = await request(source, false, "/api/app-state", { headers: { cookie, ...sessionHeaders(cookie) } });
    assert.equal(response.status, 200); assert.deepEqual(response.json().state, inventory());
  });
  await t.test("public QR performs authenticated internal lookup and saves a real GPS request", async () => {
    const lookup = await request(source, true, "/api/asset?id=receiver-0"); assert.equal(lookup.status, 200); assert.deepEqual(lookup.json(), { id: "receiver-0", assetNumber: "TEST-0" });
    const submitted = await request(source, true, "/api/requests", { method: "POST", body: { assetId: "receiver-0", requesterName: "Synthetic Docker Requester", requesterPhone: "555-0100", operatorName: "Synthetic Operator", rigFrac: "Test Rig", lease: "Test Lease", errorCode: "771", latitude: 31.9, longitude: -102.2, gpsAccuracy: 10, gpsCapturedAt: new Date().toISOString() } });
    assert.equal(submitted.status, 201, submitted.text);
  });
  await t.test("staff process crash restarts without losing inventory", async () => {
    const [id] = (await source.compose(["ps", "--quiet", "staff"])).trim().split("\n");
    await run("docker", ["kill", "--signal", "SIGKILL", id]);
    let restarted = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      await delay(1000);
      const [info] = JSON.parse(await run("docker", ["inspect", id]));
      if (info.RestartCount > 0 && info.State.Health?.Status === "healthy") { restarted = true; break; }
    }
    assert.equal(restarted, true);
    assert.equal((await request(source, false, "/api/app-state", { headers: { cookie, ...sessionHeaders(cookie) } })).status, 200);
  });
  await t.test("container recreation retains database and owner-only recovery copies", async () => {
    await source.compose(["down"]); // Persistent volumes deliberately retained.
    await source.compose(["up", "--detach", "--wait", "--wait-timeout", "180", "database", "staff", "qr", "reconciler", "gateway"]);
    const facts = JSON.parse(await source.fixture("inspect")); assert.deepEqual(facts.state, inventory()); assert.equal(facts.drafts, 1); assert.equal(facts.requests.length, 1);
    assert.equal((await request(source, false, "/api/drafts", { headers: { cookie, ...sessionHeaders(cookie) } })).status, 200);
  });
  await t.test("quiesced source produces a complete paired read-only backup", async () => {
    await source.compose(["stop", "gateway", "reconciler", "staff", "qr"]); await source.fixture("pending");
    backup = (await source.operator(["backup"])).trim(); assert.match(backup, /^backup-[A-Za-z0-9-]+$/);
  });
  const destination = await stack("destination");
  await t.test("backup restores to independent fresh databases with sessions revoked and intents paused", async () => {
    await destination.operator(["restore-empty"]);
    const bundle = path.join(directory, "move.tar"); transferArchive = bundle;
    const archive = await run("sudo", [...source.args, "run", "--rm", "--no-deps", "-T", "--entrypoint", "tar", "operator", "-C", "/operator/backups", "-cf", "-", backup], { encoding: "buffer" });
    await writeFile(bundle, archive, { mode: 0o600 });
    // A read-only bind preserves host UID, just like Compose secrets.
    await run("sudo", ["-n", "chown", "999:999", bundle]);
    await run("sudo", ["-n", "chmod", "400", bundle]);
    await destination.compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "mkdir", "operator", "-m", "700", "/operator/incoming"]);
    // Bind the trusted generated archive read-only for this fixture; production
    // copies must travel encrypted and be validated by the same restore command.
    await run("sudo", [...destination.args, "run", "--rm", "--no-deps", "-T", "--volume", `${bundle}:/transfer.tar:ro`, "--entrypoint", "tar", "operator", "-C", "/operator/incoming", "-xf", "/transfer.tar"]);
    await destination.operator(["restore", backup]);
    const facts = JSON.parse(await destination.fixture("inspect"));
    assert.deepEqual(facts.state, inventory()); assert.equal(facts.sessions, 0); assert.equal(facts.drafts, 1);
    assert.deepEqual(facts.identity, { ad_directory: "synthetic-ad", ad_guid: "12345678-90ab-cdef-8123-456789abcdef" });
    assert.deepEqual(facts.operations, [{ phase: "blocked", error_code: "restore_review" }]); assert.equal(facts.requests[0].asset_number, "TEST-0");
    const sourceVolume = JSON.parse(await run("docker", ["inspect", (await source.compose(["ps", "--quiet", "database"])).trim()]))[0].Mounts.find(mount => mount.Destination === "/var/lib/postgresql").Name;
    const destinationVolume = JSON.parse(await run("docker", ["inspect", (await destination.compose(["ps", "--quiet", "database"])).trim()]))[0].Mounts.find(mount => mount.Destination === "/var/lib/postgresql").Name;
    assert.notEqual(sourceVolume, destinationVolume);
  });
  await t.test("destination rejects old cookies; fresh AD login reads inventory/drafts and backup still works", async () => {
    await destination.compose(["up", "--detach", "--wait", "--wait-timeout", "180", "staff", "qr", "reconciler", "gateway"]);
    assert.equal((await request(destination, false, "/api/app-state", { headers: { cookie, ...sessionHeaders(cookie) } })).status, 401);
    const fresh = await login(destination);
    const response = await request(destination, false, "/api/app-state", { headers: { cookie: fresh, ...sessionHeaders(fresh) } }); assert.equal(response.status, 200); assert.deepEqual(response.json().state, inventory());
    const drafts = await request(destination, false, "/api/drafts", { headers: { cookie: fresh, ...sessionHeaders(fresh) } }); assert.equal(drafts.status, 200); assert.equal(drafts.json().drafts.length, 1);
    assert.match((await destination.operator(["backup"])).trim(), /^backup-/);
    assert.deepEqual(JSON.parse(await destination.fixture("inspect")).operations, [{ phase: "blocked", error_code: "restore_review" }]);
  });
  await t.test("a late operator manifest failure contains restored runtime/backup logins", async () => {
    const failure = await stack("late-failure"); await failure.operator(["restore-empty"]);
    const mountedManifest = path.join(directory, "readonly-manifest.json");
    const manifest = JSON.parse(await readFile(path.join(failure.prepared, "operator/database-plan/manifest.json"), "utf8"));
    await writeFile(mountedManifest, JSON.stringify({ ...manifest, status: "restore-empty" }), { mode: 0o600 });
    await run("sudo", ["-n", "chown", "999:999", mountedManifest]); await run("sudo", ["-n", "chmod", "400", mountedManifest]);
    await failure.compose(["run", "--rm", "--no-deps", "-T", "--entrypoint", "mkdir", "operator", "-m", "700", "/operator/incoming"]);
    await run("sudo", [...failure.args, "run", "--rm", "--no-deps", "-T", "--volume", `${transferArchive}:/transfer.tar:ro`, "--entrypoint", "tar", "operator", "-C", "/operator/incoming", "-xf", "/transfer.tar"]);
    // A bind-mounted manifest cannot be atomically replaced. The pair restores
    // successfully, then publication fails; new runtime/backup logins must close.
    await assert.rejects(run("sudo", [...failure.args, "run", "--rm", "--no-deps", "-T", "--volume", `${mountedManifest}:/operator/database-plan/manifest.json:ro`, "operator", "restore", backup]));
    assert.deepEqual(JSON.parse(await failure.fixture("offline")), { restrictedLogins: 0 });
    assert.deepEqual(JSON.parse(await failure.fixture("inspect")).state, inventory());
  });

});
