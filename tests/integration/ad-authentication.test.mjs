import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { linkAdIdentity } from "../../scripts/ad-linking.mjs";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { createSession } from "../../lib/pin-auth.ts";
import { createLdapDirectory, directoryGuid, syntheticAdEntry } from "../helpers/ldap-directory.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";
import { sessionHeaders } from "../helpers/session-context.mjs";
import { inventory, when } from "../helpers/inventory-fixture.mjs";

// Real restricted PostgreSQL, independent Node processes and actual TLS LDAP.
// All names, passwords, certificates, data and directory traffic are synthetic.
test("AD sign-in, explicit account ownership and session revocation", { timeout: 90000 }, async t => {
  const tracker = await createPostgresFixture("tracker"), directory = await createLdapDirectory(), servers = [];
  t.after(async () => { for (const server of servers.reverse()) await server.close(); await directory.close();
    await tracker.close(); assert.deepEqual(directory.errors, []); });
  const env = { ...directory.env, DATABASE_URL: tracker.url, LOGIN_PROXY_SECRET: "" };
  const start = async extra => { const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { ...env, ...extra });
    servers.push(server); return server; };
  const first = await start(), second = await start(), pinServer = await start({ AUTH_MODE: "pin" });
  const model = directory.model, count = async table => Number((await tracker.database.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n);
  const api = (server, path, method = "GET", body, cookie, headers = {}) => fetch(`${server.url}${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie, ...sessionHeaders(cookie) } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = (server = first, body = {}) => api(server, "/api/auth", "POST", { action: "login", name: "j.doe", password: model.entries[0].password, ...body });
  const signIn = async (server = first) => { const response = await login(server); assert.equal(response.status, 200);
    return { cookie: response.headers.get("set-cookie").split(";")[0], body: await response.json() }; };
  let userId;
  const setup = async ({ linked = true, adBootstrap = false } = {}) => {
    await tracker.database.prepare("TRUNCATE app_service_operations,app_inventory_drafts,app_sessions,app_users,app_state,app_state_history,app_change_log,app_login_rate_limits").run();
    model.entries = [syntheticAdEntry()]; model.requests = []; model.stall = false; model.onUserBind = null; model.omit = null;
    model.domainPartitions = true; model.rejectDomainScope = false; model.referral = false;
    const provisioned = await provisionAdmin(tracker.database, { name: "appadmin", pin: "482631" }, { mode: adBootstrap ? "ad" : "pin" });
    userId = provisioned.id;
    if (linked) await linkAdIdentity(tracker.database, { userId, guid: directoryGuid, directory: directory.env.AD_DIRECTORY_ID });
  };
  const ageSessions = () => tracker.database.prepare("UPDATE app_sessions SET directory_checked_at = $1 WHERE auth_method='ad'")
    .bind(Math.floor(Date.now() / 1000) - 61).run();
  const link = options => linkAdIdentity(tracker.database, { userId, guid: directoryGuid, directory: directory.env.AD_DIRECTORY_ID, ...options });

  // Both unsupported controls and unexpected referrals deny HTTP access;
  // neither failure may issue a session or refresh an expired approval cache.
  await t.test("domain scope failures deny login and stale-session access without extending approval", async () => {
    for (const failure of ["rejectDomainScope", "referral"]) {
      await setup(); model[failure] = true;
      const denied = await login(); assert.equal(denied.status, 503);
      assert.equal(denied.headers.has("set-cookie"), false); assert.equal(await count("app_sessions"), 0);
      model[failure] = false; const session = await signIn(); await ageSessions();
      const before = await tracker.database.prepare("SELECT directory_checked_at FROM app_sessions").first();
      model[failure] = true;
      assert.equal((await api(second, "/api/app-state", "GET", undefined, session.cookie)).status, 503);
      assert.deepEqual(await tracker.database.prepare("SELECT directory_checked_at FROM app_sessions").first(), before);
      model[failure] = false;
    }
  });

  await t.test("AD bootstrap creates an unlinked role record without a PIN; matching names do not grant access", async () => {
    await setup({ linked: false, adBootstrap: true });
    await tracker.database.prepare("UPDATE app_users SET name='j.doe' WHERE id=$1").bind(userId).run();
    const response = await login(); assert.equal(response.status, 401); assert.equal(response.headers.has("set-cookie"), false);
    assert.equal(await count("app_users"), 1); assert.equal(await count("app_sessions"), 0);
    assert.equal((await tracker.database.prepare("SELECT ad_guid FROM app_users").first()).ad_guid, null);
  });
  await t.test("explicit links retain IDs, app roles, inventory and owner-only recovery copies", async () => {
    await setup(); const draftId = randomUUID(), state = inventory();
    await tracker.database.prepare("INSERT INTO app_state VALUES ('tanmar-receiver-control',$1,1,$2,'appadmin')").bind(JSON.stringify(state), when).run();
    await tracker.database.prepare("INSERT INTO app_inventory_drafts VALUES ($1,$2,1,1,$3,$3,'Synthetic AD recovery','active',now(),now()+interval '7 days')")
      .bind(draftId, userId, JSON.stringify(state)).run();
    const sessions = await Promise.all([signIn(first), signIn(second)]);
    for (const session of sessions) {
      assert.deepEqual(session.body.user, { id: userId, name: "appadmin", role: "admin" }); assert.equal(session.body.authMode, "ad");
      const profile = await (await api(second, "/api/auth", "GET", undefined, session.cookie)).json(); assert.equal(profile.user.id, userId);
      assert.equal((await (await api(first, "/api/drafts", "GET", undefined, session.cookie)).json()).drafts[0].id, draftId);
      assert.equal((await api(second, "/api/app-state", "GET", undefined, session.cookie)).status, 200);
    }
    const rows = (await tracker.database.prepare("SELECT * FROM app_sessions").all()).results;
    assert.ok(rows.every(row => row.auth_method === "ad" && row.ad_guid === directoryGuid && row.ad_password_stamp === model.entries[0].stamp));
    assert.ok(rows.every(row => !JSON.stringify(row).includes(model.entries[0].password)));
  });
  await t.test("AD mode refuses PIN payloads and old PIN sessions; local mode refuses AD sessions", async () => {
    await setup(); const old = await createSession(userId, tracker.database);
    assert.equal((await login(first, { password: undefined, pin: "482631" })).status, 400);
    assert.equal((await api(first, "/api/app-state", "GET", undefined, old.cookie.split(";")[0])).status, 401);
    const ad = await signIn(); assert.equal((await api(pinServer, "/api/app-state", "GET", undefined, ad.cookie)).status, 401);
  });
  await t.test("waiting for the account lock cannot extend the cached directory approval", async () => {
    await setup(); let pending, releasedAt;
    await tracker.database.transaction(async tx => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      pending = login();
      // Hold SQL authorization until both real directory reads have completed.
      for (let attempt = 0; attempt < 100 && model.requests.filter(value => value.type === "search").length < 2; attempt++) await delay(25);
      assert.equal(model.requests.filter(value => value.type === "search").length, 2);
      await delay(1500); releasedAt = Math.floor(Date.now() / 1000);
    });
    assert.equal((await pending).status, 200);
    const stored = await tracker.database.prepare("SELECT directory_checked_at FROM app_sessions").first();
    assert.ok(Number(stored.directory_checked_at) < releasedAt);
  });
  await t.test("unknown/wrong/empty passwords are denied without cookies or local PIN counter rewrites", async () => {
    await setup();
    for (const [body, status] of [[{ password: "Wrong synthetic password" }, 401], [{ name: "unknown" }, 401], [{ password: "" }, 400]]) {
      const response = await login(first, body); assert.equal(response.status, status); assert.equal(response.headers.has("set-cookie"), false);
    }
    assert.equal(await count("app_sessions"), 0);
    assert.equal((await tracker.database.prepare("SELECT failed_attempts FROM app_users").first()).failed_attempts, 0);
  });
  await t.test("AD traffic budgets precede all directory binds across processes", async () => {
    await setup(); const window = Math.floor(Date.now() / 1000 / 60);
    for (const value of [window, window + 1]) await tracker.database.prepare("INSERT INTO app_login_rate_limits VALUES ($1,300,$2)").bind(`global:${value}`, (value + 1) * 60).run();
    for (const server of [first, second]) { const response = await login(server); assert.equal(response.status, 429); assert.equal(response.headers.has("set-cookie"), false); }
    assert.equal(model.requests.length, 0);
  });
  await t.test("application deactivation while directory bind is in flight denies session issuance", async () => {
    await setup(); model.onUserBind = () => tracker.database.prepare("UPDATE app_users SET active=0 WHERE id=$1").bind(userId).run();
    assert.equal((await login()).status, 401); assert.equal(await count("app_sessions"), 0);
  });
  await t.test("username reuse with a new GUID cannot inherit an existing app role or recovery ownership", async () => {
    await setup(); model.entries[0].guid = "87654321-90ab-cdef-8123-456789abcdef";
    model.entries[0].bytes = Buffer.from("21436587ab90efcd8123456789abcdef", "hex");
    assert.equal((await login()).status, 401); assert.equal(await count("app_sessions"), 0);
    assert.equal((await tracker.database.prepare("SELECT ad_guid FROM app_users").first()).ad_guid, directoryGuid);
  });
  await t.test("session status approval is shared; directory disable/lock/reset/missing user revokes old sessions", async () => {
    for (const change of ["disable", "lock", "password", "missing"]) {
      await setup(); const sessions = await Promise.all([signIn(), signIn(second)]); model.requests = [];
      assert.equal((await api(second, "/api/app-state", "GET", undefined, sessions[0].cookie)).status, 200);
      assert.equal(model.requests.length, 0); // Shared recent approval, not process memory.
      if (change === "disable") model.entries[0].flags = "514";
      if (change === "lock") model.entries[0].computed = "16";
      if (change === "password") model.entries[0].stamp = "134000000000000001";
      if (change === "missing") model.entries = [];
      await ageSessions();
      assert.equal((await api(second, "/api/app-state", "GET", undefined, sessions[0].cookie)).status, 401);
      assert.equal(await count("app_sessions"), 0);
      for (const session of sessions) assert.equal((await api(first, "/api/app-state", "GET", undefined, session.cookie)).status, 401);
    }
  });
  await t.test("directory outage fails expired status checks closed without extending approval", async () => {
    await setup(); const session = await signIn(); await ageSessions(); model.omit = "userAccountControl";
    const response = await api(second, "/api/app-state", "GET", undefined, session.cookie); assert.equal(response.status, 503);
    const row = await tracker.database.prepare("SELECT directory_checked_at FROM app_sessions").first();
    assert.ok(Number(row.directory_checked_at) < Math.floor(Date.now() / 1000) - 60);
    assert.equal(response.headers.has("set-cookie"), false); model.omit = null;
    assert.equal((await api(first, "/api/app-state", "GET", undefined, session.cookie)).status, 200);
  });
  await t.test("AD rename retains ownership; changing the server binding or namespace invalidates existing sessions", async () => {
    await setup(); const session = await signIn(); model.entries[0].username = "renamed.doe"; await ageSessions();
    assert.equal((await api(second, "/api/app-state", "GET", undefined, session.cookie)).status, 200);
    const alternate = await start({ AD_DIRECTORY_ID: "different-ad" });
    assert.equal((await api(alternate, "/api/app-state", "GET", undefined, session.cookie)).status, 401);
    assert.equal((await login(alternate, { name: "renamed.doe" })).status, 401);
  });
  await t.test("relinking requires reviewed compare-and-set, is unique and revokes sessions atomically", async () => {
    await setup(); const session = await signIn(), next = "87654321-90ab-cdef-8123-456789abcdef";
    await assert.rejects(link({ guid: next }), /already exists/);
    assert.equal((await link({})).changed, false); assert.equal(await count("app_sessions"), 1);
    await assert.rejects(link({ guid: next, expectedBinding: "wrong" }), /already exists/);
    await link({ guid: next, expectedBinding: `synthetic-ad:${directoryGuid}` }); assert.equal(await count("app_sessions"), 0);
    assert.equal((await api(first, "/api/app-state", "GET", undefined, session.cookie)).status, 401);
    await tracker.database.prepare("INSERT INTO app_users (id,name,role,pin_hash,pin_salt,active,created_at,updated_at) SELECT $1,'seconduser','user',pin_hash,pin_salt,1,created_at,updated_at FROM app_users LIMIT 1")
      .bind(randomUUID()).run();
    const other = await tracker.database.prepare("SELECT id FROM app_users WHERE name='seconduser'").first();
    await assert.rejects(link({ userId: other.id, guid: next }), error => error.code === "23505");
    assert.equal((await tracker.database.prepare("SELECT ad_guid FROM app_users WHERE id=$1").bind(other.id).first()).ad_guid, null);
  });
  await t.test("link audit failure rolls back mapping and session revocation; concurrent links do not overwrite", async () => {
    await setup(); const session = await signIn(), expectedBinding = `synthetic-ad:${directoryGuid}`, next = "87654321-90ab-cdef-8123-456789abcdef";
    await tracker.database.prepare("ALTER TABLE app_change_log ADD CONSTRAINT synthetic_deny_link CHECK (action NOT LIKE 'Operator linked%') NOT VALID").run();
    try { await assert.rejects(link({ guid: next, expectedBinding })); }
    finally { await tracker.database.prepare("ALTER TABLE app_change_log DROP CONSTRAINT synthetic_deny_link").run(); }
    assert.equal((await tracker.database.prepare("SELECT ad_guid FROM app_users").first()).ad_guid, directoryGuid);
    assert.equal((await api(first, "/api/app-state", "GET", undefined, session.cookie)).status, 200);
    const result = await Promise.allSettled([link({ guid: next, expectedBinding }), link({ guid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", expectedBinding })]);
    assert.equal(result.filter(value => value.status === "fulfilled").length, 1);
  });
  await t.test("app user management permits roles/access, rejects directory credential/link writes and leaves new users unlinked", async () => {
    await setup(); const session = await signIn();
    assert.equal((await api(first, "/api/users", "POST", { name: "regularuser", role: "user" }, session.cookie)).status, 200);
    const target = await tracker.database.prepare("SELECT * FROM app_users WHERE name='regularuser'").first(); assert.equal(target.ad_guid, null);
    for (const body of [{ pin: "123456" }, { password: "Synthetic must not persist" }, { ad_guid: directoryGuid }, { unlock: true }])
      assert.equal((await api(first, "/api/users", "PATCH", { id: target.id, ...body }, session.cookie)).status, 400);
    assert.equal((await api(first, "/api/users", "PATCH", { id: target.id, role: "admin" }, session.cookie)).status, 200);
    const users = await (await api(first, "/api/users", "GET", undefined, session.cookie)).json(); assert.equal(users.authMode, "ad");
    assert.equal(users.users.find(value => value.id === userId).ad_linked, true);
    assert.ok(users.users.every(value => !("ad_guid" in value) && !("pin_hash" in value)));
  });
  await t.test("AD mode rejects incomplete local settings and unavailable migration without exposing credentials", async () => {
    await setup(); const incomplete = await start({ AD_CA_FILE: "" });
    for (const response of [await login(incomplete), await api(incomplete, "/api/auth"), await api(incomplete, "/api/health")]) {
      assert.equal(response.status, 503); assert.equal(response.headers.has("set-cookie"), false);
      assert.ok(!JSON.stringify(await response.json()).includes(model.readerPassword));
    }
    await tracker.database.prepare("ALTER TABLE app_users RENAME COLUMN ad_guid TO synthetic_unavailable_ad_guid").run();
    try { assert.equal((await login()).status, 503); assert.equal((await api(first, "/api/health")).status, 503); }
    finally { await tracker.database.prepare("ALTER TABLE app_users RENAME COLUMN synthetic_unavailable_ad_guid TO ad_guid").run(); }
  });
  await t.test("regular AD staff retain server permissions and administrator role changes revoke their sessions", async () => {
    await setup(); const admin = await signIn(), guid = "87654321-90ab-cdef-8123-456789abcdef";
    assert.equal((await api(first, "/api/users", "POST", { name: "regularuser" }, admin.cookie)).status, 200);
    const target = await tracker.database.prepare("SELECT id FROM app_users WHERE name='regularuser'").first();
    await link({ userId: target.id, guid });
    model.entries.push(syntheticAdEntry({ guid, bytes: Buffer.from("21436587ab90efcd8123456789abcdef", "hex"), username: "staff.doe", dn: "CN=Other Staff,DC=example,DC=invalid" }));
    const response = await login(second, { name: "staff.doe" }); assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie").split(";")[0];
    assert.equal((await api(first, "/api/users", "GET", undefined, cookie)).status, 403);
    assert.equal((await api(first, "/api/users", "PATCH", { id: target.id, role: "admin" }, cookie)).status, 403);
    assert.equal((await api(first, "/api/users", "PATCH", { id: target.id, role: "admin" }, admin.cookie)).status, 200);
    assert.equal((await api(second, "/api/app-state", "GET", undefined, cookie)).status, 401);
  });
});
