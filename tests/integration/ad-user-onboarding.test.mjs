import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { linkAdIdentity } from "../../scripts/ad-linking.mjs";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { createSession } from "../../lib/pin-auth.ts";
import { adConfiguration } from "../../lib/ad-auth.ts";
import { issueAdConfirmation, enrollmentLifetimeMs } from "../../lib/ad-enrollment.ts";
import { createLdapDirectory, directoryGuid, syntheticAdEntry } from "../helpers/ldap-directory.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";
import { sessionHeaders } from "../helpers/session-context.mjs";
import { inventory } from "../helpers/inventory-fixture.mjs";

// Exercise actual HTTP, verified TLS LDAP and restricted PostgreSQL. Initial
// admin bootstrap is operator-only; every subsequent enrollment uses Settings APIs.
test("administrator-reviewed AD enrollment commits links, permissions and audit together", { timeout: 90000 }, async t => {
  const tracker = await createPostgresFixture("tracker"), directory = await createLdapDirectory();
  const secret = "synthetic-onboarding-key-123456789012345", env = { ...directory.env, DATABASE_URL: tracker.url, LOGIN_PROXY_SECRET: "", ADMIN_SHARED_SECRET: secret };
  const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), env);
  t.after(async () => { await server.close(); await directory.close(); await tracker.close(); assert.deepEqual(directory.errors, []); });
  const model = directory.model;
  const staff = () => syntheticAdEntry({ guid: "87654321-90ab-cdef-8123-456789abcdef", bytes: Buffer.from("21436587ab90efcd8123456789abcdef", "hex"), username: "staff.doe-007", displayName: "Synthetic New Staff", dn: "CN=Other Staff,DC=example,DC=invalid" });
  const api = (path, method = "GET", body, cookie, headers = {}) => fetch(`${server.url}${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie, ...sessionHeaders(cookie) } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = name => api("/api/auth", "POST", { action: "login", name, password: model.entries[0].password });
  let adminId, cookie;
  const setup = async () => {
    await tracker.database.prepare("TRUNCATE app_service_operations,app_inventory_drafts,app_sessions,app_users,app_state,app_state_history,app_change_log,app_login_rate_limits").run();
    model.entries = [syntheticAdEntry(), staff()]; model.requests = []; model.omit = null; model.referral = false; model.rejectDomainScope = false;
    adminId = (await provisionAdmin(tracker.database, { name: "appadmin" }, { mode: "ad" })).id;
    await linkAdIdentity(tracker.database, { userId: adminId, guid: directoryGuid, directory: directory.env.AD_DIRECTORY_ID });
    const response = await login("j.doe"); assert.equal(response.status, 200); cookie = response.headers.get("set-cookie").split(";")[0]; model.requests = [];
  };
  const review = async (target, session = cookie) => {
    const response = await api("/api/users/ad-lookup", "POST", { name: "staff.doe-007", ...(target ? { userId: target } : {}) }, session);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); return response.json();
  };
  const create = (proof, session = cookie, extra = {}) => api("/api/users", "POST", { name: "staff.doe-007", role: "user", directoryConfirmation: proof, ...extra }, session);
  const legacy = async () => {
    const id = randomUUID();
    await tracker.database.prepare("INSERT INTO app_users (id,name,role,pin_hash,pin_salt,active,created_at,updated_at) SELECT $1,'legacylabel','admin',pin_hash,pin_salt,1,created_at,updated_at FROM app_users LIMIT 1").bind(id).run(); return id;
  };
  const getTarget = () => tracker.database.prepare("SELECT * FROM app_users WHERE ad_guid=$1").bind(staff().guid).first();
  await t.test("reviewed dotted username can sign in immediately; lookup binds only the reader and hides private directory fields", async () => {
    await setup(); const preview = await review();
    assert.deepEqual(Object.keys(preview).sort(), ["confirmation", "displayName", "username"]);
    assert.equal(preview.displayName, staff().displayName);
    assert.ok(model.requests.filter(r => r.type === "bind").every(r => r.dn === model.reader));
    assert.equal((await create(preview.confirmation)).status, 200);
    const target = await getTarget(); assert.equal(target.name, "staff.doe-007"); assert.equal(target.role, "user");
    assert.equal(target.ad_directory, "synthetic-ad"); assert.ok(!JSON.stringify(target).includes(staff().password));
    assert.equal((await login("staff.doe-007")).status, 200);
    const audit = await tracker.database.prepare("SELECT action FROM app_change_log WHERE action LIKE 'Added user%'").first();
    assert.match(audit.action, /reviewed AD account link/);
    assert.equal((await api("/api/users/ad-lookup", "POST", { name: "staff.doe-007" }, cookie)).status, 409);
  });
  await t.test("only an authenticated admin with the exact session context may lookup or use a review", async () => {
    await setup(); const before = model.requests.length;
    assert.equal((await api("/api/users/ad-lookup", "POST", { name: "staff.doe-007" })).status, 401);
    assert.equal((await api("/api/users/ad-lookup", "POST", { name: "staff.doe-007" }, cookie, { "x-tracker-session-context": "0".repeat(64) })).status, 401);
    assert.equal(model.requests.length, before);
    const preview = await review(), other = await login("j.doe"), otherCookie = other.headers.get("set-cookie").split(";")[0];
    assert.equal((await create(preview.confirmation, otherCookie)).status, 409);
    assert.equal((await create("forged-proof")).status, 409);
    assert.equal((await create(undefined)).status, 409);
    assert.equal((await create(preview.confirmation, cookie, { ad_guid: staff().guid })).status, 400);
    assert.equal((await create(preview.confirmation, cookie, { password: "never store" })).status, 400);
    assert.equal(await getTarget(), null);
    assert.equal((await create(preview.confirmation)).status, 200);
    const regular = await login("staff.doe-007"), regularCookie = regular.headers.get("set-cookie").split(";")[0];
    assert.equal((await api("/api/users/ad-lookup", "POST", { name: "j.doe" }, regularCookie)).status, 403);
  });
  await t.test("missing, disabled, locked, ambiguous and referral directory results never grant app access", async () => {
    for (const failure of ["missing", "disabled", "locked", "ambiguous", "referral", "control", "metadata"]) {
      await setup();
      if (failure === "missing") model.entries.pop();
      if (failure === "disabled") model.entries[1].flags = "514";
      if (failure === "locked") model.entries[1].computed = "16";
      if (failure === "ambiguous") model.entries.push(staff());
      if (failure === "referral") model.referral = true;
      if (failure === "control") model.rejectDomainScope = true;
      if (failure === "metadata") model.omit = "userAccountControl";
      const response = await api("/api/users/ad-lookup", "POST", { name: "staff.doe-007" }, cookie);
      assert.equal(response.status, ["missing", "disabled", "locked"].includes(failure) ? 404 : 503, failure);
      assert.equal((await tracker.database.prepare("SELECT COUNT(*) AS n FROM app_users").first()).n, "1");
    }
  });
  await t.test("username reuse, directory rename, changed display name or account disable invalidate the reviewed object", async () => {
    for (const change of ["reuse", "rename", "display", "disabled"]) {
      await setup(); const preview = await review();
      if (change === "reuse") { model.entries[1].guid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"; model.entries[1].bytes = Buffer.from("aaaaaaaabbbbccccddddeeeeeeeeeeee", "hex"); }
      if (change === "rename") model.entries[1].username = "renamed.staff";
      if (change === "display") model.entries[1].displayName = "Changed Review Name";
      if (change === "disabled") model.entries[1].flags = "514";
      assert.equal((await create(preview.confirmation)).status, 409, change); assert.equal(await getTarget(), null);
    }
  });
  await t.test("expired review is rejected before LDAP traffic; concurrent creates grant the GUID once", async () => {
    await setup(); const preview = await review();
    const expired = issueAdConfirmation(staff(), { id: adminId, context: sessionHeaders(cookie)["x-tracker-session-context"] }, adConfiguration(env), null, Date.now() - enrollmentLifetimeMs - 1, env);
    const before = model.requests.length; assert.equal((await create(expired)).status, 409); assert.equal(model.requests.length, before);
    const responses = await Promise.all([create(preview.confirmation), create(preview.confirmation)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
    assert.equal((await tracker.database.prepare("SELECT COUNT(*) AS n FROM app_users WHERE ad_guid=$1").bind(staff().guid).first()).n, "1");
  });
  await t.test("input bounds reject before LDAP; a review expiring during a lock wait cannot grant access", async () => {
    await setup(); const before = model.requests.length;
    for (const [body, status] of [[{ name: "*)(objectClass=*)" }, 400], [{ name: "staff.doe-007", padding: "x".repeat(4200) }, 413]])
      assert.equal((await api("/api/users/ad-lookup", "POST", body, cookie)).status, status);
    assert.equal(model.requests.length, before);
    const issued = Date.now() - enrollmentLifetimeMs + 2500;
    const proof = issueAdConfirmation(staff(), { id: adminId, context: sessionHeaders(cookie)["x-tracker-session-context"] }, adConfiguration(env), null, issued, env);
    let pending;
    await tracker.database.transaction(async tx => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run(); pending = create(proof);
      for (let attempt = 0; attempt < 100 && !model.requests.some(r => r.type === "search"); attempt++) await delay(25);
      assert.ok(model.requests.some(r => r.type === "search"));
      await delay(Math.max(0, issued + enrollmentLifetimeMs + 50 - Date.now()));
    });
    assert.equal((await pending).status, 409); assert.equal(await getTarget(), null);
  });
  await t.test("linking a legacy account preserves IDs, names, roles and drafts; target-bound reviews cannot overwrite a link", async () => {
    await setup(); const target = await legacy();
    const draft = randomUUID(); await tracker.database.prepare("INSERT INTO app_inventory_drafts VALUES ($1,$2,1,1,$3,$3,'Synthetic recovery','active',now(),now()+interval '7 days')").bind(draft, target, JSON.stringify(inventory())).run();
    await createSession(target, tracker.database); const preview = await review(target);
    assert.equal((await create(preview.confirmation)).status, 409);
    const linkBody = { id: target, adUsername: "staff.doe-007", directoryConfirmation: preview.confirmation };
    assert.equal((await api("/api/users", "PATCH", { ...linkBody, id: adminId }, cookie)).status, 409);
    assert.equal((await api("/api/users", "PATCH", linkBody, cookie)).status, 200);
    const row = await getTarget(); assert.equal(row.id, target); assert.equal(row.name, "legacylabel"); assert.equal(row.role, "admin");
    assert.equal((await tracker.database.prepare("SELECT user_id FROM app_inventory_drafts WHERE id=$1").bind(draft).first()).user_id, target);
    assert.equal((await tracker.database.prepare("SELECT COUNT(*) AS n FROM app_sessions WHERE user_id=$1").bind(target).first()).n, "0");
    assert.equal((await api("/api/users", "PATCH", linkBody, cookie)).status, 409);
    assert.equal((await login("staff.doe-007")).status, 200);
  });
  await t.test("audit failures roll back both account creation and legacy linking/session revocation", async () => {
    await setup(); const preview = await review();
    await tracker.database.prepare("ALTER TABLE app_change_log ADD CONSTRAINT synthetic_enrollment_audit CHECK (action NOT LIKE '%reviewed AD%') NOT VALID").run();
    try {
      assert.equal((await create(preview.confirmation)).status, 503); assert.equal(await getTarget(), null);
      const target = await legacy(); await createSession(target, tracker.database); const linkPreview = await review(target);
      assert.equal((await api("/api/users", "PATCH", { id: target, adUsername: "staff.doe-007", directoryConfirmation: linkPreview.confirmation }, cookie)).status, 503);
      assert.equal((await tracker.database.prepare("SELECT ad_guid FROM app_users WHERE id=$1").bind(target).first()).ad_guid, null);
      assert.equal((await tracker.database.prepare("SELECT COUNT(*) AS n FROM app_sessions WHERE user_id=$1").bind(target).first()).n, "1");
    } finally { await tracker.database.prepare("ALTER TABLE app_change_log DROP CONSTRAINT synthetic_enrollment_audit").run(); }
  });
  await t.test("logout while a lookup waits for the account lock withholds both review fields and proof", async () => {
    await setup(); let pending;
    await tracker.database.transaction(async tx => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      pending = api("/api/users/ad-lookup", "POST", { name: "staff.doe-007" }, cookie);
      for (let attempt = 0; attempt < 100 && !model.requests.some(r => r.type === "search"); attempt++) await delay(25);
      assert.ok(model.requests.some(r => r.type === "search")); await delay(100);
      await tx.prepare("DELETE FROM app_sessions WHERE user_id=$1").bind(adminId).run();
    });
    const response = await pending; assert.equal(response.status, 401);
    const body = await response.json(); assert.ok(!("confirmation" in body) && !("displayName" in body));
  });
  await t.test("logout while enrollment waits for the account lock prevents its commit", async () => {
    await setup(); const preview = await review(); model.requests = []; let pending;
    await tracker.database.transaction(async tx => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run(); pending = create(preview.confirmation);
      for (let attempt = 0; attempt < 100 && !model.requests.some(r => r.type === "search"); attempt++) await delay(25);
      assert.ok(model.requests.some(r => r.type === "search")); await delay(100);
      await tx.prepare("DELETE FROM app_sessions WHERE user_id=$1").bind(adminId).run();
    });
    assert.equal((await pending).status, 401); assert.equal(await getTarget(), null);
  });
});
