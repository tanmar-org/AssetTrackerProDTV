import { createDatabase, type Database } from "@tanmar/database";

let connection: Database | undefined;
// Lazy initialization lets builds succeed without production credentials. Each
// Node process owns a bounded pool for this app's separate PostgreSQL database.
export function database() {
  return connection ??= createDatabase(process.env.DATABASE_URL);
}
