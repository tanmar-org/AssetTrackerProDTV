import { randomUUID } from "node:crypto";
import { createDatabase } from "@tanmar/database";
import { migrate } from "../../scripts/migrations.mjs";

// Integration tests may create/drop only randomly named databases on a local
// PostgreSQL test cluster. A dedicated admin database name prevents accidental
// use of a developer's normal DATABASE_URL or any production export.
export async function createPostgresFixture(app, { empty = false } = {}) {
  const url = new URL(process.env.TEST_DATABASE_URL || "postgresql://invalid/");
  const host = url.searchParams.get("host") || url.hostname;
  if (url.pathname !== "/assettracker_test_admin" ||
      (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) && !host.startsWith("/")))
    throw new Error("TEST_DATABASE_URL must select assettracker_test_admin on an isolated local PostgreSQL cluster.");
  const owner = createDatabase(url.href);
  const suffix = randomUUID().replaceAll("-", "");
  // Restore fixtures use the operator tool's reserved recovery prefix and start
  // empty; existing application fixtures still apply the normal migrations.
  const name = `${empty ? "assettracker_restore_test" : "assettracker_test"}_${suffix}`;
  const role = `${empty ? "assettracker_restore_runtime" : "assettracker_runtime"}_${suffix}`;
  let database;
  let runtime;
  try {
    await owner.prepare(`CREATE DATABASE "${name}"`).run();
    url.pathname = `/${name}`;
    database = createDatabase(url.href);
    if(!empty) await migrate(database, app);
    // The web role gets data access, no schema ownership or CREATE rights.
    await owner.prepare(`CREATE ROLE "${role}" LOGIN`).run();
    await database.prepare('REVOKE CREATE ON SCHEMA public FROM PUBLIC').run();
    await database.prepare(`GRANT CONNECT ON DATABASE "${name}" TO "${role}"`).run();
    await database.prepare(`GRANT USAGE ON SCHEMA public TO "${role}"`).run();
    const tables = app === "tracker"
      ? "app_users, app_sessions, app_change_log, app_state, app_state_history, app_inventory_drafts, app_service_operations"
      : "service_requests, request_rate_limits, service_request_operations";
    if(!empty) await database.prepare(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${tables} TO "${role}"`).run();
    const runtimeUrl = new URL(url);
    runtimeUrl.username = role;
    runtimeUrl.password = "";
    runtime = createDatabase(runtimeUrl.href);
    return { database, runtime, url: runtimeUrl.href, ownerUrl: url.href, close: async () => {
      await runtime.close();
      await database.close();
      await owner.prepare(`DROP DATABASE "${name}" WITH (FORCE)`).run();
      await owner.prepare(`DROP ROLE "${role}"`).run();
      await owner.close();
    } };
  } catch (error) {
    await runtime?.close();
    await database?.close();
    await owner.prepare(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).run();
    await owner.prepare(`DROP ROLE IF EXISTS "${role}"`).run();
    await owner.close();
    throw error;
  }
}
