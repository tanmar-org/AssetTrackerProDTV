import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";
import { migrate } from "../../scripts/migrations.mjs";

const trackerDirectory = fileURLToPath(new URL("../../", import.meta.url));
const qrDirectory = fileURLToPath(new URL("../../service-request/", import.meta.url));
const inventory = () => ({
  master: [{ id: "receiver-01", assetNumber: "TEST-001", model: "Test model", type: "Test type",
    serial: "00000123", rid: "00000456", accessCard: "00000789", rentState: "On Rent" }],
  accounts: [{ id: "account-01", number: "000001", name: "Synthetic private account", location: "Private location", office: "Private office" }],
  assignments: [{ id: "assignment-01", assetId: "receiver-01", accountId: "account-01", assignedAt: "2026-10-05T18:00:00.000Z" }],
  activations: [], receiverEvents: [], auditState: null, rentalStock: { batches: [] },
});
const payload = () => ({
  assetId: "receiver-01", requesterName: "Synthetic Requester", requesterPhone: "555-0100",
  operatorName: "Test Operator", rigFrac: "Test Rig", lease: "Test Lease", errorCode: "771",
  latitude: 31.9, longitude: -102.2, gpsAccuracy: 7, gpsCapturedAt: new Date().toISOString(),
});

// Real built servers, real PostgreSQL constraints, separate restricted runtime
// roles, and synthetic data. No production data, email or external service.
test("public request trust boundary, duplicate races and shared abuse controls", { timeout: 90000 }, async (t) => {
  let tracker, requests, staff, qr;
  t.after(async () => { await qr?.close(); await staff?.close(); await requests?.close(); await tracker?.close(); });
  tracker = await createPostgresFixture("tracker");
  requests = await createPostgresFixture("requests");
  const secret = randomUUID();
  staff = await startNext(trackerDirectory, { DATABASE_URL: tracker.url, ADMIN_SHARED_SECRET: secret });
  const qrEnv = { DATABASE_URL: requests.url, ADMIN_SHARED_SECRET: secret, TRACKER_ASSET_API_URL: `${staff.url}/api/service-assets` };
  qr = await startNext(qrDirectory, qrEnv);
  const call = (server, path, method = "GET", body, headers = {}) => fetch(`${server.url}${path}`, {
    method, headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const post = (body = payload(), server = qr, headers = {}) => call(server, "/api/requests", "POST", body, headers);
  const staffHeaders = { authorization: `Bearer ${secret}` };
  // Mutate through the versioned private protocol; legacy endpoints are closed.
  const change = async body => {
    const found = await call(qr,"/api/requests/item?id="+encodeURIComponent(body.id),"GET",undefined,staffHeaders);
    const current = found.ok ? (await found.json()).request : {version:1};
    return call(qr,"/api/requests/operations","PATCH",{operationId:randomUUID(),kind:"status",expectedVersion:current.version,...body},staffHeaders);
  };
  const setInventory = (state) => tracker.database.prepare(`INSERT INTO app_state (id, payload, revision, updated_at)
    VALUES ('tanmar-receiver-control', $1::jsonb, 1, $2) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`)
    .bind(JSON.stringify(state), new Date().toISOString()).run();
  const rows = async () => (await requests.database.prepare("SELECT * FROM service_requests ORDER BY requested_at").all()).results;
  t.beforeEach(async () => {
    await requests.database.prepare("TRUNCATE service_request_operations, service_requests, request_rate_limits").run();
    await setInventory(inventory());
  });

  await t.test("request migration rejects historical duplicates/bad GPS atomically without rewriting rows", async () => {
    const legacy = await createPostgresFixture("requests");
    try {
      // Reconstruct only this disposable database's pre-upgrade schema. Never
      // reverse a production migration or change the checked-in first migration.
      await legacy.database.prepare(`DROP TABLE service_request_operations; ALTER TABLE service_requests DROP COLUMN version;
        DROP INDEX service_requests_pending_number_unique;
        DROP INDEX service_requests_pending_id_unique; DROP TABLE request_rate_limits;
        ALTER TABLE service_requests DROP CONSTRAINT service_request_coordinates,
          DROP CONSTRAINT service_request_asset_id, DROP COLUMN asset_id;
        DELETE FROM schema_migrations WHERE name IN ('requests/0002_public_request_security.sql', 'requests/0003_request_pagination.sql', 'requests/0004_operation_receipts.sql');
        DROP INDEX service_requests_page_idx; DROP INDEX service_requests_status_page_idx`).run();
      await legacy.database.prepare(`INSERT INTO service_requests
        (id,asset_number,error_code,latitude,longitude,gps_accuracy,gps_captured_at,requested_at)
        VALUES ('legacy-1','TEST-001','771',31.9,-102.2,7,$1,$1),
          ('legacy-2','test-001','771',31.9,-102.2,7,$1,$1)`)
        .bind(new Date().toISOString()).run();
      await assert.rejects(migrate(legacy.database, "requests"), { code: "23505" });
      assert.equal(Number((await legacy.database.prepare("SELECT COUNT(*) AS total FROM service_requests").first()).total), 2);
      assert.equal(Number((await legacy.database.prepare("SELECT COUNT(*) AS total FROM schema_migrations").first()).total), 1);
      assert.equal((await legacy.database.prepare("SELECT column_name FROM information_schema.columns WHERE table_name = 'service_requests' AND column_name = 'asset_id'").all()).results.length, 0);
      await legacy.database.prepare("UPDATE service_requests SET status = 'Cancelled', latitude = 91 WHERE id = 'legacy-2'").run();
      await assert.rejects(migrate(legacy.database, "requests"), { code: "23514" });
      await legacy.database.prepare("UPDATE service_requests SET latitude = 31.9 WHERE id = 'legacy-2'").run();
      await migrate(legacy.database, "requests"); await migrate(legacy.database, "requests");
      assert.equal(Number((await legacy.database.prepare("SELECT COUNT(*) AS total FROM schema_migrations").first()).total), 4);
      assert.equal((await legacy.database.prepare("SELECT asset_id FROM service_requests LIMIT 1").first()).asset_id, null);
    } finally { await legacy.close(); }
  });

  await t.test("private inventory lookup requires a bearer credential and returns one committed snapshot", async () => {
    for (const headers of [{}, { authorization: "Bearer forged" }])
      assert.equal((await call(staff, "/api/service-assets?id=receiver-01", "GET", undefined, headers)).status, 401);
    assert.equal((await call(staff, "/api/service-assets?id=receiver-01&a=TEST-001", "GET", undefined, staffHeaders)).status, 400);
    const response = await call(staff, "/api/service-assets?id=receiver-01", "GET", undefined, staffHeaders);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const snapshot = await response.json();
    assert.equal(snapshot.accountNumber, "000001");
    assert.equal(snapshot.serialNumber, "00000123");
    assert.equal(snapshot.accountName, inventory().accounts[0].name);
  });

  await t.test("public label resolution exposes only ID/asset number and ignores no forged snapshot", async () => {
    for (const query of ["id=receiver-01", "a=test-001"]) {
      const response = await call(qr, `/api/asset?${query}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id: "receiver-01", assetNumber: "TEST-001" });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    for (const query of ["id=receiver-01&id=other", "id=receiver-01&a=TEST-001", "id=receiver-01&an=forged", "id=%3Cscript%3E"])
      assert.equal((await call(qr, `/api/asset?${query}`)).status, 400);
    const missing = await call(qr, "/api/asset?id=unknown");
    assert.equal(missing.status, 404);
    assert.equal((await rows()).length, 0);
  });

  await t.test("HTTP rejects malformed/oversized/forged input and unknown assets without persisting", async () => {
    for (const body of [null, [], { ...payload(), accountNumber: "forged" }, { ...payload(), latitude: null },
      { ...payload(), longitude: 181 }, { ...payload(), requesterPhone: "a".repeat(41) }])
      assert.equal((await post(body)).status, 400);
    assert.equal((await post({ ...payload(), assetId: "unknown" })).status, 404);
    assert.equal((await post(payload(), qr, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await fetch(`${qr.url}/api/requests`, { method: "POST", body: "{}" })).status, 415);
    assert.equal((await fetch(`${qr.url}/api/requests`, { method: "POST", headers: { "content-type": "application/json" }, body: "{broken" })).status, 400);
    assert.equal((await post({ content: "é".repeat(5000) })).status, 413);
    assert.equal((await rows()).length, 0);
  });

  await t.test("submission stores current server metadata, preserves zeros, and returns no private fields", async () => {
    const state = inventory();
    state.master[0].serial = "00000999";
    state.accounts[0].name = "Changed private account";
    await setInventory(state);
    const response = await post();
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.deepEqual(Object.keys(result).sort(), ["id", "requestedAt", "status"]);
    const row = (await rows())[0];
    assert.equal(row.asset_id, "receiver-01");
    assert.equal(row.serial_number, "00000999");
    assert.equal(row.account_number, "000001");
    assert.equal(row.account_name, "Changed private account");
    assert.equal((await call(qr, "/api/requests")).status, 401);
    const list = await (await call(qr, "/api/requests", "GET", undefined, staffHeaders)).json();
    assert.equal(list.requests[0].serialNumber, "00000999");
    assert.equal(list.requests[0].mapUrl, "https://maps.google.com/?q=31.9,-102.2");
  });

  await t.test("legacy asset-number links resolve to stable IDs and share the pending slot after renaming", async () => {
    const legacy = payload(); delete legacy.assetId; legacy.assetNumber = "test-001";
    assert.equal((await post(legacy)).status, 201);
    const state = inventory(); state.master[0].assetNumber = "RENAMED-001"; await setInventory(state);
    const duplicate = await post();
    assert.equal(duplicate.status, 409);
    assert.deepEqual(await duplicate.json(), { error: "A pending request already exists for this receiver." });
    assert.equal((await rows()).length, 1);
    assert.equal((await call(qr, "/api/asset?id=receiver-01")).status, 200);
    assert.equal((await call(qr, "/api/asset?a=TEST-001")).status, 404);
  });

  await t.test("independent QR processes accept exactly one simultaneous pending submission", async () => {
    const second = await startNext(qrDirectory, qrEnv);
    try {
      const responses = await Promise.all([post(), post(payload(), second)]);
      assert.deepEqual(responses.map((item) => item.status).sort(), [201, 409]);
      assert.equal((await rows()).length, 1);
      assert.deepEqual(await responses.find((item) => item.status === 409).json(), { error: "A pending request already exists for this receiver." });
    } finally { await second.close(); }
  });

  await t.test("a reopen racing a new submission retains one pending row and rolls back the loser", async () => {
    const created = await post(); const { id } = await created.json();
    assert.equal((await change({ id, status: "Completed", notes: "Test complete" })).status, 200);
    const responses = await Promise.all([post(), change({ id, status: "Pending", notes: "Reopen" })]);
    const receipt=await responses[1].json();
    assert.equal(Number(responses[0].status===201)+Number(receipt.outcome==="applied"),1);
    assert.equal(Number(responses[0].status===409)+Number(receipt.reason==="pending_conflict"),1);
    assert.equal((await rows()).filter((row) => row.status === "Pending").length, 1);
    if (receipt.outcome === "rejected") assert.equal((await rows()).find((row) => row.id === id).notes, "Test complete");
  });

  await t.test("per-receiver rate limits persist denied attempts and cannot be reset by fake forwarded headers", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => post(payload(), qr, { "x-forwarded-for": `192.0.2.${index}` })));
    assert.deepEqual(responses.map((item) => item.status).sort(), [201, 409, 409, 409, 409, 429]);
    assert.equal((await rows()).length, 1);
    const last = await post(); assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get("retry-after")) > 0 && Number(last.headers.get("retry-after")) <= 600);
  });

  await t.test("global budgets are shared across processes, expire, and cap arbitrary bucket allocation", async () => {
    const now = Math.floor(Date.now() / 1000);
    const key = `submit-hour:${Math.floor(now / 3600)}:${createHmac("sha256", secret).update("global").digest("hex")}`;
    await requests.database.prepare("INSERT INTO request_rate_limits VALUES ($1, 200, $2), ('expired-test-bucket', 1, 0)")
      .bind(key, now + 3600).run();
    const second = await startNext(qrDirectory, qrEnv);
    try {
      for (const server of [qr, second]) assert.equal((await post({ assetId: randomUUID() }, server)).status, 429);
      const counters = (await requests.database.prepare("SELECT * FROM request_rate_limits").all()).results;
      assert.equal(counters.some((row) => row.bucket_key === "expired-test-bucket"), false);
      assert.equal(counters.some((row) => row.bucket_key.startsWith("submit-asset")), false);
      assert.equal(counters.find((row) => row.bucket_key === key).hits, 201);
    } finally { await second.close(); }
  });

  await t.test("authenticated proxy IP headers enable per-client budgets and fail closed when forged", async () => {
    const proxySecret = randomUUID();
    const ingress = await startNext(qrDirectory, { ...qrEnv, REQUEST_PROXY_SECRET: proxySecret });
    try {
      for (const headers of [{}, { "x-request-client-ip": "192.0.2.1", "x-request-proxy-secret": "forged" },
        { "x-request-client-ip": "192.0.2.1, 192.0.2.2", "x-request-proxy-secret": proxySecret }])
        assert.equal((await post(payload(), ingress, headers)).status, 503);
      const headers = { "x-request-client-ip": "192.0.2.1", "x-request-proxy-secret": proxySecret };
      for (let index = 0; index < 10; index++) assert.equal((await post({}, ingress, headers)).status, 400);
      assert.equal((await post({}, ingress, headers)).status, 429);
      assert.equal((await post({}, ingress, { ...headers, "x-request-client-ip": "192.0.2.2" })).status, 400);
      const stored = JSON.stringify((await requests.database.prepare("SELECT * FROM request_rate_limits").all()).results);
      assert.equal(stored.includes("192.0.2."), false); assert.equal(stored.includes(proxySecret), false);
      assert.equal((await call(ingress, "/api/requests", "GET", undefined, staffHeaders)).status, 200);
    } finally { await ingress.close(); }
  });

  await t.test("direct staff mutations validate fields and enforce authorization before parsing", async () => {
    assert.equal((await call(qr, "/api/requests", "PATCH", { notes: "a".repeat(10000) })).status, 401);
    const { id } = await (await post()).json();
    for (const changes of [{ notes: "a".repeat(2049) }, { notes: null }, { id: "<img>" }, { status: "forged" }, { assetNumber: "forged" }])
      assert.equal((await change({ id, status: "Completed", ...changes })).status, 400);
    assert.equal((await call(qr, `/api/requests/item?id=${id}&id=other`, "GET", undefined, staffHeaders)).status, 400);
    assert.equal((await call(qr, `/api/requests?id=${id}`, "DELETE", undefined, staffHeaders)).status, 410);
    assert.equal((await rows())[0].status, "Pending");
  });

  await t.test("lookup failures, redirects, oversized responses and timeouts fail closed without private error leakage", async () => {
    let mode = "redirect", hits = 0;
    const upstream = createServer((request, response) => {
      hits++;
      if (mode === "timeout") return; // Deliberately leave only this synthetic response open.
      if (mode === "redirect") { response.writeHead(302, { location: `${staff.url}/api/service-assets?id=receiver-01` }); response.end(); }
      else if (mode === "oversized") response.end(JSON.stringify({ private: "secret".repeat(2000) }));
      else { response.writeHead(503); response.end("synthetic private error"); }
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const failing = await startNext(qrDirectory, { ...qrEnv, TRACKER_ASSET_API_URL: `http://127.0.0.1:${upstream.address().port}/lookup` });
    try {
      for (mode of ["redirect", "oversized", "error", "timeout"]) {
        const response = await post(payload(), failing);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: "Unable to submit the service request. Please try again later." });
      }
      assert.equal(hits, 4); assert.equal((await rows()).length, 0);
    } finally {
      await failing.close(); upstream.closeAllConnections();
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});
