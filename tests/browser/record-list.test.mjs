import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startNext } from "../helpers/next-server.mjs";
import { inventory } from "../helpers/inventory-fixture.mjs";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");

// Real controls, debouncing, downloads and DOM cleanup; separate integration
// tests prove SQL/authentication. Outside requests are blocked in this fixture.
test("staff request/activity page controls in Chromium",{timeout:60000},async(t)=>{
  const server=await startNext(fileURLToPath(new URL("../../",import.meta.url)),{DATABASE_URL:""});t.after(server.close);
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext({timezoneId:"America/Chicago"});t.after(()=>context.close());
  const calls=[];let failRequests=false,failActivity=false,slowRequestRelease,slowActivityRelease;
  const state=inventory();state.activations=[{id:"manual-1",assetId:"receiver-0",accountId:"account-0",action:"Deactivate",
    requestedAt:"2026-10-01T14:00:00Z",status:"Pending",requesterName:"Manual staff",notes:"Synthetic manual"}];
  const requests=Array.from({length:607},(_,i)=>({id:`qr-${i}`,assetNumber:`SAVED-${i}`,assetId:i===606?"receiver-0":null,
    action:"Reactivate / Refresh",status:i<604?"Completed":"Pending",requestedAt:"2026-10-01T14:00:00Z",notes:`Synthetic ${i}`,source:"QR"}));
  const activity=Array.from({length:605},(_,i)=>({id:`activity-${i}`,user_name:`Employee${i}`,action:`Synthetic edit ${i}`,revision:i+1,created_at:"2026-10-01T14:00:00Z"}));
  await context.route("**/*",async(route)=>{
    const url=new URL(route.request().url());if(url.origin!==server.url)return route.abort();
    if(url.pathname==="/api/auth")return route.fulfill({json:{user:{id:"test-admin",name:"testadmin",role:"admin"},sessionContext:"1".repeat(64)}});
    if(url.pathname==="/api/app-state")return route.fulfill({json:{state,revision:1}});
    if(["/api/service-requests","/api/activity"].includes(url.pathname)){
      const requestList=url.pathname==="/api/service-requests",q=url.searchParams.get("q")||"";
      calls.push({path:url.pathname,params:Object.fromEntries(url.searchParams),context:route.request().headers()["x-tracker-session-context"]});
      if(q==="slow")await new Promise(resolve=>{if(requestList)slowRequestRelease=resolve;else slowActivityRelease=resolve;});
      if(requestList?failRequests:failActivity)return route.fulfill({status:503,json:{error:"Synthetic outage"}});
      let rows=requestList?requests:activity;
      if(q==="slow")rows=[requestList?{...requests[0],assetNumber:"STALE"}:{...activity[0],user_name:"STALE"}];
      else if(q==="fresh")rows=[requestList?{...requests[0],assetNumber:"FRESH"}:{...activity[0],user_name:"FRESH"}];
      else if(q)rows=rows.filter(row=>(requestList?`${row.assetNumber} ${row.notes}`:`${row.user_name} ${row.action}`).toLowerCase().includes(q.toLowerCase()));
      const status=url.searchParams.get("status");if(requestList&&status&&status!=="all")rows=rows.filter(row=>row.status===status);
      const offset=Number(url.searchParams.get("cursor")?.slice(1)||0),limit=Number(url.searchParams.get("limit")||100);
      return route.fulfill({json:{[requestList?"requests":"activity"]:rows.slice(offset,offset+limit),
        page:{limit,nextCursor:rows.length>offset+limit?`p${offset+limit}`:null}}});
    }
    if(url.pathname.startsWith("/api/"))return route.fulfill({json:{users:[],snapshots:[],copies:[]}});
    return route.continue();
  });
  async function page(){const p=await context.newPage();p.on("pageerror",error=>process.stderr.write(`Browser error: ${error.message}\n`));await p.goto(`${server.url}/asset-tracker/index.html`);
    await p.waitForFunction(()=>!document.body.classList.contains("auth-locked"));return p;}
  const ready=(p,kind,count)=>p.waitForFunction(({kind,count})=>
    kind==="activation"?document.querySelector("#activationPageSummary").textContent.includes(`${count} request`):
      document.querySelector("#activitySummary").textContent.includes(`${count} matching event`),{kind,count});
  await t.test("QR next/previous replaces pages while manual rows remain clearly identified",async()=>{
    const p=await page();try{
      await p.click('[data-view="activations"]');await ready(p,"activation",100);
      assert.equal(await p.locator("#activationRows tr").count(),101);
      await p.click("#activationNextButton");await p.waitForFunction(()=>document.querySelector("#activationPageSummary").textContent.startsWith("QR page 2:"));
      assert.equal(await p.locator('[data-activation-reopen="qr-0"]').count(),0);
      assert.equal(await p.locator('[data-activation-reopen="qr-100"]').count(),1);
      assert.equal(await p.locator('[data-activation-complete="manual-1"]').count(),1);
      await p.click("#activationPreviousButton");await p.waitForFunction(()=>document.querySelector("#activationPageSummary").textContent.startsWith("QR page 1:"));
      assert.equal(await p.locator('[data-activation-reopen="qr-0"]').count(),1);
      assert.ok(calls.some(call=>call.path==="/api/service-requests"&&call.params.cursor==="p100"&&call.context==="1".repeat(64)));
    }finally{await p.close();}
  });
  await t.test("Pending/search filters find old saved metadata and reset page navigation",async()=>{
    const p=await page();try{
      await p.click('[data-view="activations"]');await ready(p,"activation",100);
      await p.click("#activationNextButton");await p.waitForFunction(()=>document.querySelector("#activationPageSummary").textContent.startsWith("QR page 2:"));
      await p.selectOption("#activationStatusFilter","Pending");await ready(p,"activation",3);
      assert.equal(await p.locator("#activationNextButton").isEnabled(),false);
      assert.equal(await p.locator("#activationPreviousButton").isEnabled(),false);
      await p.fill("#activationSearch","SAVED-606");await ready(p,"activation",1);
      // The live receiver has another asset number. A server match on saved
      // metadata must survive display association with that current receiver.
      assert.equal(await p.locator('[data-activation-complete="qr-606"]').count(),1);
      assert.equal(await p.locator("#activationRows tr").count(),1);
      assert.match(await p.locator("#activationRows").textContent(),/TEST-0/);
    }finally{await p.close();}
  });
  await t.test("late QR filters cannot overwrite newer results; an outage clears stale rows",async()=>{
    const p=await page();try{
      await p.click('[data-view="activations"]');await ready(p,"activation",100);
      await p.fill("#activationSearch","slow");await p.waitForFunction(()=>requestPager.loading); // Wait below confirms the actual request.
      await p.waitForRequest(r=>new URL(r.url()).pathname==="/api/service-requests"&&new URL(r.url()).searchParams.get("q")==="slow");
      await p.fill("#activationSearch","fresh");await ready(p,"activation",1);
      slowRequestRelease();slowRequestRelease=null;
      await p.waitForFunction(()=>!sessionRequests.size);
      assert.match(await p.locator("#activationRows").textContent(),/FRESH/);assert.doesNotMatch(await p.locator("#activationRows").textContent(),/STALE/);
      failRequests=true;await p.click("#refreshActivationsButton");await p.waitForFunction(()=>document.querySelector("#activationPageSummary").textContent.includes("unavailable"));
      assert.equal(await p.locator("#activationRows tr").count(),0);assert.equal(await p.locator("#activationNextButton").isEnabled(),false);
    }finally{slowRequestRelease?.();slowRequestRelease=null;failRequests=false;await p.close();}
  });
  await t.test("activity exports only the visible page and sends local-day boundaries across DST",async()=>{
    const p=await page();try{
      await p.click('[data-view="settings"]');await ready(p,"activity",100);
      await p.click("#activityNextButton");await p.waitForFunction(()=>document.querySelector("#activitySummary").textContent.startsWith("Page 2:"));
      assert.match(await p.locator("#activityList").textContent(),/Employee100/);assert.doesNotMatch(await p.locator("#activityList").textContent(),/Employee0\b/);
      const downloadPromise=p.waitForEvent("download");await p.click("#exportActivityButton");const download=await downloadPromise;
      const stream=await download.createReadStream();let csv="";for await(const chunk of stream)csv+=chunk;
      assert.equal(csv.split("\r\n").length,101);assert.match(csv,/Employee100/);assert.doesNotMatch(csv,/"Employee0"/);
      await p.fill("#activityDateFrom","2026-11-01");await p.fill("#activityDateTo","2026-11-01");await ready(p,"activity",100);
      const query=calls.filter(call=>call.path==="/api/activity").at(-1).params;
      assert.equal(query.from,"2026-11-01T05:00:00.000Z");assert.equal(query.through,"2026-11-02T06:00:00.000Z");
      assert.equal(query.cursor,undefined);assert.equal(await p.locator("#activityPreviousButton").isEnabled(),false);
    }finally{await p.close();}
  });
  await t.test("late activity filters and shared-device locking cannot restore private rows",async()=>{
    const p=await page();try{
      await p.click('[data-view="settings"]');await ready(p,"activity",100);
      await p.fill("#activitySearch","slow");await p.waitForRequest(r=>new URL(r.url()).pathname==="/api/activity"&&new URL(r.url()).searchParams.get("q")==="slow");
      await p.fill("#activitySearch","fresh");await ready(p,"activity",1);
      slowActivityRelease();slowActivityRelease=null;await p.waitForFunction(()=>!sessionRequests.size);
      assert.match(await p.locator("#activityList").textContent(),/FRESH/);assert.doesNotMatch(await p.locator("#activityList").textContent(),/STALE/);
      failActivity=true;await p.click("#refreshActivityButton");await p.waitForFunction(()=>document.querySelector("#activitySummary").textContent.includes("Synthetic outage"));
      assert.equal(await p.locator(".activity-row").count(),0);assert.equal(await p.locator("#exportActivityButton").isEnabled(),false);failActivity=false;
      await p.fill("#activitySearch","slow");await p.waitForRequest(r=>new URL(r.url()).pathname==="/api/activity"&&new URL(r.url()).searchParams.get("q")==="slow");
      await p.evaluate(()=>lockSession(false));slowActivityRelease();slowActivityRelease=null;
      await p.waitForFunction(()=>!sessionRequests.size);
      assert.equal(await p.locator(".activity-row").count(),0);
      assert.equal(await p.evaluate(()=>activityRecords.length+remoteActivations.length),0);
      assert.equal(await p.evaluate(()=>activityPager.cursors.length),1);
      assert.equal(await p.locator("#activitySearch").inputValue(),"");
    }finally{slowActivityRelease?.();slowActivityRelease=null;failActivity=false;await p.close();}
  });
});
