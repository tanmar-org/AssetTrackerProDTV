import { hashPin, newSalt, normalizeUsername, validatePin, validateUsername } from "../lib/pin-auth.ts";

// Build a single conditional INSERT rather than a separate count/create pair.
// SQLite serializes writes, so only one concurrent provisioner can create a user.
// Existing users block bootstrap regardless of their roles or active flags.
export async function buildProvisioningSql({ name, pin }) {
  const username = normalizeUsername(name);
  if (!validateUsername(username) || !validatePin(pin)) {
    throw new Error("Enter a username such as jdoe and a 4–8 digit PIN.");
  }
  const id = crypto.randomUUID();
  const salt = newSalt();
  const pinHash = await hashPin(pin, salt);
  const now = new Date().toISOString();
  // Username validation and generated values limit the inputs, but quote every
  // literal because Wrangler consumes a SQL file rather than bound parameters.
  const literal = (value) => `'${value.replaceAll("'", "''")}'`;
  const sql = `INSERT INTO app_users
    (id, name, role, pin_hash, pin_salt, active, created_at, updated_at)
    SELECT ${literal(id)}, ${literal(username)}, 'admin', ${literal(pinHash)}, ${literal(salt)}, 1, ${literal(now)}, ${literal(now)}
    WHERE NOT EXISTS (SELECT 1 FROM app_users);\n`;
  return { id, username, sql };
}

// Local Wrangler results omit affected-row counts. Identify the row created by
// this attempt's random ID instead of trusting optional metadata or a username
// that another concurrent operator might also have chosen.
export function provisioningCreated(result, id) {
  if (!Array.isArray(result) || !result.length || result.some((item) => item.success !== true || !Array.isArray(item.results))) {
    throw new Error("Local provisioning returned an unexpected result.");
  }
  return result.some((item) => item.results.some((row) => row.id === id));
}
