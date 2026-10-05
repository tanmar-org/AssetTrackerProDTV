import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { buildProvisioningSql, provisioningCreated } from "./admin-provisioning.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const run = promisify(execFile);

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: { help: { type: "boolean" }, "persist-to": { type: "string" } } }));
  } catch {
    throw new Error("Invalid options. Run npm run admin:provision -- --help.");
  }
  if (values.help) {
    console.log("Usage: npm run admin:provision -- [--persist-to DIRECTORY]");
    console.log("Provision the first admin in the tracker local D1 database after applying migrations.");
    console.log("The username and PIN are prompted interactively; remote databases are never targeted.");
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run provisioning in an interactive terminal. PIN input must not be piped or passed as an argument.");
  }
  const persistTo = resolve(projectRoot, values["persist-to"] || ".wrangler/state");
  console.log(`Local tracker database directory: ${persistTo}`);

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
  let provision;
  try {
    const name = await prompt.question("Initial administrator username: ");
    const pin = await askPin("PIN (hidden, 4–8 digits): ");
    const confirmation = await askPin("Confirm PIN (hidden): ");
    if (pin !== confirmation) throw new Error("PIN confirmation does not match; no changes made.");
    provision = await buildProvisioningSql({ name, pin });
  } finally {
    prompt.close();
  }

  // Only salted hashes enter a private temporary SQL file. Always clean it up,
  // and suppress Wrangler error output because it may contain SQL/hash material.
  const temporary = await mkdtemp(join(tmpdir(), "assettracker-admin-"));
  try {
    const sqlFile = join(temporary, "provision.sql");
    // The INSERT is still the atomic write. A following read only determines
    // whether this attempt won; it cannot authorize or create another account.
    const sql = `${provision.sql}SELECT id FROM app_users WHERE id = '${provision.id}';\n`;
    await writeFile(sqlFile, sql, { mode: 0o600, flag: "wx" });
    let result;
    try {
      const { stdout } = await run(process.execPath, [
        join(projectRoot, "node_modules/wrangler/bin/wrangler.js"),
        "d1", "execute", "DB", "--local", "--config", join(projectRoot, "wrangler.local.json"),
        "--persist-to", persistTo, "--file", sqlFile, "--json",
      ], { cwd: projectRoot, timeout: 60_000, env: { ...process.env, WRANGLER_WRITE_LOGS: "false" } });
      result = JSON.parse(stdout);
    } catch {
      throw new Error("Local provisioning failed. Apply tracker migrations and check the local database directory; command details were withheld to protect hashes.");
    }
    if (!provisioningCreated(result, provision.id)) {
      throw new Error("Users already exist; initial provisioning is closed. No account was changed.");
    }
    console.log(`Initial administrator ${provision.username} created. Sign in through the tracker.`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
