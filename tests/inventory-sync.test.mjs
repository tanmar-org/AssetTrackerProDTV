import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { inventory } from "./helpers/inventory-fixture.mjs";

async function browser(fetch) {
  const source = await readFile(new URL("../public/asset-tracker/app.js", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
  const names = ["scheduleCloudSave", "flushCloudSave"];
  const functions = parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map((node) => node.getText(parsed));
  let state = inventory();
  const status = [], timers = [];
  const context = vm.createContext({
    sessionEpoch: 0, sessionContext: "1".repeat(64), currentUser: { id: "synthetic-user", role: "user" }, currentCloudAction: "Data change", cloudReady: true,
    cloudQueued: false, cloudSaving: false, cloudWriteBlocked: false, cloudCaptureQueued: false,
    draftBusy: false, draftGeneration: 0, draftReview: null, cloudBaseState: inventory(),
    $: () => ({}), scheduleDraftCopy() {},
    cloudPendingStates: [], cloudRevision: 1, cloudSaveTimer: null,
    CLOUD_STATE_API: "/api/app-state", navigator: { onLine: true }, structuredClone, queueMicrotask,
    setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {},
    setCloudStatus: (state, detail) => status.push({ state, detail }), showAuthGate() {},
    cloudState: () => state, fetch,
    sessionActive: (epoch) => epoch === context.sessionEpoch && Boolean(context.currentUser),
    staffRequest: async (url, options) => { const response = await fetch(url, options); return { response, result: await response.json() }; },
    readCloudState() { throw new Error("A rejected draft must never be replaced by an automatic shared read."); },
  });
  vm.runInContext(functions.join("\n"), context);
  return { context, status, timers, setState: (next) => { state = next; } };
}

test("regular browser operations remain separate and use acknowledged revisions", async () => {
  const requests = [];
  const app = await browser(async (_url, options) => {
    requests.push({ method: options.method, body: JSON.parse(options.body) });
    return { status: 200, ok: true, json: async () => ({ revision: requests.length + 1, updatedAt: "2026-10-05T18:00:00Z" }) };
  });
  const first = inventory(); first.master[0].notes = "First receiver edit";
  app.setState(first); app.context.scheduleCloudSave("Edit Master receiver"); await Promise.resolve();
  const second = structuredClone(first); second.master[1].notes = "Second receiver edit";
  app.setState(second); app.context.scheduleCloudSave("Edit Master receiver"); await Promise.resolve();
  assert.equal(app.context.cloudPendingStates.length, 2);
  await app.context.flushCloudSave(); await app.context.flushCloudSave();
  assert.deepEqual(requests.map((request) => request.method), ["PATCH", "PATCH"]);
  assert.deepEqual(requests.map((request) => request.body.baseRevision), [1, 2]);
  assert.equal(requests[0].body.state.master[1].notes, undefined);
  assert.equal(requests[1].body.state.master[1].notes, "Second receiver edit");
  assert.equal(app.context.cloudPendingStates.length, 0);
  assert.equal(app.context.cloudQueued, false);
});

test("policy/conflict rejection retains the browser draft and pauses automatic retry", async () => {
  for (const status of [400, 403, 409]) {
    let calls = 0;
    const app = await browser(async () => { calls++; return { status, ok: false, json: async () => ({ error: "Synthetic rejection" }) }; });
    const draft = inventory(); draft.master[0].notes = "Retain this draft";
    app.setState(draft); app.context.scheduleCloudSave(); await Promise.resolve();
    await app.context.flushCloudSave();
    assert.equal(app.context.cloudPendingStates.length, 1);
    assert.equal(app.context.cloudPendingStates[0].state.master[0].notes, "Retain this draft");
    assert.equal(app.context.cloudWriteBlocked, true);
    assert.match(app.status.at(-1).detail, /Synthetic rejection.*Saving paused/);
    await app.context.flushCloudSave(); assert.equal(calls, 1);
    assert.equal(app.timers.some((timer) => timer.delay === 2500), false);
  }
});

test("admin browser replacements use PUT and regular offline queues remain bounded", async () => {
  const requests = [];
  const admin = await browser(async (_url, options) => { requests.push(options); return { status: 200, ok: true, json: async () => ({ revision: 2 }) }; });
  admin.context.currentUser.role = "admin"; admin.context.scheduleCloudSave();
  await admin.context.flushCloudSave(); assert.equal(requests[0].method, "PUT");
  const app = await browser(() => { throw new Error("Blocked queues must not submit."); });
  for (let index = 0; index < 33; index++) { app.context.scheduleCloudSave(); await Promise.resolve(); }
  assert.equal(app.context.cloudPendingStates.length, 32);
  assert.equal(app.context.cloudWriteBlocked, true);
  assert.match(app.status.at(-1).detail, /too many pending edits/);
  await app.context.flushCloudSave();
});

async function functionsNamed(names) {
  const source = await readFile(new URL("../public/asset-tracker/app.js", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
  return parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map((node) => node.getText(parsed)).join("\n");
}

test("a recovery list action resumes an ordinary save timer without replaying a paused draft",async()=>{
  for(const blocked of [false,true]){
    const timers=[],shell={inert:false};let saves=0;
    const context=vm.createContext({draftBusy:false,cloudSaving:false,cloudQueued:true,cloudWriteBlocked:blocked,cloudSaveTimer:null,
      sessionEpoch:1,navigator:{onLine:true},document:{querySelector:()=>shell},sessionActive:()=>true,
      revealWorkspace:()=>{shell.inert=false;},toast(){},clearTimeout(){},
      setTimeout:(callback,delay)=>{timers.push({callback,delay});},flushCloudSave:()=>{saves++;}});
    vm.runInContext(await functionsNamed(["runDraftAction"]),context);
    await context.runDraftAction(async()=>assert.equal(shell.inert,true));
    assert.equal(shell.inert,false);assert.equal(context.draftBusy,false);
    if(blocked)assert.equal(timers.length,0);
    else{assert.equal(timers[0].delay,450);timers[0].callback();assert.equal(saves,1);}
  }
});

test("downloaded inventory snapshots contain rental stock and audit with accurate scope", async () => {
  const state = inventory(); state.rentalStock.batches = [{ id: "synthetic-export-batch" }];
  let exported;
  const context = vm.createContext({ ...state, toast() {}, downloadFile: (_name, text) => { exported = JSON.parse(text); } });
  vm.runInContext(await functionsNamed(["downloadBackup"]), context);
  context.downloadBackup();
  assert.deepEqual(exported.data, state);
  assert.equal("app_users" in exported.data, false);
});

test("administrator Undo restores audit and stock; regular users cannot replace the inventory", async () => {
  const current = inventory(), previous = inventory(); previous.rentalStock.batches = [{ id: "previous-stock" }]; previous.auditState = { fileName: "previous-audit.csv" };
  let saves = 0;
  const context = vm.createContext({
    ...current, undoHistory: [{ state: previous, label: "Synthetic undo" }], currentUser: { role: "admin" },
    currentAccountId: null, selectedLabelIds: new Set(), confirm: () => true, $: () => ({}), toast() {},
    accountById: () => null, assetById: () => null, save: () => { saves++; }, persistUndoHistory() {}, persistAuditCache() {},
    renderDashboard() {}, renderAccounts() {}, renderMaster() {}, renderActivations() {}, renderAuditResults() {}, renderLabels() {}, renderReports() {},
  });
  vm.runInContext(await functionsNamed(["restoreUndoEntry"]), context);
  context.restoreUndoEntry();
  assert.equal(saves, 1); assert.deepEqual(context.rentalStock, previous.rentalStock); assert.deepEqual(context.auditState, previous.auditState);
  context.currentUser.role = "user"; context.undoHistory = [{ state: current, label: "Denied undo" }];
  context.restoreUndoEntry(); assert.equal(saves, 1);
});
