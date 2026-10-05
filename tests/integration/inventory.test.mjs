import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";
import { inventory, batch, history, when } from "../helpers/inventory-fixture.mjs";

// Real HTTP/SQL permission checks; the upstream stub contains no production data
// and lets us prove denied staff requests never reach the credentialed service.
test("inventory permissions, validation, and recovery", async (t) => {
  let tracker, server, upstream;
  const calls = [];
  let hang = false;
  const secret = randomUUID();
  t.after(async () => {
    await server?.close();
    upstream?.closeAllConnections();
    if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
    await tracker?.close();
  });
  upstream = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    calls.push({ method: request.method, authorization: request.headers.authorization, body, url: request.url });
    if (hang) return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.method === "GET" ? { requests: [] } : { ok: true }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  tracker = await createPostgresFixture("tracker");
  server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), {
    DATABASE_URL: tracker.url, ADMIN_SHARED_SECRET: secret,
    SERVICE_REQUEST_API_URL: `http://127.0.0.1:${upstream.address().port}/api/requests`,
  });
  const api = (path, method = "GET", body, cookie) => fetch(`${server.url}${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const signin = async (name, pin) => {
    const response = await api("/api/auth", "POST", { action: "login", name, pin });
    assert.equal(response.status, 200);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const count = async (table) => Number((await tracker.database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first()).total);
  const read = async (cookie) => {
    const response = await api("/api/app-state", "GET", undefined, cookie);
    assert.equal(response.status, 200); return response.json();
  };
  const save = (cookie, state, baseRevision, method = "PATCH", action = "Client label") => api("/api/app-state", method, { state, baseRevision, action }, cookie);
  const setup = async (state = inventory()) => {
    await tracker.database.prepare("TRUNCATE app_sessions, app_users, app_change_log, app_state, app_state_history").run();
    await provisionAdmin(tracker.database, { name: "testadmin", pin: "482631" });
    const admin = await signin("testadmin", "482631");
    assert.equal((await api("/api/users", "POST", { name: "testuser", pin: "593742" }, admin)).status, 200);
    const regular = await signin("testuser", "593742");
    assert.equal((await save(admin, state, 0, "PUT")).status, 200);
    return { admin, regular };
  };

  await t.test("replacement authority comes from role/method, not labels or small edit counts", async () => {
    const { admin, regular } = await setup();
    const after = inventory(); after.master[0].notes = "One allowed record edit";
    assert.equal((await save(regular, after, 1, "PUT", "Edit Master receiver")).status, 403);
    assert.equal((await save(undefined, after, 1)).status, 401);
    assert.equal((await save(regular, after, 1, "PATCH", "Restore app backup")).status, 200);
    assert.equal((await read(admin)).revision, 2);
    const log = await tracker.database.prepare("SELECT action FROM app_change_log WHERE revision = 2").first();
    assert.equal(log.action, "Updated receiver/assignment");
  });

  await t.test("bulk receiver edits, clear, and mixed account/receiver edits cannot spoof labels", async () => {
    const { admin, regular } = await setup();
    for (const action of ["Edit account", "Data change", "Import receivers to account"]) {
      const changed = inventory(); changed.master[0].notes = action; changed.master[1].notes = action;
      assert.equal((await save(regular, changed, 1, "PATCH", action)).status, 403);
    }
    const clear = inventory(0); clear.accounts = [];
    assert.equal((await save(regular, clear, 1)).status, 403);
    const mixed = inventory(); mixed.accounts[0].name = "Changed"; mixed.master[0].model = "Changed";
    assert.equal((await save(regular, mixed, 1)).status, 403);
    assert.equal((await read(admin)).revision, 1);
    assert.equal(await count("app_state_history"), 0);
  });

  await t.test("no-op labels cannot manufacture revisions, history, or audit changes", async () => {
    const { admin, regular } = await setup();
    const before = await count("app_change_log");
    for (const [cookie, method] of [[regular, "PATCH"], [admin, "PUT"]]) {
      const response = await save(cookie, inventory(), 1, method, "Forged change description");
      assert.equal(response.status, 200); assert.equal((await response.json()).revision, 1);
    }
    assert.equal(await count("app_state_history"), 0); assert.equal(await count("app_change_log"), before);
  });

  await t.test("single assignment moves and removals preserve permitted workflows", async () => {
    const initial = inventory(); initial.assignments = [{ id: "assignment-0", assetId: "receiver-0", accountId: "account-0", assignedAt: when }];
    const { admin, regular } = await setup(initial);
    const moved = structuredClone(initial); moved.assignments[0].accountId = "account-1";
    assert.equal((await save(regular, moved, 1)).status, 200);
    moved.assignments = []; assert.equal((await save(regular, moved, 2)).status, 200);
    assert.deepEqual((await read(admin)).state.assignments, []);
  });

  await t.test("regular rental issuance supports many history entries with server attribution", async () => {
    const initial = inventory(40); const { admin, regular } = await setup(initial);
    initial.rentalStock.batches = [batch(initial)];
    initial.receiverEvents = initial.master.map((row, index) => ({ ...history(`event-${index}`, row.id), changedBy: "forged administrator" }));
    assert.equal((await save(regular, initial, 1)).status, 200);
    const stored = await read(admin);
    assert.equal(stored.state.rentalStock.batches[0].originalCount, 40);
    assert.equal(stored.state.receiverEvents.every((row) => row.changedBy === "testuser"), true);
  });

  await t.test("rental-stock bypasses are rejected even with no other record changes", async () => {
    const initial = inventory(); initial.rentalStock.batches = [batch(initial)];
    const { admin, regular } = await setup(initial);
    for (const mutate of [
      (state) => { state.rentalStock.batches = []; },
      (state) => { state.rentalStock.batches[0].managerName = "Changed manager"; },
      (state) => { state.rentalStock.batches[0].lowThreshold = 10; },
    ]) { const changed = structuredClone(initial); mutate(changed); assert.equal((await save(regular, changed, 1, "PATCH", "Edit receiver")).status, 403); }
    assert.deepEqual((await read(admin)).state, initial);
    assert.equal(await count("app_state_history"), 0);
  });

  await t.test("ordinary rent edits release stock and complete the batch without metadata edits", async () => {
    const initial = inventory(); initial.rentalStock.batches = [batch(initial)];
    const { admin, regular } = await setup(initial);
    for (let index = 0; index < 3; index++) {
      initial.master[index].rentState = "On Rent"; initial.master[index].offRentSince = "";
      initial.rentalStock.batches[0].items[index].releasedAt = when;
      if (index === 2) Object.assign(initial.rentalStock.batches[0], { status: "Completed", completedAt: when });
      initial.receiverEvents.unshift({ ...history(`event-${index}`, `receiver-${index}`), kind: "rent" });
      assert.equal((await save(regular, initial, index + 1)).status, 200);
    }
    assert.equal((await read(admin)).state.rentalStock.batches[0].status, "Completed");
  });

  await t.test("administrator stock removal and clear preserve complete inventory relationships", async () => {
    const initial = inventory(); initial.rentalStock.batches = [batch(initial)];
    const { admin } = await setup(initial);
    const stock = initial.rentalStock.batches[0]; stock.receiverIds.shift();
    stock.removedItems = [{ receiverId: "receiver-0", removedAt: when, removedBy: "testadmin", reason: "Synthetic removal" }];
    Object.assign(stock.items[0], { removedAt: when, removedBy: "testadmin", removalReason: "Synthetic removal" });
    assert.equal((await save(admin, initial, 1, "PUT")).status, 200);
    const clear = inventory(0); clear.accounts = [];
    assert.equal((await save(admin, clear, 2, "PUT")).status, 200);
    assert.deepEqual((await read(admin)).state.rentalStock, { batches: [] });
    assert.equal(await count("app_state_history"), 2);
  });

  await t.test("admin replacements also reject malformed links, IDs, types, capacity, and URLs", async () => {
    const { admin } = await setup();
    const corrupted = [
      (state) => { state.assignments = [{ id: "assignment-0", assetId: "missing", accountId: "account-0", assignedAt: when }]; },
      (state) => { state.master[1].id = state.master[0].id; },
      (state) => { state.master[0].accessCard = 123; },
      (state) => { state.receiverEvents = [{ ...history("event-0"), mapUrl: "javascript:alert(1)" }]; },
      (state) => { delete state.rentalStock; },
    ];
    for (const mutate of corrupted) { const changed = inventory(); mutate(changed); assert.equal((await save(admin, changed, 1, "PUT")).status, 400); }
    const full = inventory(21); full.assignments = full.master.map((row, index) => ({ id: `assignment-${index}`, assetId: row.id, accountId: "account-0", assignedAt: when }));
    assert.equal((await save(admin, full, 1, "PUT")).status, 400);
    assert.equal((await read(admin)).revision, 1); assert.equal(await count("app_state_history"), 0);
  });

  await t.test("history cannot be rewritten/deleted by a regular user", async () => {
    const initial = inventory(); initial.receiverEvents = [history("event-0")];
    const { admin, regular } = await setup(initial);
    for (const mutate of [(state) => { state.receiverEvents[0].title = "Forged"; }, (state) => { state.receiverEvents = []; }]) {
      const changed = structuredClone(initial); mutate(changed); assert.equal((await save(regular, changed, 1)).status, 403);
    }
    assert.deepEqual((await read(admin)).state.receiverEvents, initial.receiverEvents);
  });

  await t.test("recovery refuses incompatible historical state without changing current data", async () => {
    const { admin } = await setup(); const bad = inventory(); bad.master[0].accessCard = 123;
    await tracker.database.prepare("INSERT INTO app_state_history (id, revision, payload, action, created_at, created_by) VALUES ($1, 1, $2, 'Synthetic incompatible history', $3, 'operator')")
      .bind("bad-history", JSON.stringify(bad), when).run();
    assert.equal((await api("/api/recovery", "POST", { id: "bad-history", baseRevision: 1 }, admin)).status, 400);
    assert.equal((await read(admin)).revision, 1); assert.equal(await count("app_state_history"), 1);
  });

  await t.test("staff can update QR status but only admins can delete; denied calls never forward", async () => {
    const { admin, regular } = await setup(); const before = calls.length;
    assert.equal((await api("/api/service-requests?id=request-0", "DELETE", undefined, regular)).status, 403);
    assert.equal(calls.length, before);
    assert.equal((await api("/api/service-requests", "GET", undefined, regular)).status, 200);
    assert.equal((await api("/api/service-requests", "PATCH", { id: "request-0", status: "Completed", notes: "Synthetic staff note" }, regular)).status, 200);
    assert.equal((await api("/api/service-requests", "PATCH", { id: "request-0", status: "Anything", notes: "Invalid" }, regular)).status, 400);
    assert.equal((await api("/api/service-requests?id=request-0", "DELETE", undefined, admin)).status, 200);
    assert.equal(calls.at(-1).authorization, `Bearer ${secret}`);
    assert.equal(calls.at(-1).method, "DELETE");
  });

  for (const operation of ["replace", "recover", "delete request"]) {
    await t.test(`queued ${operation} rechecks current administrator authority`, async () => {
      const { admin, regular } = await setup();
      const changed = inventory(); changed.master[0].notes = "Changed";
      await save(admin, changed, 1, "PUT");
      const point = (await tracker.database.prepare("SELECT id FROM app_state_history LIMIT 1").first()).id;
      const actor = (await tracker.database.prepare("SELECT id FROM app_users WHERE name = 'testadmin'").first()).id;
      let release, acquired;
      const ready = new Promise((resolve) => { acquired = resolve; });
      const gate = new Promise((resolve) => { release = resolve; });
      const blocker = tracker.database.transaction(async (tx) => {
        await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run(); acquired(); await gate;
        // Operator-only synthetic demotion leaves the cookie record in place to
        // verify a current role check, independently of session revocation.
        await tx.prepare("UPDATE app_users SET role = 'user' WHERE id = $1").bind(actor).run();
      });
      await ready;
      const forwarded = calls.length;
      const pending = operation === "replace" ? save(admin, inventory(), 2, "PUT") : operation === "recover"
        ? api("/api/recovery", "POST", { id: point, baseRevision: 2 }, admin)
        : api("/api/service-requests?id=request-0", "DELETE", undefined, admin);
      try {
        let queued = false;
        for (let attempt = 0; attempt < 100 && !queued; attempt++) {
          queued = Number((await tracker.database.prepare("SELECT COUNT(*) AS total FROM pg_stat_activity WHERE usename = $1 AND wait_event = 'advisory'")
            .bind(new URL(tracker.url).username).first()).total) > 0;
          if (!queued) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(queued, true);
      } finally { release(); await blocker; }
      assert.equal((await pending).status, 403);
      assert.equal((await read(regular)).revision, 2);
      assert.equal(await count("app_state_history"), 1); assert.equal(calls.length, forwarded);
    });
  }

  await t.test("a stalled QR upstream times out and releases account authorization", async () => {
    const { admin, regular } = await setup(); hang = true;
    const started = Date.now();
    try {
      const response = await api("/api/service-requests", "GET", undefined, regular);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: "Service request synchronization failed." });
      assert.ok(Date.now() - started < 8000);
    } finally { hang = false; }
    assert.equal((await api("/api/users", "POST", { name: "aftertimeout", pin: "647382" }, admin)).status, 200);
  });
});
