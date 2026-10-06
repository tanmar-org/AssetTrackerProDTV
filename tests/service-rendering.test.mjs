import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const attack = '<img src=x onerror="globalThis.injected=true">" & </dd><svg onload=alert(1)>';
const source = await readFile(new URL("../public/asset-tracker/app.js", import.meta.url), "utf8");
const parsed = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
function functions(names) {
  return parsed.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text))
    .map((node) => node.getText(parsed)).join("\n");
}

// Execute the complete compatibility redirect. Any accidental HTML sink fails;
// historical private fields must never reach the destination or page text.
async function legacy(parameters, destination = "https://qr.example.invalid/") {
  const node = { textContent: "", set innerHTML(_value) { throw new Error("Unsafe HTML sink."); } };
  const location = { search: new URLSearchParams(parameters).toString(), origin: "https://tracker.example.invalid",
    pathname: "/asset-tracker/service-request.html", replace: (value) => { location.target = value; } };
  const context = vm.createContext({ location, URL, URLSearchParams,
    window: { TANMAR_CONFIG: { serviceRequestUrl: destination } }, document: { getElementById: () => node } });
  vm.runInContext(await readFile(new URL("../public/asset-tracker/service-request.js", import.meta.url), "utf8"), context);
  return { location, node };
}

test("legacy labels forward only the validated asset reference, without a private query or draft", async () => {
  const app = await legacy({ a: "TEST-01", s: "000001", an: "000004", ac: attack }, "https://qr.example.invalid/?an=private#old");
  assert.equal(app.location.target, "https://qr.example.invalid/?a=TEST-01");
  assert.equal(app.node.textContent, "");
  const stable = await legacy({ id: "receiver-01", a: "old-number", s: "private" });
  assert.equal(stable.location.target, "https://qr.example.invalid/?id=receiver-01");
});

test("legacy redirects reject malicious asset references, destinations, and redirect loops", async () => {
  for (const [parameters, destination] of [[{ a: attack }, undefined], [{ a: "TEST-01" }, "javascript:alert(1)"],
    [{ a: "TEST-01" }, "https://user:pass@example.invalid/"], [{ a: "TEST-01" }, "https://tracker.example.invalid/asset-tracker/service-request.html"]]) {
    const app = await legacy(parameters, destination);
    assert.equal(app.location.target, undefined);
    assert.match(app.node.textContent, /Contact TanMar/);
  }
});

const unsafeMaps = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "//maps.google.com/?q=1,2",
  "http://maps.google.com/?q=1,2", "https://maps.google.com.evil.invalid/", "https://evil.invalid/maps",
  "https://maps.google.com@evil.invalid/", "https://user:password@maps.google.com/", "https://maps.google.com:444/",
  "https://www.google.com/search?q=maps", "not a URL", "", null, "https://maps.google.com/?q=" + "a".repeat(512)];

test("staff request association survives renames and does not match a reused asset number", () => {
  const master = [{ id: "receiver-01", assetNumber: "RENAMED-001" }, { id: "receiver-02", assetNumber: "TEST-001" }];
  const context = vm.createContext({ master, assetById: (id) => master.find((item) => item.id === id) });
  vm.runInContext(functions(["remoteReceiver"]), context);
  assert.equal(context.remoteReceiver({ assetId: "receiver-01", assetNumber: "TEST-001" }).id, "receiver-01");
  assert.equal(context.remoteReceiver({ assetId: "deleted-receiver", assetNumber: "TEST-001" }).id, undefined);
  assert.equal(context.remoteReceiver({ assetNumber: "TEST-001" }).id, "receiver-02");
});

test("Maps destinations require HTTPS, exact approved hosts, no credentials and a bounded URL", () => {
  const context = vm.createContext({ URL });
  vm.runInContext(functions(["safeMapsLink"]), context);
  for (const value of unsafeMaps) assert.equal(context.safeMapsLink(value), "", String(value));
  for (const value of ["https://maps.google.com/?q=31.9,-102.2", "https://www.google.com/maps?q=1,2", "https://google.com/maps/place/Test"])
    assert.equal(context.safeMapsLink(value), value);
});

test("staff service and event renderers escape records and omit unsafe map anchors", () => {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, { value: id.includes("Filter") ? "all" : "" }); return nodes.get(id); };
  const request = { id: attack, action: "Reactivate / Refresh", status: attack, requestedAt: "2026-10-05T18:00:00Z", notes: attack };
  const entry = { id: "event", title: attack, notes: attack };
  const context = vm.createContext({ URL, $: get, currentUser: { role: "admin" }, receiverEvents: [entry], openModal() {},
    requestPager:{loading:false,error:"",index:0,next:null},remoteActivations:[],serviceMutationBusy:false,
    formatUndoTime: (value) => value, allActivationRows: () => [{ request, receiver: { assetNumber: attack }, account: { name: attack } }] });
  vm.runInContext(functions(["esc", "highlightMatch", "safeMapsLink", "recordPageControls", "renderActivations", "openReceiverEvent"]), context);
  for (const mapUrl of unsafeMaps) {
    request.mapUrl = mapUrl; entry.mapUrl = mapUrl;
    context.renderActivations(); context.openReceiverEvent("event");
    for (const id of ["activationRows", "receiverEventBody"]) {
      assert.equal(get(id).innerHTML.includes("<a "), false);
      assert.equal(get(id).innerHTML.includes("<img "), false);
      assert.ok(get(id).innerHTML.includes("&lt;img"));
    }
  }
  request.mapUrl = entry.mapUrl = "https://maps.google.com/?q=31.9,-102.2";
  context.renderActivations(); context.openReceiverEvent("event");
  for (const id of ["activationRows", "receiverEventBody"])
    assert.match(get(id).innerHTML, /href="https:\/\/maps.google.com\/\?q=31.9,-102.2"/);
});

test("nonempty administrative activity formats historical dates and escapes private API text", () => {
  const nodes = new Map();
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); };
  const context = vm.createContext({ $: get, activityPager: { loading: false, error: "", index: 1, next: "opaque" },
    activityRecords: [{ user_name: attack, action: attack, revision: 7, created_at: "2025-10-01T14:00:00Z" }] });
  vm.runInContext(functions(["esc", "formatHistoryDate", "activityType", "filteredActivity", "recordPageControls", "renderActivity"]), context);
  context.renderActivity();
  assert.match(get("activityList").innerHTML, /2025/);
  assert.match(get("activityList").innerHTML, /&lt;img/);
  assert.equal(get("activityList").innerHTML.includes("<img "), false);
  assert.match(get("activitySummary").textContent, /Page 2: 1 matching event/);
  assert.equal(get("exportActivityButton").disabled, false);
  assert.equal(context.formatHistoryDate("not a date"), "");
});

test("printed QR destinations reject unsafe URLs and contain only the stable receiver ID", () => {
  const context = vm.createContext({ URL, PUBLIC_SERVICE_REQUEST_URL: "" });
  vm.runInContext(functions(["serviceRequestLink"]), context);
  for (const destination of ["javascript:alert(1)", "data:text/html,hello", "file:///tmp/test", "https://user:pass@example.invalid/", "bad URL"]) {
    context.PUBLIC_SERVICE_REQUEST_URL = destination;
    assert.equal(context.serviceRequestLink({ id: "receiver-01", assetNumber: "TEST-01" }), "");
  }
  context.PUBLIC_SERVICE_REQUEST_URL = "https://qr.example.invalid/?an=private#old";
  const link = new URL(context.serviceRequestLink({ id: "receiver-01", assetNumber: attack, serial: "000001" }));
  assert.deepEqual([...link.searchParams], [["id", "receiver-01"]]);
  assert.equal(link.hash, "");
  assert.equal(context.serviceRequestLink({ id: attack, assetNumber: "TEST-01" }), "");
  context.PUBLIC_SERVICE_REQUEST_URL = "http://localhost:5174/";
  assert.equal(new URL(context.serviceRequestLink({ id: "receiver-01", assetNumber: "TEST-01" })).protocol, "http:");
});
