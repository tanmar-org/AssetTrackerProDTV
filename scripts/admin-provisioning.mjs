import { hashPin, newSalt, normalizeUsername, validatePin, validateUsername } from "../lib/pin-auth.ts";

// Operator-only bootstrap uses bound parameters and a table lock. PostgreSQL
// permits concurrent inserts, so a conditional INSERT alone is not sufficient.
// Acquire the lock before inspecting emptiness; any existing user blocks bootstrap.
export async function provisionAdmin(database, { name, pin }, { mode = "pin" } = {}) {
  const username = normalizeUsername(name);
  if (!validateUsername(username) || !["pin", "ad"].includes(mode) || (mode === "pin" && !validatePin(pin)))
    throw new Error("Enter a username such as jdoe and a 4–8 digit PIN.");
  const id = crypto.randomUUID();
  const salt = newSalt();
  // AD mode creates only an app role record. A separate explicit GUID link grants
  // directory access; no local PIN is chosen or advertised as an AD fallback.
  const pinHash = mode === "ad" ? newSalt() + newSalt() : await hashPin(pin, salt);
  const now = new Date().toISOString();
  const created = await database.transaction(async (tx) => {
    await tx.prepare("LOCK TABLE app_users IN EXCLUSIVE MODE").run();
    const result = await tx.prepare(`INSERT INTO app_users
      (id, name, role, pin_hash, pin_salt, active, created_at, updated_at)
      SELECT $1, $2, 'admin', $3, $4, 1, $5, $5
      WHERE NOT EXISTS (SELECT 1 FROM app_users)`).bind(id, username, pinHash, salt, now).run();
    return result.meta.changes === 1;
  });
  return { id, username, created };
}
