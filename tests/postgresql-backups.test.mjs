import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backupDatabases, configuration, runPg } from "../scripts/postgresql-backups.mjs";

async function privateConfig(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(),"assettracker-backup-unit-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const service = path.join(directory,"services.conf"),pass = path.join(directory,"passfile");
  await writeFile(service,"[synthetic]\n",{mode:0o600});await writeFile(pass,"",{mode:0o600});
  const env = {PGSERVICEFILE:service,PGPASSFILE:pass,TRACKER_BACKUP_SERVICE:"tracker_synthetic",REQUESTS_BACKUP_SERVICE:"requests_synthetic"};
  return {directory,service,pass,env};
}
test("operator configuration requires private files and excludes inherited connection/password overrides",async t=>{
  const fixture = await privateConfig(t);
  const config = await configuration({...fixture.env,PGPASSWORD:"SYNTHETIC-SECRET",PGHOST:"unapproved",PGDATABASE:"unapproved",DATABASE_URL:"SYNTHETIC-URL",PGOPTIONS:"unapproved"});
  assert.equal(config.baseEnv.PGPASSWORD,undefined);assert.equal(config.baseEnv.PGHOST,undefined);
  assert.equal(config.baseEnv.PGDATABASE,undefined);assert.equal(config.baseEnv.DATABASE_URL,undefined);assert.equal(config.baseEnv.PGOPTIONS,undefined);
  assert.equal(config.baseEnv.PGPASSFILE,fixture.pass);
  for(const value of ["x;injection","tracker source",undefined]) await assert.rejects(configuration({...fixture.env,TRACKER_BACKUP_SERVICE:value}));
  await assert.rejects(configuration({...fixture.env,REQUESTS_BACKUP_SERVICE:fixture.env.TRACKER_BACKUP_SERVICE}),/separate/);
  await chmod(fixture.pass,0o644);await assert.rejects(configuration(fixture.env),/inaccessible/);
});
test("operator tools refuse symlinked credentials and shared or repository backup directories",async t=>{
  const fixture = await privateConfig(t),link = path.join(fixture.directory,"linked.conf");
  await symlink(fixture.service,link);await assert.rejects(configuration({...fixture.env,PGSERVICEFILE:link}));
  const config = await configuration(fixture.env);
  await chmod(fixture.directory,0o755);await assert.rejects(backupDatabases(config,fixture.directory),/inaccessible/);
  await chmod(fixture.directory,0o700);
  const directoryLink = path.join(fixture.directory,"linked-directory");await symlink(fixture.directory,directoryLink);
  await assert.rejects(backupDatabases(config,directoryLink));
  const forbidden = fileURLToPath(new URL("../backup-unit-must-not-create",import.meta.url));
  await assert.rejects(backupDatabases(config,forbidden),/outside/);
  await assert.rejects(lstat(forbidden),{code:"ENOENT"});
});
test("failed and warning PostgreSQL diagnostics cannot expose submitted private data",async()=>{
  const config = {baseEnv:{PATH:process.env.PATH},timeout:2000};
  for(const code of [0,1]) {
    await assert.rejects(runPg(process.execPath,["-e",`process.stderr.write('SYNTHETIC-PRIVATE-DATA');process.exit(${code})`],config),error=>{
      assert.match(error.message,/failed or reported diagnostics/);assert.equal(error.message.includes("SYNTHETIC-PRIVATE-DATA"),false);return true;
    });
  }
});
test("operator subprocess timeouts terminate stalled commands without automatic retry",async()=>{
  const started = Date.now();
  await assert.rejects(runPg(process.execPath,["-e","setInterval(()=>{},1000)"],{baseEnv:{PATH:process.env.PATH},timeout:100}),/failed/);
  assert.ok(Date.now()-started<3000);
});
test("operator cancellation terminates child processes and reports a redacted interruption",async()=>{
  const controller=new AbortController();
  const work=runPg(process.execPath,["-e","setInterval(()=>{},1000)"],{baseEnv:{PATH:process.env.PATH},timeout:5000,signal:controller.signal});
  setTimeout(()=>controller.abort(),50);await assert.rejects(work,/interrupted/);
});
test("backup CLI never echoes private filesystem or JSON errors",async t=>{
  const fixture = await privateConfig(t),cli = fileURLToPath(new URL("../scripts/backup-databases.mjs",import.meta.url));
  // Exercise actual CLI redaction, including filesystem paths that could contain
  // operator-supplied sensitive text. Capture stderr outside runPg's redaction.
  const {spawn} = await import("node:child_process");
  const result = await new Promise(resolve=>{
    const child = spawn(process.execPath,[cli],{env:{...process.env,...fixture.env,PGPASSFILE:path.join(fixture.directory,"SYNTHETIC-SECRET-MISSING"),BACKUP_DIRECTORY:fixture.directory},stdio:["ignore","pipe","pipe"]});
    let output="";child.stdout.on("data",chunk=>output+=chunk);child.stderr.on("data",chunk=>output+=chunk);child.on("close",code=>resolve({code,output}));
  });
  assert.equal(result.code,1);assert.equal(result.output.includes("SYNTHETIC-SECRET"),false);
  await writeFile(path.join(fixture.directory,"manifest.json"),"SYNTHETIC-SECRET-INVALID-JSON",{mode:0o600});
  const restore=fileURLToPath(new URL("../scripts/restore-databases.mjs",import.meta.url));
  const malformed=await new Promise(resolve=>{
    const child=spawn(process.execPath,[restore],{env:{...process.env,...fixture.env,TRACKER_RESTORE_SERVICE:"tracker_restore",REQUESTS_RESTORE_SERVICE:"requests_restore",BACKUP_SET_DIRECTORY:fixture.directory},stdio:["ignore","pipe","pipe"]});
    let output="";child.stdout.on("data",chunk=>output+=chunk);child.stderr.on("data",chunk=>output+=chunk);child.on("close",code=>resolve({code,output}));
  });
  assert.equal(malformed.code,1);assert.equal(malformed.output.includes("SYNTHETIC-SECRET"),false);
  assert.deepEqual((await readFile(fixture.pass,"utf8")),"");
});
