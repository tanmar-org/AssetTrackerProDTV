import { X509Certificate } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createDatabase } from "@tanmar/database";

const failure = () => new Error("Managed service configuration or runtime permissions are invalid.");
const common = ["DATABASE_URL", "ADMIN_SHARED_SECRET"];
const fields = {
  staff: [...common, "SERVICE_REQUEST_API_URL", "LOGIN_PROXY_SECRET", "AUTH_MODE", "AD_DIRECTORY_ID",
    "AD_LDAP_URL", "AD_BASE_DN", "AD_BIND_DN", "AD_BIND_PASSWORD"],
  qr: [...common, "TRACKER_ASSET_API_URL", "REQUEST_PROXY_SECRET"],
  reconciler: [...common, "SERVICE_REQUEST_API_URL"],
};
export function servicePorts(env = process.env) {
  const staff = Number(env.ASSETTRACKER_STAFF_PORT || 5173), qr = Number(env.ASSETTRACKER_QR_PORT || 5174);
  if ([staff, qr].some(port => !Number.isInteger(port) || port < 1024 || port > 65535) || staff === qr) throw failure();
  return { staff, qr };
}
async function credential(directory, name, maximum) {
  if (!path.isAbsolute(directory || "")) throw failure();
  const filename = path.join(directory, name), info = await lstat(filename);
  // systemd or Compose supplies a private read-only file owned by this UID. Never
  // follow a replacement symlink or read a group/world-readable source file.
  if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > maximum) throw failure();
  return readFile(filename, "utf8");
}
function internalUrl(value, port, pathname, network, service) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== (network === "compose" ? service : "127.0.0.1") || Number(url.port) !== port ||
      url.pathname !== pathname || url.username || url.password || url.search || url.hash) throw failure();
}
export async function managedEnvironment(role, directory, ports = servicePorts(), { network = "loopback" } = {}) {
  // Container launchers permit only fixed Compose service names. Arbitrary
  // hosts/public URLs remain invalid, and existing VM defaults stay loopback.
  if (!["loopback", "compose"].includes(network)) throw failure();
  if (!Object.hasOwn(fields, role)) throw failure();
  const settings = JSON.parse(await credential(directory, "runtime.json", 65536));
  if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
      Object.keys(settings).some(key => !fields[role].includes(key)) ||
      fields[role].some(key => typeof settings[key] !== "string" || !settings[key] || settings[key].includes("\0"))) throw failure();
  const db = new URL(settings.DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(db.protocol) || !db.username || !db.password) throw failure();
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(settings.ADMIN_SHARED_SECRET)) throw failure();
  const ingress = role === "staff" ? settings.LOGIN_PROXY_SECRET : settings.REQUEST_PROXY_SECRET;
  if (role !== "reconciler" && (!/^[A-Za-z0-9_-]{32,128}$/.test(ingress) || ingress === settings.ADMIN_SHARED_SECRET)) throw failure();
  if (role === "qr") internalUrl(settings.TRACKER_ASSET_API_URL, ports.staff, "/api/service-assets", network, "staff");
  else internalUrl(settings.SERVICE_REQUEST_API_URL, ports.qr, "/api/requests", network, "qr");
  if (role === "staff") {
    // Production services implement the owner's AD choice. PIN development stays
    // in the existing npm commands, never as a managed-service fallback.
    if (settings.AUTH_MODE !== "ad" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(settings.AD_DIRECTORY_ID)) throw failure();
    const ldap = new URL(settings.AD_LDAP_URL);
    if (ldap.protocol !== "ldaps:" || ldap.username || ldap.password || ldap.search || ldap.hash ||
        (ldap.pathname && ldap.pathname !== "/") || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(ldap.hostname)) throw failure();
    for (const dn of [settings.AD_BASE_DN, settings.AD_BIND_DN])
      if (dn.length > 2048 || /[\r\n]/.test(dn) || !/^[a-z][a-z0-9-]*=/i.test(dn)) throw failure();
    if (settings.AD_BIND_PASSWORD.length > 256) throw failure();
    const ca = await credential(directory, "ad-ca.pem", 262144);
    const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length) throw failure();
    for (const certificate of certificates) new X509Certificate(certificate);
    settings.AD_CA_FILE = path.join(directory, "ad-ca.pem");
  }
  // Deliberately start from an empty environment: no inherited NODE_OPTIONS,
  // operator DB URL, reader password in QR/worker, LD_PRELOAD or shell settings.
  return { ...settings, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", TZ: "UTC",
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: "/nonexistent" };
}
export async function verifyCleanRelease(root) {
  for (const directory of [root, path.join(root, "service-request")]) {
    const names = await readdir(directory);
    // Next auto-loads dotenv files. A stale release credential must not override
    // service isolation; migration-owner files must not live in a web release.
    if (names.some(name => name.startsWith(".env") && !name.endsWith(".example"))) throw failure();
  }
  const version = (await readFile(path.join(root, ".nvmrc"), "utf8")).trim().replace(/^v/, "");
  if (version !== process.versions.node) throw failure();
}
export async function verifyRuntimeDatabase(url) {
  const database = createDatabase(url);
  try {
    // Read catalog metadata only, before launching any application or worker.
    // Reject ownership, DDL and memberships that permit later SET ROLE escalation.
    const result = await database.prepare(`SELECT
      EXISTS (SELECT 1 FROM pg_roles WHERE pg_has_role(current_user, oid, 'MEMBER') AND
        (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR
         rolname ~ '^pg_')) AS unsafe_role,
      has_database_privilege(current_database(), 'CREATE') AS database_ddl,
      pg_has_role(current_user, (SELECT datdba FROM pg_database WHERE datname = current_database()), 'MEMBER') AS database_owner,
      EXISTS (SELECT 1 FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
        AND has_schema_privilege(oid, 'CREATE')) AS schema_ddl,
      EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS relation_owner,
      has_table_privilege('public.schema_migrations', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS migration_access`).first();
    if (!result || Object.values(result).some(value => value !== false)) throw failure();
  } finally { await database.close(); }
}
