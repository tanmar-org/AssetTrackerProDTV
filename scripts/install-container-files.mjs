import { constants } from "node:fs";
import { chown, chmod, lstat, mkdir, open, readFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";

const fail = () => new Error();
const planFiles = ["manifest.json", "tracker-owner.json", "tracker-runtime.json", "tracker-backup.json",
  "requests-owner.json", "requests-runtime.json", "requests-backup.json", "pg_service.conf", "pgpass"];
// Compose file-backed secrets preserve host UID/mode, rather than remapping the
// YAML uid field. Install fixed files to their actual service UIDs, below a root
// 0700 directory. This helper does not invoke Docker or connect to PostgreSQL.
async function checked(filename, directory = false) {
  const info = await lstat(filename), owner = Number(process.env.SUDO_UID || 0);
  if (!(directory ? info.isDirectory() : info.isFile()) || ![0, owner].includes(info.uid) ||
      (info.mode & 0o077) || (!directory && info.size > 65536) || await realpath(filename) !== filename) throw fail();
  for (let ancestor = directory ? filename : path.dirname(filename); ; ancestor = path.dirname(ancestor)) {
    const parent = await lstat(ancestor);
    if (![0, owner].includes(parent.uid) || ((parent.mode & 0o022) && !(parent.mode & 0o1000))) throw fail();
    const git = await lstat(path.join(ancestor, ".git")).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (git?.isFile() || (git?.isDirectory() && await lstat(path.join(ancestor, ".git", "HEAD")).catch(() => null))) throw fail();
    if (ancestor === path.dirname(ancestor)) break;
  }
}
async function copy(source, destination, uid, mode = 0o400) {
  await checked(source);
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const output = await open(destination, "wx", 0o600);
    try { await output.writeFile(await input.readFile()); await output.chown(uid, uid); await output.chmod(mode); }
    finally { await output.close(); }
  } finally { await input.close(); }
}
try {
  if (process.getuid() !== 0 || process.argv.length !== 3) throw fail();
  const source = process.argv[2]; await checked(source, true); await checked(path.join(source, "manifest.json"));
  const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8")), destination = manifest.installDirectory;
  if (manifest.version !== 1 || !/^\/[A-Za-z0-9_./-]+$/.test(destination || "") || destination.includes("..")) throw fail();
  const parent = path.dirname(destination);
  if (await realpath(parent) !== parent) throw fail();
  for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    const info = await lstat(ancestor);
    if (info.uid !== 0 || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw fail();
    if (await lstat(path.join(ancestor, ".git")).catch(() => null)) throw fail();
    if (ancestor === path.dirname(ancestor)) break;
  }
  // Validate the complete fixed source tree before creating the destination.
  const files = { "postgres-password": 999, "staff-runtime.json": 10001, "qr-runtime.json": 10002,
    "reconciler-runtime.json": 10003, "ad-ca.pem": 10001, "vm.conf": 10004, "vm-qr-upstream.conf": 10004,
    "tls.pem": 10004, "tls.key": 10004, "compose.env": 0, "manifest.json": 0,
    "npm-staff.conf": 0, "npm-qr.conf": 0, "npm-qr-upstream.conf": 0 };
  if (JSON.stringify((await readdir(source)).sort()) !== JSON.stringify([...Object.keys(files), "operator"].sort())) throw fail();
  for (const filename of Object.keys(files)) await checked(path.join(source, filename));
  await checked(path.join(source, "operator"), true); await checked(path.join(source, "operator", "database-plan"), true);
  if (JSON.stringify((await readdir(path.join(source, "operator"))).sort()) !== JSON.stringify(["database-plan", "database-settings.json", "identity-directory.json"].sort()) ||
      JSON.stringify((await readdir(path.join(source, "operator", "database-plan"))).sort()) !== JSON.stringify([...planFiles].sort())) throw fail();
  for (const filename of ["database-settings.json", "identity-directory.json", ...planFiles.map(name => `database-plan/${name}`)]) await checked(path.join(source, "operator", filename));
  await mkdir(destination, { mode: 0o700 });
  for (const [filename, uid] of Object.entries(files)) await copy(path.join(source, filename), path.join(destination, filename), uid, uid === 0 ? 0o600 : 0o400);
  for (const directory of ["operator", "operator/database-plan"]) {
    await mkdir(path.join(destination, directory), { mode: 0o700 }); await chown(path.join(destination, directory), 999, 999); await chmod(path.join(destination, directory), 0o700);
  }
  for (const filename of ["database-settings.json", "identity-directory.json", ...planFiles.map(name => `database-plan/${name}`)])
    await copy(path.join(source, "operator", filename), path.join(destination, "operator", filename), 999);
  console.log("Protected container files installed. No service started or database changed.");
} catch {
  // A partial directory is preserved for private inspection; never auto-delete
  // an operator-selected path or replace a previously installed deployment.
  console.error("Container file installation failed; inspect source/destination privately. Existing paths are never replaced."); process.exitCode = 1;
}
