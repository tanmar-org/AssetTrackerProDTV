import { Pool } from "pg";

// This small query facade preserves route result shapes while executing native
// PostgreSQL SQL ($1 parameters). It performs no SQLite/D1 SQL translation.
class Statement {
  constructor(executor, text, values = []) {
    this.executor = executor;
    this.text = text;
    this.values = values;
  }
  bind(...values) { return new Statement(this.executor, this.text, values); }
  async first() { return (await this.executor.query(this.text, this.values)).rows[0] ?? null; }
  async all() { return { results: (await this.executor.query(this.text, this.values)).rows }; }
  async run() {
    const response = await this.executor.query(this.text, this.values);
    const result = Array.isArray(response) ? response.at(-1) : response;
    return { results: result.rows, meta: { changes: result.rowCount ?? 0 } };
  }
}

class Database {
  constructor(pool, executor = pool) {
    this.pool = pool;
    this.executor = executor;
  }
  prepare(text) { return new Statement(this.executor, text); }
  async transaction(callback) {
    // All transaction statements must use this client, never the shared pool.
    // Release it on every path so a failed write cannot exhaust connections.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(new Database(this.pool, client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}

export function createDatabase(connectionString) {
  if (!connectionString) throw new Error("DATABASE_URL is required for PostgreSQL access.");
  const pool = new Pool({
    connectionString, max: 4, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000, statement_timeout: 10000,
  });
  // Do not print driver errors: connection details or query values can be sensitive.
  pool.on("error", () => console.error("An idle PostgreSQL connection failed."));
  return new Database(pool);
}
