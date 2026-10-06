import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDatabase } from "@tanmar/database";
import { reserveLoginAttempt, loginLimits } from "../../lib/login-rate-limit.ts";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";

// Real independent pools/Node processes and restricted roles, on synthetic data.
// A fixed module clock proves boundaries without sleeps or an HTTP clock override.
test("shared login traffic protection", { timeout: 120000 }, async t => {
  const fixture = await createPostgresFixture("tracker");
  const otherPool = createDatabase(fixture.url), servers = [];
  t.after(async () => { for (const server of servers.reverse()) await server.close(); await otherPool.close(); await fixture.close(); });
  const secret = randomBytes(32).toString("hex"), now = 1800000000;
  const credentials = { name: "jdoe", pin: "482631" };
  await provisionAdmin(fixture.database, credentials);
  const start = async value => {
    const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: fixture.url, LOGIN_PROXY_SECRET: value });
    servers.push(server); return server;
  };
  const first = await start(secret), second = await start(secret), local = await start("");
  const clear = () => fixture.database.prepare("TRUNCATE app_login_rate_limits").run();
  const rows = () => fixture.database.prepare("SELECT * FROM app_login_rate_limits ORDER BY bucket_key").all();
  const login = (server, headers = {}, body = credentials) => fetch(`${server.url}/api/auth`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ action: "login", ...body }),
  });
  const trusted = ip => ({ "x-login-proxy-secret": secret, "x-login-client-ip": ip });
  // Seed current AND next window so HTTP denial assertions cannot flake at a
  // minute boundary. Module concurrency/rollover assertions use the fixed clock.
  async function saturate(scope, hits, identity) {
    const window = Math.floor(Date.now() / 1000 / 60);
    const suffix = identity === undefined ? "" : `:${createHmac("sha256", secret).update(identity).digest("hex")}`;
    for (const value of [window, window + 1]) await fixture.database.prepare(
      "INSERT INTO app_login_rate_limits VALUES ($1,$2,$3) ON CONFLICT (bucket_key) DO UPDATE SET hits=$2")
      .bind(`${scope}:${value}${suffix}`, hits, (value + 1) * 60).run();
  }

  await t.test("concurrent reservations share the username ceiling across independent pools", async () => {
    await clear();
    const result = await Promise.all(Array.from({ length: 40 }, (_, i) => reserveLoginAttempt(i % 2 ? fixture.runtime : otherPool, "unknown-user", null, now, "")));
    assert.equal(result.filter(value => value === 0).length, loginLimits.username);
    assert.ok(result.filter(Boolean).every(value => value === 60));
    const stored = (await rows()).results;
    assert.equal(stored.find(row => row.bucket_key.startsWith("username:")).hits, 31);
    assert.equal(stored.find(row => row.bucket_key.startsWith("global:")).hits, 40);
    assert.ok(stored.every(row => !row.bucket_key.includes("unknown-user")));
  });
  await t.test("client ceilings stop username spray before allocating further selector rows", async () => {
    await clear();
    const result = await Promise.all(Array.from({ length: 90 }, (_, i) => reserveLoginAttempt(i % 2 ? fixture.runtime : otherPool, `unknown${i}`, "192.0.2.20", now, secret)));
    assert.equal(result.filter(value => value === 0).length, loginLimits.client);
    const stored = (await rows()).results;
    assert.equal(stored.filter(row => row.bucket_key.startsWith("username:")).length, 60);
    assert.equal(stored.find(row => row.bucket_key.startsWith("client:")).hits, 61);
    assert.ok(stored.every(row => !row.bucket_key.includes("192.0.2.20") && !row.bucket_key.includes(secret)));
  });
  await t.test("global ceiling bounds unknown-username cardinality and commits denied attempts", async () => {
    await clear();
    const result = await Promise.all(Array.from({ length: 310 }, (_, i) => reserveLoginAttempt(i % 2 ? fixture.runtime : otherPool, `unknown${i}`, null, now, "")));
    assert.equal(result.filter(value => value === 0).length, loginLimits.global);
    const stored = (await rows()).results;
    assert.equal(stored.length, 301); assert.equal(stored.find(row => row.bucket_key.startsWith("global:")).hits, 301);
    await reserveLoginAttempt(fixture.runtime, "another-selector", null, now, "");
    assert.equal((await rows()).results.length, 301);
  });
  await t.test("next window expires old counters; one exhausted username does not exhaust another", async () => {
    await clear();
    for (let i = 0; i < 30; i++) assert.equal(await reserveLoginAttempt(fixture.runtime, "first-user", null, now, ""), 0);
    assert.equal(await reserveLoginAttempt(fixture.runtime, "first-user", null, now, ""), 60);
    assert.equal(await reserveLoginAttempt(fixture.runtime, "second-user", null, now, ""), 0);
    assert.equal(await reserveLoginAttempt(otherPool, "first-user", null, now + 60, ""), 0);
    const stored = (await rows()).results;
    assert.equal(stored.length, 2); assert.ok(stored.every(row => Number(row.expires_at) === now + 120 && row.hits === 1));
  });
  await t.test("HTTP global denial precedes account reads and returns bounded noncacheable retry", async () => {
    await clear(); await saturate("global", 300);
    const role = new URL(fixture.url).username;
    await fixture.database.prepare(`REVOKE SELECT ON app_users FROM "${role}"`).run();
    try {
      const responses = await Promise.all([login(first, trusted("192.0.2.20")), login(second, trusted("192.0.2.21"))]);
      for (const response of responses) {
        assert.equal(response.status, 429); assert.equal(response.headers.get("cache-control"), "no-store");
        assert.ok(Number(response.headers.get("retry-after")) >= 1 && Number(response.headers.get("retry-after")) <= 60);
        assert.equal(response.headers.has("set-cookie"), false);
      }
      assert.ok((await rows()).results.every(row => row.bucket_key.startsWith("global:")));
    } finally { await fixture.database.prepare(`GRANT SELECT ON app_users TO "${role}"`).run(); }
  });
  await t.test("missing or forged trusted ingress fails closed without creating counters", async () => {
    await clear();
    for (const headers of [{}, { "x-forwarded-for": "192.0.2.20" }, { ...trusted("192.0.2.20"), "x-login-proxy-secret": "wrong" }, trusted("192.0.2.20, 192.0.2.21")]) {
      const response = await login(first, headers); assert.equal(response.status, 503);
      assert.equal(response.headers.has("set-cookie"), false); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal((await rows()).results.length, 0);
    }
  });
  await t.test("HTTP client ceiling follows authenticated ingress, survives changing usernames and isolates other clients", async () => {
    await clear(); await saturate("client", 60, "192.0.2.20");
    for (const [server, name] of [[first, "unknown-one"], [second, "unknown-two"]]) {
      const response = await login(server, { ...trusted("192.0.2.20"), "x-forwarded-for": "192.0.2.99" }, { name, pin: "123456" });
      assert.equal(response.status, 429); assert.equal(response.headers.has("set-cookie"), false);
    }
    assert.ok((await rows()).results.every(row => !row.bucket_key.startsWith("username:")));
    assert.equal((await login(second, trusted("192.0.2.21"))).status, 200);
  });
  await t.test("HTTP username ceiling shares canonical aliases across different clients and servers", async () => {
    await clear(); await saturate("username", 30, "jdoe");
    for (const [server, name, ip] of [[first, "JDOE", "192.0.2.20"], [second, "  jdoe  ", "192.0.2.21"]]) {
      const response = await login(server, trusted(ip), { name, pin: credentials.pin });
      assert.equal(response.status, 429); assert.equal(response.headers.has("set-cookie"), false);
    }
    assert.equal(Number((await fixture.database.prepare("SELECT failed_attempts FROM app_users WHERE name='jdoe'").first()).failed_attempts), 0);
  });
  await t.test("incorrect credentials and nonexistent accounts consume traffic reservations without issuing sessions", async () => {
    await clear();
    for (const body of [{ name: "jdoe", pin: "123456" }, { name: "unknown-one", pin: "123456" }]) {
      const response = await login(first, trusted("192.0.2.20"), body);
      assert.equal(response.status, 401); assert.equal(response.headers.has("set-cookie"), false);
    }
    const stored = (await rows()).results;
    assert.equal(stored.filter(row => row.bucket_key.startsWith("global:")).reduce((sum, row) => sum + row.hits, 0), 2);
    assert.equal(stored.filter(row => row.bucket_key.startsWith("client:")).reduce((sum, row) => sum + row.hits, 0), 2);
    assert.equal(stored.filter(row => row.bucket_key.startsWith("username:")).reduce((sum, row) => sum + row.hits, 0), 2);
  });
  await t.test("trusted login and successful sessions consume the same budget across servers", async () => {
    await clear();
    for (const server of [first, second]) {
      const response = await login(server, trusted("192.0.2.20")); assert.equal(response.status, 200);
      assert.ok(response.headers.get("set-cookie").includes("tanmar_session="));
    }
    // A window boundary may allocate another set, but never loses admissions.
    assert.equal((await rows()).results.filter(row => row.bucket_key.startsWith("global:")).reduce((sum, row) => sum + row.hits, 0), 2);
  });
  await t.test("unconfigured ingress cannot gain a spoofed per-IP budget; global limit still applies", async () => {
    await clear(); await saturate("global", 300);
    for (const ip of ["192.0.2.20", "192.0.2.21"]) {
      const response = await login(local, { "x-forwarded-for": ip, ...trusted(ip) });
      assert.equal(response.status, 429);
    }
    assert.ok((await rows()).results.every(row => row.bucket_key.startsWith("global:")));
  });
  await t.test("an account lookup outage cannot roll back a committed traffic reservation", async () => {
    await clear(); const role = new URL(fixture.url).username;
    await fixture.database.prepare(`REVOKE SELECT ON app_users FROM "${role}"`).run();
    try {
      const response = await login(first, trusted("192.0.2.20")); assert.equal(response.status, 503);
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal((await rows()).results.length, 3); assert.ok((await rows()).results.every(row => row.hits === 1));
    } finally { await fixture.database.prepare(`GRANT SELECT ON app_users TO "${role}"`).run(); }
  });
  await t.test("unavailable counter schema fails closed and readiness reports unavailable", async () => {
    await clear(); await fixture.database.prepare("ALTER TABLE app_login_rate_limits RENAME TO synthetic_unavailable_login_limits").run();
    try {
      const response = await login(first, trusted("192.0.2.20")); assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Unable to sign in." });
      assert.equal(response.headers.has("set-cookie"), false);
      assert.equal((await fetch(`${first.url}/api/health`)).status, 503);
    } finally { await fixture.database.prepare("ALTER TABLE synthetic_unavailable_login_limits RENAME TO app_login_rate_limits").run(); }
  });
});
