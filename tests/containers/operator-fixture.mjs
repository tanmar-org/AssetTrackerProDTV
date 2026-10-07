import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createDatabase } from "/opt/assettracker/packages/database/index.mjs";
import { provisionAdmin } from "/opt/assettracker/scripts/admin-provisioning.mjs";
import { linkAdIdentity } from "/opt/assettracker/scripts/ad-linking.mjs";
import { inventory, when } from "../helpers/inventory-fixture.mjs";
// This fixture is excluded from all release images. The synthetic test mounts
// it read-only in a disposable operator container; no production seed endpoint.
const [mode] = process.argv.slice(2), databases = {};
try {
  for (const app of ["tracker", "requests"]) databases[app] = createDatabase(JSON.parse(await readFile(`/operator/database-plan/${app}-owner.json`, "utf8")).DATABASE_URL);
  const tracker = databases.tracker, requests = databases.requests;
  if (mode === "seed") {
    const user = await provisionAdmin(tracker, { name: "containeradmin" }, { mode: "ad" });
    await linkAdIdentity(tracker, { userId: user.id, guid: "12345678-90ab-cdef-8123-456789abcdef", directory: "synthetic-ad" });
    const state = JSON.stringify(inventory());
    await tracker.prepare("INSERT INTO app_state VALUES ('tanmar-receiver-control',$1,2,$2,'containeradmin')").bind(state, when).run();
    await tracker.prepare("INSERT INTO app_inventory_drafts VALUES ($1,$2,1,2,$3,$3,'Container recovery copy','active',now(),now()+interval '7 days')").bind(randomUUID(), user.id, state).run();
  } else if (mode === "pending") {
    const user = await tracker.prepare("SELECT id FROM app_users WHERE name='containeradmin'").first();
    await tracker.prepare(`INSERT INTO app_service_operations(id,request_id,kind,target_status,notes,expected_version,fingerprint,actor_id,actor_name,approver_id,approver_name,snapshot,created_at,updated_at)
      VALUES($1,'move-pending','status','Completed','Synthetic pending move',1,$2,$3,'containeradmin',$3,'containeradmin','{}',$4,$4)`)
      .bind(randomUUID(), "b".repeat(64), user.id, when).run();
  } else if (mode === "inspect") {
    console.log(JSON.stringify({ state: (await tracker.prepare("SELECT payload FROM app_state").first()).payload,
      sessions: (await tracker.prepare("SELECT count(*)::integer AS count FROM app_sessions").first()).count,
      drafts: (await tracker.prepare("SELECT count(*)::integer AS count FROM app_inventory_drafts").first()).count,
      identity: await tracker.prepare("SELECT ad_directory,ad_guid FROM app_users WHERE name='containeradmin'").first(),
      operations: (await tracker.prepare("SELECT phase,error_code FROM app_service_operations ORDER BY id").all()).results,
      requests: (await requests.prepare("SELECT asset_id,asset_number,requester_name FROM service_requests ORDER BY id").all()).results }));
  } else throw new Error("Invalid synthetic fixture mode");
} finally { for (const database of Object.values(databases)) await database.close(); }
