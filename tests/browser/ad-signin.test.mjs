import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startNext } from "../helpers/next-server.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const admin = { id: "synthetic-admin", name: "appadmin", role: "admin" };

// Exercise actual UI fields, submitted payloads and password clearing in Chromium.
// Synthetic same-origin APIs model AD mode; TLS/SQL auth is proved separately.
test("AD password UI preserves shared-device and app-role controls", { timeout: 45000 }, async t => {
  const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: "" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const fixture = async scenario => {
    const context = await browser.newContext(); scenario.after(() => context.close());
    const model = { user: null, context: "1".repeat(64), login: [], writes: [], reject: false }, errors = [];
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url()); assert.equal(url.origin, server.url);
      if (url.pathname === "/api/auth") {
        if (request.method() === "POST") {
          model.login.push(request.postDataJSON());
          if (model.reject) return route.fulfill({ status: 503, json: { error: "Directory sign-in unavailable." } });
          model.user = admin;
        }
        if (request.method() === "DELETE") { model.user = null; return route.fulfill({ json: { ok: true } }); }
        return route.fulfill({ json: { authMode: "ad", needsProvisioning: false, user: model.user, sessionContext: model.user ? model.context : null } });
      }
      if (url.pathname === "/api/users") {
        if (request.method() !== "GET") model.writes.push(request.postDataJSON());
        return route.fulfill({ json: { ok: true, authMode: "ad", users: [{ ...admin, active: 1, ad_linked: true },
          { id: "unlinked", name: "newstaff", role: "user", active: 1, ad_linked: false }] } });
      }
      if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { state: null, revision: 0, requests: [], activity: [], snapshots: [], drafts: [], operations: [] } });
      return route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    scenario.after(() => assert.deepEqual(errors, []));
    await page.goto(`${server.url}/asset-tracker/index.html`);
    await page.waitForFunction(() => document.getElementById("authCredentialLabel").textContent === "AD Password");
    const login = async () => { await page.locator("#authName").fill("j.doe-007");
      await page.locator("#authPin").fill("  Synthetic AD password 007!  "); await page.locator("#authSubmit").click(); };
    return { page, model, login };
  };
  await t.test("AD sign-in accepts dotted usernames/passwords, omits PINs and clears credentials", async scenario => {
    const { page, model, login } = await fixture(scenario);
    assert.equal(await page.locator("#authPin").getAttribute("pattern"), null);
    assert.match(await page.locator("#authDescription").textContent(), /AD username and password/);
    await login(); await page.waitForFunction(() => document.getElementById("authGate").hidden);
    assert.deepEqual(model.login[0], { action: "login", name: "j.doe-007", password: "  Synthetic AD password 007!  " });
    assert.equal(await page.locator("#authPin").inputValue(), "");
    const saved = await page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)]
      .map(key => localStorage.getItem(key) || sessionStorage.getItem(key)).join("\n"));
    assert.ok(!saved.includes("Synthetic AD password"));
  });
  await t.test("directory failure keeps the workspace locked and clears the attempted password", async scenario => {
    const { page, model, login } = await fixture(scenario); model.reject = true;
    await login(); await page.waitForFunction(() => !document.getElementById("authError").hidden);
    assert.match(await page.locator("#authError").textContent(), /Directory sign-in unavailable/);
    assert.equal(await page.locator("#authPin").inputValue(), "");
    assert.equal(await page.locator(".app-shell").evaluate(element => element.inert), true);
  });
  await t.test("AD account management shows link status and submits app permissions without credential changes", async scenario => {
    const { page, model, login } = await fixture(scenario);
    await login(); await page.waitForFunction(() => document.getElementById("authGate").hidden);
    await page.locator('[data-view="settings"]').click();
    await page.waitForFunction(() => document.querySelectorAll("[data-user-id]").length === 2);
    assert.equal(await page.locator("#newUserPin").isEnabled(), false);
    assert.equal(await page.locator("[data-user-pin]").count(), 0);
    assert.equal(await page.locator("[data-unlock-user]").count(), 0);
    assert.match(await page.locator("#userList").textContent(), /AD account linking required/);
    await page.locator('[data-user-id="unlinked"] [data-user-role]').selectOption("admin");
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/users" && response.request().method() === "PATCH");
    await page.locator('[data-user-id="unlinked"] [data-save-user]').click();
    await saved;
    assert.equal(model.writes[0].role, "admin"); assert.ok(!("pin" in model.writes[0]) && !("password" in model.writes[0]));
    await page.locator("#newUserName").fill("anotherstaff");
    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/users" && response.request().method() === "POST");
    await page.locator('#userCreateForm button[type="submit"]').click(); await created;
    assert.ok(model.writes.some(body => body.name === "anotherstaff" && !("pin" in body) && !("password" in body)));
  });
});
