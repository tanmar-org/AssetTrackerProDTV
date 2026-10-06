import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { inventory } from "../helpers/inventory-fixture.mjs";
import { startNext } from "../helpers/next-server.mjs";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const library = vm.createContext({});
vm.runInContext(await readFile(new URL("../../public/asset-tracker/vendor/xlsx-0.20.3.full.min.js", import.meta.url), "utf8"), library);
const XLSX = library.XLSX;
function book(rows, name = "Master") {
  const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name); return workbook;
}
function bytes(workbook, bookType = "xlsx") { return Buffer.from(new Uint8Array(XLSX.write(workbook, { type: "array", bookType, compression: true }))); }

// Use the real browser worker and actual file-input/previews; mock only staff
// session/state APIs with synthetic data. All external network requests fail.
test("local spreadsheet assets and worker support staff imports with outside network blocked", { timeout: 60000 }, async (t) => {
  const server = await startNext(fileURLToPath(new URL("../../", import.meta.url)), { DATABASE_URL: "" });
  t.after(server.close);
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const context = await browser.newContext(); t.after(() => context.close());
  const outside = [], failures = [];
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== server.url) { outside.push(url.origin); return route.abort(); }
    if (url.pathname === "/api/auth") return route.fulfill({ json: { user: { id: "test-admin", name: "testadmin", role: "admin" }, sessionContext: "1".repeat(64) } });
    if (url.pathname === "/api/app-state") return route.fulfill({ json: { state: inventory(), revision: 1 } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: { requests: [], users: [], activity: [], snapshots: [] } });
    return route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => failures.push(error.message));
  await page.goto(`${server.url}/asset-tracker/index.html`);
  await page.waitForFunction(() => document.getElementById("authGate").hidden);
  assert.equal(await page.evaluate(() => XLSX.version), "0.20.3");

  await t.test("real browser worker reads XLSX and XLS without a CDN", async () => {
    const workbook = book([["Asset Number", "RID"], ["TEST-1", "000001"]]);
    for (const format of ["xlsx", "biff8"]) {
      const values = await page.evaluate(async ({ input, extension }) => {
        const parsed = await readExcelBook(new File([new Uint8Array(input)], `synthetic.${extension}`));
        return XLSX.utils.sheet_to_json(parsed.Sheets.Master, { raw: false });
      }, { input: [...bytes(workbook, format)], extension: format === "xlsx" ? "xlsx" : "xls" });
      assert.equal(values[0].RID, "000001");
    }
  });

  await t.test("Master input creates a preview with leading-zero values", async () => {
    await page.locator("#masterXlsxInput").setInputFiles({ name: "synthetic.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: bytes(book([["Asset Number", "Access Card", "Receiver ID"], ["TEST-NEW", "000001", "000002"]])) });
    await page.waitForFunction(() => document.getElementById("dataImportType").textContent === "Master Registry XLSX");
    const record = await page.evaluate(() => pendingDataImport.data[0]);
    assert.equal(record.accessCard, "000001"); assert.equal(record.rid, "000002");
    assert.equal(await page.locator("#applyDataImport").isEnabled(), true);
  });

  await t.test("West Texas input still reads A:N and grouped account data", async () => {
    const row = Array(14).fill(""); row[1] = "TEST-NEW"; row[2] = "000001"; row[4] = "000002"; row[7] = "000004"; row[8] = "Synthetic Account";
    await page.locator("#wtxXlsxInput").setInputFiles({ name: "synthetic.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: bytes(book([Array(14).fill("Heading"), row], "West Texas")) });
    await page.waitForFunction(() => document.getElementById("dataImportType").textContent === "West Texas XLSX");
    const record = await page.evaluate(() => pendingDataImport.data[0]);
    assert.equal(record.accountNumber, "000004"); assert.equal(record.accessCard, "000001");
  });

  await t.test("account Excel and audit CSV inputs use the actual import previews", async () => {
    await page.evaluate(() => { currentAccountId = "account-0"; openAccountImportModal(); });
    await page.locator("#accountImportFileInput").setInputFiles({ name: "synthetic.xls", mimeType: "application/vnd.ms-excel",
      buffer: bytes(book([["Asset Number", "Access Card", "RID"], ["TEST-NEW", "000001", "000002"]]), "biff8") });
    await page.waitForFunction(() => !document.getElementById("accountImportPreview").hidden);
    assert.equal((await page.evaluate(() => pendingAccountImport.preview[0].record)).accessCard, "000001");
    await page.locator("#accountImportFileInput").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv",
      buffer: Buffer.from('Asset Number,Access Card,RID\r\nTEST-CSV,000003,000004\r\n') });
    await page.waitForFunction(() => pendingAccountImport?.fileName === "synthetic.csv");
    assert.equal((await page.evaluate(() => pendingAccountImport.preview[0].record)).accessCard, "000003");
    await page.evaluate(() => openAuditImport());
    await page.locator("#auditFileInput").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv",
      buffer: Buffer.from('Account Number,Access Card,Receiver RID Num\r\n000001,000001,000002\r\n') });
    await page.waitForFunction(() => !document.getElementById("auditImportPreview").hidden);
    const record = await page.evaluate(() => pendingAuditImport.validRows[0]);
    assert.equal(record.accountNumber, "000001"); assert.equal(record.rid, "000002");
  });

  await t.test("a malformed workbook returns an error while the staff page remains usable", async () => {
    const error = await page.evaluate(async () => {
      try { await readExcelBook(new File(["not a spreadsheet"], "synthetic.xlsx")); } catch (error) { return error.message; }
    });
    assert.match(error, /not a valid spreadsheet archive/);
    assert.equal(await page.evaluate(() => typeof renderDashboard), "function");
    assert.deepEqual(outside, []); assert.deepEqual(failures, []);
  });
});
