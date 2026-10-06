import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startNext } from "../helpers/next-server.mjs";
import { inventory } from "../helpers/inventory-fixture.mjs";
import { mergeInventory } from "../../lib/inventory-merge.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const admin = { id: "admin-0", name: "testadmin", role: "admin" }, staff = { id: "staff-0", name: "teststaff", role: "user" };

// Browser interaction uses synthetic API fixtures; real cookie ownership, SQL
// permission checks and rollback are exercised by the PostgreSQL suite.
test("browser draft comparison and account isolation", { timeout: 90000 }, async t => {
  const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: "" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  async function fixture(scenario) {
    const context = await browser.newContext(); scenario.after(() => context.close());
    const model = { user: admin, context: "1".repeat(64), state: inventory(), revision: 1, drafts: new Map(), applies: 0, deletes: 0,
      failCopy: false, failRead: false, denyApply: false, delayedCopy: null, loseCopyAck: false };
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()), method = request.method();
      assert.equal(url.origin, server.url, "Outside traffic must remain blocked");
      if (url.pathname === "/api/auth") return route.fulfill({ json: { user: model.user, sessionContext: model.context, needsProvisioning: false } });
      if (!url.pathname.startsWith("/api/")) return route.continue();
      if (request.headers()["x-tracker-session-context"] !== model.context) return route.fulfill({ status: 401, json: { error: "Session changed" } });
      if (url.pathname === "/api/app-state") {
        if (method !== "GET") return route.fulfill({ status: 409, json: { error: "Synthetic revision conflict" } });
        return route.fulfill(model.failRead ? { status: 503, json: { error: "Synthetic read failure" } } : { json: { state: model.state, revision: model.revision } });
      }
      if (url.pathname === "/api/drafts") {
        if (method === "PUT") {
          if (model.failCopy) return route.fulfill({ status: 503, json: { error: "Synthetic checkpoint failure" } });
          const body = request.postDataJSON(), old = model.drafts.get(body.id);
          if (old && (old.owner !== model.user.id || old.version !== body.version)) return route.fulfill({ status: 409, json: { error: "Draft changed" } });
          const row = { ...body, version: body.version + 1, owner: model.user.id, updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 604800000).toISOString() };
          model.drafts.set(row.id, row);
          if(model.loseCopyAck){model.loseCopyAck=false;return route.fulfill({ status:503,json:{error:"Synthetic lost acknowledgement"} });}
          if (model.delayedCopy) { const delayed = model.delayedCopy; model.delayedCopy = null; delayed.started(); await delayed.gate; }
          return route.fulfill({ json: row }).catch(() => {});
        }
        if (method === "GET" && !url.searchParams.has("id")) return route.fulfill({ json: { drafts: [...model.drafts.values()].filter(row => row.owner === model.user.id) } });
        const body = method === "GET" ? null : request.postDataJSON(), id = url.searchParams.get("id") || body.id;
        const row = model.drafts.get(id);
        if (!row || row.owner !== model.user.id) return route.fulfill({ status: 404, json: { error: "Unavailable" } });
        if (method === "GET") return route.fulfill({ json: url.searchParams.has("preview") ? {
          ...row, expectedRevision: model.revision, ...mergeInventory(row.baseState, row.draftState, model.state),
        } : row });
        if (row.version !== body.version) return route.fulfill({ status: 409, json: { error: "Draft changed" } });
        if (method === "POST") {
          model.applies++;
          if (model.denyApply) return route.fulfill({ status: 403, json: { error: "Administrator required" } });
          if (body.expectedRevision !== model.revision) return route.fulfill({ status: 409, json: { error: "Shared inventory changed. Review again." } });
          const plan = mergeInventory(row.baseState, row.draftState, model.state, body.choices);
          if (plan.unresolved) return route.fulfill({ status: 409, json: { error: "Missing choice" } });
          model.state = plan.state; model.revision++; model.drafts.delete(id);
          return route.fulfill({ json: { state: model.state, revision: model.revision, updatedAt: new Date().toISOString() } });
        }
        model.deletes++; model.drafts.delete(id); return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { requests: [], users: [], activity: [], snapshots: [] } });
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message)); scenario.after(() => assert.deepEqual(errors, []));
    await page.goto(`${server.url}/asset-tracker/index.html`);
    const ready = () => page.waitForFunction(() => document.getElementById("authGate").hidden);
    await ready();
    const pause = async () => {
      await page.evaluate(() => { master[0].notes = "MY-PRIVATE-DRAFT"; save("Edit receiver"); showView("settings"); });
      await page.waitForFunction(() => cloudWriteBlocked);
    };
    const copied = () => page.waitForFunction(() => draftCopy?.version > 0 && draftSavedGeneration === draftGeneration);
    const review = async () => { await page.locator("#reviewDraftButton").click(); await page.waitForFunction(() => Boolean(draftReview)); };
    const apply = async () => { page.once("dialog", dialog => dialog.accept()); await page.locator("#applyDraftButton").click(); };
    return { page, model, context, ready, pause, copied, review, apply };
  }
  await t.test("acknowledged copy survives reload; conflicts need choices and unrelated shared edits survive", async scenario => {
    const f = await fixture(scenario); await f.pause(); await f.copied();
    f.model.state.master[0].notes = "SHARED-NOTE"; f.model.state.master[0].model = "SHARED-MODEL"; f.model.revision++;
    await f.page.reload(); await f.ready();
    assert.equal(await f.page.evaluate(() => master[0].notes), "SHARED-NOTE");
    assert.equal(f.model.applies, 0);
    await f.page.evaluate(() => showView("settings"));
    await f.page.locator("[data-open-draft]").click(); await f.page.waitForFunction(() => Boolean(draftReview));
    assert.match(await f.page.locator("#draftReviewTable").innerText(), /MY-PRIVATE-DRAFT.*SHARED-NOTE/s);
    // Optional synthetic screenshot for reviewer inspection; never a live page.
    if(process.env.DRAFT_REVIEW_SCREENSHOT)await f.page.locator("#draftPanel").screenshot({path:process.env.DRAFT_REVIEW_SCREENSHOT});
    await f.page.locator("#applyDraftButton").click(); assert.equal(f.model.applies, 0);
    assert.match(await f.page.locator("#draftReviewNotice").innerText(), /Choose a value/);
    await f.page.locator("[data-draft-choice]").selectOption("mine"); await f.apply();
    await f.page.waitForFunction(() => !cloudWriteBlocked && !cloudQueued);
    assert.equal(f.model.state.master[0].notes, "MY-PRIVATE-DRAFT"); assert.equal(f.model.state.master[0].model, "SHARED-MODEL");
    assert.equal(f.model.drafts.size, 0);
    const storage = await f.page.evaluate(() => Object.values(localStorage));
    assert.equal(JSON.stringify(storage).includes("MY-PRIVATE-DRAFT"), false);
  });
  await t.test("another employee never receives the prior employee's recovery copies", async scenario => {
    const f = await fixture(scenario); await f.pause(); await f.copied();
    f.model.user = staff; f.model.context = "2".repeat(64);
    await f.page.reload(); await f.ready(); await f.page.evaluate(() => showView("settings"));
    await f.page.locator("#refreshDraftsButton").click();
    assert.equal(await f.page.locator("[data-open-draft]").count(), 0);
    assert.equal((await f.page.content()).includes("MY-PRIVATE-DRAFT"), false); assert.equal(f.model.drafts.size, 1);
  });
  await t.test("stale comparison and permission rejection preserve draft for a fresh review", async scenario => {
    const f = await fixture(scenario); await f.pause(); await f.copied(); await f.review();
    f.model.state.master[1].model = "New shared change"; f.model.revision++;
    await f.apply(); await f.page.waitForFunction(() => !draftReview);
    assert.match(await f.page.locator("#draftReviewNotice").innerText(), /Shared inventory changed/);
    assert.equal(f.model.drafts.size, 1); assert.equal(f.model.state.master[0].notes, undefined);
    await f.review(); f.model.denyApply = true; await f.apply(); await f.page.waitForFunction(() => !draftReview);
    assert.match(await f.page.locator("#draftReviewNotice").innerText(), /Administrator required/); assert.equal(f.model.drafts.size, 1);
    assert.equal(await f.page.evaluate(() => master[0].notes), "MY-PRIVATE-DRAFT");
  });
  await t.test("unconfirmed checkpoints clearly warn and leave a downloadable snapshot", async scenario => {
    const f = await fixture(scenario); f.model.failCopy = true; await f.pause();
    await f.page.waitForFunction(() => document.getElementById("draftStatus").textContent.includes("Synthetic checkpoint failure"));
    assert.match(await f.page.locator("#draftStatus").innerText(), /only in this tab.*Download a snapshot/);
    const downloaded = f.page.waitForEvent("download"); await f.page.locator("#downloadBackupButton").click();
    const contents = JSON.parse(await readFile(await (await downloaded).path(), "utf8"));
    assert.equal(contents.data.master[0].notes, "MY-PRIVATE-DRAFT"); assert.equal(f.model.drafts.size, 0);
    f.model.failCopy = false; await f.review(); assert.equal(f.model.drafts.size, 1);
  });
  await t.test("late checkpoint acknowledgement cannot restore another employee's private state", async scenario => {
    const f = await fixture(scenario); let started, release;
    const pending = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.model.delayedCopy = { started, gate }; await f.pause(); await pending;
    f.model.user = staff; f.model.context = "3".repeat(64);
    await f.page.evaluate(() => verifyActiveSession());
    release(); await f.page.waitForFunction(() => !currentUser && !draftCopy);
    assert.equal((await f.page.content()).includes("MY-PRIVATE-DRAFT"), false);
    assert.equal(await f.page.evaluate(() => master.length), 0);
  });
  await t.test("a committed copy with a lost acknowledgement can be opened explicitly without duplicating it", async scenario => {
    const f=await fixture(scenario);f.model.loseCopyAck=true;await f.pause();
    await f.page.waitForFunction(()=>document.getElementById("draftStatus").textContent.includes("lost acknowledgement"));
    assert.equal(f.model.drafts.size,1);assert.equal(await f.page.evaluate(()=>draftCopy.version),0);
    await f.page.locator("#refreshDraftsButton").click();
    f.page.once("dialog",dialog=>dialog.accept());await f.page.locator("[data-open-draft]").click();
    await f.page.waitForFunction(()=>Boolean(draftReview));assert.equal(f.model.drafts.size,1);
    assert.equal(await f.page.evaluate(()=>master[0].notes),"MY-PRIVATE-DRAFT");
  });
  await t.test("discard waits for a successful shared read and never writes inventory", async scenario => {
    const f = await fixture(scenario); await f.pause(); await f.copied(); f.model.failRead = true;
    f.page.once("dialog", dialog => dialog.accept()); await f.page.locator("#useSharedButton").click();
    await f.page.waitForFunction(() => document.getElementById("draftReviewNotice").textContent.includes("Draft retained"));
    assert.equal(f.model.deletes, 0); assert.equal(await f.page.evaluate(() => master[0].notes), "MY-PRIVATE-DRAFT");
    f.model.failRead = false; f.page.once("dialog", dialog => dialog.accept()); await f.page.locator("#useSharedButton").click();
    await f.page.waitForFunction(() => !cloudWriteBlocked && !cloudQueued);
    assert.equal(f.model.deletes, 1); assert.equal(f.model.applies, 0); assert.equal(await f.page.evaluate(() => master[0].notes), undefined);
  });
});
