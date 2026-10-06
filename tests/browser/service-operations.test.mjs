import assert from "node:assert/strict";
import test from "node:test";
import {fileURLToPath} from "node:url";
import {startNext} from "../helpers/next-server.mjs";
import {inventory,when} from "../helpers/inventory-fixture.mjs";
import {snapshot} from "../helpers/service-fixture.mjs";
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||"playwright");

// Actual staff controls with private API fixtures and no outside traffic. SQL,
// permissions and durable recovery are checked independently over PostgreSQL.
test("staff durable QR controls in Chromium",{timeout:90000},async t=>{
  const server=await startNext(fileURLToPath(new URL("../../",import.meta.url)),{DATABASE_URL:""});t.after(server.close);
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext();t.after(()=>context.close());
  let state,revision,request,operations,mode,failRefresh,delayRelease,detailsRelease,details;
  const commands=[],stateWrites=[],reviews=[];
  const reset=()=>{state=inventory();revision=1;request={...snapshot(),status:"Pending",version:1,completedAt:null};operations=[];mode="done";failRefresh=false;details=request;commands.length=0;stateWrites.length=0;reviews.length=0;};reset();
  const complete=(body,historyOnly=false)=>{
    revision++;if(!historyOnly){state.master[0].rentState="On Rent";state.master[0].offRentSince="";}
    state.receiverEvents=[{id:`qr:${body.operationId}`,receiverId:"receiver-0",kind:"service",title:"Server confirmed history",date:when,changedBy:"testadmin"}];
    request={...request,status:"Completed",version:2,completedAt:when};
  };
  const summary=(body,phase)=>({id:body.operationId,requestId:request.id,assetNumber:request.assetNumber,kind:"status",status:"Completed",phase,
    actorName:"testadmin",approvedBy:"testadmin",createdAt:when,updatedAt:when,historyScope:phase==="done"?"receiver":null,
    message:phase==="needs_review"?"QR change is saved. Receiver rent status changed while waiting; review before recording history.":phase==="failed"?"Request changed before this action. Refresh and review its current status.":"",
    canRetry:true,canReview:phase==="needs_review"});
  await context.route("**/*",async route=>{
    const url=new URL(route.request().url()),method=route.request().method();if(url.origin!==server.url)return route.abort();
    if(url.pathname==="/api/auth")return route.fulfill({json:{user:{id:"test-admin",name:"testadmin",role:"admin"},sessionContext:"1".repeat(64)}});
    if(url.pathname==="/api/app-state"){
      if(method!=="GET")stateWrites.push(route.request().postDataJSON());
      return route.fulfill(failRefresh?{status:503,json:{error:"Synthetic unavailable"}}:{json:{state,revision}});
    }
    if(url.pathname==="/api/service-requests"){
      if(method==="GET")return route.fulfill({json:{requests:[{...request,synchronization:operations.find(op=>["pending","needs_review"].includes(op.phase))||null}],page:{nextCursor:null}}});
      const body=route.request().postDataJSON();commands.push({body,context:route.request().headers()["x-tracker-session-context"]});
      if(mode==="lost-response"&&commands.length===1)return route.fulfill({status:503,json:{error:"Synthetic response unavailable"}});
      if(mode==="delayed")await new Promise(resolve=>{delayRelease=resolve;});
      const phase=["pending","needs_review","failed"].includes(mode)?mode:"done";
      if(phase==="done")complete(body);
      const operation=summary(body,phase);operations=[operation];
      return route.fulfill({status:phase==="failed"?409:phase==="done"?200:202,json:{accepted:true,operation}});
    }
    if(url.pathname==="/api/service-operations"){
      if(method==="POST"){
        const body=route.request().postDataJSON();reviews.push(body);
        complete({operationId:body.id},body.mode==="history-only");operations=operations.map(op=>({...op,phase:"done",canReview:false,historyScope:"receiver",message:""}));
        return route.fulfill({json:{operation:operations[0]}});
      }
      if(url.searchParams.has("id")){
        if(mode==="slow-details")await new Promise(resolve=>{detailsRelease=resolve;});
        return route.fulfill({json:{operation:operations[0],request:details}});
      }
      const filter=url.searchParams.get("status");return route.fulfill({json:{operations:operations.filter(op=>filter==="all"||filter==="active"&&["pending","needs_review"].includes(op.phase)||op.phase===filter),page:{nextCursor:null}}});
    }
    if(url.pathname.startsWith("/api/"))return route.fulfill({json:{users:[],snapshots:[],copies:[],activity:[]}});
    return route.continue();
  });
  const page=async()=>{const p=await context.newPage();p.on("pageerror",error=>process.stderr.write(`Browser error: ${error.message}\n`));await p.goto(`${server.url}/asset-tracker/index.html`);await p.waitForFunction(()=>!document.body.classList.contains("auth-locked"));await p.click('[data-view="activations"]');await p.waitForFunction(()=>remoteActivations.length===1&&!serviceOperationPager.loading);return p;};
  const action=async p=>{await p.click('[data-activation-complete="request-1"]');await p.waitForFunction(()=>!serviceMutationBusy);};
  await t.test("completion sends immutable UUID/version/revision and reads authoritative history without a browser save",async()=>{
    reset();const p=await page();try{
      await action(p);assert.equal(commands.length,1,await p.locator("#toast").textContent());assert.match(commands[0].body.operationId,/^[a-f0-9-]{36}$/);
      assert.equal(commands[0].body.expectedVersion,1);assert.equal(commands[0].body.baseRevision,1);assert.equal(commands[0].context,"1".repeat(64));
      assert.equal(stateWrites.length,0);assert.equal(await p.evaluate(()=>cloudRevision),2);assert.equal(await p.evaluate(()=>master[0].rentState),"On Rent");
      assert.equal(await p.evaluate(()=>receiverEvents[0].title),"Server confirmed history");assert.match(await p.locator("#toast").textContent(),/history saved/);
    }finally{await p.close();}
  });
  await t.test("unconfirmed retry retains the original command and never fabricates local success",async()=>{
    reset();mode="lost-response";const p=await page();try{
      await action(p);assert.equal(await p.evaluate(()=>receiverEvents.length),0);assert.equal(await p.evaluate(()=>master[0].rentState),"Off Rent");
      assert.equal(await p.evaluate(()=>serviceCommands.size),1);await action(p);
      assert.deepEqual(commands[0].body,commands[1].body);assert.equal(await p.evaluate(()=>serviceCommands.size),0);assert.equal(stateWrites.length,0);
    }finally{await p.close();}
  });
  await t.test("accepted pending work survives reload, disables overtaking and completes through its Retry control",async()=>{
    reset();mode="pending";const p=await page();try{
      await action(p);assert.match(await p.locator("#serviceOperationList").textContent(),/Synchronization is pending/);
      assert.equal(await p.locator('[data-activation-complete="request-1"]').isEnabled(),false);
      await p.reload();await p.waitForFunction(()=>!document.body.classList.contains("auth-locked"));await p.click('[data-view="activations"]');
      await p.waitForSelector("[data-service-operation-retry]");assert.equal(await p.evaluate(()=>serviceCommands.size),0);
      await p.click("[data-service-operation-retry]");await p.waitForFunction(()=>!serviceMutationBusy);
      assert.equal(reviews[0].id,commands[0].body.operationId);assert.equal(reviews[0].mode,"retry");assert.equal(await p.evaluate(()=>receiverEvents.length),1);
      await p.selectOption("#serviceOperationFilter","done");await p.waitForFunction(()=>serviceOperations[0]?.phase==="done");
      assert.match(await p.locator("#serviceOperationList").textContent(),/history have been saved/);
    }finally{await p.close();}
  });
  await t.test("rent conflict review sends a fresh revision and keeps the current receiver rent status",async()=>{
    reset();mode="needs_review";const p=await page();try{
      await action(p);assert.equal(await p.evaluate(()=>master[0].rentState),"Off Rent");
      p.once("dialog",dialog=>dialog.accept());await p.click("[data-service-operation-review]");await p.waitForFunction(()=>!serviceMutationBusy);
      assert.deepEqual(reviews[0],{id:commands[0].body.operationId,mode:"history-only",baseRevision:1});
      assert.equal(await p.evaluate(()=>master[0].rentState),"Off Rent");assert.equal(await p.evaluate(()=>receiverEvents.length),1);
    }finally{await p.close();}
  });
  await t.test("accepted rejection refreshes both lists and reports the persisted reason",async()=>{
    reset();mode="failed";const p=await page();try{
      await action(p);assert.equal(await p.evaluate(()=>serviceCommands.size),0);assert.equal(await p.evaluate(()=>receiverEvents.length),0);
      assert.match(await p.locator("#toast").textContent(),/Request changed/);
      await p.selectOption("#serviceOperationFilter","failed");await p.waitForFunction(()=>serviceOperations[0]?.phase==="failed");
      assert.match(await p.locator("#serviceOperationList").textContent(),/Request changed/);assert.equal(stateWrites.length,0);
    }finally{await p.close();}
  });
  await t.test("accepted operation is reported accurately when inventory refresh fails",async()=>{
    reset();const p=await page();try{failRefresh=true;await action(p);assert.match(await p.locator("#toast").textContent(),/Operation accepted.*refresh is unavailable/);assert.equal(await p.evaluate(()=>receiverEvents.length),0);assert.equal(stateWrites.length,0);}finally{failRefresh=false;await p.close();}
  });
  await t.test("local drafts block a QR action; edits started during a request survive its refresh",async()=>{
    reset();const p=await page();try{
      await p.evaluate(()=>{cloudWriteBlocked=true;});await action(p);assert.equal(commands.length,0);assert.match(await p.locator("#toast").textContent(),/inventory edits/);
      await p.evaluate(()=>{cloudWriteBlocked=false;});mode="delayed";
      await p.click('[data-activation-complete="request-1"]');await p.waitForFunction(()=>serviceMutationBusy);
      await p.evaluate(()=>{master[0].notes="Unsubmitted tab draft";cloudWriteBlocked=true;});delayRelease();delayRelease=null;
      await p.waitForFunction(()=>!serviceMutationBusy);assert.equal(await p.evaluate(()=>master[0].notes),"Unsubmitted tab draft");
      assert.equal(await p.evaluate(()=>cloudRevision),1);assert.equal(await p.evaluate(()=>receiverEvents.length),0);assert.equal(stateWrites.length,0);
    }finally{delayRelease?.();delayRelease=null;await p.close();}
  });
  await t.test("operation details escape private text, reject unsafe maps and cannot return after session lock",async()=>{
    reset();mode="pending";const p=await page();try{
      await action(p);const attack='<img data-injection src=x onerror="window.injected=true">';details={...request,requesterName:attack,mapUrl:"javascript:window.injected=true"};
      await p.click("[data-service-operation-view]");await p.waitForSelector("#receiverEventModal:not([hidden])");
      assert.equal(await p.locator("[data-injection]").count(),0);assert.match(await p.locator("#receiverEventBody").textContent(),/data-injection/);assert.equal(await p.locator("#receiverEventBody a").count(),0);
      await p.evaluate(()=>closeModal("receiverEventModal"));mode="slow-details";
      const detailRequest=p.waitForRequest(r=>new URL(r.url()).pathname==="/api/service-operations"&&new URL(r.url()).searchParams.has("id"));
      await p.click("[data-service-operation-view]");await detailRequest;
      await p.evaluate(()=>lockSession(false));detailsRelease();detailsRelease=null;await p.waitForFunction(()=>!sessionRequests.size);
      assert.equal(await p.evaluate(()=>serviceOperations.length+serviceCommands.size),0);assert.equal(await p.locator("#serviceOperationList").textContent(),"");
      assert.equal(await p.locator("#receiverEventModal").isVisible(),false);assert.equal(await p.locator("[data-injection]").count(),0);
    }finally{detailsRelease?.();detailsRelease=null;await p.close();}
  });
});
