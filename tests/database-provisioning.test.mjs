import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareDatabases, provisioningSettings, scramVerifier } from "../scripts/database-provisioning.mjs";

const settings = { administratorUrl: "postgresql://operator:synthetic@localhost:55432/postgres?host=/run/postgresql", namespace: "assettracker_synthetic" };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-db-plan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "settings.json"), output = path.join(directory, "plan");
  await writeFile(input, JSON.stringify(settings), { mode: 0o600 });
  return { directory, input, output };
}
// Default staging performs no connection (the example socket need not exist),
// while preserving unique role credentials and refusing destructive replacement.
test("database staging isolates six credentials and matching read-only backup services", async t => {
  const { input, output } = await fixture(t);
  assert.deepEqual(await prepareDatabases(input, output), { files: 9 });
  assert.equal((await lstat(output)).mode & 0o777, 0o700);
  const passwords = [];
  for (const app of ["tracker", "requests"]) for (const kind of ["owner", "runtime", "backup"]) {
    const file = path.join(output, `${app}-${kind}.json`);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    const url = new URL(JSON.parse(await readFile(file, "utf8")).DATABASE_URL);
    assert.equal(url.username, `assettracker_synthetic_${app}_${kind}`);
    assert.equal(url.pathname, `/assettracker_synthetic_${app}`);
    assert.equal(url.searchParams.get("host"), "/run/postgresql");
    assert.match(url.password, /^[A-Za-z0-9_-]{43}$/); passwords.push(url.password);
    if (kind === "backup") {
      const passwordFile = await readFile(path.join(output, "pgpass"), "utf8");
      assert.ok(passwordFile.includes(`${url.searchParams.get("host")}:${url.port}:${url.pathname.slice(1)}:${url.username}:${url.password}`));
      assert.ok(passwordFile.includes(`localhost:${url.port}:${url.pathname.slice(1)}:${url.username}:${url.password}`));
      assert.equal(passwordFile.includes("*"), false);
    }
  }
  assert.equal(new Set(passwords).size, 6);
  const original = await readFile(path.join(output, "tracker-runtime.json"), "utf8");
  await assert.rejects(prepareDatabases(input, output), { code: "EEXIST" });
  assert.equal(await readFile(path.join(output, "tracker-runtime.json"), "utf8"), original);
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  assert.equal(manifest.status, "prepared"); assert.ok(!JSON.stringify(manifest).includes("synthetic@"));
});
test("database plans reject SQL/libpq injection, public connections and unknown fields", () => {
  for (const change of [
    { namespace: 'assettracker_x";DROP DATABASE postgres;' }, { namespace: "postgres" }, { namespace: "assettracker_" }, { namespace: ["assettracker_array"] },
    { namespace: `assettracker_${"a".repeat(31)}` }, { extra: "typo" },
    { administratorUrl: settings.administratorUrl.replace("localhost", "example.test") },
    { administratorUrl: settings.administratorUrl.replace("/postgres?", "/production?") },
    { administratorUrl: settings.administratorUrl.replace("?host=/run/postgresql", "") },
    { administratorUrl: `${settings.administratorUrl}&options=unsafe` },
    { administratorUrl: `${settings.administratorUrl}&host=/tmp/socket` },
    { administratorUrl: settings.administratorUrl.replace("/run/postgresql", "/tmp/socket;injection") },
    { administratorUrl: settings.administratorUrl.replace(":55432", ":99999") },
  ]) assert.throws(() => provisioningSettings({ ...settings, ...change }));
});
test("database credentials refuse exposed files, symlinks, shared parents and other worktrees", async t => {
  const { directory, input, output } = await fixture(t);
  await chmod(input, 0o644); await assert.rejects(prepareDatabases(input, output)); await chmod(input, 0o600);
  const link = path.join(directory, "linked.json"); await symlink(input, link);
  await assert.rejects(prepareDatabases(link, output));
  const other = path.join(directory, "other"); await mkdir(other, { mode: 0o700 });
  await writeFile(path.join(other, ".git"), "gitdir: /private/other\n");
  await assert.rejects(prepareDatabases(input, path.join(other, "plan")));
  await chmod(directory, 0o755); await assert.rejects(prepareDatabases(input, output));
});
test("SCRAM generation accepts only generated ASCII passwords and salts each verifier", () => {
  const password = "A".repeat(43), first = scramVerifier(password), second = scramVerifier(password);
  assert.match(first, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
  assert.notEqual(first, second); assert.ok(!first.includes(password));
  for (const value of ["", "short", "é".repeat(43), " ".repeat(43)]) assert.throws(() => scramVerifier(value));
});
test("database CLI errors never expose private paths or administrator credentials", async t => {
  const { directory } = await fixture(t);
  const cli = fileURLToPath(new URL("../scripts/prepare-databases.mjs", import.meta.url));
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [cli, path.join(directory, "SYNTHETIC-PRIVATE-SECRET"), path.join(directory, "plan")], { stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", value => output += value); child.stderr.on("data", value => output += value);
    child.on("close", code => resolve({ code, output }));
  });
  assert.equal(result.code, 1); assert.ok(!result.output.includes("SYNTHETIC-PRIVATE-SECRET"));
});
