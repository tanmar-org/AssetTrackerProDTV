import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// Exercise real SQL with synthetic, isolated data. This adapter implements only
// the D1 methods used by auth routes; deployment-specific D1 behavior needs its
// own local Wrangler check rather than being inferred from this test helper.
export function createTestDatabase(filename = ":memory:") {
  const storage = new DatabaseSync(filename);
  const migrationDirectory = new URL("../../drizzle/", import.meta.url);
  for (const file of readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()) {
    storage.exec(readFileSync(new URL(file, migrationDirectory), "utf8"));
  }
  const statement = (sql, values = []) => ({
    bind(...parameters) { return statement(sql, parameters); },
    execute() {
      const result = storage.prepare(sql).run(...values);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    },
    async run() { return this.execute(); },
    async first() { return storage.prepare(sql).get(...values) || null; },
    async all() { return { results: storage.prepare(sql).all(...values) }; },
  });
  const db = {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      storage.exec("BEGIN");
      try {
        const results = statements.map((item) => item.execute());
        storage.exec("COMMIT");
        return results;
      } catch (error) {
        storage.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, storage, close: () => storage.close() };
}
