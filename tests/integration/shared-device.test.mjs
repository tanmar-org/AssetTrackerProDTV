import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";
import { sessionHeaders } from "../helpers/session-context.mjs";
import { inventory } from "../helpers/inventory-fixture.mjs";

// Real cookies, authorization, and transactions exercise the shared-device
// boundary. A context is a tab identity check, never a substitute for a cookie.
test("shared-device HTTP session boundaries", async (t) => {
  const tracker = await createPostgresFixture("tracker");
  let server;
  t.after(async () => { await server?.close(); await tracker.close(); });
  server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: tracker.url });
  const admin = { name: "testadmin", pin: "482631" };
  const other = { name: "teststaff", pin: "593742", role: "user" };
  await provisionAdmin(tracker.database, admin);
  const api = (path, method = "GET", body, cookie, context = sessionHeaders(cookie)) => fetch(`${server.url}${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...context },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async (account) => {
    const response = await api("/api/auth", "POST", { action: "login", ...account });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const profile = await response.json();
    assert.equal(profile.sessionContext, sessionHeaders(cookie)["x-tracker-session-context"]);
    return cookie;
  };
  let cookie = await login(admin);
  assert.equal((await api("/api/users", "POST", other, cookie)).status, 200);

  await t.test("context values cannot authenticate; omitted or stale mutation contexts fail", async () => {
    const context = sessionHeaders(cookie);
    assert.equal((await api("/api/app-state", "GET", undefined, undefined, context)).status, 401);
    const token = cookie.split("=")[1];
    const stored = await tracker.database.prepare("SELECT token_hash FROM app_sessions").first();
    assert.equal(stored.token_hash, createHash("sha256").update(token).digest("hex"));
    assert.notEqual(stored.token_hash, context["x-tracker-session-context"]);
    for (const headers of [{}, { "x-tracker-session-context": "f".repeat(64) }]) {
      assert.equal((await api("/api/app-state", "PUT", { state: inventory(), baseRevision: 0 }, cookie, headers)).status, 401);
      assert.equal((await api("/api/users", "POST", { ...other, name: "blockeduser" }, cookie, headers)).status, 401);
    }
    assert.equal((await api("/api/app-state", "GET", undefined, cookie, { "x-tracker-session-context": "f".repeat(64) })).status, 401);
    assert.equal((await api("/api/app-state", "PUT", { state: inventory(), baseRevision: 0 }, cookie)).status, 200);
    assert.equal((await api("/api/auth", "DELETE", undefined, cookie, {})).status, 400);
    assert.equal((await api("/api/app-state", "GET", undefined, cookie)).status, 200);
  });

  await t.test("a shared cookie switch cannot attribute old-tab writes to a new employee or session", async () => {
    const old = cookie;
    for (const account of [other, admin]) {
      const newer = await login(account);
      assert.equal((await api("/api/app-state", "PATCH", { state: inventory(), baseRevision: 1 }, newer, sessionHeaders(old))).status, 401);
      const signout = await api("/api/auth", "DELETE", undefined, newer, sessionHeaders(old));
      assert.equal(signout.status, 200);
      assert.deepEqual(await signout.json(), { ok: true, sessionChanged: true });
      assert.equal(signout.headers.has("set-cookie"), false);
      assert.equal((await api("/api/app-state", "GET", undefined, newer)).status, 200);
      cookie = newer;
    }
    const row = await tracker.database.prepare("SELECT revision FROM app_state").first();
    assert.equal(Number(row.revision), 1);
  });

  await t.test("failed session deletion never clears the cookie or falsely confirms logout", async () => {
    await tracker.database.prepare(`CREATE FUNCTION synthetic_logout_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'synthetic logout failure'; END $$;
      CREATE TRIGGER synthetic_logout_failure BEFORE DELETE ON app_sessions FOR EACH ROW EXECUTE FUNCTION synthetic_logout_failure()`).run();
    try {
      const response = await api("/api/auth", "DELETE", undefined, cookie);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Unable to sign out." });
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal((await api("/api/app-state", "GET", undefined, cookie)).status, 200);
    } finally { await tracker.database.prepare("DROP TRIGGER synthetic_logout_failure ON app_sessions; DROP FUNCTION synthetic_logout_failure()").run(); }
  });

  await t.test("confirmed sign-out revokes the cookie and serializes against staff writes", async () => {
    let unlock, acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    const gate = new Promise((resolve) => { unlock = resolve; });
    const blocker = tracker.database.transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      acquired(); await gate;
    });
    await ready;
    const pending = api("/api/auth", "DELETE", undefined, cookie);
    try {
      let queued = false;
      for (let attempt = 0; attempt < 100 && !queued; attempt++) {
        const row = await tracker.database.prepare("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE usename = $1 AND wait_event = 'advisory'")
          .bind(new URL(tracker.url).username).first();
        queued = Number(row.total) > 0;
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(queued, true, "Logout must share the account authorization lock.");
    } finally { unlock(); await blocker; }
    const response = await pending;
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await api("/api/app-state", "GET", undefined, cookie)).status, 401);
    assert.equal((await api("/api/app-state", "PUT", { state: inventory(), baseRevision: 1 }, cookie)).status, 401);
  });
});
