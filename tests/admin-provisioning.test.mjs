import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { buildProvisioningSql, provisioningCreated } from "../scripts/admin-provisioning.mjs";
import { createTestDatabase } from "./helpers/sqlite-d1.mjs";

const { default: worker } = await import(new URL("../dist/server/index.js", import.meta.url));
const context = { waitUntil() {}, passThroughOnException() {} };
const fixture = { name: "jdoe", pin: "482631" }; // Synthetic test credentials only.
const count = (database, table) => database.storage.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total;
const request = (database, method, body, headers = {}) => worker.fetch(
  new Request("https://tracker.test/api/auth", {
    method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { DB: database.db }, context,
);

test("an empty database rejects direct HTTP setup without creating a user or session", async (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const response = await request(database, "POST", { action: "setup", ...fixture });
  assert.equal(response.status, 403);
  assert.equal(response.headers.has("set-cookie"), false);
  assert.equal(count(database, "app_users"), 0);
  assert.equal(count(database, "app_sessions"), 0);
});

test("fresh status requires operator provisioning instead of public setup", async (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const response = await request(database, "GET");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { needsProvisioning: true, user: null });
});

test("an operator-created admin can sign in and resolve its issued session", async (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const provision = await buildProvisioningSql(fixture);
  assert.equal(database.storage.prepare(provision.sql).run().changes, 1);
  const stored = database.storage.prepare("SELECT role, active, pin_hash, pin_salt FROM app_users").get();
  assert.equal(stored.role, "admin");
  assert.equal(stored.active, 1);
  assert.notEqual(stored.pin_hash, fixture.pin);
  assert.equal(stored.pin_hash.length, 64);
  assert.equal(stored.pin_salt.length, 32);
  const response = await request(database, "POST", { action: "login", ...fixture });
  assert.equal(response.status, 200);
  assert.equal(count(database, "app_sessions"), 1);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const status = await request(database, "GET", undefined, { cookie: cookie.split(";")[0] });
  assert.deepEqual(await status.json(), {
    needsProvisioning: false, user: { id: provision.id, name: "jdoe", role: "admin" },
  });
});

test("initialized users block repeated operator provisioning and HTTP setup", async (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const first = await buildProvisioningSql(fixture);
  database.storage.prepare(first.sql).run();
  const before = database.storage.prepare("SELECT * FROM app_users").get();
  const next = await buildProvisioningSql({ name: "otheradmin", pin: "593742" });
  assert.equal(database.storage.prepare(next.sql).run().changes, 0);
  const response = await request(database, "POST", { action: "setup", name: "otheradmin", pin: "593742" });
  assert.equal(response.status, 403);
  assert.equal(count(database, "app_users"), 1);
  assert.deepEqual(database.storage.prepare("SELECT * FROM app_users").get(), before);
  assert.equal(count(database, "app_sessions"), 0);
});

test("a database containing only an inactive regular user cannot be bootstrapped again", async (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const first = await buildProvisioningSql(fixture);
  database.storage.prepare(first.sql).run();
  database.storage.exec("UPDATE app_users SET role = 'user', active = 0");
  const next = await buildProvisioningSql({ name: "newadmin", pin: "593742" });
  assert.equal(database.storage.prepare(next.sql).run().changes, 0);
  assert.equal(count(database, "app_users"), 1);
});

test("concurrent operator SQL on separate SQLite connections creates exactly one admin", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "assettracker-bootstrap-test-"));
  const filename = join(directory, "test.sqlite");
  const database = createTestDatabase(filename);
  t.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const provisions = await Promise.all([
    buildProvisioningSql({ name: "firstadmin", pin: "482631" }),
    buildProvisioningSql({ name: "secondadmin", pin: "593742" }),
  ]);
  // Start two independent threads together, each with its own database connection.
  // This checks the SQL write boundary rather than mocking a count/create race.
  const threads = provisions.map(({ sql }) => new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(workerData.filename);
    database.exec('PRAGMA busy_timeout = 5000');
    parentPort.once('message', () => {
      const changes = database.prepare(workerData.sql).run().changes;
      database.close();
      parentPort.postMessage({ changes });
      parentPort.close();
    });
    parentPort.postMessage('ready');
  `, { eval: true, workerData: { filename, sql } }));
  t.after(async () => { await Promise.all(threads.map((thread) => thread.terminate())); });
  await Promise.all(threads.map((thread) => once(thread, "message")));
  const results = threads.map((thread) => once(thread, "message"));
  for (const thread of threads) thread.postMessage("start");
  const changes = (await Promise.all(results)).map(([result]) => Number(result.changes));
  assert.deepEqual(changes.sort(), [0, 1]);
  assert.equal(count(database, "app_users"), 1);
});

test("invalid operator credentials are rejected before SQL is produced", async () => {
  for (const invalid of [{ name: "a", pin: "482631" }, { name: "jdoe", pin: "abc" }, { name: "jdoe", pin: "123" }]) {
    await assert.rejects(buildProvisioningSql(invalid), /Enter a username/);
  }
});

test("local Wrangler success is identified by the attempt ID without affected-row metadata", () => {
  const results = [
    { success: true, results: [], meta: { duration: 0 } },
    { success: true, results: [{ id: "synthetic-attempt-id" }], meta: { duration: 0 } },
  ];
  assert.equal(provisioningCreated(results, "synthetic-attempt-id"), true);
  assert.equal(provisioningCreated(results, "other-attempt-id"), false);
  assert.equal(provisioningCreated([{ success: true, results: [], meta: { changes: 1 } }], "synthetic-attempt-id"), false);
  assert.throws(() => provisioningCreated([{ success: false, results: [] }], "synthetic-attempt-id"), /unexpected result/);
});

test("HTTP rejects unknown actions and incorrect PINs without opening setup", async (t) => {
  const database = createTestDatabase();
  t.after(database.close);
  const provision = await buildProvisioningSql(fixture);
  database.storage.prepare(provision.sql).run();
  assert.equal((await request(database, "POST", { ...fixture })).status, 400);
  assert.equal((await request(database, "POST", { action: "create", ...fixture })).status, 400);
  assert.equal((await request(database, "POST", { action: "login", name: fixture.name, pin: "593742" })).status, 401);
  assert.equal(count(database, "app_users"), 1);
  assert.equal(count(database, "app_sessions"), 0);
});

test("the public auth gate hides input until provisioning and restores ordinary sign-in", async () => {
  const source = await readFile(new URL("../public/asset-tracker/app.js", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "showAuthGate");
  const elements = new Map();
  const state = { authNeedsProvisioning: false, $: (id) => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  }, document: { body: { classList: { add() {} } } } };
  const show = vm.runInNewContext(`(${declaration.getText(parsed)})`, state);
  show(true);
  assert.equal(elements.get("authForm").hidden, true);
  assert.equal(elements.get("authSubmit").textContent, "Sign In");
  assert.equal(state.authNeedsProvisioning, true);
  show(false);
  assert.equal(elements.get("authForm").hidden, false);
  assert.equal(state.authNeedsProvisioning, false);
});
