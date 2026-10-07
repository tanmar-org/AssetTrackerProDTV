import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createDatabase } from "@tanmar/database";
import { prepareDatabases, initializeDatabases } from "../../scripts/database-provisioning.mjs";
import { applications } from "../../scripts/postgresql-backups.mjs";
import { migrate } from "../../scripts/migrations.mjs";
import { unusedPort } from "../helpers/next-server.mjs";

const run = promisify(execFile), root = fileURLToPath(new URL("../../", import.meta.url));
// A distinct socket-only cluster proves SCRAM (the shared integration cluster
// deliberately uses test-only trust). Never edit that cluster's HBA or templates.
test("fresh paired database initialization with real SCRAM and failure containment", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-provisioning-sql-"));
  const data = path.join(directory, "data"), socket = path.join(directory, "socket"), passwordFile = path.join(directory, "operator-password");
  await mkdir(socket, { mode: 0o700 });
  const password = randomBytes(32).toString("base64url"), port = await unusedPort();
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  let running = false, admin;
  t.after(async () => {
    await admin?.close();
    if (running) await run("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
    await rm(directory, { recursive: true, force: true });
  });
  const initArgs = ["-D", data, "-U", "provision_test_operator", "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", `--pwfile=${passwordFile}`, "--no-locale", "--encoding=UTF8"];
  // Extracted VM tools need their matching share directory. CI's installed PG18
  // finds its own; neither branch weakens authentication or skips missing tools.
  if (process.env.POSTGRES_TEST_SHARE) initArgs.push("-L", process.env.POSTGRES_TEST_SHARE);
  await run("initdb", initArgs);
  await run("pg_ctl", ["-D", data, "-l", path.join(directory, "server.log"), "-o", `-h '' -p ${port} -k ${socket} -c unix_socket_permissions=0700`, "-w", "start"]);
  running = true;
  const operator = new URL(`postgresql://provision_test_operator@localhost:${port}/postgres`);
  operator.password = password; operator.searchParams.set("host", socket);
  admin = createDatabase(operator.href);
  async function plan(namespace) {
    const input = path.join(directory, `${namespace}.json`), output = path.join(directory, `${namespace}-plan`);
    await writeFile(input, JSON.stringify({ administratorUrl: operator.href, namespace }), { mode: 0o600 });
    await prepareDatabases(input, output); return { input, output };
  }
  const good = await plan("assettracker_good");
  await t.test("both fresh schemas have distinct owners, restricted runtime and SELECT-only backup access", async () => {
    assert.deepEqual(await initializeDatabases(good.input, good.output), { databases: 2, roles: 6 });
    const manifest = JSON.parse(await readFile(path.join(good.output, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "initialized"); assert.equal(manifest.inventoryImported, false);
    for (const [app, target] of Object.entries(manifest.targets)) {
      const runtimeUrl = JSON.parse(await readFile(path.join(good.output, `${app}-runtime.json`), "utf8")).DATABASE_URL;
      const backupUrl = JSON.parse(await readFile(path.join(good.output, `${app}-backup.json`), "utf8")).DATABASE_URL;
      const ownerUrl = JSON.parse(await readFile(path.join(good.output, `${app}-owner.json`), "utf8")).DATABASE_URL;
      const owner = createDatabase(ownerUrl), runtime = createDatabase(runtimeUrl), backup = createDatabase(backupUrl);
      try {
        await migrate(owner, app); // The saved owner can replay the existing operator migrations.
        await assert.rejects(runtime.prepare(`SET ROLE "${target.roles.owner}"`).run());
        const role = await runtime.prepare("SELECT current_user AS role").first(); assert.equal(role.role, target.roles.runtime);
        for (const table of applications[app]) {
          assert.equal((await runtime.prepare(`SELECT count(*)::integer AS count FROM public."${table}"`).first()).count, 0);
          assert.equal((await backup.prepare(`SELECT count(*)::integer AS count FROM public."${table}"`).first()).count, 0);
          const grants = await backup.prepare("SELECT has_table_privilege($1, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS writes").bind(`public.${table}`).first();
          assert.equal(grants.writes, false);
        }
        await assert.rejects(runtime.prepare("SELECT * FROM schema_migrations").all());
        await assert.rejects(runtime.prepare("CREATE TABLE must_not_exist (id int)").run());
        await assert.rejects(backup.prepare(`DELETE FROM public."${applications[app][0]}"`).run());
        assert.ok((await backup.prepare("SELECT count(*)::integer AS count FROM schema_migrations").first()).count > 0);
        const elevated = await admin.prepare("SELECT rolpassword AS verifier, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_authid WHERE rolname = $1").bind(target.roles.runtime).first();
        assert.match(elevated.verifier, /^SCRAM-SHA-256\$/);
        assert.equal(elevated.rolsuper || elevated.rolcreatedb || elevated.rolcreaterole || elevated.rolreplication || elevated.rolbypassrls, false);
        const wrongPassword = new URL(runtimeUrl); wrongPassword.password = "incorrect";
        const wrong = createDatabase(wrongPassword.href); try { await assert.rejects(wrong.prepare("SELECT 1").first()); } finally { await wrong.close(); }
        const other = new URL(runtimeUrl); other.pathname = `/assettracker_good_${app === "tracker" ? "requests" : "tracker"}`;
        const cross = createDatabase(other.href); try { await assert.rejects(cross.prepare("SELECT 1").first()); } finally { await cross.close(); }
      } finally { await owner.close(); await runtime.close(); await backup.close(); }
    }
  });
  await t.test("backup services/password file work with actual paired pg_dump verification", async () => {
    const { backupDatabases, configuration } = await import("../../scripts/postgresql-backups.mjs");
    const config = await configuration({ PGSERVICEFILE: path.join(good.output, "pg_service.conf"), PGPASSFILE: path.join(good.output, "pgpass"), TRACKER_BACKUP_SERVICE: "tracker_backup", REQUESTS_BACKUP_SERVICE: "requests_backup" });
    const output = path.join(directory, "backups"); await mkdir(output, { mode: 0o700 });
    // This exercises the current complete snapshot/catalog/checksum contract,
    // rather than merely testing that a SELECT-only password can connect.
    const result = await backupDatabases(config, output);
    assert.ok(result);
  });
  await t.test("restore preparation requires reserved names before database creation", async () => {
    const ordinary = await plan("assettracker_not_recovery");
    await assert.rejects(initializeDatabases(ordinary.input, ordinary.output, { restoreEmpty: true }));
    assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_database WHERE datname LIKE 'assettracker_not_recovery_%'").first()).count, 0);
  });
  await t.test("fresh recovery targets remain empty and deny runtime/backup connections", async () => {
    const recovery = await plan("assettracker_restore_drill");
    await initializeDatabases(recovery.input, recovery.output, { restoreEmpty: true });
    assert.equal(JSON.parse(await readFile(path.join(recovery.output, "manifest.json"), "utf8")).status, "restore-empty");
    for (const app of Object.keys(applications)) {
      const owner = createDatabase(JSON.parse(await readFile(path.join(recovery.output, `${app}-owner.json`), "utf8")).DATABASE_URL);
      try { assert.equal((await owner.prepare("SELECT count(*)::integer AS count FROM information_schema.tables WHERE table_schema='public'").first()).count, 0); }
      finally { await owner.close(); }
      for (const kind of ["runtime", "backup"]) {
        const denied = createDatabase(JSON.parse(await readFile(path.join(recovery.output, `${app}-${kind}.json`), "utf8")).DATABASE_URL);
        try { await assert.rejects(denied.prepare("SELECT 1").first(), error => error.code === "42501"); }
        finally { await denied.close(); }
      }
    }
  });
  await t.test("existing second database blocks all creation and preserves existing data", async () => {
    const conflict = await plan("assettracker_conflict");
    await admin.prepare('CREATE DATABASE "assettracker_conflict_requests"').run();
    const existingUrl = new URL(operator); existingUrl.pathname = "/assettracker_conflict_requests";
    const existing = createDatabase(existingUrl.href);
    try {
      await existing.prepare("CREATE TABLE sentinel (value text); INSERT INTO sentinel VALUES ('preserve')").run();
      await assert.rejects(initializeDatabases(conflict.input, conflict.output));
      assert.equal((await existing.prepare("SELECT value FROM sentinel").first()).value, "preserve");
      assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_roles WHERE rolname LIKE 'assettracker_conflict_%'").first()).count, 0);
      assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_database WHERE datname = 'assettracker_conflict_tracker'").first()).count, 0);
    } finally { await existing.close(); }
  });
  await t.test("existing role blocks both fresh databases without rotating that role", async () => {
    const conflict = await plan("assettracker_role_collision");
    await admin.prepare('CREATE ROLE "assettracker_role_collision_requests_backup" NOLOGIN').run();
    await assert.rejects(initializeDatabases(conflict.input, conflict.output));
    assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_database WHERE datname LIKE 'assettracker_role_collision_%'").first()).count, 0);
    assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_roles WHERE rolname LIKE 'assettracker_role_collision_%'").first()).count, 1);
  });
  await t.test("cancelled operator initialization performs no database or role creation", async () => {
    const cancelled = await plan("assettracker_cancelled"), controller = new AbortController(); controller.abort();
    await assert.rejects(initializeDatabases(cancelled.input, cancelled.output, { signal: controller.signal }));
    assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_roles WHERE rolname LIKE 'assettracker_cancelled_%'").first()).count, 0);
  });
  await t.test("concurrent initializers cannot disable the winning plan's credentials", async () => {
    const one = await plan("assettracker_race");
    const second = path.join(directory, "second-race-plan"); await prepareDatabases(one.input, second);
    const results = await Promise.allSettled([initializeDatabases(one.input, one.output), initializeDatabases(one.input, second)]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_roles WHERE rolname LIKE 'assettracker_race_%' AND rolcanlogin").first()).count, 6);
  });
  await t.test("unsafe trust rules fail before any role or database is created", async () => {
    const unsafe = await plan("assettracker_unsafe"), hba = path.join(data, "pg_hba.conf"), original = await readFile(hba, "utf8");
    await writeFile(hba, `local all all trust\n${original}`); await run("pg_ctl", ["-D", data, "reload"]);
    try {
      await assert.rejects(initializeDatabases(unsafe.input, unsafe.output));
      assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_roles WHERE rolname LIKE 'assettracker_unsafe_%'").first()).count, 0);
    } finally { await writeFile(hba, original); await run("pg_ctl", ["-D", data, "reload"]); }
  });
  await t.test("unreloaded strict HBA cannot conceal active password-bypassing trust", async () => {
    const stale = await plan("assettracker_stale_hba"), hba = path.join(data, "pg_hba.conf"), original = await readFile(hba, "utf8");
    await writeFile(hba, `local all all trust\n${original}`); await run("pg_ctl", ["-D", data, "reload"]);
    await admin.prepare("SELECT pg_sleep(0.1)").run();
    // Restore the file but intentionally leave trust loaded. Catalog inspection
    // alone would pass; actual negative-password acceptance must reject it.
    await writeFile(hba, original);
    try {
      await assert.rejects(initializeDatabases(stale.input, stale.output));
      assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_roles WHERE rolname LIKE 'assettracker_stale_hba_%' AND rolcanlogin").first()).count, 0);
      assert.equal(JSON.parse(await readFile(path.join(stale.output, "manifest.json"), "utf8")).status, "failed-offline");
    } finally { await run("pg_ctl", ["-D", data, "reload"]); await admin.prepare("SELECT pg_sleep(0.1)").run(); }
  });
  await t.test("migration failure leaves both app pairs offline and refuses automatic retry", async () => {
    const broken = await plan("assettracker_broken"), release = path.join(directory, "broken-release");
    await mkdir(path.join(release, "scripts"), { recursive: true });
    for (const file of ["prepare-databases.mjs", "database-provisioning.mjs", "postgresql-backups.mjs", "migrations.mjs", "managed-runtime.mjs"])
      await cp(path.join(root, "scripts", file), path.join(release, "scripts", file));
    await cp(path.join(root, "migrations"), path.join(release, "migrations"), { recursive: true });
    await symlink(path.join(root, "node_modules"), path.join(release, "node_modules"));
    await writeFile(path.join(release, "migrations", "requests", "9999_synthetic_failure.sql"), "THIS IS A SYNTHETIC MIGRATION FAILURE;");
    let diagnostic = "";
    try { await run(process.execPath, [path.join(release, "scripts", "prepare-databases.mjs"), "--initialize", broken.input, broken.output]); assert.fail("Should fail"); }
    catch (error) { diagnostic = `${error.stdout || ""}${error.stderr || ""}`; }
    assert.match(diagnostic, /Database preparation failed/); assert.ok(!diagnostic.includes(password) && !diagnostic.includes("SYNTHETIC MIGRATION FAILURE"));
    const manifest = JSON.parse(await readFile(path.join(broken.output, "manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed-offline");
    assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_roles WHERE rolname LIKE 'assettracker_broken_%' AND rolcanlogin").first()).count, 0);
    assert.equal((await admin.prepare("SELECT count(*)::integer AS count FROM pg_database WHERE datname LIKE 'assettracker_broken_%'").first()).count, 2);
    await assert.rejects(initializeDatabases(broken.input, broken.output));
  });
});
