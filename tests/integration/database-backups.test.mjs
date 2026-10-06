import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@tanmar/database";
import { backupDatabases, configuration, restoreDatabases } from "../../scripts/postgresql-backups.mjs";
import { provisionAdmin } from "../../scripts/admin-provisioning.mjs";
import { createPostgresFixture } from "../helpers/postgres.mjs";
import { serviceFingerprint } from "../../lib/service-protocol.ts";
import { snapshot } from "../helpers/service-fixture.mjs";
import { inventory, batch, history, when } from "../helpers/inventory-fixture.mjs";
import { startNext, unusedPort } from "../helpers/next-server.mjs";

// Actual pg_dump/pg_restore and restricted PostgreSQL roles. All source/target
// databases are randomly named fixtures on the dedicated synthetic local cluster.
test("complete PostgreSQL backup and isolated restore",{timeout:120000},async t=>{
  const fixtures=[],servers=[];
  const directory=await mkdtemp(path.join(os.tmpdir(),"assettracker-backup-integration-"));
  let admin,backupRoleCreated=false;
  const backupRole=`assettracker_backup_test_${randomUUID().replaceAll("-","")}`;
  t.after(async()=>{
    for(const server of servers.reverse())await server.close();
    for(const fixture of fixtures.reverse())await fixture.close();
    // Invalid test URLs must fail the fixture guard before an admin connection
    // or cleanup SQL can run. Drop only the role this drill actually created.
    if(backupRoleCreated)await admin.prepare(`DROP ROLE "${backupRole}"`).run();
    await admin?.close();
    await rm(directory,{recursive:true,force:true});
  });
  const fixture=async(app,empty=false)=>{const item=await createPostgresFixture(app,{empty});fixtures.push(item);return item;};
  const tracker=await fixture("tracker"),requests=await fixture("requests");
  admin=createDatabase(process.env.TEST_DATABASE_URL);
  await admin.prepare(`CREATE ROLE "${backupRole}" LOGIN`).run();
  backupRoleCreated=true;
  for(const source of [tracker,requests]){
    await source.database.prepare(`GRANT CONNECT ON DATABASE "${new URL(source.ownerUrl).pathname.slice(1)}" TO "${backupRole}"`).run();
    await source.database.prepare(`GRANT USAGE ON SCHEMA public TO "${backupRole}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${backupRole}"`).run();
  }
  const serviceFile=path.join(directory,"services.conf"),passFile=path.join(directory,"passfile");
  const services={};
  async function addService(name,source,username){
    const url=new URL(source.ownerUrl);
    services[name]=`[${name}]\nhost=${url.searchParams.get("host")||url.hostname}\nport=${url.port||5432}\ndbname=${url.pathname.slice(1)}\nuser=${username||url.username}\n`;
    await writeFile(serviceFile,Object.values(services).join("\n"),{mode:0o600});
  }
  await writeFile(passFile,"",{mode:0o600});
  await addService("tracker_backup",tracker,backupRole);await addService("requests_backup",requests,backupRole);
  const baseEnv={PGSERVICEFILE:serviceFile,PGPASSFILE:passFile,TRACKER_BACKUP_SERVICE:"tracker_backup",REQUESTS_BACKUP_SERVICE:"requests_backup",BACKUP_TIMEOUT_SECONDS:"30"};
  const backupConfig=await configuration(baseEnv),backupRoot=path.join(directory,"sets");
  const targets=async()=>{
    const trackerTarget=await fixture("tracker",true),requestsTarget=await fixture("requests",true);
    await addService("tracker_restore",trackerTarget);await addService("requests_restore",requestsTarget);
    const config=await configuration({...baseEnv,TRACKER_RESTORE_SERVICE:"tracker_restore",REQUESTS_RESTORE_SERVICE:"requests_restore",
      TRACKER_RESTORE_RUNTIME_ROLE:new URL(trackerTarget.url).username,REQUESTS_RESTORE_RUNTIME_ROLE:new URL(requestsTarget.url).username},"restore");
    return {trackerTarget,requestsTarget,config};
  };
  const state=inventory();state.rentalStock.batches=[batch(state)];state.receiverEvents=[history("backup-event")];
  // Real structured audit data and leading-zero identifiers survive the JSONB
  // archive, along with account PIN hashes, history and owner-only draft payloads.
  state.auditState={fileName:"synthetic.csv",importedAt:when,results:[]};
  await provisionAdmin(tracker.database,{name:"testadmin",pin:"482631"});
  const user=await tracker.database.prepare("SELECT * FROM app_users WHERE name='testadmin'").first();
  const oldToken=randomBytes(32).toString("hex");
  await tracker.database.prepare("INSERT INTO app_sessions VALUES ($1,$2,$3,$4,$5)")
    .bind(randomUUID(),user.id,createHash("sha256").update(oldToken).digest("hex"),new Date(Date.now()+3600000).toISOString(),when).run();
  await tracker.database.prepare("INSERT INTO app_state VALUES ('tanmar-receiver-control',$1,2,$2,'testadmin')").bind(JSON.stringify(state),when).run();
  await tracker.database.prepare("INSERT INTO app_state_history VALUES ($1,1,$2,'Before synthetic backup',$3,'testadmin')").bind(randomUUID(),JSON.stringify(inventory()),when).run();
  await tracker.database.prepare("INSERT INTO app_change_log VALUES ($1,$2,'testadmin','Synthetic data setup',2,$3)").bind(randomUUID(),user.id,when).run();
  await tracker.database.prepare("INSERT INTO app_inventory_drafts VALUES ($1,$2,1,2,$3,$3,'Synthetic paused copy','active',now(),now()+interval '7 days')")
    .bind(randomUUID(),user.id,JSON.stringify(state)).run();
  await requests.database.prepare(`INSERT INTO service_requests (id,asset_id,asset_number,account_number,requester_name,requester_phone,error_code,latitude,longitude,gps_accuracy,gps_captured_at,requested_at)
    VALUES ('synthetic-request','receiver-0','TEST-0','000001','Synthetic requester','555-0100','771',31.9,-102.2,10,$1,$1)`).bind(when).run();
  await requests.database.prepare("INSERT INTO request_rate_limits VALUES ('synthetic-rate-bucket',3,4102444800)").run();
  // A split backup may contain a pending tracker intent and an already committed
  // QR receipt. Restore preserves both and pauses automatic writes for review.
  const operationId=randomUUID(),command={operationId,id:"synthetic-request",kind:"status",status:"Completed",notes:"Recovered note",expectedVersion:1};
  const fingerprint=serviceFingerprint(command),receipt={operationId,requestId:command.id,fingerprint,outcome:"applied",reason:"",appliedAt:when,deleted:false,request:{...snapshot(),id:command.id,notes:command.notes}};
  await tracker.database.prepare(`INSERT INTO app_service_operations(id,request_id,kind,target_status,notes,expected_version,fingerprint,actor_id,actor_name,approver_id,approver_name,receiver_id,receiver_baseline,snapshot,created_at,updated_at)
    VALUES($1,$2,'status','Completed',$3,1,$4,$5,'testadmin',$5,'testadmin','receiver-0',$6::jsonb,$7::jsonb,$8,$8)`)
    .bind(operationId,command.id,command.notes,fingerprint,user.id,JSON.stringify({rentState:"Off Rent",offRentSince:state.master[0].offRentSince}),JSON.stringify({...receipt.request,status:"Pending",version:1,completedAt:null}),when).run();
  await requests.database.prepare("UPDATE service_requests SET status='Completed',version=2,notes=$1,completed_at=$2 WHERE id=$3").bind(command.notes,when,command.id).run();
  await requests.database.prepare("INSERT INTO service_request_operations VALUES($1,$2,$3,$4::jsonb,$5)").bind(operationId,command.id,fingerprint,JSON.stringify(receipt),when).run();
  let set,manifest;

  await t.test("read-only sources produce private, complete archives with matching snapshot evidence",async()=>{
    set=await backupDatabases(backupConfig,backupRoot);
    manifest=JSON.parse(await readFile(path.join(set,"manifest.json"),"utf8"));
    assert.equal(manifest.version,1);assert.equal(manifest.databases.tracker.tables.length,8);assert.equal(manifest.databases.requests.tables.length,4);
    for(const app of ["tracker","requests"]){
      const record=manifest.databases[app];assert.equal(record.identity.user,backupRole);assert.match(record.sha256,/^[a-f0-9]{64}$/);
      assert.ok(record.tables.every(table=>Number(table.rows)>0));
      assert.equal((await lstat(path.join(set,`${app}.dump`))).mode&0o077,0);
    }
    assert.equal((await lstat(set)).mode&0o077,0);assert.equal((await lstat(path.join(set,"manifest.json"))).mode&0o077,0);
    assert.equal((await readdir(backupRoot)).some(name=>name.startsWith(".partial-")),false);
  });
  await t.test("restore verifies both databases and preserves private records while revoking old sessions",async()=>{
    const {trackerTarget,requestsTarget,config}=await targets();
    const result=await restoreDatabases(config,set);assert.equal(result.sessionsRevoked,true);
    const restored=(await trackerTarget.database.prepare("SELECT payload FROM app_state").first()).payload;
    assert.deepEqual(restored,state);assert.equal(restored.accounts[0].number,"000001");assert.equal(restored.master[0].accessCard,"0000");
    assert.equal((await trackerTarget.database.prepare("SELECT pin_hash FROM app_users").first()).pin_hash,user.pin_hash);
    assert.equal(Number((await trackerTarget.database.prepare("SELECT count(*) AS total FROM app_sessions").first()).total),0);
    assert.equal((await trackerTarget.database.prepare("SELECT draft_state FROM app_inventory_drafts").first()).draft_state.accounts[0].number,"000001");
    assert.equal(Number((await trackerTarget.database.prepare("SELECT count(*) AS total FROM app_state_history").first()).total),1);
    assert.ok(await trackerTarget.database.prepare("SELECT id FROM app_change_log WHERE action='Restored database; previous sessions revoked'").first());
    const restoredOperation=await trackerTarget.runtime.prepare("SELECT * FROM app_service_operations").first();
    assert.equal(restoredOperation.id,operationId);assert.equal(restoredOperation.fingerprint,fingerprint);
    assert.equal(restoredOperation.phase,"blocked");assert.equal(restoredOperation.error_code,"restore_review");
    assert.deepEqual((await requestsTarget.runtime.prepare("SELECT result FROM service_request_operations").first()).result,receipt);
    const request=await requestsTarget.runtime.prepare("SELECT * FROM service_requests").first();
    assert.equal(request.account_number,"000001");assert.equal(request.requester_phone,"555-0100");assert.equal(request.latitude,31.9);
    assert.equal((await requestsTarget.runtime.prepare("SELECT hits FROM request_rate_limits").first()).hits,3);
    await trackerTarget.runtime.prepare("SELECT * FROM app_users").all();
    await assert.rejects(trackerTarget.runtime.prepare("SELECT * FROM schema_migrations").all());
    await assert.rejects(trackerTarget.runtime.prepare("CREATE TABLE denied (id text)").run());
    await assert.rejects(requestsTarget.runtime.prepare("CREATE TABLE denied (id text)").run());
    // The restored applications actually start under restricted roles. Existing
    // accounts can sign in again, and both health endpoints see restored schema.
    const secret=randomUUID(),qrPort=await unusedPort();
    const staff=await startNext(fileURLToPath(new URL("../../",import.meta.url)),{DATABASE_URL:trackerTarget.url,ADMIN_SHARED_SECRET:secret,SERVICE_REQUEST_API_URL:`http://127.0.0.1:${qrPort}/api/requests`});servers.push(staff);
    const qr=await startNext(fileURLToPath(new URL("../../service-request/",import.meta.url)),{DATABASE_URL:requestsTarget.url,ADMIN_SHARED_SECRET:secret,TRACKER_ASSET_API_URL:`${staff.url}/api/service-assets`},{port:qrPort});servers.push(qr);
    assert.equal((await fetch(`${staff.url}/api/health`)).status,200);assert.equal((await fetch(`${qr.url}/api/health`)).status,200);
    const login=await fetch(`${staff.url}/api/auth`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",name:"testadmin",pin:"482631"})});
    assert.equal(login.status,200);
    assert.equal((await fetch(`${staff.url}/api/app-state`,{headers:{cookie:`tanmar_session=${oldToken}`}})).status,401);
    const response=await fetch(`${staff.url}/api/app-state`,{headers:{cookie:login.headers.get("set-cookie").split(";")[0]}});
    assert.equal(response.status,200);assert.deepEqual((await response.json()).state,state);
    const drafts=await fetch(`${staff.url}/api/drafts`,{headers:{cookie:login.headers.get("set-cookie").split(";")[0]}});
    assert.equal(drafts.status,200);assert.equal((await drafts.json()).drafts.length,1);
    const listed=await fetch(`${qr.url}/api/requests`,{headers:{authorization:`Bearer ${secret}`}});
    assert.equal(listed.status,200);assert.equal((await listed.json()).requests[0].accountNumber,"000001");
  });
  await t.test("nonempty/live-name destinations are refused before any restore or source change",async()=>{
    const {trackerTarget,requestsTarget,config}=await targets();
    await requestsTarget.database.prepare("CREATE TABLE existing_data (id text); INSERT INTO existing_data VALUES ('KEEP-THIS')").run();
    await assert.rejects(restoreDatabases(config,set),/not empty/);
    assert.equal(await trackerTarget.database.prepare("SELECT to_regclass('app_users') AS table_name").first().then(row=>row.table_name),null);
    assert.equal((await requestsTarget.database.prepare("SELECT id FROM existing_data").first()).id,"KEEP-THIS");
    await addService("tracker_restore",tracker);await assert.rejects(restoreDatabases(config,set),/new assettracker_restore/);
    assert.equal((await tracker.database.prepare("SELECT revision FROM app_state").first()).revision,2);
  });
  await t.test("tampered archives/metadata and public artifact permissions fail before destination writes",async()=>{
    const {trackerTarget,config}=await targets(),archive=path.join(set,"requests.dump"),original=await readFile(archive);
    await writeFile(archive,"CORRUPT-ARCHIVE");
    await assert.rejects(restoreDatabases(config,set),/checksum/);await writeFile(archive,original);
    const file=path.join(set,"manifest.json"),text=await readFile(file,"utf8"),altered=JSON.parse(text);
    altered.databases.tracker.file="../escape.dump";await writeFile(file,JSON.stringify(altered));
    await assert.rejects(restoreDatabases(config,set),/manifest entry/);await writeFile(file,text);
    await chmod(archive,0o644);await assert.rejects(restoreDatabases(config,set),/inaccessible/);await chmod(archive,0o600);
    assert.equal((await trackerTarget.database.prepare("SELECT to_regclass('app_users') AS table_name").first()).table_name,null);
  });
  await t.test("a failed second dump or wrong migration history never publishes a partial backup pair",async()=>{
    const before=await readdir(backupRoot);
    await assert.rejects(backupDatabases({...backupConfig,services:{tracker:"tracker_backup",requests:"tracker_backup"}},backupRoot),/requests schema/);
    assert.deepEqual(await readdir(backupRoot),before);
    await requests.database.prepare("UPDATE schema_migrations SET checksum='synthetic-wrong-checksum' WHERE name='requests/0001_initial.sql'").run();
    await assert.rejects(backupDatabases(backupConfig,backupRoot),/migration history/);
    assert.deepEqual(await readdir(backupRoot),before);
    await requests.database.prepare("UPDATE schema_migrations SET checksum=$1 WHERE name='requests/0001_initial.sql'").bind(manifest.databases.requests.migrations[0].checksum).run();
  });
  await t.test("changed row-count evidence is rejected after restore and runtime roles stay disconnected",async()=>{
    const {trackerTarget,config}=await targets(),file=path.join(set,"manifest.json"),text=await readFile(file,"utf8"),altered=JSON.parse(text);
    altered.databases.tracker.tables.find(table=>table.name==="app_users").rows="999";
    await writeFile(file,JSON.stringify(altered));
    try{await assert.rejects(restoreDatabases(config,set),/verification failed/);}finally{await writeFile(file,text);}
    assert.ok(await trackerTarget.database.prepare("SELECT id FROM app_users").first());
    await assert.rejects(trackerTarget.runtime.prepare("SELECT * FROM app_users").all());
    assert.equal((await tracker.database.prepare("SELECT revision FROM app_state").first()).revision,2);
  });
  await t.test("privileged runtime roles and default public grants cannot enter the restore workflow",async()=>{
    const first=await targets(),role=new URL(first.trackerTarget.url).username;
    await admin.prepare(`GRANT "${backupRole}" TO "${role}"`).run();
    await assert.rejects(restoreDatabases(first.config,set),/restricted login/);
    assert.equal((await first.trackerTarget.database.prepare("SELECT to_regclass('app_users') AS table_name").first()).table_name,null);
    const second=await targets();
    await second.trackerTarget.database.prepare("ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO PUBLIC").run();
    await assert.rejects(restoreDatabases(second.config,set),/default privilege/);
    assert.equal((await second.trackerTarget.database.prepare("SELECT to_regclass('app_users') AS table_name").first()).table_name,null);
  });
  await t.test("continuing source writes do not invalidate the exported snapshot or its restore proof",async()=>{
    const {trackerTarget,config}=await targets();let done=false,changes=0;
    const updating=(async()=>{
      while(!done){
        await tracker.database.transaction(async store=>{
          await store.prepare("UPDATE app_state SET revision=revision+1,payload=jsonb_set(payload,'{master,0,notes}',to_jsonb($1::text))").bind(`Concurrent synthetic edit ${changes}`).run();
          await store.prepare("INSERT INTO app_change_log (id,user_name,action,created_at) VALUES ($1,'Synthetic writer','Concurrent source edit',$2)").bind(randomUUID(),new Date().toISOString()).run();
        });
        changes++;await new Promise(resolve=>setTimeout(resolve,10));
      }
    })();
    let concurrent;
    try{concurrent=await backupDatabases(backupConfig,backupRoot);}finally{done=true;await updating;}
    assert.ok(changes>1);
    await restoreDatabases(config,concurrent);
    const restored=await trackerTarget.database.prepare("SELECT revision FROM app_state").first(),current=await tracker.database.prepare("SELECT revision FROM app_state").first();
    assert.ok(current.revision>restored.revision,"The source advanced beyond the restored snapshot while backups were running");
  });
});
