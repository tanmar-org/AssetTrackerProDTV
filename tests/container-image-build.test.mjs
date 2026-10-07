import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Substitute tool executables, not the helper: exercise its actual CLI argument
// routing and private-file guards without sudo privileges or a Docker daemon.
const revision = "a".repeat(40), image = `sha256:${"b".repeat(64)}`;
test("container release builds scope sudo to Docker and retain private operator ownership", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-build-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, "bin"), log = path.join(directory, "calls.jsonl");
  await mkdir(bin, { mode: 0o700 });
  const tool = `#!${process.execPath}
const fs = require('node:fs'), cp = require('node:child_process'), path = require('node:path');
const name = path.basename(process.argv[1]), args = process.argv.slice(2);
fs.appendFileSync(process.env.BUILD_TEST_LOG, JSON.stringify({name, args}) + '\\n');
if (name === 'git') {
  if (args[0] === 'status') process.stdout.write(process.env.BUILD_TEST_DIRTY || '');
  else if (args[0] === 'rev-parse') process.stdout.write('${revision}\\n');
  else process.exit(2);
} else if (name === 'sudo') {
  if (args[0] !== '--' || args[1] !== 'docker') process.exit(3);
  if (process.env.BUILD_TEST_DENIED) process.exit(1);
  process.exit(cp.spawnSync(path.join(__dirname, 'docker'), args.slice(2), {stdio:'inherit'}).status ?? 1);
} else if (name === 'docker') {
  if (args[0] === 'version') process.stdout.write('29.8.2\\n');
  else if (args[0] === 'build') process.exit(process.env.BUILD_TEST_BUILD_FAIL ? 1 : 0);
  else if (args[0] === 'image' && args[1] === 'inspect') {
    process.stdout.write(JSON.stringify([{Id:'${image}', Os:'linux', Architecture:'amd64',
      Config:{Labels:{'org.opencontainers.image.revision':process.env.BUILD_TEST_WRONG_REVISION || '${revision}'}}}]));
  } else process.exit(4);
} else process.exit(5);
`;
  for (const name of ["git", "sudo", "docker"]) await writeFile(path.join(bin, name), tool, { mode: 0o700 });
  const execute = async (name, args, changes = {}) => {
    await writeFile(log, "", { mode: 0o600 });
    const output = path.join(directory, name);
    const result = spawnSync(process.execPath, ["scripts/build-container-images.mjs", ...args, output], {
      cwd: new URL("../", import.meta.url), encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BUILD_TEST_LOG: log, ...changes },
    });
    const calls = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.ifError(result.error);
    return { result, output, calls };
  };
  await t.test("explicit sudo prefixes every Docker command while Git and outputs remain unprivileged", async () => {
    const { result, output, calls } = await execute("sudo-build", ["--sudo", "https://qr.example.test/"]);
    assert.equal(result.status, 0, result.stderr);
    const privileged = calls.filter(call => call.name === "sudo"), docker = calls.filter(call => call.name === "docker");
    assert.equal(privileged.length, 9); assert.equal(docker.length, 9);
    assert.deepEqual(privileged.map(call => call.args.slice(2)), docker.map(call => call.args));
    assert.ok(privileged.every(call => call.args[0] === "--" && call.args[1] === "docker"));
    assert.equal(docker.filter(call => call.args[0] === "build").length, 4);
    const pins = JSON.parse(await readFile(path.join(output, "images.json"), "utf8"));
    assert.deepEqual(pins, { version: 1, revision, publicQrUrl: "https://qr.example.test/", platform: "linux/amd64",
      appImage: image, postgresImage: image, operatorImage: image, gatewayImage: image });
    for (const [filename, mode] of [[output, 0o700], [path.join(output, "images.json"), 0o600]]) {
      const info = await stat(filename); assert.equal(info.uid, process.getuid()); assert.equal(info.mode & 0o777, mode);
    }
  });
  await t.test("direct-daemon use preserves CI behavior without invoking sudo", async () => {
    const { result, calls } = await execute("direct-build", ["https://qr.example.test/"]);
    assert.equal(result.status, 0, result.stderr); assert.ok(calls.every(call => call.name !== "sudo"));
    assert.equal(calls.filter(call => call.name === "docker").length, 9);
  });
  await t.test("denied daemon access creates no release directory or image build", async () => {
    const { result, output, calls } = await execute("denied", ["--sudo", "https://qr.example.test/"], { BUILD_TEST_DENIED: "yes" });
    assert.equal(result.status, 1); await assert.rejects(access(output));
    assert.equal(calls.filter(call => call.name === "sudo").length, 1);
    assert.ok(calls.every(call => call.name !== "docker"));
  });
  await t.test("dirty checkout and unsupported options refuse elevation", async () => {
    for (const [name, args, changes] of [
      ["dirty", ["--sudo", "https://qr.example.test/"], { BUILD_TEST_DIRTY: " M source.js\n" }],
      ["unknown", ["--sudo-shell", "https://qr.example.test/"], {}],
      ["duplicate", ["--sudo", "--sudo", "https://qr.example.test/"], {}],
      ["bad-origin", ["--sudo", "https://qr.example.test/$(echo unsafe)"], {}],
    ]) {
      const { result, output, calls } = await execute(name, args, changes);
      assert.equal(result.status, 1); await assert.rejects(access(output));
      assert.ok(calls.every(call => call.name !== "sudo" && call.name !== "docker"));
    }
  });
  await t.test("build failures and mismatched source revisions never publish an image manifest", async () => {
    for (const [name, changes] of [["failed", { BUILD_TEST_BUILD_FAIL: "yes" }], ["mismatch", { BUILD_TEST_WRONG_REVISION: "c".repeat(40) }]]) {
      const { result, output } = await execute(name, ["--sudo", "https://qr.example.test/"], changes);
      assert.equal(result.status, 1); await assert.rejects(access(path.join(output, "images.json")));
    }
  });
});
