import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@tanmar/database";
import { applications } from "./postgresql-backups.mjs";
import { migrate } from "./migrations.mjs";
import { verifyRuntimeDatabase } from "./managed-runtime.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const fail = () => new Error("Database provisioning failed; inspect the protected plan and database state privately.");
const identifier = value => {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw fail();
  return `"${value}"`;
};
const literal = value => `'${value.replaceAll("'", "''")}'`;

// Generated passwords are ASCII only, so SASLprep normalization cannot alter
// them. Send PostgreSQL a SCRAM verifier, never a plaintext password in DDL/logs.
// Format/keys follow PostgreSQL src/common/scram-common.c (SCRAM-SHA-256).
export function scramVerifier(password) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw fail();
  const salt = randomBytes(16), iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const client = createHmac("sha256", salted).update("Client Key").digest();
  const stored = createHash("sha256").update(client).digest("base64");
  const server = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${stored}:${server}`;
}

// Credentials must be private, canonical and outside every Git worktree. Check
// ancestor ownership/write permissions too: a writable parent defeats file modes.
export async function protectedOperatorPath(filename, directory = false) {
  if (!path.isAbsolute(filename || "")) throw fail();
  const info = await lstat(filename);
  if ((directory ? !info.isDirectory() : !info.isFile()) || info.uid !== process.getuid() ||
      (info.mode & 0o077) || (!directory && info.size > 65536) || await realpath(filename) !== filename) throw fail();
  const repo = await realpath(repository);
  if (filename === repo || filename.startsWith(`${repo}${path.sep}`)) throw fail();
  for (let ancestor = directory ? filename : path.dirname(filename); ; ancestor = path.dirname(ancestor)) {
    const parent = await lstat(ancestor);
    // A sticky /tmp is safe for a user-owned private child; shared writable
    // non-sticky ancestors are not. Root-owned or operator-owned parents only.
    if (![0, process.getuid()].includes(parent.uid) || ((parent.mode & 0o022) && !(parent.mode & 0o1000))) throw fail();
    const git = await lstat(path.join(ancestor, ".git")).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (git?.isFile() || (git?.isDirectory() && await lstat(path.join(ancestor, ".git", "HEAD")).catch(() => null))) throw fail();
    if (ancestor === path.dirname(ancestor)) break;
  }
}
export function provisioningSettings(settings) {
  if (!settings || Array.isArray(settings) || Object.keys(settings).length !== 2 ||
      !Object.hasOwn(settings, "administratorUrl") || !Object.hasOwn(settings, "namespace") ||
      typeof settings.administratorUrl !== "string" || typeof settings.namespace !== "string" ||
      !/^assettracker_[a-z0-9_]{1,30}$/.test(settings.namespace)) throw fail();
  const url = new URL(settings.administratorUrl);
  const socket = url.searchParams.get("host");
  // Provision a private socket-only PG18 cluster. No public hosts, alternate
  // options/ssl overrides, URI credentials in generated diagnostics or TCP path.
  if (url.protocol !== "postgresql:" || url.hostname !== "localhost" || !url.username ||
      url.pathname !== "/postgres" || url.hash || !/^\/[A-Za-z0-9_/-]+$/.test(socket || "") ||
      socket.includes("..") || [...url.searchParams.keys()].length !== 1 || !/^\d+$/.test(url.port || "5432") ||
      Number(url.port || 5432) < 1024 || Number(url.port || 5432) > 65535) throw fail();
  const targets = Object.fromEntries(Object.keys(applications).map(app => [app, {
    database: `${settings.namespace}_${app}`,
    roles: Object.fromEntries(["owner", "runtime", "backup"].map(kind => [kind, `${settings.namespace}_${app}_${kind}`])),
  }]));
  for (const target of Object.values(targets)) {
    identifier(target.database); Object.values(target.roles).forEach(identifier);
  }
  return { url, targets };
}
function connection(url, database, role, password) {
  const result = new URL(url); result.pathname = `/${database}`; result.username = role; result.password = password;
  return result.href;
}
async function saveManifest(output, manifest) {
  const temporary = path.join(output, `.manifest-${randomBytes(12).toString("hex")}`);
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(output, "manifest.json"));
  } finally { await rm(temporary, { force: true }); }
}
export async function prepareDatabases(settingsFile, output) {
  await protectedOperatorPath(settingsFile); await protectedOperatorPath(path.dirname(output), true);
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  const { url, targets } = provisioningSettings(settings);
  // Generate/save credentials before DDL so a partial failure cannot lose the
  // only record of newly created roles. Never replace another attempt's files.
  await mkdir(output, { mode: 0o700 });
  try {
    let services = "", passfile = "";
    for (const [app, target] of Object.entries(targets)) {
      for (const [kind, role] of Object.entries(target.roles)) {
        const password = randomBytes(32).toString("base64url");
        await writeFile(path.join(output, `${app}-${kind}.json`), `${JSON.stringify({ DATABASE_URL: connection(url, target.database, role, password) })}\n`, { flag: "wx", mode: 0o600 });
        if (kind === "backup") {
          const socket = url.searchParams.get("host"), port = url.port || "5432";
          services += `[${app}_backup]\nhost=${socket}\nport=${port}\ndbname=${target.database}\nuser=${role}\n\n`;
          // libpq matches "localhost" for its compiled default socket directory.
          // Keep exact DB/user/port entries for both default and custom sockets;
          // the protected service file still selects socket-only transport.
          // https://www.postgresql.org/docs/18/libpq-pgpass.html
          passfile += `${socket}:${port}:${target.database}:${role}:${password}\nlocalhost:${port}:${target.database}:${role}:${password}\n`;
        }
      }
    }
    await writeFile(path.join(output, "pg_service.conf"), services, { flag: "wx", mode: 0o600 });
    await writeFile(path.join(output, "pgpass"), passfile, { flag: "wx", mode: 0o600 });
    await saveManifest(output, { version: 1, namespace: settings.namespace, targets, status: "prepared" });
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  return { files: 9 };
}

export async function initializeDatabases(settingsFile, output, { signal, restoreEmpty = false } = {}) {
  const cancelled = () => { if (signal?.aborted) throw fail(); };
  cancelled();
  await protectedOperatorPath(settingsFile); await protectedOperatorPath(output, true);
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  const { url, targets } = provisioningSettings(settings), connections = {};
  if (restoreEmpty && (!/^assettracker_restore_[a-z0-9_]+$/.test(settings.namespace) ||
      Object.values(targets).some(target => !/^assettracker_restore_[a-z0-9_]{1,40}$/.test(target.database) ||
        !/^assettracker_restore_[a-z0-9_]{1,40}$/.test(target.roles.runtime)))) throw fail();
  await protectedOperatorPath(path.join(output, "manifest.json"));
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  if (manifest.version !== 1 || manifest.status !== "prepared" || manifest.namespace !== settings.namespace ||
      JSON.stringify(manifest.targets) !== JSON.stringify(targets)) throw fail();
  for (const [app, target] of Object.entries(targets)) {
    connections[app] = {};
    for (const [kind, role] of Object.entries(target.roles)) {
      const file = path.join(output, `${app}-${kind}.json`); await protectedOperatorPath(file);
      const value = JSON.parse(await readFile(file, "utf8"));
      const parsed = new URL(value.DATABASE_URL);
      if (Object.keys(value).length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(parsed.password) ||
          value.DATABASE_URL !== connection(url, target.database, role, parsed.password)) throw fail();
      connections[app][kind] = value.DATABASE_URL;
    }
  }
  if (new Set(Object.values(connections).flatMap(group => Object.values(group).map(value => new URL(value).password))).size !== 6) throw fail();
  // Backup credentials contain the same generated secrets; exposed or replaced
  // companion files must also block initialization before any DDL.
  await protectedOperatorPath(path.join(output, "pg_service.conf"));
  await protectedOperatorPath(path.join(output, "pgpass"));
  const admin = createDatabase(url.href);
  let createdRoles = false, started = false;
  try {
    const server = await admin.prepare(`SELECT current_setting('server_version_num')::integer AS version,
      current_setting('listen_addresses') AS listeners, rolsuper FROM pg_roles WHERE rolname = current_user`).first();
    if (server.version < 180000 || server.version >= 190000 || server.listeners !== "" || !server.rolsuper) throw fail();
    const rules = (await admin.prepare("SELECT type, user_name, auth_method, error FROM pg_hba_file_rules").all()).results;
    // A broad peer/trust rule can bypass the freshly assigned passwords. Permit
    // peer only for the single explicit operator, never PUBLIC/app roles. Runtime
    // paths must use SCRAM; production config is inspected, never edited here.
    if (!rules.some(rule => rule.type === "local" && rule.auth_method === "scram-sha-256") || rules.some(rule => rule.error ||
      (rule.type === "local" && !["scram-sha-256", "reject"].includes(rule.auth_method) &&
        !(rule.auth_method === "peer" && rule.user_name?.length === 1 && rule.user_name[0] === decodeURIComponent(url.username))))) throw fail();
    const names = Object.values(targets).map(target => target.database), roles = Object.values(targets).flatMap(target => Object.values(target.roles));
    // Both destinations must be fresh. Never adopt, rotate, migrate, revoke or
    // drop existing databases/roles, even if the first destination is empty.
    cancelled();
    await admin.transaction(async tx => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728305)").run();
      if ((await tx.prepare("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = ANY($1::text[])) OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ANY($2::text[])) AS occupied").bind(names, roles).first()).occupied) throw fail();
      cancelled();
      started = true;
      for (const [app, target] of Object.entries(targets)) for (const [kind, role] of Object.entries(target.roles)) {
        const verifier = scramVerifier(new URL(connections[app][kind]).password);
        await tx.prepare(`CREATE ROLE ${identifier(role)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD ${literal(verifier)}`).run();
      }
    });
    createdRoles = true;
    cancelled();
    await saveManifest(output, { ...manifest, status: "initializing" });
    for (const [app, target] of Object.entries(targets)) {
      cancelled();
      // CREATE DATABASE cannot run in a transaction. Keep connections disabled
      // until PUBLIC access is revoked; roles remain NOLOGIN through migrations.
      await admin.prepare(`CREATE DATABASE ${identifier(target.database)} WITH OWNER ${identifier(target.roles.owner)} TEMPLATE template0 ENCODING 'UTF8' ALLOW_CONNECTIONS false`).run();
      await admin.transaction(async tx => {
        await tx.prepare(`REVOKE ALL ON DATABASE ${identifier(target.database)} FROM PUBLIC`).run();
        if (!restoreEmpty) await tx.prepare(`GRANT CONNECT ON DATABASE ${identifier(target.database)} TO ${identifier(target.roles.runtime)}, ${identifier(target.roles.backup)}`).run();
        await tx.prepare(`ALTER DATABASE ${identifier(target.database)} ALLOW_CONNECTIONS true`).run();
      });
      if (restoreEmpty) continue; // Recovery imports its schema; keep runtime/backup CONNECT denied.
      const databaseUrl = new URL(url); databaseUrl.pathname = `/${target.database}`;
      const database = createDatabase(databaseUrl.href);
      try {
        // Execute checksummed migrations as the real schema owner, while only
        // the operator can connect. SET LOCAL is bound to this exact client/tx.
        await migrate({ transaction: callback => database.transaction(async tx => {
          await tx.prepare(`SET LOCAL ROLE ${identifier(target.roles.owner)}`).run(); return callback(tx);
        }) }, app);
        await database.transaction(async tx => {
          await tx.prepare(`SET LOCAL ROLE ${identifier(target.roles.owner)}`).run();
          await tx.prepare("REVOKE ALL ON SCHEMA public FROM PUBLIC").run();
          await tx.prepare(`GRANT USAGE ON SCHEMA public TO ${identifier(target.roles.runtime)}, ${identifier(target.roles.backup)}`).run();
          const tables = applications[app].map(name => `public.${identifier(name)}`).join(", ");
          await tx.prepare(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO ${identifier(target.roles.runtime)}`).run();
          await tx.prepare(`GRANT SELECT ON ${tables}, public.schema_migrations TO ${identifier(target.roles.backup)}`).run();
        });
      } finally { await database.close(); }
    }
    cancelled();
    // Test the actual authentication policy while every new role is still
    // NOLOGIN. A wrong SCRAM password must fail with 28P01 BEFORE session/LOGIN
    // permission checks. Trust/peer/reject/stale rules fail differently, so no
    // application can connect during this safety check, even with stale HBA.
    for (const group of Object.values(connections)) for (const value of Object.values(group)) {
      cancelled();
      const wrongUrl = new URL(value); wrongUrl.password = randomBytes(32).toString("base64url");
      const wrong = createDatabase(wrongUrl.href); let passwordRejected = false;
      try { await wrong.prepare("SELECT 1").first(); }
      catch (error) { passwordRejected = error.code === "28P01"; }
      finally { await wrong.close(); }
      if (!passwordRejected) throw fail();
    }
    cancelled();
    // Only after BOTH schemas/grants and authentication checks pass may these
    // credentials be used. Verify real connections and runtime least privilege.
    await admin.transaction(async tx => { for (const role of roles) await tx.prepare(`ALTER ROLE ${identifier(role)} LOGIN`).run(); });
    for (const app of Object.keys(targets)) {
      cancelled(); if (!restoreEmpty) await verifyRuntimeDatabase(connections[app].runtime);
      for (const value of restoreEmpty ? [connections[app].owner] : Object.values(connections[app])) {
        const valid = createDatabase(value);
        try { await valid.prepare("SELECT 1").first(); } finally { await valid.close(); }
      }
    }
    cancelled();
    await saveManifest(output, { ...manifest, status: restoreEmpty ? "restore-empty" : "initialized", inventoryImported: false, administratorsProvisioned: false });
    return { databases: 2, roles: 6 };
  } catch {
    // Preserve partial databases for private diagnosis. Never silently delete
    // data or retry/reuse them. Revoke only roles created by THIS attempt; a
    // conflicting concurrent attempt must not disable someone else's roles.
    let contained = true;
    if (createdRoles) {
      try {
        await admin.transaction(async tx => {
          for (const target of Object.values(targets)) for (const role of Object.values(target.roles))
            await tx.prepare(`ALTER ROLE ${identifier(role)} NOLOGIN`).run();
        });
        // Publish NOLOGIN before terminating sessions, so another connection
        // cannot enter between the termination scan and privilege commit.
        await admin.prepare("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = ANY($1::text[]) AND pid <> pg_backend_pid()")
          .bind(Object.values(targets).flatMap(target => Object.values(target.roles))).run();
      } catch { contained = false; }
    }
    if (started) await saveManifest(output, { ...manifest, status: contained ? "failed-offline" : "failed-operator-action-required" });
    throw fail();
  } finally { await admin.close(); }
}
