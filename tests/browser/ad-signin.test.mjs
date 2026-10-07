import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startNext } from "../helpers/next-server.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const admin = { id: "synthetic-admin", name: "appadmin", role: "admin" };

// Exercise actual UI fields, submitted payloads and password clearing in Chromium.
// Synthetic same-origin APIs model AD mode; TLS/SQL auth is proved separately.
test("AD password UI preserves shared-device and app-role controls", { timeout: 90000 }, async t => {
  const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: "" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  const fixture = async scenario => {
    const context = await browser.newContext(); scenario.after(() => context.close());
    const model = { user: null, context: "1".repeat(64), login: [], writes: [], lookups: [], lookupReject: false, lookupWait: null, writeWait: null, reject: false, users: [{ ...admin, active: 1, ad_linked: true },
      { id: "unlinked", name: "existing.staff", role: "admin", active: 1, ad_linked: false }] }, errors = [];
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
      if (url.pathname === "/api/users/ad-lookup") {
        const body = request.postDataJSON(); model.lookups.push(body);
        if (model.lookupWait) await model.lookupWait;
        if (model.lookupReject) return route.fulfill({ status: 404, json: { error: "No eligible AD user was found." } });
        return route.fulfill({ json: { username: body.name, displayName: "Synthetic <b>Staff</b>", confirmation: "synthetic-reviewed-proof" } });
      }
      if (url.pathname === "/api/users") {
        if (request.method() !== "GET") {
          const body = request.postDataJSON(); model.writes.push(body);
          if (model.writeWait) await model.writeWait;
          const target = model.users.find(user => user.id === body.id);
          if (target && body.directoryConfirmation) target.ad_linked = true;
          if (target && body.role) target.role = body.role;
        }
        return route.fulfill({ json: { ok: true, authMode: "ad", users: model.users } });
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
    assert.equal(await page.locator("#createUserButton").isEnabled(), false);
    await page.locator("#newUserName").fill("another.staff-007");
    await page.locator("#findDirectoryUser").click();
    await page.waitForFunction(() => !document.getElementById("createUserButton").disabled);
    assert.match(await page.locator("#directoryUserPreview").textContent(), /Synthetic <b>Staff<\/b>/);
    assert.equal(await page.locator("#directoryUserPreview b").count(), 0);
    await page.locator("#newUserName").fill("different.staff");
    assert.equal(await page.locator("#createUserButton").isEnabled(), false);
    await page.locator("#findDirectoryUser").click();
    await page.waitForFunction(() => !document.getElementById("createUserButton").disabled);
    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/users" && response.request().method() === "POST");
    await page.locator('#userCreateForm button[type="submit"]').click(); await created;
    assert.ok(model.writes.some(body => body.name === "different.staff" && body.directoryConfirmation === "synthetic-reviewed-proof" && !("pin" in body) && !("password" in body)));
  });
  await t.test("row linking opens its own review, preserves Administrator and the add-user draft, and PATCHes only the existing ID", async scenario => {
    const { page, model, login } = await fixture(scenario);
    await login(); await page.waitForFunction(() => document.getElementById("authGate").hidden);
    await page.locator('[data-view="settings"]').click();
    await page.locator("#newUserName").fill("pending.new-user");
    // Unsaved row edits must not be presented as the existing server permission.
    await page.locator('[data-user-id="unlinked"] [data-user-role]').selectOption("user");
    await page.locator('[data-user-id="unlinked"] [data-link-user]').click();
    await page.waitForFunction(() => !document.getElementById("confirmDirectoryLink").disabled);
    assert.equal(await page.locator("#directoryLinkDialog").evaluate(el => el.open), true);
    assert.deepEqual(model.lookups[0], { name: "existing.staff", userId: "unlinked" });
    assert.equal(model.writes.length, 0);
    assert.match(await page.locator("#directoryLinkPermission").textContent(), /Administrator \(preserved\)/);
    assert.match(await page.locator("#directoryLinkPreview").textContent(), /Synthetic <b>Staff<\/b>/);
    assert.equal(await page.locator("#directoryLinkPreview b").count(), 0);
    assert.equal(await page.locator("#newUserName").inputValue(), "pending.new-user");
    assert.equal(await page.locator("#newUserRole").inputValue(), "user");
    assert.equal(await page.locator("#createUserButton").textContent(), "Add User");
    assert.equal(await page.locator("#createUserButton").isEnabled(), false);
    const linked = page.waitForResponse(response => new URL(response.url()).pathname === "/api/users" && response.request().method() === "PATCH");
    await page.locator("#confirmDirectoryLink").click(); await linked;
    await page.waitForFunction(() => !document.getElementById("directoryLinkDialog").open);
    assert.deepEqual(model.writes[0], { id: "unlinked", adUsername: "existing.staff", directoryConfirmation: "synthetic-reviewed-proof" });
    await page.waitForFunction(() => document.querySelector('[data-user-id="unlinked"] [data-link-user]') === null);
    assert.equal(await page.locator('[data-user-id="unlinked"] [data-user-role]').inputValue(), "admin");
    assert.equal(await page.locator("#newUserName").inputValue(), "pending.new-user");
    assert.equal(model.users.length, 2);
  });
  await t.test("dialog lookup failures/editing block confirmation and Escape/sign-out clear the independent proof", async scenario => {
    const { page, model, login } = await fixture(scenario);
    await login(); await page.waitForFunction(() => document.getElementById("authGate").hidden);
    await page.locator('[data-view="settings"]').click(); model.lookupReject = true;
    await page.locator('[data-user-id="unlinked"] [data-link-user]').click();
    await page.waitForFunction(() => document.getElementById("directoryLinkPreview").textContent.includes("No eligible"));
    assert.equal(await page.locator("#confirmDirectoryLink").isEnabled(), false);
    model.lookupReject = false;
    await page.locator("#directoryLinkName").fill("correct.staff");
    await page.locator("#findDirectoryLinkUser").click();
    await page.waitForFunction(() => !document.getElementById("confirmDirectoryLink").disabled);
    await page.locator("#directoryLinkName").fill("different.staff");
    assert.equal(await page.locator("#confirmDirectoryLink").isEnabled(), false);
    await page.locator("#findDirectoryLinkUser").click();
    await page.waitForFunction(() => !document.getElementById("confirmDirectoryLink").disabled);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#directoryLinkDialog").evaluate(el => el.open), false);
    assert.equal(await page.evaluate(() => directoryLinkConfirmation), null);
    assert.equal(await page.locator("#directoryLinkPermission").textContent(), "");
    assert.equal(model.writes.length, 0);
    await page.locator('[data-user-id="unlinked"] [data-link-user]').click();
    await page.waitForFunction(() => !document.getElementById("confirmDirectoryLink").disabled);
    await page.evaluate(() => lockSession());
    assert.equal(await page.locator("#directoryLinkDialog").evaluate(el => el.open), false);
    assert.equal(await page.locator("#directoryLinkPreview").textContent(), "");
    assert.equal(await page.locator("#directoryLinkName").inputValue(), "");
    assert.equal(await page.evaluate(() => directoryLinkConfirmation), null);
  });
  await t.test("canceled and overlapping dialog lookups cannot approve another user; modal fits a narrow screen", async scenario => {
    const { page, model, login } = await fixture(scenario);
    await login(); await page.waitForFunction(() => document.getElementById("authGate").hidden);
    await page.locator('[data-view="settings"]').click();
    let release; model.lookupWait = new Promise(resolve => { release = resolve; });
    await page.locator('[data-user-id="unlinked"] [data-link-user]').click();
    await page.waitForFunction(() => document.getElementById("findDirectoryLinkUser").disabled);
    await page.keyboard.press("Escape"); model.lookupWait = null;
    model.users.push({ id: "second-user", name: "other.staff", role: "user", active: 0, ad_linked: false });
    await page.evaluate(() => loadUsers());
    await page.locator('[data-user-id="second-user"] [data-link-user]').click();
    await page.waitForFunction(() => !document.getElementById("confirmDirectoryLink").disabled);
    release(); await page.waitForTimeout(100);
    assert.match(await page.locator("#directoryLinkPreview").textContent(), /other.staff/);
    assert.match(await page.locator("#directoryLinkPermission").textContent(), /Regular User/);
    assert.match(await page.locator("#directoryLinkAccess").textContent(), /Inactive/);
    assert.equal(await page.evaluate(() => directoryLinkTarget.id), "second-user");
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.locator("#directoryLinkDialog").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
    await page.locator("#directoryLinkName").focus();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.getElementById("directoryLinkDialog").contains(document.activeElement)), true);
    }
    const linked = page.waitForResponse(response => new URL(response.url()).pathname === "/api/users" && response.request().method() === "PATCH");
    await page.locator("#confirmDirectoryLink").click(); await linked;
    assert.equal(model.writes[0].id, "second-user"); assert.equal(model.writes[0].adUsername, "other.staff");
    assert.equal(model.users.find(user => user.id === "second-user").active, 0);
  });
  await t.test("a pending link cannot double-submit or close, but session lock scrubs it and discards its late response", async scenario => {
    const { page, model, login } = await fixture(scenario);
    await login(); await page.waitForFunction(() => document.getElementById("authGate").hidden);
    await page.locator('[data-view="settings"]').click();
    await page.locator('[data-user-id="unlinked"] [data-link-user]').click();
    await page.waitForFunction(() => !document.getElementById("confirmDirectoryLink").disabled);
    let release; model.writeWait = new Promise(resolve => { release = resolve; });
    await page.locator("#confirmDirectoryLink").click();
    await page.waitForFunction(() => document.getElementById("directoryLinkName").disabled);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#directoryLinkDialog").evaluate(el => el.open), true);
    assert.equal(await page.locator("#confirmDirectoryLink").isEnabled(), false);
    assert.equal(model.writes.length, 1);
    await page.evaluate(() => lockSession()); release(); await page.waitForTimeout(100);
    assert.equal(await page.locator("#directoryLinkDialog").evaluate(el => el.open), false);
    assert.equal(await page.locator("#directoryLinkPreview").textContent(), "");
    assert.equal(await page.evaluate(() => directoryLinkTarget), null);
    assert.equal(await page.locator("#authGate").isVisible(), true);
  });
  await t.test("late lookup cannot approve an edited selector and AD controls fit narrow screens", async scenario => {
    const { page, model, login } = await fixture(scenario);
    await login(); await page.waitForFunction(() => document.getElementById("authGate").hidden);
    await page.locator('[data-view="settings"]').click();
    let release; model.lookupWait = new Promise(resolve => { release = resolve; });
    await page.locator("#newUserName").fill("old.staff"); await page.locator("#findDirectoryUser").click();
    await page.waitForFunction(() => document.getElementById("findDirectoryUser").disabled);
    await page.locator("#newUserName").fill("new.staff"); release();
    await page.waitForFunction(() => !document.getElementById("findDirectoryUser").disabled);
    assert.equal(await page.locator("#createUserButton").isEnabled(), false);
    assert.equal(await page.evaluate(() => directoryUserConfirmation), null);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.locator("#userCreateForm").evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
  });

});
