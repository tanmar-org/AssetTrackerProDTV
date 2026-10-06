import { parseArgs } from "node:util";
import { createDatabase } from "@tanmar/database";
import { AccessInputError } from "../lib/access-input.ts";
import { linkAdIdentity } from "./ad-linking.mjs";

// Identity IDs are not credentials. Directory reader/user passwords are never
// arguments; this command uses only operator DB access and a directory namespace.
async function main() {
  let values;
  try { ({ values } = parseArgs({ options: { help: { type: "boolean" }, "user-id": { type: "string" },
    guid: { type: "string" }, "expected-binding": { type: "string" } } })); }
  catch { throw new AccessInputError("Invalid options. Run npm run auth:link-ad -- --help."); }
  if (values.help) {
    console.log("Usage: npm run auth:link-ad -- --user-id APP_ID --guid AD_OBJECT_GUID [--expected-binding DIRECTORY_ID:OLD_GUID]");
    console.log("Verify the AD objectGUID and existing application user explicitly. AD_DIRECTORY_ID selects its namespace.");
    console.log("DATABASE_URL selects the tracker operator connection. Existing sessions are revoked atomically.");
    return;
  }
  const database = createDatabase(process.env.DATABASE_URL);
  try {
    const result = await linkAdIdentity(database, { userId: values["user-id"], guid: values.guid,
      directory: process.env.AD_DIRECTORY_ID, expectedBinding: values["expected-binding"] });
    console.log(result.changed ? "AD identity linked; existing sessions revoked." : "The reviewed identity is already linked; no changes made.");
  } finally { await database.close(); }
}
main().catch(error => {
  // PostgreSQL and configuration diagnostics may contain connection details.
  console.error(error instanceof AccessInputError ? error.message : "AD linking failed. Check operator access, identity uniqueness and tracker migrations.");
  process.exitCode = 1;
});
