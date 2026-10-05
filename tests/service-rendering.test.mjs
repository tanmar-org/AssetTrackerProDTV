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

// Execute the entire legacy script with a strict DOM boundary: any accidental
// HTML sink fails, while text nodes preserve exactly what an old label supplied.
async function legacy(parameters, coords = null) {
  const nodes = new Map();
  const node = (tag = "div") => ({
    tag, textContent: "", children: [], value: "", listeners: {},
    classList: { add() {}, remove() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(fragment) { this.children = fragment.children; },
    addEventListener(event, listener) { this.listeners[event] = listener; },
    set innerHTML(_value) { throw new Error("Untrusted URL values must never enter an HTML sink."); },
  });
  const get = (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  const location = { search: new URLSearchParams(parameters).toString(), href: "" };
  const context = vm.createContext({
    location, URLSearchParams, document: { getElementById: get, querySelector: get,
      createElement: node, createDocumentFragment: () => node("fragment") },
    navigator: { geolocation: coords ? { getCurrentPosition: (success) => success({ coords }) } : undefined },
  });
  vm.runInContext(await readFile(new URL("../public/asset-tracker/service-request.js", import.meta.url), "utf8"), context);
  return { context, nodes, location };
}

test("legacy URL details remain literal text, including malicious markup and leading zeros", async () => {
  const app = await legacy({ a: attack, m: attack, t: attack, s: "000001", r: "000002", c: "000003",
    rs: attack, an: "000004", ac: attack, al: attack, ao: attack });
  assert.equal(app.nodes.get("assetNumber").textContent, attack);
  const children = app.nodes.get("receiverDetails").children;
  assert.equal(children.length, 20);
  assert.deepEqual(children.map((child) => child.tag), Array.from({ length: 10 }, () => ["dt", "dd"]).flat());
  assert.equal(children[1].textContent, attack);
  assert.equal(children[5].textContent, "000001");
  assert.equal(app.context.injected, undefined);
  assert.equal(app.nodes.get("emailButton").disabled, true);
});

test("legacy valid GPS and error still create an encoded mail draft with receiver details", async () => {
  const app = await legacy({ a: "TEST-01&bcc=outside@example.invalid", s: "000001", an: "000004", ac: attack },
    { latitude: 31.9, longitude: -102.2, accuracy: 7 });
  app.nodes.get("errorCode").value = '771 &bcc=outside@example.invalid';
  app.nodes.get("errorCode").listeners.input();
  assert.equal(app.nodes.get("emailButton").disabled, false);
  app.context.createEmail();
  const draft = new URL(app.location.href);
  assert.equal(draft.protocol, "mailto:");
  assert.deepEqual([...draft.searchParams.keys()], ["subject", "body"]);
  assert.match(draft.searchParams.get("body"), /Serial Number: 000001/);
  assert.match(draft.searchParams.get("body"), /Current Account: 000004/);
  assert.ok(draft.searchParams.get("body").includes(attack));
  assert.match(draft.searchParams.get("body"), /https:\/\/maps.google.com\/\?q=31.9,-102.2/);
});

const unsafeMaps = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "//maps.google.com/?q=1,2",
  "http://maps.google.com/?q=1,2", "https://maps.google.com.evil.invalid/", "https://evil.invalid/maps",
  "https://maps.google.com@evil.invalid/", "https://user:password@maps.google.com/", "https://maps.google.com:444/",
  "https://www.google.com/search?q=maps", "not a URL", "", null, "https://maps.google.com/?q=" + "a".repeat(512)];

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
    formatUndoTime: (value) => value, allActivationRows: () => [{ request, receiver: { assetNumber: attack }, account: { name: attack } }] });
  vm.runInContext(functions(["esc", "highlightMatch", "safeMapsLink", "renderActivations", "openReceiverEvent"]), context);
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

test("printed QR destinations reject executable/credential URLs and encode label metadata", () => {
  const context = vm.createContext({ URL, PUBLIC_SERVICE_REQUEST_URL: "" });
  vm.runInContext(functions(["serviceRequestLink"]), context);
  for (const destination of ["javascript:alert(1)", "data:text/html,hello", "file:///tmp/test", "https://user:pass@example.invalid/", "bad URL"]) {
    context.PUBLIC_SERVICE_REQUEST_URL = destination;
    assert.equal(context.serviceRequestLink({ assetNumber: "TEST-01" }), "");
  }
  context.PUBLIC_SERVICE_REQUEST_URL = "https://qr.example.invalid/";
  const link = new URL(context.serviceRequestLink({ assetNumber: attack, serial: "000001" }));
  assert.equal(link.searchParams.get("a"), attack);
  assert.equal(link.searchParams.get("s"), "000001");
  context.PUBLIC_SERVICE_REQUEST_URL = "http://localhost:5174/";
  assert.equal(new URL(context.serviceRequestLink({ assetNumber: "TEST-01" })).protocol, "http:");
});
