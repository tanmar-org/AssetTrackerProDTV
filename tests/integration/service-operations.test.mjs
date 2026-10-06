import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {createServer} from "node:http";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {createPostgresFixture} from "../helpers/postgres.mjs";
import {startNext} from "../helpers/next-server.mjs";
import {sessionHeaders} from "../helpers/session-context.mjs";
import {inventory,batch,when} from "../helpers/inventory-fixture.mjs";
import {provisionAdmin} from "../../scripts/admin-provisioning.mjs";

const directory=fileURLToPath(new URL("../../",import.meta.url));
// Real databases and both built applications. This loopback-only gateway can
// lose an acknowledgement AFTER the QR database commits, without faking proof.
test("durable QR coordination across interruptions, permissions and processes",{timeout:120000},async t=>{
  let tracker,requests,staff,qr,gateway,second;
  t.after(async()=>{
    await second?.close();await staff?.close();await qr?.close();
    gateway?.closeAllConnections();if(gateway?.listening)await new Promise(resolve=>gateway.close(resolve));
    await requests?.close();await tracker?.close();
  });
  tracker=await createPostgresFixture("tracker");requests=await createPostgresFixture("requests");
  const secret=randomUUID();qr=await startNext(`${directory}/service-request`,{DATABASE_URL:requests.url,ADMIN_SHARED_SECRET:secret});
  let mode="normal",mutations=0;
  gateway=createServer(async(req,res)=>{
    try{
      let body="";for await(const chunk of req)body+=chunk;
      if(req.url.includes("/operations")&&mode==="unavailable"){res.writeHead(503);return res.end("Synthetic unavailable");}
      if(req.url.includes("/operations")&&mode==="slow-receipt"){
        if(req.method==="PATCH")return; // This synthetic connection is closed in teardown.
        await new Promise(resolve=>setTimeout(resolve,3000));
      }
      if(req.method==="PATCH")mutations++;
      const response=await fetch(`${qr.url}${req.url}`,{method:req.method,headers:{authorization:req.headers.authorization||"","content-type":"application/json"},...(body?{body}:{})});
      const text=await response.text();
      if(mode==="drop-ack"&&req.method==="PATCH"){res.destroy();return;}
      res.writeHead(response.status,{"content-type":"application/json"});res.end(text);
    }catch{res.writeHead(503);res.end("Synthetic gateway failure");}
  });
  await new Promise(resolve=>gateway.listen(0,"127.0.0.1",resolve));
  const env={DATABASE_URL:tracker.url,ADMIN_SHARED_SECRET:secret,SERVICE_REQUEST_API_URL:`http://127.0.0.1:${gateway.address().port}/api/requests`};
  staff=await startNext(directory,env);
  const api=(path,method="GET",body,cookie,server=staff)=>fetch(`${server.url}${path}`,{method,headers:{"content-type":"application/json",...(cookie?{cookie,...sessionHeaders(cookie)}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=async name=>{const response=await api("/api/auth","POST",{action:"login",name,pin:name==="testadmin"?"482631":"593742"});assert.equal(response.status,200);return response.headers.get("set-cookie").split(";")[0];};
  const read=async cookie=>(await api("/api/app-state","GET",undefined,cookie)).json();
  const row=async id=>tracker.database.prepare("SELECT * FROM app_service_operations WHERE id=$1").bind(id).first();
  const qrRow=async()=>requests.database.prepare("SELECT * FROM service_requests WHERE id='request-1'").first();
  const count=async(store,table)=>Number((await store.prepare(`SELECT count(*) AS n FROM ${table}`).first()).n);
  const setup=async(state=inventory())=>{
    mode="normal";mutations=0;
    // Isolate this scenario's login budget together with its accounts/sessions.
    await tracker.database.prepare("TRUNCATE app_login_rate_limits,app_service_operations,app_inventory_drafts,app_sessions,app_users,app_change_log,app_state,app_state_history").run();
    await requests.database.prepare("TRUNCATE service_request_operations,service_requests,request_rate_limits").run();
    await provisionAdmin(tracker.database,{name:"testadmin",pin:"482631"});const admin=await login("testadmin");
    for(const name of ["testuser","otheruser"])assert.equal((await api("/api/users","POST",{name,pin:"593742"},admin)).status,200);
    const regular=await login("testuser"),other=await login("otheruser");
    assert.equal((await api("/api/app-state","PUT",{state,baseRevision:0},admin)).status,200);
    await requests.database.prepare(`INSERT INTO service_requests(id,asset_id,asset_number,account_number,requester_name,requester_phone,error_code,latitude,longitude,gps_accuracy,gps_captured_at,requested_at)
      VALUES('request-1','receiver-0','TEST-0','000001','Synthetic requester','555-0100','771',31.9,-102.2,0,$1,$1)`).bind(when).run();
    return {admin,regular,other};
  };
  const command=(changes={})=>({operationId:randomUUID(),id:"request-1",status:"Completed",notes:"Synthetic note",expectedVersion:1,baseRevision:1,...changes});
  const submit=(body,cookie,server=staff)=>api("/api/service-requests","PATCH",body,cookie,server);
  const retry=(id,cookie,extra={})=>api("/api/service-operations","POST",{id,mode:"retry",...extra},cookie);
  const worker=async()=>{
    await tracker.database.prepare("UPDATE app_service_operations SET next_attempt_at=now()").run();
    const result=await promisify(execFile)(process.execPath,["--experimental-strip-types","scripts/reconcile-service-operations.mjs"],{cwd:directory,env:{...process.env,...env},timeout:20000});
    return JSON.parse(result.stdout.trim());
  };
  const direct=body=>fetch(`${qr.url}/api/requests/operations`,{method:"PATCH",headers:{authorization:`Bearer ${secret}`,"content-type":"application/json"},body:JSON.stringify(body)});

  await t.test("independent staff processes replay one immutable command with one history/audit commit",async()=>{
    const initial=inventory();initial.rentalStock.batches=[batch(initial)];const {regular,other}=await setup(initial);
    second=await startNext(directory,env);const body=command({notes:"中".repeat(2048)});
    const responses=await Promise.all([submit(body,regular),submit(body,regular,second)]);
    assert.deepEqual(responses.map(r=>r.status),[200,200]);const receipts=await Promise.all(responses.map(r=>r.json()));
    assert.equal(receipts[0].operation.id,receipts[1].operation.id);assert.equal(mutations,1);
    const state=await read(regular);assert.equal(state.revision,2);assert.equal(state.state.master[0].rentState,"On Rent");
    assert.equal(state.state.receiverEvents.filter(r=>r.id===`qr:${body.operationId}`).length,1);
    assert.equal(state.state.rentalStock.batches[0].items[0].releasedAt,(await qrRow()).completed_at);
    assert.equal((await qrRow()).version,2);assert.equal((await qrRow()).notes.length,2048);
    assert.equal(await count(tracker.database,"app_state_history"),1);
    assert.equal(Number((await tracker.database.prepare("SELECT count(*) AS n FROM app_change_log WHERE revision=2").first()).n),1);
    assert.equal((await submit({...body,notes:"Different"},regular)).status,409);
    assert.equal((await submit(body,other)).status,409); // A UUID never transfers ownership.
    await second.close();second=null;
  });
  await t.test("lost acknowledgement survives logout and a separate CLI process completes from the original receipt",async()=>{
    const {regular}=await setup(),body=command();mode="drop-ack";
    const response=await submit(body,regular);assert.equal(response.status,202);assert.equal((await response.json()).accepted,true);
    const before=await qrRow();assert.equal(before.version,2);assert.equal((await row(body.operationId)).phase,"pending");
    assert.equal((await read(regular)).state.receiverEvents.length,0);
    assert.equal((await api("/api/auth","DELETE",undefined,regular)).status,200);
    mode="normal";assert.equal((await worker()).done,1);assert.equal(mutations,1);
    const op=await row(body.operationId);assert.equal(op.receipt.appliedAt,before.completed_at);assert.equal(op.phase,"done");
    const state=(await tracker.database.prepare("SELECT payload FROM app_state").first()).payload;
    assert.equal(state.receiverEvents[0].date,before.completed_at);assert.equal(state.receiverEvents[0].changedBy,"testuser");
    assert.equal((await worker()).processed,0);assert.equal((await qrRow()).version,2);
  });
  await t.test("failed tracker audit rolls back all local state, then recovery uses QR proof exactly once",async()=>{
    const {regular}=await setup(),body=command();
    await tracker.database.prepare("ALTER TABLE app_change_log ADD CONSTRAINT synthetic_qr_failure CHECK (action NOT LIKE 'QR status%')").run();
    try{
      const response=await submit(body,regular);assert.equal(response.status,202);
      assert.equal((await row(body.operationId)).error_code,"history_unavailable");assert.equal((await qrRow()).version,2);
      assert.equal((await read(regular)).revision,1);assert.equal(await count(tracker.database,"app_state_history"),0);
    }finally{await tracker.database.prepare("ALTER TABLE app_change_log DROP CONSTRAINT synthetic_qr_failure").run();}
    assert.equal((await worker()).done,1);assert.equal(mutations,1);assert.equal((await read(regular)).revision,2);
    assert.equal((await retry(body.operationId,regular)).status,200);assert.equal((await read(regular)).revision,2);
  });
  await t.test("receipt lookup and mutation share one five-second attempt budget without losing intent",async()=>{
    const {regular}=await setup(),body=command();mode="slow-receipt";const started=Date.now();
    const response=await submit(body,regular);assert.equal(response.status,202);
    assert.ok(Date.now()-started<7000,"The second upstream call must not restart the five-second budget.");
    assert.equal((await row(body.operationId)).error_code,"remote_unavailable");assert.equal((await qrRow()).version,1);
    mode="normal";assert.equal((await retry(body.operationId,regular)).status,200);assert.equal((await qrRow()).version,2);
  });
  await t.test("unconfirmed intent rechecks account access; only its owner/admin can approve retry",async()=>{
    const {admin,regular,other}=await setup(),body=command();mode="unavailable";
    assert.equal((await submit(body,regular)).status,202);
    await tracker.database.prepare("UPDATE app_users SET active=0 WHERE name='testuser'").run();mode="normal";
    assert.equal((await worker()).pending,1);assert.equal((await row(body.operationId)).error_code,"authorization");assert.equal(mutations,0);
    assert.equal((await retry(body.operationId,other)).status,403);assert.equal((await retry(body.operationId,regular)).status,401);
    assert.equal((await retry(body.operationId,admin)).status,200);assert.equal((await row(body.operationId)).actor_name,"testuser");
    assert.equal((await row(body.operationId)).approver_name,"testadmin");assert.equal(mutations,1);
  });
  await t.test("an already applied receipt can finish factual history after the initiating account is disabled",async()=>{
    const {regular}=await setup(),body=command();mode="drop-ack";assert.equal((await submit(body,regular)).status,202);
    await tracker.database.prepare("UPDATE app_users SET active=0 WHERE name='testuser'").run();mode="normal";
    assert.equal((await worker()).done,1);assert.equal(mutations,1);assert.equal((await row(body.operationId)).phase,"done");
  });
  await t.test("rent changes while waiting pause history; explicit fresh review keeps current rent state",async()=>{
    const {admin,regular,other}=await setup(),body=command();mode="unavailable";assert.equal((await submit(body,regular)).status,202);
    const changed=await read(admin);changed.state.master[0].offRentSince="2026-10-06T12:00:00.000Z";
    assert.equal((await api("/api/app-state","PUT",{state:changed.state,baseRevision:1},admin)).status,200);mode="normal";
    assert.equal((await worker()).review,1);assert.equal((await read(regular)).state.master[0].rentState,"Off Rent");
    assert.equal((await row(body.operationId)).phase,"needs_review");assert.equal((await retry(body.operationId,regular)).status,409);
    assert.equal((await retry(body.operationId,other,{mode:"history-only",baseRevision:2})).status,403);
    assert.equal((await retry(body.operationId,regular,{mode:"history-only",baseRevision:1})).status,409);
    assert.equal((await retry(body.operationId,regular,{mode:"history-only",baseRevision:2})).status,200);
    const final=await read(regular);assert.equal(final.state.master[0].rentState,"Off Rent");assert.equal(final.state.master[0].offRentSince,changed.state.master[0].offRentSince);
    assert.equal(final.state.receiverEvents.length,1);assert.equal(final.revision,3);assert.equal(mutations,1);
  });
  await t.test("saved stable association survives renaming/reused numbers and never attaches to a deleted receiver",async()=>{
    for(const deleted of [false,true]){
      const {admin,regular}=await setup(),body=command();mode="unavailable";assert.equal((await submit(body,regular)).status,202);
      const current=await read(admin);
      if(deleted)current.state.master=current.state.master.filter(r=>r.id!=="receiver-0");else current.state.master[0].assetNumber="RENAMED";
      current.state.master.find(r=>r.id==="receiver-1").assetNumber="TEST-0";
      assert.equal((await api("/api/app-state","PUT",{state:current.state,baseRevision:1},admin)).status,200);mode="normal";
      assert.equal((await worker()).done,1);const final=await read(regular),op=await row(body.operationId);
      assert.equal(final.state.master.find(r=>r.id==="receiver-1").rentState,"Off Rent");
      assert.equal(op.history_scope,deleted?"operation":"receiver");
      if(deleted){assert.equal(final.revision,2);assert.equal(final.state.receiverEvents.length,0);}
      else assert.equal(final.state.master.find(r=>r.id==="receiver-0").rentState,"On Rent");
      const record=await (await api(`/api/service-operations?id=${body.operationId}`,"GET",undefined,regular)).json();
      assert.equal(record.request.accountNumber,"000001");assert.equal(record.request.assetNumber,"TEST-0");
    }
  });
  await t.test("a second intent cannot overtake unresolved work; external version changes become durable rejections",async()=>{
    const {regular}=await setup(),body=command();mode="unavailable";assert.equal((await submit(body,regular)).status,202);
    assert.equal((await submit(command({status:"Cancelled"}),regular)).status,409);assert.equal(mutations,0);
    assert.equal((await direct({operationId:randomUUID(),id:"request-1",kind:"status",status:"Cancelled",notes:"External",expectedVersion:1})).status,200);
    mode="normal";assert.equal((await worker()).failed,1);const op=await row(body.operationId);
    assert.equal(op.receipt.reason,"version_conflict");assert.equal(op.phase,"failed");assert.equal((await read(regular)).revision,1);
    assert.equal((await qrRow()).notes,"External");assert.equal((await retry(body.operationId,regular)).status,409);
  });
  await t.test("pending reopen uniqueness stores a rejection without changing original notes/version",async()=>{
    const {regular}=await setup();await requests.database.prepare("UPDATE service_requests SET status='Completed',notes='Keep',completed_at=$1").bind(when).run();
    await requests.database.prepare(`INSERT INTO service_requests(id,asset_id,asset_number,error_code,latitude,longitude,gps_accuracy,gps_captured_at,requested_at)
      VALUES('new-pending','receiver-0','TEST-0','771',31.9,-102.2,0,$1,$1)`).bind(when).run();
    const body=command({status:"Pending"}),response=await submit(body,regular);assert.equal(response.status,409);
    assert.equal((await response.json()).accepted,true);assert.equal((await row(body.operationId)).receipt.reason,"pending_conflict");
    assert.equal((await qrRow()).notes,"Keep");assert.equal((await qrRow()).version,1);assert.equal((await read(regular)).revision,1);
    assert.equal((await submit(body,regular)).status,409);assert.equal(mutations,1);
  });
  await t.test("independent QR processes accept one competing version and replay immutable receipts",async()=>{
    await setup();const secondQr=await startNext(`${directory}/service-request`,{DATABASE_URL:requests.url,ADMIN_SHARED_SECRET:secret});
    try{
      const first={operationId:randomUUID(),id:"request-1",kind:"status",status:"Completed",notes:"First",expectedVersion:1};
      const other={...first,operationId:randomUUID(),status:"Cancelled",notes:"Second"};
      const responses=await Promise.all([direct(first),fetch(`${secondQr.url}/api/requests/operations`,{method:"PATCH",headers:{authorization:`Bearer ${secret}`,"content-type":"application/json"},body:JSON.stringify(other)})]);
      const receipts=await Promise.all(responses.map(r=>r.json()));assert.deepEqual(receipts.map(r=>r.outcome).sort(),["applied","rejected"]);
      assert.equal(receipts.find(r=>r.outcome==="rejected").reason,"version_conflict");assert.equal((await qrRow()).version,2);
      assert.deepEqual(await (await direct(first)).json(),receipts[0]);
      assert.equal((await direct({...first,notes:"Changed"})).status,409);
      assert.deepEqual(await (await direct({...first,operationId:first.operationId.toUpperCase()})).json(),receipts[0]);
    }finally{await secondQr.close();}
  });
  await t.test("administrator archival is recoverable and idempotent; demotion blocks unconfirmed deletion",async()=>{
    const {admin,regular}=await setup(),body={operationId:randomUUID(),expectedVersion:1,baseRevision:1};
    assert.equal((await api("/api/service-requests?id=request-1","DELETE",body,regular)).status,403);assert.equal(mutations,0);
    mode="unavailable";assert.equal((await api("/api/service-requests?id=request-1","DELETE",body,admin)).status,202);
    await tracker.database.prepare("UPDATE app_users SET role='user' WHERE name='testadmin'").run();mode="normal";
    await worker();assert.equal((await row(body.operationId)).error_code,"authorization");assert.equal((await qrRow()).deleted_at,null);
    await tracker.database.prepare("UPDATE app_users SET role='admin' WHERE name='testadmin'").run();
    assert.equal((await retry(body.operationId,admin)).status,200);assert.ok((await qrRow()).deleted_at);
    const final=await read(admin);assert.equal(final.state.master[0].rentState,"Off Rent");assert.equal(final.state.receiverEvents.length,1);
    assert.equal((await api("/api/service-requests?id=request-1","DELETE",body,admin)).status,200);assert.equal(mutations,1);assert.equal((await qrRow()).version,2);
  });
  await t.test("restored work stays paused until explicit administrator approval",async()=>{
    const {admin,regular}=await setup(),body=command();mode="unavailable";assert.equal((await submit(body,regular)).status,202);
    await tracker.database.prepare("UPDATE app_service_operations SET phase='blocked',error_code='restore_review'").run();mode="normal";
    assert.equal((await worker()).processed,0);assert.equal((await retry(body.operationId,regular)).status,403);
    assert.equal((await retry(body.operationId,admin)).status,200);assert.equal(mutations,1);
  });
  await t.test("invalid input, stale inventory and private selectors reject before intent or mutation",async()=>{
    const {regular}=await setup();
    for(const extra of [{operationId:"bad"},{expectedVersion:0},{baseRevision:-1},{notes:null},{notes:"x".repeat(2049)},{assetNumber:"forged"}])assert.equal((await submit(command(extra),regular)).status,400);
    assert.equal((await submit(command({baseRevision:0}),regular)).status,409);
    assert.equal((await submit(command({expectedVersion:2}),regular)).status,409);
    assert.equal((await submit(command(),undefined)).status,401);
    const raw={method:"PATCH",headers:{cookie:regular,...sessionHeaders(regular)},body:JSON.stringify(command())};
    assert.equal((await fetch(`${staff.url}/api/service-requests`,raw)).status,415);
    assert.equal((await fetch(`${staff.url}/api/service-requests`,{...raw,headers:{...raw.headers,"content-type":"application/json"},body:JSON.stringify({...command(),notes:"中".repeat(3000)})})).status,413);
    for(const path of ["/api/requests/item?id=request-1",`/api/requests/operations?id=${randomUUID()}`])assert.equal((await fetch(`${qr.url}${path}`)).status,401);
    assert.equal((await fetch(`${qr.url}/api/requests`,{method:"PATCH",headers:{authorization:`Bearer ${secret}`,"content-type":"application/json"},body:"{}"})).status,410);
    assert.equal(await count(tracker.database,"app_service_operations"),0);assert.equal(mutations,0);
    await requests.database.prepare("UPDATE service_requests SET requested_at='invalid'").run();
    assert.equal((await submit(command(),regular)).status,400);assert.equal(mutations,0);
  });
  await t.test("operation browsing is authenticated, bounded and cursor-paged without tie omissions",async()=>{
    const {regular}=await setup(),body=command();mode="unavailable";assert.equal((await submit(body,regular)).status,202);
    await tracker.database.prepare(`INSERT INTO app_service_operations(id,request_id,kind,target_status,notes,expected_version,fingerprint,actor_id,actor_name,approver_id,approver_name,snapshot,phase,created_at,updated_at)
      SELECT gen_random_uuid(),'history-'||n,'status','Completed','',1,fingerprint,actor_id,actor_name,approver_id,approver_name,snapshot,'done',$2,$2
      FROM app_service_operations CROSS JOIN generate_series(1,205) n WHERE id=$1`).bind(body.operationId,when).run();
    assert.equal((await api("/api/service-operations")).status,401);
    let cursor=null;const ids=[];
    do{const response=await api(`/api/service-operations?status=done&limit=100${cursor?`&cursor=${cursor}`:""}`,"GET",undefined,regular);assert.equal(response.status,200);
      const result=await response.json();assert.ok(result.operations.length<=100);ids.push(...result.operations.map(r=>r.id));cursor=result.page.nextCursor;
    }while(cursor);
    assert.equal(ids.length,205);assert.equal(new Set(ids).size,205);
    assert.equal((await api("/api/service-operations?limit=101","GET",undefined,regular)).status,400);
    const first=await (await api("/api/service-operations?status=done&limit=1","GET",undefined,regular)).json();
    assert.equal((await api(`/api/service-operations?status=failed&limit=1&cursor=${first.page.nextCursor}`,"GET",undefined,regular)).status,400);
    const forged=JSON.parse(Buffer.from(first.page.nextCursor,"base64url").toString());forged.id="invalid-uuid";
    assert.equal((await api(`/api/service-operations?status=done&limit=1&cursor=${Buffer.from(JSON.stringify(forged)).toString("base64url")}`,"GET",undefined,regular)).status,400);
    const searched=await (await api("/api/service-operations?status=all&q=Synthetic","GET",undefined,regular)).json();
    assert.equal(searched.operations.length,1);assert.equal(searched.operations[0].id,body.operationId);
  });
});
