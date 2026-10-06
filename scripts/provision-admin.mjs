import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { createDatabase } from "@tanmar/database";
import { provisionAdmin } from "./admin-provisioning.mjs";
import { authenticationMode } from "../lib/ad-auth.ts";

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { help: { type: "boolean" } } }));
  } catch {
    throw new Error("Invalid options. Run npm run admin:provision -- --help.");
  }
  if (values.help) {
    console.log("Usage: npm run admin:provision -- [--help]");
    console.log("Provision the first admin in the tracker PostgreSQL database after applying migrations.");
    console.log("DATABASE_URL selects the database. AUTH_MODE=ad prompts for an app username only; link its AD identity separately.");
    console.log("Local PIN mode prompts interactively for username and a hidden PIN. No credential arguments are accepted.");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run provisioning in an interactive terminal. PIN input must not be piped or passed as an argument.");
  }
  const mode = authenticationMode();
  console.log("Provisioning the PostgreSQL tracker database selected by DATABASE_URL.");

  // Suppress readline's echo while collecting PINs. Neither PIN is logged,
  // placed in the environment, written to disk, or passed to the child process.
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });
  const askPin = async (label) => {
    process.stdout.write(label);
    muted = true;
    try { return await prompt.question(""); }
    finally { muted = false; process.stdout.write("\n"); }
  };
  let credentials;
  try {
    const name = await prompt.question("Initial administrator username: ");
    const pin = mode === "ad" ? undefined : await askPin("PIN (hidden, 4–8 digits): ");
    const confirmation = mode === "ad" ? undefined : await askPin("Confirm PIN (hidden): ");
    if (pin !== confirmation) throw new Error("PIN confirmation does not match; no changes made.");
    credentials = { name, pin };
  } finally {
    prompt.close();
  }

  const database = createDatabase(process.env.DATABASE_URL);
  try {
    let result;
    try { result = await provisionAdmin(database, credentials, { mode }); }
    catch { throw new Error("Provisioning failed. Check PostgreSQL access and apply tracker migrations first."); }
    if (!result.created) throw new Error("Provisioning refused: users already exist. Use authenticated account management or an approved recovery procedure.");
    console.log(mode === "ad" ? `Created initial administrator ${result.username}. Explicitly link its reviewed AD identity with auth:link-ad before signing in.`
      : `Created initial administrator ${result.username}. Sign in through the tracker.`);
  } finally { await database.close(); }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
