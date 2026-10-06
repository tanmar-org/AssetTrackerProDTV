import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startNext } from "../helpers/next-server.mjs";
import { inventory } from "../helpers/inventory-fixture.mjs";

// Optional real-browser check. Supply the user-local Playwright module through
// PLAYWRIGHT_MODULE (or install it separately). Do not add a browser to runtime.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const attack = '\"><img data-injection src=x onerror="window.injected=true"><svg data-injection onload="window.injected=true">';
const coordinates = { latitude: 31.9, longitude: -102.2, accuracy: 7 };

// Authentication/API fixtures isolate rendering only. These are not substitutes
// for the real PostgreSQL permission tests. All requests stay on the test servers;
// no external CDN, email client, production API, or GPS device is involved.
test("public and staff pages safely render malicious label/cache/API values in Chromium", { timeout: 60000 }, async (t) => {
  const tracker = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: "" });
  t.after(tracker.close);
  const qr = await startNext(fileURLToPath(new URL("../../service-request/", import.meta.url)), { DATABASE_URL: "" });
  t.after(qr.close);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ geolocation: coordinates, permissions: ["geolocation"] });
  t.after(() => context.close());
  const origins = [tracker.url, qr.url];
  let remoteRequest = { id: attack, assetNumber: attack, action: "Reactivate / Refresh", status: "Pending",
    requestedAt: "2026-10-05T18:00:00Z", requesterName: attack, notes: attack, mapUrl: "javascript:window.injected=true" };
  let savedRequest;
  let currentState = inventory();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!origins.includes(url.origin)) return route.abort();
    if (url.pathname === "/asset-tracker/config.js") return route.fulfill({ contentType: "application/javascript",
      body: `window.TANMAR_CONFIG = { serviceRequestUrl: ${JSON.stringify(qr.url)} };` });
    if (url.pathname === "/api/asset") return route.fulfill({ json: { id: "receiver-01", assetNumber: attack } });
    if (url.pathname === "/api/auth") return route.fulfill({ json: { user: { id: "test-admin", name: "testadmin", role: "admin" }, sessionContext: "1".repeat(64) } });
    if (url.pathname === "/api/app-state") return route.fulfill({ json: { state: currentState, revision: 1 } });
    if (url.pathname === "/api/service-requests") return route.fulfill({ json: { requests: [remoteRequest] } });
    if (url.pathname === "/api/requests") {
      if (route.request().method() !== "POST") return route.fulfill({ status: 401, json: {} });
      savedRequest = route.request().postDataJSON();
      return route.fulfill({ json: { success: true } });
    }
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { users: [], activity: [], snapshots: [] } });
    return route.continue();
  });
  await context.addInitScript(() => { window.injected = false; });
  async function assertSafe(page) {
    assert.equal(await page.locator("[data-injection]").count(), 0, "Untrusted values must not create elements.");
    assert.equal(await page.evaluate(() => window.injected), false, "Untrusted handlers must not execute.");
    assert.equal(await page.locator('[href^="javascript:"], [href^="data:"]').count(), 0);
  }

  await t.test("legacy labels redirect to the verified form without private metadata", async () => {
    const page = await context.newPage();
    try {
      const query = new URLSearchParams({ a: "TEST-01", m: attack, s: "000001", an: "000004", ac: attack, al: attack });
      await page.goto(`${tracker.url}/asset-tracker/service-request.html?${query}`);
      await page.waitForURL(`${qr.url}/?id=receiver-01`);
      assert.equal(await page.locator(".receiver-summary strong").textContent(), attack);
      assert.deepEqual([...new URL(page.url()).searchParams], [["id", "receiver-01"]]);
      assert.equal(await page.locator("#receiverDetails").count(), 0);
      assert.equal(await page.locator("button.primary").isEnabled(), false);
      assert.equal(await page.locator('meta[name="referrer"]').getAttribute("content"), "no-referrer");
      await assertSafe(page);
    } finally { await page.close(); }
  });

  await t.test("React QR label values and submitted text remain safe", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${qr.url}/?${new URLSearchParams({ a: attack, s: "000001", ac: attack })}`);
      await page.waitForFunction((value) => document.querySelector(".receiver-summary strong").textContent === value, attack);
      assert.equal(await page.locator(".receiver-summary strong").textContent(), attack);
      for (const id of ["requesterName", "requesterPhone", "operatorName", "rigFrac", "lease", "errorCode"])
        await page.locator(`#${id}`).fill(id === "requesterPhone" ? "555-0100" : attack.slice(0, 70));
      await page.locator("button.secondary").click();
      await page.waitForFunction(() => document.querySelector(".location-panel").classList.contains("ready"));
      // Public submissions use only the stable ID and requester claims. No email
      // navigation or private receiver/account metadata is available in the page.
      await page.locator("button.primary").click();
      await page.waitForFunction(() => document.querySelector("button.primary").textContent.includes("Submitted"));
      assert.equal(savedRequest.assetId, "receiver-01");
      for (const key of ["assetNumber", "serialNumber", "rid", "accessCard", "accountNumber", "accountName"])
        assert.equal(Object.hasOwn(savedRequest, key), false);
      assert.deepEqual([...new URL(page.url()).searchParams], [["id", "receiver-01"]]);
      assert.match(await page.locator(".privacy-note").textContent(), /staff review/);
      await assertSafe(page);
    } finally { await page.close(); }
  });

  await t.test("GPS denial explains staff fallback and cannot submit an empty location", async () => {
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        navigator.geolocation.getCurrentPosition = (_success, failure) => failure({ code: 1 });
      });
      await page.goto(`${qr.url}/?id=receiver-01`);
      await page.waitForFunction(() => document.querySelector(".receiver-summary strong").textContent !== "—");
      await page.locator("button.secondary").click();
      await page.waitForFunction(() => document.querySelector(".location-panel").classList.contains("error"));
      assert.match(await page.locator(".location-panel").textContent(), /contact TanMar/);
      assert.equal(await page.locator("button.primary").isEnabled(), false);
      await assertSafe(page);
    } finally { await page.close(); }
  });

  await t.test("staff API IDs, history, and audit counts cannot create markup", async () => {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = inventory();
    state.master = [{ ...state.master[0], id: attack, assetNumber: attack, model: attack, notes: attack }];
    state.accounts = [{ ...state.accounts[0], id: attack, name: attack }, { ...state.accounts[1], id: attack + "other", name: attack }];
    state.assignments = [{ id: "assignment", assetId: attack, accountId: attack, assignedAt: "2026-10-05T18:00:00Z" }];
    state.receiverEvents = [{ id: "event", receiverId: attack, title: attack, kind: attack, date: "2026-10-05T18:00:00Z",
      notes: attack, mapUrl: "data:text/html,hello" }];
    state.auditState = { fileName: "synthetic.csv", importedAt: "2026-10-05T18:00:00Z", results: [{ accountNumber: "000001",
      accountName: attack, appCount: attack, auditCount: attack, matchedCount: attack, perfect: false, countMatch: false,
      missingFromAudit: [], missingFromApp: [] }] };
    currentState = state;
    try {
      await page.goto(`${tracker.url}/asset-tracker/index.html`);
      await page.waitForFunction(() => document.getElementById("authGate").hidden);
      await page.evaluate((id) => {
        expandedAccountIds.add(id); renderAccounts(); renderMaster(); renderLabels(); renderAuditResults();
        openMove(id); openReceiverInfo(id); openReceiverEvent("event");
      }, attack);
      assert.equal(await page.locator("[data-edit-master]").getAttribute("data-edit-master"), attack);
      assert.equal(await page.locator("[data-inline-move]").getAttribute("data-account-id"), attack);
      assert.equal(await page.locator("[data-label-id]").getAttribute("data-label-id"), attack);
      assert.equal(await page.locator("#moveAccountSelect option").getAttribute("value"), attack + "other");
      assert.equal(await page.locator(".audit-count-box strong").first().textContent(), attack);
      assert.equal(await page.locator("#receiverEventBody a").count(), 0);
      await assertSafe(page);
      assert.deepEqual(errors, []);
    } finally { currentState = inventory(); await page.close(); }
  });

  await t.test("staff service links reject unsafe destinations and retain valid Maps links", async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${tracker.url}/asset-tracker/index.html`);
      await page.waitForFunction(() => document.getElementById("authGate").hidden);
      for (const mapUrl of ["javascript:window.injected=true", "https://maps.google.com.evil.invalid/", "https://user:pass@maps.google.com/"]) {
        remoteRequest = { ...remoteRequest, mapUrl, status: attack };
        await page.evaluate(() => loadRemoteActivations());
        assert.equal(await page.locator("#activationRows a").count(), 0);
        await assertSafe(page);
      }
      remoteRequest = { ...remoteRequest, mapUrl: "https://maps.google.com/?q=31.9,-102.2", status: "Pending" };
      await page.evaluate(() => loadRemoteActivations());
      assert.equal(await page.locator("#activationRows a").getAttribute("href"), remoteRequest.mapUrl);
      assert.equal(await page.locator("[data-activation-complete]").getAttribute("data-activation-complete"), attack);
      await assertSafe(page);
    } finally { await page.close(); }
  });
});
