import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDatabase } from "@tanmar/database";
import { initializeDatabases, protectedOperatorPath } from "./database-provisioning.mjs";
import { applications, backupDatabases, configuration, operatorCancellation, restoreDatabases } from "./postgresql-backups.mjs";

const root = "/operator", plan = `${root}/database-plan`, settings = `${root}/database-settings.json`;
const seedFiles = ["database-settings.json", "identity-directory.json", "database-plan/manifest.json",
  "database-plan/tracker-owner.json", "database-plan/tracker-runtime.json", "database-plan/tracker-backup.json",
  "database-plan/requests-owner.json", "database-plan/requests-runtime.json", "database-plan/requests-backup.json",
  "database-plan/pg_service.conf", "database-plan/pgpass"];
async function json(filename) { await protectedOperatorPath(filename); return JSON.parse(await readFile(filename, "utf8")); }
async function privateWrite(filename, value) { await writeFile(filename, value, { flag: "wx", mode: 0o600 }); }
async function config(mode, signal) {
  const manifest = await json(`${plan}/manifest.json`);
  const env = { PGSERVICEFILE: `${plan}/pg_service.conf`, PGPASSFILE: `${plan}/pgpass`, TRACKER_BACKUP_SERVICE: "tracker_backup", REQUESTS_BACKUP_SERVICE: "requests_backup" };
  if (mode === "restore") {
    // Recovery runs through each schema owner. Build private libpq files without
    // placing passwords on a command line, environment or SQL log.
    const directory = `${root}/restore-${Date.now()}`; await mkdir(directory, { mode: 0o700 });
    let services = "", passfile = "";
    for (const app of Object.keys(applications)) {
      const url = new URL((await json(`${plan}/${app}-owner.json`)).DATABASE_URL), socket = url.searchParams.get("host"), role = decodeURIComponent(url.username);
      services += `[${app}_restore]\nhost=${socket}\nport=5432\ndbname=${manifest.targets[app].database}\nuser=${role}\n\n`;
      passfile += `${socket}:5432:${manifest.targets[app].database}:${role}:${decodeURIComponent(url.password)}\n`;
      env[`${app.toUpperCase()}_RESTORE_SERVICE`] = `${app}_restore`;
      env[`${app.toUpperCase()}_RESTORE_RUNTIME_ROLE`] = manifest.targets[app].roles.runtime;
    }
    env.PGSERVICEFILE = `${directory}/pg_service.conf`; env.PGPASSFILE = `${directory}/pgpass`;
    await privateWrite(env.PGSERVICEFILE, services); await privateWrite(env.PGPASSFILE, passfile);
  }
  return { ...await configuration(env, mode), signal };
}
async function childCommand(script, args, env) {
  // The operator profile has only DB credentials. AD mode here creates/links
  // app records, without contacting AD or importing its reader password.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
      stdio: "inherit", env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/nonexistent", AUTH_MODE: "ad", ...env },
    });
    const stop = signal => child.kill(signal), term = () => stop("SIGTERM"), interrupt = () => stop("SIGINT");
    process.on("SIGTERM", term); process.on("SIGINT", interrupt);
    child.once("error", reject); child.once("exit", code => {
      process.off("SIGTERM", term); process.off("SIGINT", interrupt); if (code === 0) resolve(); else reject(new Error());
    });
  });
}
const cancellation = operatorCancellation();
let verifiedRestoreTargets;
// Publish operator status atomically; a torn JSON write must not masquerade as a
// usable deployment. Files remain private even under a permissive host umask.
async function publishManifest(manifest) {
  const temporary = `${plan}/.manifest-${randomBytes(12).toString("hex")}`;
  await privateWrite(temporary, JSON.stringify(manifest)); await rename(temporary, `${plan}/manifest.json`);
}
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === "help" && !args.length) {
    console.log("Commands: seed | initialize | restore-empty | backup | restore BACKUP_BASENAME | admin | link-ad [reviewed identity options]");
  } else {
    if (process.getuid() !== 999) throw new Error(); await protectedOperatorPath(root, true);
    if (command === "seed" && !args.length) {
      if ((await readdir(root)).length) throw new Error();
      for (const filename of seedFiles) await protectedOperatorPath(path.join("/seed", filename));
      await mkdir(plan, { mode: 0o700 });
      for (const filename of seedFiles) await privateWrite(path.join(root, filename), await readFile(path.join("/seed", filename)));
      console.log("Operator volume seeded; no database connection made.");
    } else if (["initialize", "restore-empty"].includes(command) && !args.length) {
      await initializeDatabases(settings, plan, { signal: cancellation.signal, restoreEmpty: command === "restore-empty" });
      console.log(command === "initialize" ? "Fresh paired schemas initialized; applications remain offline." : "Fresh recovery databases prepared empty; runtime/backup access remains denied.");
    } else if (command === "backup" && !args.length) {
      const destination = await backupDatabases(await config("backup", cancellation.signal), `${root}/backups`);
      console.log(path.basename(destination));
    } else if (command === "restore" && args.length === 1 && /^backup-[A-Za-z0-9-]+$/.test(args[0])) {
      if ((await json(`${plan}/manifest.json`)).status !== "restore-empty") throw new Error();
      await restoreDatabases(await config("restore", cancellation.signal), `${root}/incoming/${args[0]}`);
      // Restores grant runtime DML only. Restore SELECT-only backup access after
      // the verified pair, using protected owner URLs and fixed generated names.
      const manifest = await json(`${plan}/manifest.json`);
      verifiedRestoreTargets = manifest.targets;
      if (cancellation.signal.aborted) throw new Error();
      for (const app of Object.keys(applications)) {
        const database = createDatabase((await json(`${plan}/${app}-owner.json`)).DATABASE_URL), target = manifest.targets[app];
        if (![target.database, target.roles.backup].every(value => /^[a-z][a-z0-9_]{0,62}$/.test(value))) throw new Error();
        try {
          await database.transaction(async tx => {
            await tx.prepare(`GRANT CONNECT ON DATABASE "${target.database}" TO "${target.roles.backup}"`).run();
            await tx.prepare(`GRANT USAGE ON SCHEMA public TO "${target.roles.backup}"`).run();
            await tx.prepare(`GRANT SELECT ON ${[...applications[app], "schema_migrations"].map(name => `public."${name}"`).join(",")} TO "${target.roles.backup}"`).run();
          });
        } finally { await database.close(); }
      }
      if (cancellation.signal.aborted) throw new Error();
      await publishManifest({ ...manifest, status: "restored" });
      verifiedRestoreTargets = undefined;
      console.log("Paired restore verified; old sessions revoked and unfinished operations paused. Applications remain offline until approved cutover.");
    } else if (command === "admin" && !args.length) {
      await childCommand("scripts/provision-admin.mjs", [], await json(`${plan}/tracker-owner.json`));
    } else if (command === "link-ad") {
      const identity = await json(`${root}/identity-directory.json`);
      await childCommand("scripts/link-ad-identity.mjs", args, { ...await json(`${plan}/tracker-owner.json`), AD_DIRECTORY_ID: identity.directory });
    } else throw new Error();
  }
} catch {
  // The paired restore already contains its own failures. After it succeeds,
  // contain any later backup-grant/status failure too. Do not touch a concurrent
  // winner when this attempt failed before completing its own verified restore.
  if (verifiedRestoreTargets) {
    let administrator;
    try {
      administrator = createDatabase((await json(settings)).administratorUrl);
      const roles = [];
      for (const target of Object.values(verifiedRestoreTargets)) {
        const pair = [target.roles.runtime, target.roles.backup];
        if (!pair.every(role => /^assettracker_restore_[a-z0-9_]{1,40}$/.test(role))) throw new Error();
        roles.push(...pair);
      }
      await administrator.transaction(async tx => {
        for (const role of roles) await tx.prepare(`ALTER ROLE "${role}" NOLOGIN`).run();
      });
      await administrator.prepare("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=ANY($1::text[]) AND pid<>pg_backend_pid()")
        .bind(roles).run();
    } catch { /* Interrupted/unavailable containment still requires offline DBA review. */ }
    finally { await administrator?.close(); }
  }
  console.error("Container operator failed. Inspect protected configuration/state privately; keep recovery destinations offline."); process.exitCode = 1;
} finally { cancellation.close(); }
