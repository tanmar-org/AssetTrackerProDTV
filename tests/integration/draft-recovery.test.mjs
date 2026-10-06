import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { startNext } from "../helpers/next-server.mjs";
import { sessionHeaders } from "../helpers/session-context.mjs";
import { inventory, history, when } from "../helpers/inventory-fixture.mjs";

// Real HTTP, restricted-role SQL and transactions. Drafts contain synthetic data
// only, and fixtures are destroyed even if a schema/audit/concurrency check fails.
test("account-owned PostgreSQL draft recovery", async t => {
  const tracker = await createPostgresFixture("tracker");
  const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: tracker.url });
  t.after(async()=>{await server.close();await tracker.close();});
  const api = (path, method = "GET", body, cookie, headers = {}) => fetch(`${server.url}${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie, ...sessionHeaders(cookie) } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const login = async (name, pin) => {
    const response = await api("/api/auth", "POST", { action: "login", name, pin });
    assert.equal(response.status, 200); return response.headers.get("set-cookie").split(";")[0];
  };
  const setup = async () => {
    await tracker.database.prepare("TRUNCATE app_inventory_drafts, app_sessions, app_users, app_state, app_state_history, app_change_log").run();
    await provisionAdmin(tracker.database, { name: "testadmin", pin: "482631" });
    const admin = await login("testadmin", "482631");
    assert.equal((await api("/api/users", "POST", { name: "testuser", pin: "593742" }, admin)).status, 200);
    const regular = await login("testuser", "593742");
    assert.equal((await api("/api/app-state", "PUT", { state: inventory(), baseRevision: 0 }, admin)).status, 200);
    return { admin, regular };
  };
  const saveDraft = async (cookie, mine, options = {}) => {
    const body = { id: randomUUID(), version: 0, baseRevision: 1, baseState: inventory(), draftState: mine, label: "Synthetic recovery", ...options };
    return { body, response: await api("/api/drafts", "PUT", body, cookie) };
  };
  const read = async cookie => (await api("/api/app-state", "GET", undefined, cookie)).json();
  const preview = async (cookie, id) => (await api(`/api/drafts?id=${id}&preview=1`, "GET", undefined, cookie)).json();
  const apply = (cookie, plan, choices = {}) => api("/api/drafts", "POST", { id: plan.id, version: plan.version, expectedRevision: plan.expectedRevision, choices }, cookie);
  const status = async id => (await tracker.database.prepare("SELECT status FROM app_inventory_drafts WHERE id = $1").bind(id).first()).status;

  await t.test("copies are owner-only, including administrators, and never mutate inventory", async () => {
    const { admin, regular } = await setup(), mine = inventory(); mine.master[0].notes = "Private staff draft";
    const { body, response } = await saveDraft(regular, mine); assert.equal(response.status, 200);
    assert.equal((await read(admin)).revision, 1);
    assert.equal((await api("/api/drafts", "GET", undefined, regular)).headers.get("cache-control"), "no-store");
    assert.equal((await (await api("/api/drafts", "GET", undefined, regular)).json()).drafts.length, 1);
    assert.deepEqual((await (await api("/api/drafts", "GET", undefined, admin)).json()).drafts, []);
    for (const path of [`/api/drafts?id=${body.id}`, `/api/drafts?id=${body.id}&preview=1`]) assert.equal((await api(path, "GET", undefined, admin)).status, 404);
    assert.equal((await api("/api/drafts", "DELETE", { id: body.id, version: 1 }, admin)).status, 404);
    assert.equal((await api("/api/drafts", "POST", { id: body.id, version: 1, expectedRevision: 1, choices: {} }, admin)).status, 404);
    assert.equal((await api("/api/drafts", "PUT", { ...body, version: 1 }, admin)).status, 409);
    assert.equal((await saveDraft(regular, mine, { userId: "spoof-owner" })).response.status, 400);
    assert.equal((await saveDraft(undefined, mine)).response.status, 401);
    assert.equal((await api("/api/drafts", "PUT", body, regular, { "x-tracker-session-context": "0".repeat(64) })).status, 401);
  });
  await t.test("draft CAS, quota, discard tombstones, schema and expiry are enforced", async () => {
    const { regular } = await setup(), mine = inventory(); mine.master[0].notes = "My draft";
    const { body, response } = await saveDraft(regular, mine); assert.equal(response.status, 200);
    assert.equal((await api("/api/drafts", "PUT", body, regular)).status, 409);
    assert.equal((await api("/api/drafts", "PUT", { ...body, version: 1 }, regular)).status, 200);
    assert.equal((await api("/api/drafts", "DELETE", { id: body.id, version: 1 }, regular)).status, 409);
    assert.equal((await api("/api/drafts", "DELETE", { id: body.id, version: 2 }, regular)).status, 200);
    assert.equal(await status(body.id), "discarded");
    assert.equal((await api("/api/drafts", "PUT", { ...body, version: 3 }, regular)).status, 409);
    const closed = await tracker.database.prepare("SELECT draft_state, base_state FROM app_inventory_drafts WHERE id = $1").bind(body.id).first();
    assert.deepEqual(closed, { draft_state: {}, base_state: {} });
    const malformed = inventory(); malformed.master[0].unknown = "bad";
    assert.equal((await saveDraft(regular, malformed)).response.status, 400);
    assert.equal((await saveDraft(regular, mine, { label: "x".repeat(161) })).response.status, 400);
    assert.equal((await saveDraft(regular, mine, { baseRevision: -1 })).response.status, 400);
    const active = [];
    for (let index = 0; index < 5; index++) { const saved = await saveDraft(regular, mine); assert.equal(saved.response.status, 200); active.push(saved.body.id); }
    assert.equal((await saveDraft(regular, mine)).response.status, 409);
    await tracker.database.prepare("UPDATE app_inventory_drafts SET expires_at = now() - interval '1 second' WHERE id = $1").bind(active[0]).run();
    assert.equal((await api(`/api/drafts?id=${active[0]}`, "GET", undefined, regular)).status, 404);
    assert.equal((await saveDraft(regular, mine)).response.status, 200);
    // Advertised and streamed budgets reject before JSON parsing/DB allocation.
    assert.equal((await api("/api/drafts", "PUT", { padding: "x".repeat(16 * 1024 * 1024 + 4097) }, regular)).status, 413);
  });
  await t.test("review preserves nonoverlapping edits and enforces conflicts/revisions atomically", async () => {
    const { admin, regular } = await setup(), mine = inventory(); mine.master[0].notes = "Mine";
    const saved = await saveDraft(regular, mine); assert.equal(saved.response.status, 200);
    const shared = inventory(); shared.master[0].model = "Other employee";
    assert.equal((await api("/api/app-state", "PUT", { state: shared, baseRevision: 1 }, admin)).status, 200);
    let plan = await preview(regular, saved.body.id); assert.equal(plan.unresolved, 0);
    shared.master[0].notes = "Their note";
    assert.equal((await api("/api/app-state", "PUT", { state: shared, baseRevision: 2 }, admin)).status, 200);
    assert.equal((await apply(regular, plan)).status, 409); // stale comparison
    plan = await preview(regular, saved.body.id); assert.equal(plan.unresolved, 1);
    assert.equal((await apply(regular, plan)).status, 409); // missing explicit choice
    assert.equal((await apply(regular, plan, { foreign: "mine" })).status, 409);
    assert.equal(await status(saved.body.id), "active");
    const response = await apply(regular, plan, { [plan.changes[0].key]: "mine" }); assert.equal(response.status, 200);
    const result = await response.json(); assert.equal(result.revision, 4); assert.equal(result.state.master[0].notes, "Mine"); assert.equal(result.state.master[0].model, "Other employee");
    assert.equal(await status(saved.body.id), "applied");
    assert.equal((await apply(regular, plan)).status, 404);
    const log = await tracker.database.prepare("SELECT action, user_name FROM app_change_log WHERE revision = 4").first();
    assert.deepEqual(log, { action: "Updated receiver/assignment", user_name: "testuser" });
    assert.equal(Number((await tracker.database.prepare("SELECT count(*) AS total FROM app_state_history").first()).total), 3);
  });
  await t.test("discard/create cycles cannot evade the retained-ID quota; expired tombstones free a slot",async()=>{
    const {admin,regular}=await setup();let first;
    for(let index=0;index<20;index++){
      const saved=await saveDraft(regular,inventory());assert.equal(saved.response.status,200);first??=saved.body.id;
      assert.equal((await api("/api/drafts","DELETE",{id:saved.body.id,version:1},regular)).status,200);
    }
    assert.equal((await saveDraft(regular,inventory())).response.status,409);
    assert.equal((await saveDraft(admin,inventory())).response.status,200);
    await tracker.database.prepare("UPDATE app_inventory_drafts SET expires_at = now() - interval '1 second' WHERE id = $1").bind(first).run();
    assert.equal((await saveDraft(regular,inventory())).response.status,200);
  });
  await t.test("recovery cannot bypass ordinary bulk policy or schema; failures preserve copies", async () => {
    const { admin, regular } = await setup(), mine = inventory(); mine.master[0].notes = "First"; mine.master[1].notes = "Second";
    const saved = await saveDraft(regular, mine), plan = await preview(regular, saved.body.id);
    assert.equal((await apply(regular, plan)).status, 403); assert.equal(await status(saved.body.id), "active"); assert.equal((await read(admin)).revision, 1);
    // The employee can choose to discard one operation explicitly, without being
    // granted administrator replacement authority by the recovery endpoint.
    assert.equal((await apply(regular, plan, { [plan.changes.find(row => row.id === "receiver-1").key]: "shared" })).status, 200);
    assert.equal((await read(admin)).state.master[1].notes, undefined);
    const adminMine = (await read(admin)).state; adminMine.master[0].assetNumber = "NEW";
    const savedAdmin = await saveDraft(admin, adminMine, { baseRevision: 2, baseState: (await read(admin)).state });
    const shared = (await read(admin)).state; shared.master[1].assetNumber = "NEW";
    assert.equal((await api("/api/app-state", "PUT", { state: shared, baseRevision: 2 }, admin)).status, 200);
    const invalid = await preview(admin, savedAdmin.body.id);
    assert.equal((await apply(admin, invalid)).status, 400); assert.equal(await status(savedAdmin.body.id), "active"); assert.equal((await read(admin)).revision, 3);
  });
  await t.test("audit failure rolls back inventory, history, and closing the draft", async () => {
    const { admin } = await setup(), mine = inventory(); mine.master[0].notes = "Atomic draft";
    const saved = await saveDraft(admin, mine), plan = await preview(admin, saved.body.id);
    await tracker.database.prepare("ALTER TABLE app_change_log ADD CONSTRAINT synthetic_draft_audit_failure CHECK (revision IS DISTINCT FROM 2)").run();
    try { assert.equal((await apply(admin, plan)).status, 503); } finally { await tracker.database.prepare("ALTER TABLE app_change_log DROP CONSTRAINT synthetic_draft_audit_failure").run(); }
    assert.equal((await read(admin)).revision, 1); assert.equal(await status(saved.body.id), "active");
    assert.equal(Number((await tracker.database.prepare("SELECT count(*) AS total FROM app_state_history").first()).total), 0);
    assert.equal((await apply(admin, plan)).status, 200);
  });
  await t.test("ordinary linked assignment/history recovery preserves ordering and stamps the actual employee",async()=>{
    const {admin,regular}=await setup(),base=inventory();base.receiverEvents=[history("old-event")];
    assert.equal((await api("/api/app-state","PUT",{state:base,baseRevision:1},admin)).status,200);
    const mine=structuredClone(base);
    mine.assignments.push({id:"assignment-0",assetId:"receiver-0",accountId:"account-0",assignedAt:when});
    mine.receiverEvents.unshift({...history("my-event"),changedBy:"spoofed-name"});
    const saved=await saveDraft(regular,mine,{baseRevision:2,baseState:base});
    const shared=structuredClone(base);shared.receiverEvents.unshift(history("shared-event","receiver-1"));
    assert.equal((await api("/api/app-state","PUT",{state:shared,baseRevision:2},admin)).status,200);
    const response=await apply(regular,await preview(regular,saved.body.id));assert.equal(response.status,200);
    const result=await response.json();assert.deepEqual(result.state.receiverEvents.map(row=>row.id),["my-event","shared-event","old-event"]);
    assert.equal(result.state.receiverEvents[0].changedBy,"testuser");assert.equal(result.state.receiverEvents[1].changedBy,"syntheticuser");
    assert.equal(result.state.assignments[0].accountId,"account-0");
  });
  await t.test("simultaneous applications commit once; shared-value no-op closes without inventing history", async () => {
    const { admin }=await setup(),mine=inventory();mine.master[0].notes="Race recovery";
    const saved=await saveDraft(admin,mine),plan=await preview(admin,saved.body.id);
    const outcomes=await Promise.all([apply(admin,plan),apply(admin,plan)]);
    assert.deepEqual(outcomes.map(response=>response.status).sort(),[200,404]);
    assert.equal((await read(admin)).revision,2);
    const before=(await read(admin)).state,after=structuredClone(before);after.master[0].notes="Discard through review";
    const other=await saveDraft(admin,after,{baseState:before,baseRevision:2}),next=await preview(admin,other.body.id);
    assert.equal((await apply(admin,next,{[next.changes[0].key]:"shared"})).status,200);
    assert.equal((await read(admin)).revision,2);assert.equal(await status(other.body.id),"applied");
    assert.equal(Number((await tracker.database.prepare("SELECT count(*) AS total FROM app_state_history").first()).total),1);
  });
  await t.test("authorization is rechecked after waiting on the account lock", async () => {
    const { admin, regular } = await setup(), mine = inventory(); mine.master[0].notes = "Never authorized after revocation";
    const saved = await saveDraft(regular, mine), plan = await preview(regular, saved.body.id);
    let acquired, release;
    const ready = new Promise(resolve => { acquired = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const holding = tracker.database.transaction(async store => {
      await store.prepare("SELECT pg_advisory_xact_lock(728303)").run(); acquired(); await gate;
      await store.prepare("UPDATE app_users SET active = 0 WHERE name = 'testuser'").run();
    });
    await ready;
    const pending = apply(regular, plan);
    try {
      // Observe the database waiter rather than assuming a fixed delay proves it.
      for (let attempt = 0; attempt < 100; attempt++) {
        const waiting = await tracker.database.prepare("SELECT count(*) AS total FROM pg_locks WHERE locktype = 'advisory' AND granted = false").first();
        if (Number(waiting.total)) break;
        if (attempt === 99) assert.fail("Recovery did not wait for authorization lock");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { release(); await holding; }
    assert.equal((await pending).status, 401); assert.equal((await read(admin)).revision, 1); assert.equal(await status(saved.body.id), "active");
  });
});
