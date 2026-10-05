import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

// Operator-managed, checksummed migrations. One database lock and transaction
// prevent concurrent runners or partial schema application; modified history fails.
export async function migrate(database, app) {
  if (!["tracker", "requests"].includes(app)) throw new Error("Choose tracker or requests migrations.");
  const directory = new URL(`../migrations/${app}/`, import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d+_.*\.sql$/.test(name)).sort();
  await database.transaction(async (tx) => {
    await tx.prepare("SELECT pg_advisory_xact_lock(728301)").run();
    await tx.prepare("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at text NOT NULL)").run();
    const history = await tx.prepare("SELECT name FROM schema_migrations").all();
    if (history.results.some((row) => !row.name.startsWith(`${app}/`)))
      throw new Error("This database belongs to the other application.");
    for (const name of files) {
      const key = `${app}/${name}`;
      const sql = await readFile(new URL(name, directory), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const previous = await tx.prepare("SELECT checksum FROM schema_migrations WHERE name = $1").bind(key).first();
      if (previous) {
        if (previous.checksum !== checksum) throw new Error("An applied migration has changed.");
        continue;
      }
      await tx.prepare(sql).run();
      await tx.prepare("INSERT INTO schema_migrations (name, checksum, applied_at) VALUES ($1, $2, $3)")
        .bind(key, checksum, new Date().toISOString()).run();
    }
  });
}
