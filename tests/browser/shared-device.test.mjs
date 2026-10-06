import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startNext } from "../helpers/next-server.mjs";
import { inventory } from "../helpers/inventory-fixture.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const admin = { id: "admin-0", name: "testadmin", role: "admin" };
const staff = { id: "staff-0", name: "teststaff", role: "user" };
const legacySecret = "LEGACY-PRIVATE-RECORD";

// Real Chromium UI/storage/BroadcastChannel behavior; only synthetic HTTP APIs
// are mocked. Cookie authorization and locking are covered by PostgreSQL tests.
test("shared-device browser isolation and recoverable sign-out", { timeout: 90000 }, async (t) => {
  const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: "" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); });
  async function fixture(scenario, options = {}) {
    const context = await browser.newContext(); scenario.after(() => context.close());
    const model = { user: options.signedOut ? null : admin, context: "1".repeat(64), serial: 1,
      state: inventory(), revision: 1, unavailable: false, logoutFails: false, requests: [], delayedRead: null, delayedWrite: null };
    const failures = [];
    await context.route("**/*", async (route) => {
      const request = route.request(), url = new URL(request.url());
      assert.equal(url.origin, server.url, "No outside services are allowed.");
      if (url.pathname === "/api/auth") {
        if (request.method() === "DELETE") {
          if (model.logoutFails) return route.fulfill({ status: 503, json: { error: "Synthetic outage" } });
          if (request.headers()["x-tracker-session-context"] === model.context) model.user = null;
          return route.fulfill({ json: { ok: true } });
        }
        if (request.method() === "POST") {
          model.user = request.postDataJSON().name === staff.name ? staff : admin;
          model.context = (++model.serial).toString(16).padStart(64, "0");
        }
        const profile = { user: model.user, sessionContext: model.user ? model.context : null, needsProvisioning: false };
        // Model a shared cookie changing just after this login's response. The
        // recovered draft must verify that cookie before showing private work.
        if (request.method() === "POST" && model.loginRace) {
          model.loginRace = false; model.user = staff; model.context = "a".repeat(64);
        }
        if(request.method()==="POST"&&model.loginGate)await model.loginGate;
        return route.fulfill({ json: profile });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!model.user || request.headers()["x-tracker-session-context"] !== model.context)
          return route.fulfill({ status: 401, json: { error: "Session changed" } });
        if (url.pathname === "/api/app-state") {
          if (request.method() !== "GET") {
            model.requests.push({ body: request.postDataJSON(), context: request.headers()["x-tracker-session-context"] });
            if (model.delayedWrite) {
              const delayed = model.delayedWrite; model.delayedWrite = null;
              delayed.started(); await delayed.gate;
              return route.fulfill({ json: { revision: 9, updatedAt: new Date().toISOString() } }).catch(() => {});
            }
            return route.fulfill({ status: 409, json: { error: "Synthetic revision conflict" } });
          }
          if (model.delayedRead) {
            const delayed = model.delayedRead; model.delayedRead = null;
            delayed.started(); await delayed.gate;
            return route.fulfill({ json: { state: delayed.state, revision: 9 } }).catch(() => {});
          }
          return route.fulfill(model.unavailable ? { status: 503, json: { error: "Synthetic outage" } } : { json: { state: model.state, revision: model.revision } });
        }
        return route.fulfill({ json: { requests: [], users: [], activity: [], snapshots: [] } });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", (error) => failures.push(error.message));
    if (options.legacy) await page.addInitScript(({ secret }) => {
      if (!localStorage.getItem("unrelated")) {
        localStorage.setItem("atp.master.v5", JSON.stringify([{ id: "old", assetNumber: secret }]));
        localStorage.setItem("atp.accounts.v5", "old unsaved accounts");
        localStorage.setItem("tanmar.directv-recipient.v1", "private@example.invalid");
        localStorage.setItem("unrelated", "keep");
      }
    }, { secret: legacySecret });
    if (options.blockStorage) await page.addInitScript(() => {
      Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Blocked", "SecurityError"); } });
    });
    await page.goto(`${server.url}/asset-tracker/index.html`);
    const ready = () => page.waitForFunction(() => document.getElementById("authGate").hidden);
    const locked = () => page.waitForFunction(() => !document.getElementById("authGate").hidden && document.querySelector(".app-shell").inert);
    const login = async (account = admin) => {
      await page.locator("#authName").fill(account.name); await page.locator("#authPin").fill("482631");
      await page.locator("#authSubmit").click();
    };
    const signout = async () => { await page.locator("#profileButton").click(); await page.locator("#signOutButton").click(); await locked(); };
    scenario.after(() => assert.deepEqual(failures, []));
    return { page, context, model, ready, locked, login, signout };
  }

  await t.test("legacy data is quarantined before login and never seeds an empty server", async (scenario) => {
    const { page, model, login, ready } = await fixture(scenario, { signedOut: true, legacy: true });
    assert.equal((await page.content()).includes(legacySecret), false);
    assert.equal(await page.evaluate(() => master.length), 0);
    model.state = null; model.revision = 0;
    await login(); await ready();
    assert.equal(await page.evaluate(() => master.length), 0);
    assert.equal((await page.content()).includes(legacySecret), false);
    assert.deepEqual(model.requests, []);
    assert.ok((await page.evaluate(() => localStorage.getItem("atp.master.v5"))).includes(legacySecret));
    await page.evaluate(() => showView("settings"));
    const downloaded = page.waitForEvent("download");
    await page.locator("#exportLegacyBrowserButton").click();
    const download = await downloaded;
    const exported = JSON.parse(await readFile(await download.path(), "utf8"));
    assert.ok(exported.entries["atp.master.v5"].includes(legacySecret));
    page.once("dialog", (dialog) => dialog.accept()); await page.locator("#clearLegacyBrowserButton").click();
    assert.equal(await page.evaluate(() => localStorage.getItem("atp.master.v5")), null);
    assert.equal(await page.evaluate(() => localStorage.getItem("unrelated")), "keep");
  });

  await t.test("failed logout scrubs private DOM and stays locked across reload until acknowledged", async (scenario) => {
    const f = await fixture(scenario, { legacy: true }); await f.ready();
    await f.page.evaluate(() => { openAccountForm(accounts[0]); $("accountNameInput").value = "PRIVATE-FORM"; $("directvRecipientEmail").value = "PRIVATE-MAIL"; });
    // Close the dialog through its normal handler, leaving hidden form values.
    await f.page.evaluate(() => closeModal("accountModal"));
    f.model.logoutFails = true;
    f.page.once("dialog", (dialog) => dialog.accept()); await f.signout();
    await f.page.waitForFunction(() => document.getElementById("authError").textContent.includes("Unable to confirm"));
    const privateState = await f.page.evaluate(() => ({ records: master.length + accounts.length + undoHistory.length,
      text: document.body.textContent, values: [...document.querySelectorAll("input,textarea")].map((node) => node.value).join(" "),
      cache: Object.keys(localStorage).filter((key) => key.startsWith("atp.") || key === "tanmar.directv-recipient.v1") }));
    assert.equal(privateState.records, 0); assert.deepEqual(privateState.cache, []);
    for (const value of ["Synthetic Account", "TEST-0", "PRIVATE-FORM", "PRIVATE-MAIL", legacySecret])
      assert.equal(`${privateState.text} ${privateState.values}`.includes(value), false, value);
    assert.equal(await f.page.evaluate(() => localStorage.getItem("unrelated")), "keep");
    await f.page.reload(); await f.locked();
    assert.equal(await f.page.locator("#authForm").isVisible(), false);
    assert.equal(await f.page.locator("#authTitle").textContent(), "Sign Out Not Confirmed");
    f.model.logoutFails = false; await f.page.locator("#retryAccessButton").click();
    await f.page.waitForFunction(() => document.getElementById("authTitle").textContent === "Employee Sign In");
    await f.page.reload(); await f.locked(); assert.equal(await f.page.evaluate(() => master.length), 0);
  });

  await t.test("storage-denied devices keep failed logout locked using the tab marker", async (scenario) => {
    const f = await fixture(scenario, { blockStorage: true }); await f.ready(); f.model.logoutFails = true;
    await f.page.evaluate(() => { accounts[0].name = "SYNTHETIC-STORAGE-DENIED"; save("Edit account"); });
    await f.page.waitForFunction(() => cloudWriteBlocked);
    assert.equal(f.model.requests[0].body.state.accounts[0].name, "SYNTHETIC-STORAGE-DENIED", "Storage failure must not prevent a server save attempt.");
    f.page.once("dialog", (dialog) => dialog.accept());
    await f.signout(); await f.page.reload(); await f.locked();
    assert.equal(await f.page.locator("#authTitle").textContent(), "Sign Out Not Confirmed");
    f.model.logoutFails = false; await f.page.locator("#retryAccessButton").click();
    await f.page.waitForFunction(() => document.getElementById("authError").textContent.includes("could not be erased"));
    await f.page.reload(); await f.locked();
    assert.ok((await f.page.locator("#authError").textContent()).includes("could not be erased"));
  });

  await t.test("user switches lock other tabs; only the original employee can recover a paused draft", async (scenario) => {
    const f = await fixture(scenario); await f.ready();
    await f.page.evaluate(() => { accounts[0].name = "PRIVATE-UNSAVED"; save("Edit account"); renderAccounts(); });
    await f.page.waitForFunction(() => cloudWriteBlocked);
    assert.equal(await f.page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith("atp."))), false);
    const second = await f.context.newPage(); await second.goto(`${server.url}/asset-tracker/index.html`);
    await second.waitForFunction(() => document.getElementById("authGate").hidden);
    await second.evaluate(() => lockSession(true));
    await second.locator("#authName").fill(staff.name); await second.locator("#authPin").fill("593742"); await second.locator("#authSubmit").click();
    await second.waitForFunction(() => document.getElementById("authGate").hidden); await f.locked();
    assert.equal((await f.page.content()).includes("PRIVATE-UNSAVED"), false);
    f.page.once("dialog", (dialog) => dialog.dismiss()); await f.login(staff);
    await f.page.waitForFunction(() => document.getElementById("authError").textContent.includes("owns the unsaved edits"));
    assert.equal(await f.page.evaluate(() => currentUser), null);
    const count = f.model.requests.length;
    await f.login(admin); await f.ready();
    assert.equal(await f.page.evaluate(() => accounts[0].name), "PRIVATE-UNSAVED");
    assert.equal(await f.page.evaluate(() => cloudWriteBlocked), true);
    assert.equal(f.model.requests.length, count, "Reauthentication must never replay the old draft.");
    await f.page.evaluate(() => showView("settings"));
    const downloading = f.page.waitForEvent("download"); await f.page.locator("#downloadBackupButton").click();
    const exported = JSON.parse(await readFile(await (await downloading).path(), "utf8"));
    assert.equal(exported.data.accounts[0].name, "PRIVATE-UNSAVED");
  });

  await t.test("late inventory reads cannot restore a signed-out display or overwrite a newer edit", async (scenario) => {
    const f = await fixture(scenario); await f.ready();
    let release, started;
    const gate = new Promise((resolve) => { release = resolve; });
    const receiving = new Promise((resolve) => { started = resolve; });
    const state = inventory(); state.accounts[0].name = "PRIVATE-LATE-READ";
    f.model.delayedRead = { gate, started, state };
    await f.page.evaluate(() => { window.readCompletion = readCloudState().catch(() => {}); });
    await receiving;
    await f.signout(); release();
    await f.page.evaluate(() => window.readCompletion);
    assert.equal((await f.page.content()).includes("PRIVATE-LATE-READ"), false);
    await f.login(); await f.ready();
    let releaseNext, startedNext;
    const next = new Promise((resolve) => { startedNext = resolve; });
    f.model.delayedRead = { gate: new Promise((resolve) => { releaseNext = resolve; }), started: startedNext, state };
    await f.page.evaluate(() => { window.readCompletion = readCloudState().catch(() => {}); }); await next;
    await f.page.evaluate(() => { accounts[0].name = "NEWER-EDIT"; save("Edit account"); });
    releaseNext(); await f.page.evaluate(() => window.readCompletion);
    assert.equal(await f.page.evaluate(() => accounts[0].name), "NEWER-EDIT");
  });

  await t.test("initial server failure and restored-page session expiry keep the workspace closed", async (scenario) => {
    const f = await fixture(scenario, { signedOut: true }); f.model.unavailable = true;
    await f.login(); await f.locked();
    await f.page.waitForFunction(() => document.getElementById("authDescription").textContent.includes("Unable to load shared inventory"));
    assert.equal(await f.page.evaluate(() => master.length), 0);
    f.model.unavailable = false; await f.page.locator("#retryAccessButton").click(); await f.ready();
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    assert.equal((await f.page.content()).includes("Synthetic Account"), false);
    f.model.user = null;
    await f.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await f.locked(); assert.equal(await f.page.evaluate(() => master.length), 0);
  });

  await t.test("late import and acknowledged save cannot modify the next employee's workspace", async (scenario) => {
    const f = await fixture(scenario); await f.ready();
    await f.page.evaluate(() => {
      currentAccountId = "account-0";
      window.importCompletion = prepareAccountImport({ name: "synthetic.csv", size: 80,
        text: () => new Promise((resolve) => { window.finishImport = resolve; }) });
    });
    let release, started;
    const receiving = new Promise((resolve) => { started = resolve; });
    f.model.delayedWrite = { started, gate: new Promise((resolve) => { release = resolve; }) };
    await f.page.evaluate(() => { accounts[0].name = "PRIVATE-SUBMITTED"; save("Edit account"); });
    await receiving;
    f.page.once("dialog", (dialog) => dialog.accept()); await f.signout();
    await f.login(staff); await f.ready();
    release();
    await f.page.evaluate(async () => {
      window.finishImport("Asset Number,Access Card,RID\r\nPRIVATE-IMPORT,000001,000002\r\n");
      await window.importCompletion;
    });
    assert.equal(await f.page.evaluate(() => pendingAccountImport), null);
    assert.equal(await f.page.evaluate(() => cloudRevision), 1);
    assert.equal(await f.page.evaluate(() => currentUser.id), staff.id);
    assert.equal((await f.page.content()).includes("PRIVATE-IMPORT"), false);
    assert.equal((await f.page.content()).includes("PRIVATE-SUBMITTED"), false);
  });

  await t.test("a paused draft still verifies its session and clears the display on expiry", async (scenario) => {
    const f = await fixture(scenario); await f.ready();
    await f.page.evaluate(() => { accounts[0].name = "PRIVATE-PAUSED"; save("Edit account"); renderAccounts(); });
    await f.page.waitForFunction(() => cloudWriteBlocked);
    f.model.user = null;
    await f.page.evaluate(() => window.dispatchEvent(new Event("focus"))); await f.locked();
    assert.equal((await f.page.content()).includes("PRIVATE-PAUSED"), false);
    assert.equal(await f.page.evaluate(() => accounts.length + master.length), 0);
    assert.equal(await f.page.evaluate(() => lockedDraft.ownerId), admin.id);
  });

  await t.test("draft recovery verifies the actual cookie if another login overtakes its response", async (scenario) => {
    const f = await fixture(scenario); await f.ready();
    await f.page.evaluate(() => { accounts[0].name = "PRIVATE-RECOVERY-RACE"; save("Edit account"); renderAccounts(); });
    await f.page.waitForFunction(() => cloudWriteBlocked);
    f.model.user = null; await f.page.evaluate(() => window.dispatchEvent(new Event("focus"))); await f.locked();
    // The previous lock leaves this error text in the DOM while login hides it.
    // Hold the response to prove that text alone can match before login finishes.
    let release;
    f.model.loginGate=new Promise(resolve=>{release=resolve;});
    f.model.loginRace = true; await f.login();
    try{
      assert.equal(await f.page.evaluate(()=>document.getElementById("authError").hidden&&
        document.getElementById("authSubmit").disabled&&document.getElementById("authError").textContent.includes("session changed or expired")),true);
    }finally{release();}
    await f.page.waitForFunction(() => !document.getElementById("authError").hidden&&
      !document.getElementById("authSubmit").disabled&&document.getElementById("authError").textContent.includes("session changed or expired"));
    assert.equal(await f.page.evaluate(() => currentUser), null);
    assert.equal((await f.page.content()).includes("PRIVATE-RECOVERY-RACE"), false);
    assert.equal(await f.page.evaluate(() => lockedDraft.ownerId), admin.id);
  });
});
