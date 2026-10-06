import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { sessionHeaders } from "../helpers/session-context.mjs";
import { startNext, unusedPort } from "../helpers/next-server.mjs";

// More than 500 synthetic records, equal timestamps and restricted real roles
// exercise the old omission, stable navigation and both applications' boundaries.
test("bounded request/activity pages over real PostgreSQL and HTTP",async(t)=>{
  let tracker,requests,staff,qr;
  t.after(async()=>{await qr?.close();await staff?.close();await requests?.close();await tracker?.close();});
  tracker=await createPostgresFixture("tracker");requests=await createPostgresFixture("requests");
  const secret=randomUUID(),port=await unusedPort();
  staff=await startNext(fileURLToPath(new URL("../../",import.meta.url)),{DATABASE_URL:tracker.url,
    ADMIN_SHARED_SECRET:secret,SERVICE_REQUEST_API_URL:`http://127.0.0.1:${port}/api/requests`});
  qr=await startNext(fileURLToPath(new URL("../../service-request/",import.meta.url)),{DATABASE_URL:requests.url,ADMIN_SHARED_SECRET:secret},{port});
  const call=(server,path,cookie,method="GET",body)=>fetch(`${server.url}${path}`,{method,
    headers:{"content-type":"application/json",...(cookie?{cookie,...sessionHeaders(cookie)}:{})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const login=async(name,pin)=>{const r=await call(staff,"/api/auth",null,"POST",{action:"login",name,pin});assert.equal(r.status,200);return r.headers.get("set-cookie").split(";")[0];};
  await provisionAdmin(tracker.database,{name:"testadmin",pin:"482631"});
  const admin=await login("testadmin","482631");
  assert.equal((await call(staff,"/api/users",admin,"POST",{name:"testuser",pin:"593742"})).status,200);
  const regular=await login("testuser","593742");
  const direct=path=>fetch(`${qr.url}${path}`,{headers:{authorization:`Bearer ${secret}`}});
  const read=async(path,cookie=regular)=>{const r=await call(staff,path,cookie);assert.equal(r.status,200);assert.equal(r.headers.get("cache-control"),"no-store");return r.json();};
  t.beforeEach(async()=>{
    await requests.database.prepare("TRUNCATE service_requests").run();
    await requests.database.prepare(`INSERT INTO service_requests
      (id,asset_number,error_code,latitude,longitude,gps_accuracy,gps_captured_at,requested_at,status,notes,deleted_at)
      SELECT 'request-'||lpad(i::text,4,'0'),'TEST-'||i,'771',31.9,-102.2,7,'2026-10-01T14:00:00Z','2026-10-01T14:00:00Z',
        CASE WHEN i < 3 THEN 'Pending' ELSE 'Completed' END,
        CASE WHEN i=10 THEN $1 ELSE 'Synthetic request' END,
        CASE WHEN i=1 THEN '2026-10-02T00:00:00Z' ELSE NULL END FROM generate_series(0,606) AS g(i)`)
      .bind("needle%_\\literal'").run();
    await tracker.database.prepare("TRUNCATE app_change_log").run();
    await tracker.database.prepare(`INSERT INTO app_change_log(id,user_name,action,revision,created_at)
      SELECT 'activity-'||lpad(i::text,4,'0'),'syntheticuser',
        CASE WHEN i=10 THEN $1 WHEN i%3=0 THEN 'Denied: access edit' WHEN i%3=1 THEN 'Reset user PIN' ELSE 'Inventory updated' END,
        i+1,'2026-10-01T14:00:00Z' FROM generate_series(0,604) AS g(i)`).bind("needle%_\\literal'").run();
  });
  await t.test("old pending requests are filtered before the first page and tombstones stay hidden",async()=>{
    const page=await read("/api/service-requests?status=Pending");
    assert.deepEqual(page.requests.map(row=>row.id),["request-0002","request-0000"]);
    assert.equal(page.page.nextCursor,null);
    const response=await direct("/api/requests?status=Pending");assert.equal(response.status,200);
    assert.deepEqual((await response.json()).requests,page.requests.map(({synchronization,...row})=>{assert.equal(synchronization,null);return row;}));
  });
  await t.test("all request pages reach beyond 500 without duplicates, even with equal timestamps",async()=>{
    let cursor=null;const ids=[];let pages=0;
    do{
      const page=await read(`/api/service-requests?limit=100${cursor?`&cursor=${cursor}`:""}`);
      assert.ok(page.requests.length<=100);ids.push(...page.requests.map(row=>row.id));cursor=page.page.nextCursor;pages++;
    }while(cursor);
    assert.equal(pages,7);assert.equal(ids.length,606);assert.equal(new Set(ids).size,606);
    assert.equal(ids.at(-1),"request-0000");assert.equal(ids.includes("request-0001"),false);
    const first=await read("/api/service-requests?limit=2");
    await requests.database.prepare(`INSERT INTO service_requests (id,asset_number,error_code,latitude,longitude,gps_accuracy,gps_captured_at,requested_at,status)
      VALUES ('newest','NEW','771',31.9,-102.2,7,'2026-10-02T00:00:00Z','2026-10-02T00:00:00Z','Completed')`).run();
    await requests.database.prepare("UPDATE service_requests SET deleted_at='2026-10-02T00:00:00Z' WHERE id=$1").bind(first.requests.at(-1).id).run();
    const next=await read(`/api/service-requests?limit=2&cursor=${first.page.nextCursor}`);
    assert.deepEqual(next.requests.map(row=>row.id),["request-0604","request-0603"]);
  });
  await t.test("literal searches and invalid private filters are enforced by both endpoints",async()=>{
    const query=new URLSearchParams({q:"needle%_\\literal'"});
    assert.deepEqual((await read(`/api/service-requests?${query}`)).requests.map(row=>row.id),["request-0010"]);
    assert.deepEqual((await read(`/api/activity?${query}`,admin)).activity.map(row=>row.id),["activity-0010"]);
    for(const query of ["limit=101","limit=2&limit=3","status=wrong","url=https://example.test","q=bad%00text","cursor=e30"]){
      assert.equal((await call(staff,`/api/service-requests?${query}`,regular)).status,400);
      assert.equal((await direct(`/api/requests?${query}`)).status,400);
    }
    const page=await read("/api/service-requests?limit=2");
    assert.equal((await call(staff,`/api/service-requests?limit=2&status=Pending&cursor=${page.page.nextCursor}`,regular)).status,400);
    assert.equal((await direct(`/api/requests?limit=2&status=Pending&cursor=${page.page.nextCursor}`)).status,400);
    assert.equal((await read(`/api/service-requests?${new URLSearchParams({q:"' OR TRUE --"})}`)).requests.length,0);
  });
  await t.test("activity pages reach old events and combine category/date/search filters",async()=>{
    let cursor=null;const ids=[];
    do{const page=await read(`/api/activity?limit=100${cursor?`&cursor=${cursor}`:""}`,admin);
      ids.push(...page.activity.map(row=>row.id));cursor=page.page.nextCursor;}while(cursor);
    assert.equal(ids.length,605);assert.equal(new Set(ids).size,605);assert.equal(ids.at(-1),"activity-0000");
    for(const [type,action] of [["denied","Denied:"],["user","Reset user PIN"],["data","Inventory updated"]]){
      const query=new URLSearchParams({type,q:action,from:"2026-10-01T05:00:00.000Z",through:"2026-10-02T05:00:00.000Z"});
      const page=await read(`/api/activity?${query}`,admin);assert.equal(page.activity.length,100);
      assert.ok(page.activity.every(row=>row.action.startsWith(action)));assert.ok(page.page.nextCursor);
    }
    await tracker.database.prepare(`INSERT INTO app_change_log(id,user_name,action,created_at) VALUES
      ('inclusive','boundary','Inventory updated','2026-10-01T05:00:00Z'),
      ('exclusive','boundary','Inventory updated','2026-10-02T05:00:00Z')`).run();
    const query=new URLSearchParams({q:"boundary",from:"2026-10-01T05:00:00.000Z",through:"2026-10-02T05:00:00.000Z"});
    assert.deepEqual((await read(`/api/activity?${query}`,admin)).activity.map(row=>row.id),["inclusive"]);
    for(const query of ["type=bad","status=Pending","from=2026-02-30T00:00:00.000Z","cursor=e30"])
      assert.equal((await call(staff,`/api/activity?${query}`,admin)).status,400);
  });
  await t.test("every cursor page retains staff, admin and bearer checks, including revocation",async()=>{
    const page=await read("/api/service-requests?limit=2");
    const url=`/api/service-requests?limit=2&cursor=${page.page.nextCursor}`;
    assert.equal((await call(staff,url)).status,401);
    assert.equal((await fetch(`${qr.url}/api/requests?limit=2&cursor=${page.page.nextCursor}`)).status,401);
    assert.equal((await call(staff,"/api/activity?cursor=e30")).status,401);
    assert.equal((await call(staff,"/api/activity?cursor=e30",regular)).status,403);
    assert.equal((await call(staff,"/api/auth",regular,"DELETE")).status,200);
    assert.equal((await call(staff,url,regular)).status,401);
  });
});
