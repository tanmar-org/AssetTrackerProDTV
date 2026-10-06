import { sessionHeaders } from "../helpers/session-context.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { migrate } from "../../scripts/migrations.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";

// Use the built HTTP server and a restricted web role against real PostgreSQL.
// All accounts, PINs, locks, and failure-injection DDL are disposable test data.
test("account security and concurrency", async (t) => {
  let tracker, server;
  t.after(async () => { await server?.close(); await tracker?.close(); });
  tracker = await createPostgresFixture("tracker");
  server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: tracker.url });
  const credentials = { name: "jdoe", pin: "482631" };
  const staff = { name: "testuser", pin: "593742", role: "user" };
  const api = (path, method = "GET", body, cookie, baseUrl = server.url) => fetch(`${baseUrl}${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie, ...sessionHeaders(cookie) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = (account = credentials) => api("/api/auth", "POST", { action: "login", ...account });
  const signIn = async (account = credentials) => {
    const response = await login(account);
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const user = (name = staff.name) => tracker.database.prepare("SELECT * FROM app_users WHERE name = $1").bind(name).first();
  const reset = async () => {
    await tracker.database.prepare("TRUNCATE app_sessions, app_users, app_change_log").run();
    await provisionAdmin(tracker.database, credentials);
    return signIn();
  };
  const add = async (admin, account = staff) => {
    assert.equal((await api("/api/users", "POST", account, admin)).status, 200);
    return user(account.name);
  };
  const sessionCount = async (id) => Number((await tracker.database.prepare("SELECT COUNT(*) AS total FROM app_sessions WHERE user_id = $1")
    .bind(id).first()).total);

  await t.test("upgrading existing accounts fails atomically on incompatible rows without rewriting credentials", async () => {
    await reset();
    // Recreate the old schema state on this fixture only, preserving its user
    // and session. An invalid legacy counter must fail the entire new migration.
    await tracker.database.prepare(`ALTER TABLE app_users
      DROP CONSTRAINT app_users_pin_hash_format, DROP CONSTRAINT app_users_pin_salt_format,
      DROP CONSTRAINT app_users_attempts_bounded;
      ALTER TABLE app_sessions DROP CONSTRAINT app_sessions_token_hash_format;
      DROP INDEX app_sessions_user_idx;
      DELETE FROM schema_migrations WHERE name = 'tracker/0002_access_constraints.sql';
      UPDATE app_users SET failed_attempts = 5`).run();
    await assert.rejects(migrate(tracker.database, "tracker"));
    const constraints = await tracker.database.prepare("SELECT COUNT(*) AS total FROM pg_constraint WHERE conname IN ('app_users_pin_hash_format', 'app_users_pin_salt_format')").first();
    assert.equal(Number(constraints.total), 0);
    assert.equal((await tracker.database.prepare("SELECT name FROM schema_migrations WHERE name = 'tracker/0002_access_constraints.sql'").first()), null);
    await tracker.database.prepare("UPDATE app_users SET failed_attempts = 4").run();
    const before = await user(credentials.name);
    await migrate(tracker.database, "tracker");
    await migrate(tracker.database, "tracker");
    assert.deepEqual(await user(credentials.name), before);
    assert.equal(await sessionCount(before.id), 1);
  });

  await t.test("concurrent wrong PINs across Node servers count five failures before locking", async (scenario) => {
    await reset();
    const other = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: tracker.url });
    scenario.after(() => other.close());
    const responses = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      api("/api/auth", "POST", { action: "login", ...credentials, pin: "593742" }, undefined, index % 2 ? other.url : server.url)));
    assert.deepEqual(responses.map((response) => response.status).sort(), [...Array(5).fill(401), ...Array(7).fill(423)]);
    assert.equal(responses.some((response) => response.headers.has("set-cookie")), false);
    const row = await user(credentials.name);
    assert.equal(row.failed_attempts, 0);
    assert.ok(Date.parse(row.locked_until) > Date.now() + 14 * 60 * 1000);
    assert.equal((await login()).status, 423);
    // Expiry permits attempts again; a successful login clears the lock/counter.
    await tracker.database.prepare("UPDATE app_users SET locked_until = $1 WHERE id = $2")
      .bind(new Date(Date.now() - 1000).toISOString(), row.id).run();
    assert.equal((await login({ ...credentials, pin: "593742" })).status, 401);
    assert.equal((await user(credentials.name)).failed_attempts, 1);
    assert.equal((await login()).status, 200);
    assert.equal((await user(credentials.name)).failed_attempts, 0);
    assert.equal((await user(credentials.name)).locked_until, null);
  });

  await t.test("PIN resets revoke every session and require the new PIN", async () => {
    const admin = await reset();
    const row = await add(admin);
    const sessions = await Promise.all([signIn(staff), signIn(staff)]);
    assert.equal(await sessionCount(row.id), 2);
    const response = await api("/api/users", "PATCH", { id: row.id, pin: "647382" }, admin);
    assert.equal(response.status, 200);
    assert.equal(await sessionCount(row.id), 0);
    for (const cookie of sessions) assert.equal((await api("/api/app-state", "GET", undefined, cookie)).status, 401);
    assert.equal((await login(staff)).status, 401);
    assert.equal((await login({ ...staff, pin: "647382" })).status, 200);
    const changed = await user();
    assert.equal(changed.role, "user");
    assert.equal(changed.active, 1);
    assert.equal(changed.name, staff.name);
  });

  await t.test("PIN reset racing login cannot leave an old-PIN session valid", async () => {
    const admin = await reset();
    const row = await add(admin);
    const [signedIn, resetPin] = await Promise.all([
      login(staff), api("/api/users", "PATCH", { id: row.id, pin: "647382" }, admin),
    ]);
    assert.equal(resetPin.status, 200);
    assert.ok([200, 401].includes(signedIn.status));
    if (signedIn.status === 200) {
      const old = signedIn.headers.get("set-cookie").split(";")[0];
      assert.equal((await api("/api/app-state", "GET", undefined, old)).status, 401);
    }
    assert.equal(await sessionCount(row.id), 0);
    assert.equal((await login({ ...staff, pin: "647382" })).status, 200);
  });

  await t.test("role/deactivation changes revoke sessions; reactivation does not revive them", async () => {
    const admin = await reset();
    const row = await add(admin);
    const old = await signIn(staff);
    assert.equal((await api("/api/users", "PATCH", { id: row.id, role: "admin" }, admin)).status, 200);
    assert.equal((await api("/api/users", "GET", undefined, old)).status, 401);
    const promoted = await signIn(staff);
    assert.equal((await api("/api/users", "GET", undefined, promoted)).status, 200);
    assert.equal((await api("/api/users", "PATCH", { id: row.id, active: false }, admin)).status, 200);
    assert.equal(await sessionCount(row.id), 0);
    assert.equal((await login(staff)).status, 401);
    assert.equal((await api("/api/users", "PATCH", { id: row.id, active: true }, admin)).status, 200);
    assert.equal((await api("/api/users", "GET", undefined, promoted)).status, 401);
    assert.equal((await login(staff)).status, 200);
  });

  await t.test("the last active admin cannot be demoted; inactive admins do not count", async () => {
    const admin = await reset();
    const first = await user(credentials.name);
    assert.equal((await api("/api/users", "PATCH", { id: first.id, role: "user" }, admin)).status, 409);
    assert.equal((await api("/api/users", "PATCH", { id: first.id, active: false }, admin)).status, 400);
    const second = await add(admin, { ...staff, role: "admin" });
    await api("/api/users", "PATCH", { id: second.id, active: false }, admin);
    assert.equal((await api("/api/users", "PATCH", { id: first.id, role: "user" }, admin)).status, 409);
    assert.equal((await api("/api/users", "GET", undefined, admin)).status, 200);
  });

  await t.test("concurrent self-demotions leave exactly one active administrator", async () => {
    const admin = await reset();
    const first = await user(credentials.name);
    const second = await add(admin, { ...staff, role: "admin" });
    const other = await signIn(staff);
    const responses = await Promise.all([
      api("/api/users", "PATCH", { id: first.id, role: "user" }, admin),
      api("/api/users", "PATCH", { id: second.id, role: "user" }, other),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const success = responses.find((response) => response.status === 200);
    assert.equal((await success.json()).reauthenticate, true);
    assert.match(success.headers.get("set-cookie"), /Max-Age=0/);
    const active = await tracker.database.prepare("SELECT COUNT(*) AS total FROM app_users WHERE role = 'admin' AND active = 1").first();
    assert.equal(Number(active.total), 1);
  });

  await t.test("queued account mutations recheck a revoked administrator session", async () => {
    const admin = await reset();
    const row = await user(credentials.name);
    let release, acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    // An independent operator transaction holds the same advisory lock. Wait
    // until the HTTP request is queued, then revoke its actor before releasing.
    const blocker = tracker.database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      acquired();
      await gate;
      await tx.prepare("UPDATE app_users SET role = 'user' WHERE id = $1").bind(row.id).run();
      await tx.prepare("DELETE FROM app_sessions WHERE user_id = $1").bind(row.id).run();
    });
    await ready;
    const pending = api("/api/users", "POST", staff, admin);
    try {
      let queued = false;
      for (let attempt = 0; attempt < 100 && !queued; attempt++) {
        const activity = await tracker.database.prepare("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE usename = $1 AND wait_event = 'advisory'")
          .bind(new URL(tracker.url).username).first();
        queued = Number(activity.total) > 0;
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(queued, true, "The HTTP request should wait on the account lock.");
    } finally { release(); await blocker; }
    assert.equal((await pending).status, 401);
    assert.equal(await user(), null);
  });

  await t.test("account creation and PIN reset roll back when their audit insert fails", async () => {
    const admin = await reset();
    const row = await add(admin);
    const regular = await signIn(staff);
    const before = await user();
    await tracker.database.prepare("ALTER TABLE app_change_log ADD CONSTRAINT synthetic_account_audit CHECK (action NOT IN ('Added user auditfail', 'Reset PIN for user testuser'))").run();
    try {
      const create = await api("/api/users", "POST", { ...staff, name: "auditfail" }, admin);
      assert.equal(create.status, 503);
      assert.deepEqual(await create.json(), { error: "Account service unavailable." });
      assert.equal(await user("auditfail"), null);
      const resetPin = await api("/api/users", "PATCH", { id: row.id, pin: "647382" }, admin);
      assert.equal(resetPin.status, 503);
      assert.deepEqual(await resetPin.json(), { error: "Account service unavailable." });
      assert.deepEqual(await user(), before);
      assert.equal(await sessionCount(row.id), 1);
      assert.equal((await api("/api/app-state", "GET", undefined, regular)).status, 200);
    } finally { await tracker.database.prepare("ALTER TABLE app_change_log DROP CONSTRAINT synthetic_account_audit").run(); }
  });

  await t.test("failed session issuance rolls back successful-login account updates", async () => {
    await reset();
    const row = await user(credentials.name);
    await tracker.database.prepare("UPDATE app_users SET failed_attempts = 2 WHERE id = $1").bind(row.id).run();
    const before = await user(credentials.name);
    await tracker.database.prepare(`CREATE FUNCTION synthetic_session_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic session insert failure'; END $$;
      CREATE TRIGGER synthetic_session_failure BEFORE INSERT ON app_sessions FOR EACH ROW EXECUTE FUNCTION synthetic_session_failure()`).run();
    try {
      const response = await login();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Unable to sign in." });
      assert.equal(response.headers.has("set-cookie"), false);
      assert.deepEqual(await user(credentials.name), before);
      assert.equal(await sessionCount(row.id), 1);
    } finally { await tracker.database.prepare("DROP TRIGGER synthetic_session_failure ON app_sessions; DROP FUNCTION synthetic_session_failure()").run(); }
  });

  await t.test("self PIN reset clears the cookie and expired sessions are pruned on login", async () => {
    const admin = await reset();
    const row = await user(credentials.name);
    await tracker.database.prepare("UPDATE app_sessions SET expires_at = $1 WHERE user_id = $2")
      .bind(new Date(Date.now() - 1000).toISOString(), row.id).run();
    const renewed = await signIn();
    assert.equal(await sessionCount(row.id), 1);
    const response = await api("/api/users", "PATCH", { id: row.id, pin: "647382" }, renewed);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reauthenticate, true);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
    for (const cookie of [admin, renewed]) assert.equal((await api("/api/users", "GET", undefined, cookie)).status, 401);
    assert.equal((await login({ ...credentials, pin: "647382" })).status, 200);
  });

  await t.test("legacy display-name aliases work without login-side renaming; ambiguous aliases fail", async () => {
    const admin = await reset();
    const row = await add(admin);
    await tracker.database.prepare("UPDATE app_users SET name = 'Alice Smith' WHERE id = $1").bind(row.id).run();
    assert.equal((await login({ ...staff, name: "asmith", pin: "647382" })).status, 401);
    assert.equal((await user("Alice Smith")).name, "Alice Smith");
    assert.equal((await login({ ...staff, name: "asmith" })).status, 200);
    assert.equal((await user("Alice Smith")).name, "Alice Smith");
    const second = await add(admin, { ...staff, name: "seconduser" });
    await tracker.database.prepare("UPDATE app_users SET name = 'Andrew Smith' WHERE id = $1").bind(second.id).run();
    assert.equal((await login({ ...staff, name: "asmith" })).status, 401);
  });

  await t.test("strict HTTP input and account permissions reject bypasses without changes", async () => {
    const admin = await reset();
    const row = await add(admin);
    const regular = await signIn(staff);
    for (const method of ["POST", "PATCH"]) {
      assert.equal((await api("/api/users", method, { ...staff, id: row.id, role: "admin" }, regular)).status, 403);
      assert.equal((await api("/api/users", method, { ...staff, id: row.id, role: "admin" })).status, 401);
    }
    const before = await user();
    for (const invalid of [{ role: "superadmin" }, { active: "false" }, { unlock: 1 }, { pin: null }, { pin: 1234 }, { name: {} }])
      assert.equal((await api("/api/users", "PATCH", { id: row.id, ...invalid }, admin)).status, 400);
    assert.deepEqual(await user(), before);
    assert.equal((await login({ name: {}, pin: staff.pin })).status, 400);
    assert.equal((await login({ name: staff.name, pin: 1234 })).status, 400);
    const oversized = await login({ ...staff, name: "a".repeat(5000) });
    assert.equal(oversized.status, 413);
    assert.equal((await fetch(`${server.url}/api/auth`, { method: "POST", headers: { "content-type": "text/plain" }, body: '{}' })).status, 415);
    assert.equal((await api("/api/auth", "POST", null)).status, 400);
    assert.equal((await api("/api/users", "GET", undefined, "tanmar_session=%")).status, 401);
  });

  await t.test("database constraints reject invalid hashes and unbounded failure counters", async () => {
    await reset();
    const row = await user(credentials.name);
    for (const statement of [
      "UPDATE app_users SET failed_attempts = 5", "UPDATE app_users SET pin_hash = 'not-a-hash'",
      "UPDATE app_users SET pin_salt = 'not-a-salt'", "UPDATE app_sessions SET token_hash = 'not-a-hash'",
    ]) await assert.rejects(tracker.runtime.prepare(statement).run());
    assert.equal((await user(credentials.name)).failed_attempts, 0);
    assert.equal(await sessionCount(row.id), 1);
  });
});
