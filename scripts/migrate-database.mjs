import { createDatabase } from "@tanmar/database";
import { migrate } from "./migrations.mjs";

// DATABASE_URL is loaded from the calling app's private environment file.
// Use its migration owner connection, never grant DDL to the web runtime role.
let database;
try {
  database = createDatabase(process.env.DATABASE_URL);
  await migrate(database, process.argv[2]);
  console.log("PostgreSQL migrations complete.");
} catch {
  console.error("Migration failed. Check database access and the migration history privately.");
  process.exitCode = 1;
} finally { await database?.close(); }
