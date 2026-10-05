import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@tanmar/database";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { migrate } from "../../scripts/migrations.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";

// Every database and credential below is synthetic. Use real PostgreSQL pools,
// restricted web roles, and built Node servers to verify the replacement backend.
test("Node/PostgreSQL integration", async (t) => {
  let tracker, requests, staffServer, qrServer;
  t.after(async () => {
    await staffServer?.close();
    await qrServer?.close();
    await tracker?.close();
    await requests?.close();
  });
  tracker = await createPostgresFixture("tracker");
  requests = await createPostgresFixture("requests");
  const secret = randomUUID();
  qrServer = await startNext(fileURLToPath(new URL("../../service-request/", import.meta.url)), {
    DATABASE_URL: requests.url, ADMIN_SHARED_SECRET: secret,
  });
  staffServer = await startNext(fileURLToPath(new URL("../../", import.meta.url)), {
    DATABASE_URL: tracker.url, ADMIN_SHARED_SECRET: secret,
    SERVICE_REQUEST_API_URL: `${qrServer.url}/api/requests`,
  });
  const fixture = { name: "jdoe", pin: "482631" };
  const call = (server, path, method = "GET", body, cookie, headers = {}) => fetch(`${server.url}${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = (path, method, body, cookie) => call(staffServer, path, method, body, cookie);
  const count = async (table) => Number((await tracker.database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first()).total);
  const reset = () => tracker.database.prepare("TRUNCATE app_sessions, app_users, app_change_log, app_state, app_state_history").run();
  const signIn = async (credentials = fixture) => {
    const response = await api("/api/auth", "POST", { action: "login", ...credentials });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const admin = async () => { await reset(); await provisionAdmin(tracker.database, fixture); return signIn(); };
  const state = (id) => ({
    master: [{ id, assetNumber: "TEST-001" }], accounts: [], assignments: [],
    activations: [], receiverEvents: [], auditState: null, rentalStock: [{ id: "TEST-STOCK" }],
  });
  const save = (cookie, id, baseRevision, action = "Test inventory change") =>
    api("/api/app-state", "PUT", { state: state(id), baseRevision, action }, cookie);

  await t.test("migrations are repeatable, checksummed, and cannot mix applications", async () => {
    await migrate(tracker.database, "tracker");
    assert.equal(Number((await tracker.database.prepare("SELECT COUNT(*) AS total FROM schema_migrations").first()).total), 2);
    await assert.rejects(migrate(tracker.database, "requests"), /other application/);
    await tracker.database.prepare("UPDATE schema_migrations SET checksum = 'synthetic-changed-checksum' WHERE name = 'tracker/0001_initial.sql'").run();
    await assert.rejects(migrate(tracker.database, "tracker"), /has changed/);
    // Restore only the changed test checksum without discarding migration history.
    const { createHash } = await import("node:crypto");
    const { readFile } = await import("node:fs/promises");
    const sql = await readFile(new URL("../../migrations/tracker/0001_initial.sql", import.meta.url));
    await tracker.database.prepare("UPDATE schema_migrations SET checksum = $1 WHERE name = $2")
      .bind(createHash("sha256").update(sql).digest("hex"), "tracker/0001_initial.sql").run();
  });

  await t.test("restricted web roles cannot create tables, edit migration history, or read the other app", async () => {
    await assert.rejects(tracker.runtime.prepare("CREATE TABLE forbidden_test (id text)").run());
    await assert.rejects(tracker.runtime.prepare("DELETE FROM schema_migrations").run());
    await assert.rejects(requests.runtime.prepare("SELECT * FROM app_users").all());
    await assert.rejects(tracker.runtime.prepare("SELECT * FROM service_requests").all());
  });

  await t.test("HTTP setup is rejected on a fresh database; status asks for operator provisioning", async () => {
    const response = await api("/api/auth", "POST", { action: "setup", ...fixture });
    assert.equal(response.status, 403);
    assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(await count("app_users"), 0);
    assert.equal(await count("app_sessions"), 0);
    const status = await api("/api/auth");
    assert.equal(status.headers.get("cache-control"), "no-store");
    assert.deepEqual(await status.json(), { needsProvisioning: true, user: null });
  });

  await t.test("concurrent provisioning on independent PostgreSQL pools creates exactly one admin", async () => {
    await reset();
    const connections = [createDatabase(tracker.ownerUrl), createDatabase(tracker.ownerUrl)];
    try {
      const results = await Promise.all(connections.map((database, index) =>
        provisionAdmin(database, { name: index ? "secondadmin" : "firstadmin", pin: fixture.pin })));
      assert.deepEqual(results.map((result) => result.created).sort(), [false, true]);
      assert.equal(await count("app_users"), 1);
    } finally { await Promise.all(connections.map((database) => database.close())); }
  });

  await t.test("operator-created salted admin can sign in and resolve a secure session", async () => {
    await reset();
    const provision = await provisionAdmin(tracker.database, fixture);
    const stored = await tracker.database.prepare("SELECT role, active, pin_hash, pin_salt FROM app_users").first();
    assert.equal(stored.role, "admin");
    assert.equal(stored.active, 1);
    assert.notEqual(stored.pin_hash, fixture.pin);
    assert.equal(stored.pin_hash.length, 64);
    assert.equal(stored.pin_salt.length, 32);
    const response = await api("/api/auth", "POST", { action: "login", ...fixture });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie");
    assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
    assert.equal(await count("app_sessions"), 1);
    assert.deepEqual(await (await api("/api/auth", "GET", undefined, cookie.split(";")[0])).json(), {
      needsProvisioning: false, user: { id: provision.id, name: "jdoe", role: "admin" },
    });
  });

  await t.test("any existing user, including an inactive regular user, blocks repeat bootstrap", async () => {
    await admin();
    const before = (await tracker.database.prepare("SELECT * FROM app_users").all()).results;
    assert.equal((await provisionAdmin(tracker.database, { name: "otheradmin", pin: "593742" })).created, false);
    assert.deepEqual((await tracker.database.prepare("SELECT * FROM app_users").all()).results, before);
    assert.equal((await api("/api/auth", "POST", { action: "setup", ...fixture })).status, 403);
    await tracker.database.prepare("UPDATE app_users SET active = 0, role = 'user'").run();
    assert.equal((await provisionAdmin(tracker.database, { name: "otheradmin", pin: "593742" })).created, false);
    assert.equal(await count("app_users"), 1);
  });

  await t.test("invalid HTTP actions/PINs are denied and logout invalidates the stored session", async () => {
    const cookie = await admin();
    assert.equal((await api("/api/auth", "POST", fixture)).status, 400);
    assert.equal((await api("/api/auth", "POST", { action: "create", ...fixture })).status, 400);
    assert.equal((await api("/api/auth", "POST", { action: "login", name: fixture.name, pin: "593742" })).status, 401);
    const response = await api("/api/auth", "DELETE", undefined, cookie);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal(await count("app_sessions"), 0);
    assert.equal((await api("/api/app-state", "GET", undefined, cookie)).status, 401);
  });

  await t.test("account creation, case-insensitive uniqueness, and unlock/PIN updates work on PostgreSQL", async () => {
    const cookie = await admin();
    const user = { name: "testuser", pin: "593742", role: "user" };
    assert.equal((await api("/api/users", "POST", user, cookie)).status, 200);
    assert.equal((await api("/api/users", "POST", { ...user, name: "TESTUSER" }, cookie)).status, 409);
    const row = await tracker.database.prepare("SELECT id FROM app_users WHERE name = 'testuser'").first();
    await tracker.database.prepare("UPDATE app_users SET failed_attempts = 3, locked_until = $1 WHERE id = $2")
      .bind(new Date(Date.now() + 60000).toISOString(), row.id).run();
    assert.equal((await api("/api/users", "PATCH", { id: row.id, name: "testuser", role: "user", unlock: true }, cookie)).status, 200);
    assert.equal((await tracker.database.prepare("SELECT failed_attempts FROM app_users WHERE id = $1").bind(row.id).first()).failed_attempts, 0);
    assert.equal((await api("/api/users", "PATCH", { id: row.id, name: "testuser", role: "user", pin: "647382" }, cookie)).status, 200);
    const regular = await signIn({ name: "testuser", pin: "647382" });
    for (const path of ["/api/users", "/api/recovery", "/api/activity"])
      assert.equal((await api(path, "GET", undefined, regular)).status, 403);
    const rows = await (await api("/api/users", "GET", undefined, cookie)).json();
    assert.equal(rows.users.some((item) => "pin_hash" in item || "pin_salt" in item), false);
  });

  await t.test("native JSONB preserves operational state and audit records", async () => {
    const cookie = await admin();
    assert.equal((await save(cookie, "initial", 0)).status, 200);
    const response = await api("/api/app-state", "GET", undefined, cookie);
    const stored = await response.json();
    assert.deepEqual(stored.state, state("initial"));
    assert.equal(stored.revision, 1);
    assert.equal(await count("app_change_log"), 1);
    assert.equal(await count("app_state_history"), 0);
  });

  await t.test("simultaneous initial and later saves accept one revision and reject the other", async () => {
    const cookie = await admin();
    for (const revision of [0, 1]) {
      const responses = await Promise.all([save(cookie, "writer-a", revision), save(cookie, "writer-b", revision)]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    }
    assert.equal(await count("app_state_history"), 1);
    assert.equal(await count("app_change_log"), 2);
    assert.equal((await tracker.database.prepare("SELECT revision FROM app_state").first()).revision, 2);
  });

  await t.test("JSONB key ordering does not inflate regular-user record change counts", async () => {
    const cookie = await admin();
    const initial = state("initial");
    initial.master = Array.from({ length: 12 }, (_, index) => ({ id: String(index), assetNumber: `TEST-${index}` }));
    assert.equal((await api("/api/app-state", "PUT", { state: initial, baseRevision: 0 }, cookie)).status, 200);
    const credentials = { name: "testuser", pin: "593742", role: "user" };
    await api("/api/users", "POST", credentials, cookie);
    const regular = await signIn(credentials);
    initial.master[0].assetNumber = "TEST-CHANGED";
    assert.equal((await api("/api/app-state", "PUT", { state: initial, baseRevision: 1 }, regular)).status, 200);
  });

  await t.test("an update rejected by PostgreSQL produces no orphan history or audit", async () => {
    const cookie = await admin();
    await save(cookie, "before", 0);
    // A test-only trigger makes UPDATE affect zero rows, exercising the retained
    // revision guard independently of cooperating application advisory locks.
    await tracker.database.prepare(`CREATE FUNCTION synthetic_skip_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER synthetic_skip BEFORE UPDATE ON app_state FOR EACH ROW EXECUTE FUNCTION synthetic_skip_update()`).run();
    try {
      assert.equal((await save(cookie, "after", 1)).status, 409);
      assert.equal(await count("app_state_history"), 0);
      assert.equal(await count("app_change_log"), 1);
      assert.equal((await tracker.database.prepare("SELECT revision FROM app_state").first()).revision, 1);
    } finally {
      await tracker.database.prepare("DROP TRIGGER synthetic_skip ON app_state; DROP FUNCTION synthetic_skip_update()").run();
    }
  });

  await t.test("a failed audit insert rolls back state and history without leaking SQL details", async () => {
    const cookie = await admin();
    await save(cookie, "before", 0);
    await tracker.database.prepare("ALTER TABLE app_change_log ADD CONSTRAINT synthetic_failure CHECK (action <> 'Reject transaction test')").run();
    try {
      const response = await save(cookie, "after", 1, "Reject transaction test");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Database save failed." });
      assert.equal((await tracker.database.prepare("SELECT revision FROM app_state").first()).revision, 1);
      assert.equal(await count("app_state_history"), 0);
      assert.equal(await count("app_change_log"), 1);
    } finally { await tracker.database.prepare("ALTER TABLE app_change_log DROP CONSTRAINT synthetic_failure").run(); }
  });

  await t.test("recovery rejects stale revisions and restores state/history/audit in one transaction", async () => {
    const cookie = await admin();
    await save(cookie, "before", 0);
    await save(cookie, "after", 1);
    const history = await (await api("/api/recovery", "GET", undefined, cookie)).json();
    const id = history.snapshots[0].id;
    assert.equal((await api("/api/recovery", "POST", { id }, cookie)).status, 400);
    assert.equal((await api("/api/recovery", "POST", { id, baseRevision: 1 }, cookie)).status, 409);
    assert.equal((await api("/api/recovery", "POST", { id, baseRevision: 2 }, cookie)).status, 200);
    const restored = await (await api("/api/app-state", "GET", undefined, cookie)).json();
    assert.deepEqual(restored.state, state("before"));
    assert.equal(restored.revision, 3);
    assert.equal(await count("app_state_history"), 2);
    assert.equal(await count("app_change_log"), 3);
    const responses = await Promise.all([
      api("/api/recovery", "POST", { id, baseRevision: 3 }, cookie),
      save(cookie, "concurrent", 3),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  });

  await t.test("public QR submission and authenticated tracker proxy preserve request lifecycle", async () => {
    const cookie = await admin();
    const payload = {
      assetNumber: "TEST-QR-01", serialNumber: "00000123", rid: "00000456", accessCard: "00000789",
      accountNumber: "000001", requesterName: "Synthetic Requester", requesterPhone: "555-0100",
      operatorName: "Test Operator", rigFrac: "Test Rig", lease: "Test Lease", errorCode: "771",
      latitude: 32.123456789, longitude: -102.987654321, gpsAccuracy: 10, gpsCapturedAt: new Date().toISOString(),
    };
    const response = await call(qrServer, "/api/requests", "POST", payload);
    assert.equal(response.status, 201);
    const { id } = await response.json();
    assert.equal((await call(qrServer, "/api/requests", "POST", payload)).status, 409);
    for (const method of ["GET", "PATCH", "DELETE"])
      assert.equal((await call(qrServer, "/api/requests", method, method === "PATCH" ? { id, status: "Completed" } : undefined)).status, 401);
    assert.equal((await call(qrServer, "/api/requests", "OPTIONS", undefined, undefined, { origin: "https://untrusted.test" })).status, 403);
    assert.equal((await api("/api/service-requests")).status, 401);
    const listed = await (await api("/api/service-requests", "GET", undefined, cookie)).json();
    assert.equal(listed.requests[0].id, id);
    assert.equal(listed.requests[0].serialNumber, payload.serialNumber);
    assert.equal(listed.requests[0].latitude, payload.latitude);
    const notes = "Synthetic apostrophe ' and SQL-like text ; DROP TABLE service_requests;";
    assert.equal((await api("/api/service-requests", "PATCH", { id, status: "Completed", notes }, cookie)).status, 200);
    assert.equal((await requests.database.prepare("SELECT notes FROM service_requests WHERE id = $1").bind(id).first()).notes, notes);
    assert.equal((await api(`/api/service-requests?id=${id}`, "DELETE", undefined, cookie)).status, 200);
    assert.equal((await (await api("/api/service-requests", "GET", undefined, cookie)).json()).requests.length, 0);
    assert.ok((await requests.database.prepare("SELECT deleted_at FROM service_requests WHERE id = $1").bind(id).first()).deleted_at);
  });

  await t.test("both readiness endpoints reach their restricted PostgreSQL connections", async () => {
    for (const server of [staffServer, qrServer]) {
      const response = await call(server, "/api/health");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { status: "ok" });
    }
  });
});
