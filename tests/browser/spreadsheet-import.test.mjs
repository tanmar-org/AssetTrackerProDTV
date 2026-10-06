import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";
import { validateInventory } from "../../lib/inventory-state.ts";
import { inventory, when } from "../helpers/inventory-fixture.mjs";
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
  const outside = [], failures = [], writes = [];
  let sharedState=inventory(),revision=1,user={id:"test-admin",name:"testadmin",role:"admin"};
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== server.url) { outside.push(url.origin); return route.abort(); }
    if (url.pathname === "/api/auth") return route.fulfill({ json: { user, sessionContext: "1".repeat(64) } });
    if (url.pathname === "/api/app-state") {
      if(route.request().method()!=="GET"){
        const body=route.request().postDataJSON();validateInventory(body.state);
        writes.push({method:route.request().method(),body});sharedState=body.state;revision++;
        return route.fulfill({json:{revision,updatedAt:new Date().toISOString()}});
      }
      return route.fulfill({ json: { state: sharedState, revision } });
    }
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

  async function reload(state=inventory(),role="admin"){
    sharedState=state;revision++;user={...user,role};
    await page.reload();await page.waitForFunction(()=>document.getElementById("authGate").hidden);
  }
  const westRow=(asset,number="000001")=>{const row=Array(14).fill("");row[1]=asset;row[2]="000009";row[4]="000010";row[7]=number;row[12]="West office";row[13]="Import notes";return row;};
  async function westPreview(rows){
    await page.evaluate(()=>openDataImport());
    await page.locator("#wtxXlsxInput").setInputFiles({name:"synthetic.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer:bytes(book([Array(14).fill("Heading"),...rows],"West Texas"))});
    await page.waitForFunction(()=>pendingDataImport?.type==="West Texas XLSX");
  }

  await t.test("West Texas Apply reports actual moves and skipped full-account rows through real controls",async()=>{
    const state=inventory(21);
    state.assignments=Array.from({length:20},(_,i)=>({id:`assignment-${i}`,assetId:`receiver-${i}`,accountId:i===19?"account-1":"account-0",assignedAt:when}));
    await reload(state);const previous=writes.length;
    await westPreview([westRow("TEST-19"),westRow("NEW-BLOCKED")]);
    assert.equal(await page.locator("#dataWarningCount").textContent(),"1");
    assert.match(await page.locator("#dataImportPreviewRows").textContent(),/20-receiver limit/);
    await page.locator("#applyDataImport").click();
    await page.waitForFunction(()=>!cloudQueued&&!cloudSaving);
    assert.equal(writes.length,previous+1);const saved=writes.at(-1).body.state;
    assert.equal(saved.assignments.filter(row=>row.accountId==="account-0").length,20);
    assert.equal(saved.master.some(row=>row.assetNumber==="NEW-BLOCKED"),false);
    assert.equal(saved.master[19].accessCard,"000009");assert.equal(saved.master[19].rid,"000010");assert.equal(saved.master[19].notes,"Import notes");
    assert.ok(saved.receiverEvents.some(row=>row.title==="Moved to Account 000001"));
    assert.match(await page.locator("#toast").textContent(),/0 assigned, 1 moved.*1 skipped.*0 added/);
    assert.equal(await page.evaluate(()=>cloudWriteBlocked),false);
  });

  await t.test("Apply rechecks aged capacity without adding blocked registry rows or sending a save",async()=>{
    const state=inventory(20);state.assignments=Array.from({length:19},(_,i)=>({id:`assignment-${i}`,assetId:`receiver-${i}`,accountId:"account-0",assignedAt:when}));
    await reload(state);const previous=writes.length;
    await westPreview([westRow("NEW-AGED")]);
    await page.evaluate(when=>assignments.push({id:"later",assetId:"receiver-19",accountId:"account-0",assignedAt:when}),when);
    await page.locator("#applyDataImport").click();
    assert.equal(await page.evaluate(()=>master.some(row=>row.assetNumber==="NEW-AGED")),false);
    assert.equal(writes.length,previous);assert.match(await page.locator("#toast").textContent(),/0 assigned.*1 skipped.*No inventory changes/);
  });

  await t.test("regular account import applies one receiver with history and a PATCH save",async()=>{
    await reload(inventory(),"user");const previous=writes.length;
    await page.evaluate(()=>{currentAccountId="account-0";openAccountImportModal();});
    await page.locator("#accountImportFileInput").setInputFiles({name:"synthetic.csv",mimeType:"text/csv",buffer:Buffer.from('Asset Number,Access Card,RID\r\nNEW-STAFF,000001,000002\r\nNEW-SKIPPED,000003,000004\r\n')});
    await page.waitForFunction(()=>pendingAccountImport?.fileName==="synthetic.csv");
    assert.equal(await page.locator("#accountImportReady").textContent(),"1");
    await page.locator("#applyAccountImport").click();await page.waitForFunction(()=>!cloudQueued&&!cloudSaving);
    assert.equal(writes.length,previous+1);assert.equal(writes.at(-1).method,"PATCH");
    const saved=writes.at(-1).body.state;assert.equal(saved.assignments.length,1);assert.equal(saved.master.at(-1).accessCard,"000001");
    assert.equal(saved.master.some(row=>row.assetNumber==="NEW-SKIPPED"),false);assert.equal(saved.receiverEvents.length,1);
    assert.match(await page.locator("#toast").textContent(),/1 assigned.*1 skipped/);
  });

  await t.test("actual CSV downloads protect entered text and preserve identifier text without mutating inventory",async()=>{
    await reload();
    await page.evaluate(()=>{
      accounts[0].name="=1+1";accounts[0].office="＠Office";
      auditState={fileName:"synthetic.csv",importedAt:new Date().toISOString(),results:[{accountNumber:"000001",accountName:"+Name",appCount:1,auditCount:0,matchedCount:0,countMatch:false,perfect:false,accountExists:true,missingFromAudit:[{issueId:"issue-1",assetNumber:"000002",accessCard:"000003",rid:"000004",status:"needs-research",notes:'=SUM(1,2)"\n@SUM(A1)'}],missingFromApp:[]}]};
      activityRecords=[{user_name:"=Name",action:"@Action",revision:2,created_at:new Date().toISOString()}];
    });
    for(const name of ["exportReportCsv","exportAuditCsv","exportActivityCsv"]){
      const waiting=page.waitForEvent("download");await page.evaluate(name=>window[name](),name);
      const download=await waiting;const path=await download.path();assert.ok(path);
      const csv=await readFile(path,"utf8");assert.ok(download.suggestedFilename().endsWith(".csv"));
      const parsed=XLSX.read(csv,{type:"string",raw:true});const rows=XLSX.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]],{header:1,raw:true});
      if(name==="exportReportCsv"){assert.equal(rows[1][0],"\t000001");assert.equal(rows[1][1],"\t=1+1");assert.equal(rows[1][2],"\t＠Office");}
      if(name==="exportAuditCsv"){assert.equal(rows[1][1],"\t+Name");assert.equal(rows[1][7],'\t=SUM(1,2)"\n@SUM(A1)');}
      if(name==="exportActivityCsv"){assert.equal(rows[1][0],"\t=Name");assert.equal(rows[1][2],"\t@Action");}
    }
    assert.equal(await page.evaluate(()=>accounts[0].number),"000001");assert.equal(await page.evaluate(()=>accounts[0].name),"=1+1");
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
