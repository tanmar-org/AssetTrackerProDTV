import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Only these reviewed errors may reach operator stdout/stderr.
export class BackupError extends Error {}
export function operatorCancellation() {
  const controller = new AbortController();
  const interrupt = ()=>controller.abort();
  process.on("SIGINT",interrupt);process.on("SIGTERM",interrupt);
  return {signal:controller.signal,close(){process.off("SIGINT",interrupt);process.off("SIGTERM",interrupt);}};
}

const repository = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
export const applications = {
  tracker: ["app_change_log", "app_inventory_drafts", "app_sessions", "app_state", "app_state_history", "app_users"],
  requests: ["request_rate_limits", "service_requests"],
};
const identifier = value => {
  if(typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new BackupError("Invalid database object name.");
  return `"${value}"`;
};
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const inside = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

// All credential files and artifacts must be private regular files/directories.
// Do not quietly chmod a caller's shared directory or follow a symlink into it.
async function privatePath(filename, directory = false) {
  if(!path.isAbsolute(filename || "")) throw new BackupError("Use absolute operator paths.");
  const info = await lstat(filename);
  if(info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) ||
    (info.mode & 0o077) || info.uid !== process.getuid()) throw new BackupError("Operator files/directories must be owned by this user and inaccessible to group/others.");
  const resolved = await realpath(filename);
  if(inside(repository, resolved)) throw new BackupError("Store credentials and database backups outside the repository/web directory.");
  return resolved;
}
export async function configuration(env = process.env, mode = "backup") {
  const serviceFile = await privatePath(env.PGSERVICEFILE), passFile = await privatePath(env.PGPASSFILE);
  const timeout = Number(env.BACKUP_TIMEOUT_SECONDS || 600);
  if(!Number.isInteger(timeout) || timeout < 1 || timeout > 7200) throw new BackupError("BACKUP_TIMEOUT_SECONDS must be 1–7200.");
  const services = {};
  for(const app of Object.keys(applications)) {
    const service = env[`${app.toUpperCase()}_${mode.toUpperCase()}_SERVICE`];
    if(typeof service !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{1,63}$/.test(service)) throw new BackupError(`Configure the ${app} ${mode} service.`);
    services[app] = service;
  }
  if(services.tracker === services.requests) throw new BackupError("Use separate application services.");
  // libpq reads passwords from a protected file. Inherited PGDATABASE/PGHOST/
  // PGPASSWORD and application URLs cannot redirect or expose the selected source.
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8", LC_ALL: "C.UTF-8",
    PGSERVICEFILE: serviceFile, PGPASSFILE: passFile, PGCONNECT_TIMEOUT: "10", PGAPPNAME: "assettracker-operator-backup" };
  return { services, baseEnv, timeout: timeout * 1000, runtimeRoles: {
    tracker: env.TRACKER_RESTORE_RUNTIME_ROLE, requests: env.REQUESTS_RESTORE_RUNTIME_ROLE,
  } };
}

// Never print PostgreSQL stderr: errors can contain row values, connection data
// or SQL from a restored archive. Every failure is stage-specific and redacted.
export function runPg(tool, args, config, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(tool, args, { env: config.baseEnv, signal:config.signal,killSignal:"SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
    let output = "", diagnostic = false, failed = false;
    const timer = setTimeout(()=>{failed = true;child.kill("SIGKILL");},config.timeout);
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if(Buffer.byteLength(output) > 4 * 1024 * 1024){failed = true;child.kill("SIGKILL");}
    });
    child.stderr.on("data",()=>{diagnostic = true;});
    child.stdin.on("error",()=>{});
    child.on("error",()=>{clearTimeout(timer);reject(new BackupError(config.signal?.aborted ? "Operator job interrupted; keep recovery destinations offline." : `${tool} could not start. Check the operator tools privately.`));});
    child.on("close",code=>{
      clearTimeout(timer);
      if(code !== 0 || diagnostic || failed) reject(new BackupError(`${tool} failed or reported diagnostics. Check access, tool versions, storage and time limits privately.`));
      else resolve(output);
    });
    child.stdin.end(input);
  });
}

// Keep a read-only exported snapshot alive across manifest queries and pg_dump.
// The manifest's counts/fingerprints describe exactly the dumped snapshot even
// when employees keep writing. Separate databases still have separate snapshots.
class Snapshot {
  constructor(service, config) {
    this.child = spawn("psql", ["--no-psqlrc", "--quiet", "--no-align", "--tuples-only", "--no-password", "--set=ON_ERROR_STOP=1", `--dbname=service=${service}`],
      { env: config.baseEnv, signal:config.signal,killSignal:"SIGKILL", stdio: ["pipe", "pipe", "pipe"] });
    this.buffer = "";this.pending = null;this.failed = false;
    this.timer = setTimeout(()=>this.fail(),config.timeout);
    this.closed = new Promise(resolve=>this.child.on("close",()=>{this.fail();resolve();}));
    this.child.on("error",()=>this.fail());this.child.stdin.on("error",()=>this.fail());
    this.child.stderr.on("data",()=>this.fail());
    this.child.stdout.on("data",chunk=>{
      this.buffer += chunk.toString();
      if(Buffer.byteLength(this.buffer) > 4 * 1024 * 1024){this.fail();return;}
      let newline;
      while((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0,newline);this.buffer = this.buffer.slice(newline+1);
        if(this.pending && line.startsWith(this.pending.marker)) {
          const pending = this.pending;this.pending = null;
          try{pending.resolve(JSON.parse(line.slice(pending.marker.length)));}catch{pending.reject(new BackupError("Invalid PostgreSQL verification response."));}
        }
      }
    });
  }
  fail() {
    this.failed = true;this.child.kill("SIGKILL");
    this.pending?.reject(new BackupError("PostgreSQL snapshot failed. Check operator access and time limits privately."));this.pending = null;
  }
  query(expression, prefix = "") {
    if(this.failed || this.pending) return Promise.reject(new BackupError("PostgreSQL snapshot is unavailable."));
    return new Promise((resolve,reject)=>{
      const marker = `ATP_${randomUUID()}:`;
      this.pending = {marker,resolve,reject};
      this.child.stdin.write(`${prefix}\nSELECT ${literal(marker)} || (${expression})::text;\n`);
    });
  }
  async close(){clearTimeout(this.timer);this.child.kill("SIGKILL");await this.closed;}
}

const identitySql = `json_build_object('database',current_database(),'owner',pg_get_userbyid((SELECT datdba FROM pg_database WHERE datname=current_database())),
  'user',current_user,'serverVersion',current_setting('server_version_num')::integer,
  'settings',(SELECT json_build_object('encoding',pg_encoding_to_char(encoding),'collate',datcollate,'ctype',datctype,
    'provider',datlocprovider,'locale',datlocale,'collationVersion',datcollversion,'actualCollationVersion',pg_database_collation_actual_version(oid))
    FROM pg_database WHERE datname=current_database()))`;
const catalogSql = `json_build_object(
  'tables',(SELECT coalesce(json_agg(c.relname ORDER BY c.relname),'[]'::json) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'),
  'columns',(SELECT coalesce(json_agg(json_build_array(c.relname,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum),'[]'::json)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped),
  -- Minimal parentheses preserve operator precedence without treating equivalent
  -- nested AND groups as schema corruption after PostgreSQL reparses the dump.
  'constraints',(SELECT coalesce(json_agg(json_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid,true)) ORDER BY c.relname,k.conname),'[]'::json)
    FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
  'indexes',(SELECT coalesce(json_agg(json_build_array(tablename,indexname,indexdef) ORDER BY tablename,indexname),'[]'::json) FROM pg_indexes WHERE schemaname='public'),
  'unsupported',(SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%')
    +(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind NOT IN ('r','i'))
    +(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public')
    +(SELECT count(*) FROM pg_extension WHERE extname<>'plpgsql')
    +(SELECT count(*) FROM pg_largeobject_metadata)
)`;
async function migrations(app) {
  const directory = new URL(`../migrations/${app}/`,import.meta.url);
  return Promise.all((await readdir(directory)).filter(name=>/^\d+_.*\.sql$/.test(name)).sort().map(async name=>({
    name:`${app}/${name}`,checksum:createHash("sha256").update(await readFile(new URL(name,directory))).digest("hex"),
  })));
}
async function inventory(snapshot, app) {
  const schema = await snapshot.query(catalogSql);
  if(schema.unsupported !== 0 || JSON.stringify(schema.tables) !== JSON.stringify([...applications[app],"schema_migrations"].sort()))
    throw new BackupError(`${app} schema is unsupported or belongs to a different application. No backup/restore is declared complete.`);
  const history = await snapshot.query(`(SELECT json_agg(json_build_object('name',name,'checksum',checksum) ORDER BY name) FROM schema_migrations)`);
  if(JSON.stringify(history) !== JSON.stringify(await migrations(app))) throw new BackupError(`${app} migration history does not match this code checkout.`);
  // Sort per-row hashes so physical row order does not affect restore checks.
  // This MD5 fingerprint is a content comparison, not an authenticity guarantee;
  // private trusted archives also carry an independent SHA-256 file checksum.
  const tables = [];
  for(const table of schema.tables) {
    const data = await snapshot.query(`(SELECT json_build_object('name',${literal(table)},'rows',count(*)::text,
      'fingerprint',md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' ORDER BY md5(to_jsonb(t)::text)),''))) FROM public.${identifier(table)} t)`);
    tables.push(data);
  }
  return {schema,migrations:history,tables};
}
async function digest(filename) {
  const hash = createHash("sha256");
  for await(const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}
async function writePrivate(filename, data) {
  const file = await open(filename,"wx",0o600);
  try{await file.writeFile(data);await file.sync();}finally{await file.close();}
}
async function syncDirectory(directory) {
  const handle = await open(directory,"r");try{await handle.sync();}finally{await handle.close();}
}
async function backupDirectory(directory) {
  if(!path.isAbsolute(directory || "")) throw new BackupError("Use an absolute backup directory outside the repository.");
  directory = path.resolve(directory);
  let existing = directory;
  while(true) {
    try{await lstat(existing);break;}catch(error){if(error.code !== "ENOENT") throw error;existing = path.dirname(existing);}
  }
  const resolved = path.resolve(await realpath(existing),path.relative(existing,directory));
  if(inside(repository,resolved)) throw new BackupError("Store backups outside the repository/web directory.");
  await mkdir(directory,{recursive:true,mode:0o700});
  return privatePath(directory,true);
}

export async function backupDatabases(config, directory) {
  directory = await backupDirectory(directory);
  const id = `backup-${new Date().toISOString().replaceAll(":","-")}-${randomUUID()}`;
  const temporary = path.join(directory,`.partial-${randomUUID()}`), destination = path.join(directory,id);
  await mkdir(temporary,{mode:0o700});
  const manifest = {version:1,createdAt:new Date().toISOString(),databases:{}};
  try {
    const toolVersion = (await runPg("pg_dump",["--version"],config)).trim();
    const toolMajor = Number(toolVersion.match(/PostgreSQL\) (\d+)\./)?.[1]);
    if(!toolMajor) throw new BackupError("Could not verify pg_dump version.");
    manifest.pgDumpVersion = toolVersion;
    for(const app of Object.keys(applications)) {
      const snapshot = new Snapshot(config.services[app],config);
      try {
        const identity = await snapshot.query(identitySql,"BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL lock_timeout='10s';");
        if(Math.floor(identity.serverVersion/10000) !== toolMajor) throw new BackupError("Use pg_dump matching the source PostgreSQL major version.");
        if(identity.settings.collationVersion !== identity.settings.actualCollationVersion) throw new BackupError("Source collation version changed; operator reconciliation is required before backup verification.");
        const snapshotId = await snapshot.query("to_json(pg_export_snapshot())");
        if(!/^[0-9A-Fa-f-]+$/.test(snapshotId)) throw new BackupError("Invalid exported snapshot.");
        const contents = await inventory(snapshot,app);
        const filename = `${app}.dump`, filePath = path.join(temporary,filename);
        // Precreate private files so an operator's permissive umask cannot expose
        // hashes, contact/GPS data or inventory while pg_dump is writing.
        await writePrivate(filePath,"");
        await runPg("pg_dump",["--no-password","--format=custom","--lock-wait-timeout=10s",`--snapshot=${snapshotId}`,`--file=${filePath}`,`--dbname=service=${config.services[app]}`],config);
        const file = await open(filePath,"r+");try{await file.sync();}finally{await file.close();}
        await runPg("pg_restore",["--list",filePath],config);
        manifest.databases[app] = {file:filename,sha256:await digest(filePath),identity,...contents};
      } finally {await snapshot.close();}
    }
    if(manifest.databases.tracker.identity.database === manifest.databases.requests.identity.database)
      throw new BackupError("Application databases must have distinct names.");
    await writePrivate(path.join(temporary,"manifest.json"),`${JSON.stringify(manifest,null,2)}\n`);
    // Publish the pair only after both dumps, hashes and archive checks succeed.
    await syncDirectory(temporary);
    config.signal?.throwIfAborted();
    await rename(temporary,destination);await syncDirectory(directory);
    return destination;
  } catch(error) {await rm(temporary,{recursive:true,force:true});throw error;}
}

async function psql(service, config, sql) {
  return runPg("psql",["--no-psqlrc","--quiet","--no-align","--tuples-only","--no-password","--set=ON_ERROR_STOP=1",`--dbname=service=${service}`],config,sql);
}
export async function restoreDatabases(config, directory) {
  directory = await privatePath(directory,true);
  const manifestPath = await privatePath(path.join(directory,"manifest.json"));
  if((await lstat(manifestPath)).size > 1024*1024) throw new BackupError("Backup manifest is too large.");
  const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
  if(manifest.version !== 1 || !manifest.databases) throw new BackupError("Unsupported backup manifest.");
  const targets = {},archives = {},guards = [];
  let gated = false;
  const assertGuards = ()=>{
    if(config.signal?.aborted || guards.some(guard=>guard.failed)) throw new BackupError("Restore guard lost or job interrupted. Keep recovery destinations offline.");
  };
  try {
    const toolVersion = (await runPg("pg_restore",["--version"],config)).trim();
    const toolMajor = Number(toolVersion.match(/PostgreSQL\) (\d+)\./)?.[1]);
    if(!toolMajor) throw new BackupError("Could not verify pg_restore version.");
    // Validate the entire pair before touching either destination. Restore never
    // uses --clean/--create, drops a database, or writes into an ordinary live name.
    for(const app of Object.keys(applications)) {
      const record = manifest.databases[app];
      if(!record || record.file !== `${app}.dump` || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new BackupError("Invalid backup manifest entry.");
      const expectedTables = [...applications[app],"schema_migrations"].sort();
      if(!record.identity || typeof record.identity.database !== "string" || !record.schema || record.schema.unsupported !== 0 ||
        JSON.stringify(record.schema.tables) !== JSON.stringify(expectedTables) || !Array.isArray(record.tables) ||
        JSON.stringify(record.tables.map(table=>table.name)) !== JSON.stringify(expectedTables) ||
        record.tables.some(table=>!/^\d+$/.test(table.rows) || !/^[a-f0-9]{32}$/.test(table.fingerprint)) ||
        JSON.stringify(record.migrations) !== JSON.stringify(await migrations(app))) throw new BackupError("Backup metadata/migrations do not match this code checkout.");
      const archive = await privatePath(path.join(directory,record.file));
      if(await digest(archive) !== record.sha256) throw new BackupError(`${app} archive checksum does not match. Restore refused.`);
      await runPg("pg_restore",["--list",archive],config);
      archives[app] = archive;
    }
    for(const app of Object.keys(applications)) {
      const record = manifest.databases[app],archive = archives[app];
      const snapshot = new Snapshot(config.services[app],config);
      guards.push(snapshot);
      // Serialize cooperating restores on each new destination. The guard stays
      // alive through verification/grants, and emptiness is checked after waiting.
      let identity = await snapshot.query(identitySql);
      if(!/^assettracker_restore_[a-z0-9_]{1,40}$/.test(identity.database) || identity.database === record.identity?.database || identity.owner !== identity.user)
        throw new BackupError("Restore requires a new assettracker_restore_* database selected by its owner.");
      identity = await snapshot.query(identitySql,"SELECT pg_advisory_lock(728304);");
      if(identity.owner !== identity.user || !/^assettracker_restore_[a-z0-9_]{1,40}$/.test(identity.database)) throw new BackupError("Restore destination ownership/name changed while waiting.");
      if(Math.floor(identity.serverVersion/10000) !== Math.floor(record.identity.serverVersion/10000) || Math.floor(identity.serverVersion/10000) !== toolMajor)
        throw new BackupError("Restore requires source, target and tools with matching PostgreSQL major versions.");
      if(JSON.stringify(identity.settings) !== JSON.stringify(record.identity.settings)) throw new BackupError("Recovery database encoding/locale/collation must match the backup source.");
      const schema = await snapshot.query(catalogSql);
      if(schema.tables.length || schema.unsupported || schema.indexes.length) throw new BackupError("Restore destination is not empty. Existing databases are never overwritten.");
      const privateTarget = await snapshot.query(`to_json(NOT EXISTS (SELECT 1 FROM pg_default_acl) AND NOT EXISTS
        (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename<>current_user))`);
      if(!privateTarget) throw new BackupError("Recovery databases require no default privilege grants or connected non-owner users.");
      const role = config.runtimeRoles[app];identifier(role);
      if(!/^assettracker_restore_[a-z0-9_]{1,40}$/.test(role)) throw new BackupError("Use a dedicated assettracker_restore_* runtime role.");
      const safeRole = await snapshot.query(`(SELECT to_json(count(*)=1) FROM pg_roles WHERE rolname=${literal(role)} AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=pg_roles.oid) AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datdba=pg_roles.oid))`);
      if(!safeRole) throw new BackupError("Restore runtime role must be a restricted login with no role memberships or database ownership.");
      targets[app] = {identity,archive,role};
    }
    if(targets.tracker.identity.database === targets.requests.identity.database || targets.tracker.role === targets.requests.role)
      throw new BackupError("Restore destinations and runtime roles must be separate.");
    gated = true;
    for(const app of Object.keys(applications)) {
      assertGuards();
      const {identity,role} = targets[app];
      await psql(config.services[app],config,`REVOKE ALL ON DATABASE ${identifier(identity.database)} FROM PUBLIC, ${identifier(role)};`);
    }
    for(const app of Object.keys(applications)) {
      assertGuards();
      const target = targets[app];
      await runPg("pg_restore",["--no-password","--no-owner","--no-acl","--single-transaction","--exit-on-error",`--dbname=service=${config.services[app]}`,target.archive],config);
      const snapshot = new Snapshot(config.services[app],config);
      try {
        const actual = await inventory(snapshot,app), expected = manifest.databases[app];
        if(JSON.stringify(actual) !== JSON.stringify({schema:expected.schema,migrations:expected.migrations,tables:expected.tables})) {
          throw new BackupError(`${app} restored schema/data verification failed. Keep both destinations offline.`);
        }
      } finally {await snapshot.close();}
    }
    // Only verified copies receive runtime access. Account data survives, while
    // old cookie sessions do not become valid again after disaster recovery.
    for(const app of Object.keys(applications)) {
      assertGuards();
      const {role} = targets[app];
      await psql(config.services[app],config,`BEGIN;
        ${app === "tracker" ? "DELETE FROM app_sessions; INSERT INTO app_change_log (id,user_name,action,created_at) VALUES ('"+randomUUID()+"','Database operator','Restored database; previous sessions revoked','"+new Date().toISOString()+"');" : ""}
        REVOKE ALL ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO ${identifier(role)};
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, ${identifier(role)};
        GRANT SELECT,INSERT,UPDATE,DELETE ON ${applications[app].map(identifier).join(",")} TO ${identifier(role)}; COMMIT;`);
    }
    for(const app of Object.keys(applications)) {
      assertGuards();
      const {identity,role} = targets[app];
      await psql(config.services[app],config,`GRANT CONNECT ON DATABASE ${identifier(identity.database)} TO ${identifier(role)};`);
    }
    return {version:1,verifiedAt:new Date().toISOString(),sessionsRevoked:true,
      databases:Object.fromEntries(Object.entries(targets).map(([app,target])=>[app,target.identity.database]))};
  } catch(error) {
    // Hardening spans two databases. If a late grant fails, attempt to revoke
    // known runtime connections again; never claim a global atomic restore.
    for(const [app,target] of gated ? Object.entries(targets) : []) {
      await psql(config.services[app],{...config,signal:undefined,timeout:10000},`REVOKE CONNECT ON DATABASE ${identifier(target.identity.database)} FROM ${identifier(target.role)};`).catch(()=>{});
    }
    throw error;
  } finally {for(const guard of guards)await guard.close();}
}
