import { createHash, X509Certificate } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { connect, type TLSSocket, type ConnectionOptions } from "node:tls";
import { Client, Control, AndFilter, EqualityFilter, InvalidCredentialsError, type Entry, type Filter } from "ldapts";
import { AccessInputError } from "./access-input.ts";

export const directoryRecheckSeconds = 60;
export const directoryDeadlineMs = 5000;
const unavailable = () => new AccessInputError("Directory sign-in unavailable.", 503);
const settings = ["AD_DIRECTORY_ID", "AD_LDAP_URL", "AD_BASE_DN", "AD_BIND_DN", "AD_BIND_PASSWORD", "AD_CA_FILE"];

// Partial/unknown configuration must not silently select a public PIN fallback.
export function authenticationMode(env = process.env): "pin" | "ad" {
  if (env.AUTH_MODE === "ad" || env.AUTH_MODE === "pin") return env.AUTH_MODE;
  if (env.AUTH_MODE || settings.some(key => env[key])) throw unavailable();
  return "pin"; // Unconfigured synthetic/local development remains compatible.
}
export function directoryId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw unavailable();
  return value;
}
export function canonicalAdUsername(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) return "";
  const name = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) ? name : "";
}
export function validAdPassword(value: unknown): value is string {
  // Preserve spaces/leading zeros; reject empty binds (LDAP anonymous bind risk).
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
}
export function canonicalGuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(value)) throw unavailable();
  return value.toLowerCase();
}
// AD's first three GUID fields are little-endian; the remaining eight bytes aren't.
export function guidBytes(value: string): Buffer {
  const parts = canonicalGuid(value).split("-");
  const bytes = Buffer.from(parts.join(""), "hex");
  bytes.writeUInt32LE(parseInt(parts[0], 16), 0);
  bytes.writeUInt16LE(parseInt(parts[1], 16), 4);
  bytes.writeUInt16LE(parseInt(parts[2], 16), 6);
  return bytes;
}
export function guidText(bytes: Buffer): string {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw unavailable();
  return `${bytes.readUInt32LE(0).toString(16).padStart(8, "0")}-${bytes.readUInt16LE(4).toString(16).padStart(4, "0")}-${bytes.readUInt16LE(6).toString(16).padStart(4, "0")}-${bytes.subarray(8, 10).toString("hex")}-${bytes.subarray(10).toString("hex")}`;
}

export function adConfiguration(env = process.env) {
  try {
    const id = directoryId(env.AD_DIRECTORY_ID), url = new URL(env.AD_LDAP_URL || "");
    if (url.protocol !== "ldaps:" || url.username || url.password || url.search || url.hash ||
        (url.pathname && url.pathname !== "/") || !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/i.test(url.hostname)) throw unavailable();
    const base = env.AD_BASE_DN || "", reader = env.AD_BIND_DN || "", password = env.AD_BIND_PASSWORD || "";
    for (const dn of [base, reader]) {
      if (!dn || dn.length > 2048 || /[\0\r\n]/.test(dn)) throw unavailable();
      if (!/^[a-z][a-z0-9-]*=/i.test(dn)) throw unavailable();
    }
    if (!validAdPassword(password)) throw unavailable();
    const filename = env.AD_CA_FILE || "";
    if (!isAbsolute(filename)) throw unavailable();
    const info = statSync(filename);
    if (!info.isFile() || info.size > 262144) throw unavailable();
    const ca = readFileSync(filename, "utf8");
    const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length) throw unavailable();
    for (const certificate of certificates) new X509Certificate(certificate);
    // Nonsecret configuration binding invalidates sessions across directory,
    // server, search scope, reader identity or trust-anchor changes.
    const binding = createHash("sha256").update(JSON.stringify([id, url.href, base, reader, ca])).digest("hex");
    return { id, url: url.href, hostname: url.hostname, base, reader, password, ca, binding };
  } catch { throw unavailable(); } // Never expose paths, credentials or TLS diagnostics.
}
export type AdConfiguration = ReturnType<typeof adConfiguration>;
export type AdIdentity = { guid: string; dn: string; username: string; passwordStamp: string; displayName?: string };
function scalar(entry: Entry, attribute: string): string | Buffer {
  const key = Object.keys(entry).find(key => key.toLowerCase() === attribute.toLowerCase());
  const field = key ? entry[key] : undefined;
  const value = Array.isArray(field) && field.length === 1 ? field[0] : field;
  if (typeof value !== "string" && !Buffer.isBuffer(value)) throw unavailable();
  return value;
}
function integer(entry: Entry, attribute: string): bigint {
  const value = scalar(entry, attribute);
  if (typeof value !== "string" || !/^\d{1,19}$/.test(value)) throw unavailable();
  const result = BigInt(value);
  if (result > BigInt("9223372036854775807")) throw unavailable();
  return result;
}
export function adIdentity(entry: Entry, now = Date.now()): AdIdentity | null {
  const guid = scalar(entry, "objectGUID");
  if (!Buffer.isBuffer(guid)) throw unavailable();
  const identity = { guid: guidText(guid), dn: entry.dn, username: canonicalAdUsername(scalar(entry, "sAMAccountName")),
    passwordStamp: integer(entry, "pwdLastSet").toString() };
  if (!identity.username || typeof identity.dn !== "string" || !identity.dn || identity.dn.length > 2048) throw unavailable();
  if (/[\0\r\n]/.test(identity.dn) || !/^[a-z][a-z0-9-]*=/i.test(identity.dn)) throw unavailable();
  const flags = integer(entry, "userAccountControl"), computed = integer(entry, "msDS-User-Account-Control-Computed");
  const expiry = integer(entry, "accountExpires"), filetime = (BigInt(now) + BigInt("11644473600000")) * BigInt("10000");
  if (!(flags & BigInt("512")) || (flags & BigInt("2")) || (computed & (BigInt("16") | BigInt("8388608"))) || identity.passwordStamp === "0" ||
      (expiry !== BigInt("0") && expiry !== BigInt("9223372036854775807") && expiry <= filetime)) return null;
  return identity;
}

// One wall-clock budget covers TLS, reader binds, searches and credential bind.
// Track sockets through the public connection factory to cancel stalled I/O;
// no private ldapts internals, referral following or cached end-user credentials.
async function directoryOperation<T>(config: AdConfiguration, operation: (client: () => Client) => Promise<T>): Promise<T> {
  const sockets = new Set<TLSSocket>();
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const client = () => new Client({ url: config.url, timeout: 2000, connectTimeout: 2000, autoRebind: false,
    tlsOptions: { ca: config.ca, servername: config.hostname, minVersion: "TLSv1.2", rejectUnauthorized: true },
    createSecureConnection: ((port: number, host: string, options: ConnectionOptions) => {
      if (stopped) throw unavailable();
      const socket = connect({ ...options, port, host }); sockets.add(socket); return socket;
    }) as typeof connect,
  });
  try {
    return await Promise.race([operation(client), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { stopped = true; for (const socket of sockets) socket.destroy(); reject(unavailable()); }, directoryDeadlineMs);
    })]);
  } catch { throw unavailable(); }
  finally { stopped = true; clearTimeout(timer); for (const socket of sockets) socket.destroy(); }
}
// Structured equality filters encode values separately from filter syntax. Keep
// GUIDs as Buffer values: string filter parsing would UTF-8 encode binary bytes.
async function searchIdentity(client: Client, config: AdConfiguration, filter: Filter, preview = false): Promise<AdIdentity | null> {
  await client.bind(config.reader, config.password);
  // AD domain-root searches otherwise include referrals to DNS/other partitions.
  // Require DOMAIN_SCOPE (no control value) to stay in one naming context; an
  // unsupported control or any unexpected returned referral still fails closed.
  const result = await client.search(config.base, { scope: "sub", filter: new AndFilter({ filters: [
      new EqualityFilter({ attribute: "objectCategory", value: "person" }),
      new EqualityFilter({ attribute: "objectClass", value: "user" }), filter,
    ] }),
    sizeLimit: 2, timeLimit: 2, paged: false, derefAliases: "never",
    attributes: ["objectGUID", "sAMAccountName", "userAccountControl", "msDS-User-Account-Control-Computed", "pwdLastSet", "accountExpires", ...(preview ? ["displayName"] : [])],
    explicitBufferAttributes: ["objectGUID"],
  }, new Control("1.2.840.113556.1.4.1339", { critical: true }));
  if (result.searchReferences.length || result.searchEntries.length > 1) throw unavailable();
  const entry = result.searchEntries[0], identity = entry ? adIdentity(entry) : null;
  if (!identity || !preview) return identity;
  // The optional name helps an administrator review the person found. It never
  // selects an identity, changes directory eligibility, or becomes a login key.
  const key = Object.keys(entry).find(key => key.toLowerCase() === "displayname");
  const name = key ? entry[key] : undefined;
  return { ...identity, displayName: typeof name === "string" && name.length <= 256 && !/[\x00-\x1f]/.test(name) && name.trim()
    ? name.trim() : identity.username };
}
export async function verifyAdPassword(config: AdConfiguration, username: string, password: string): Promise<AdIdentity | null> {
  if (!canonicalAdUsername(username) || !validAdPassword(password)) return null;
  return directoryOperation(config, async create => {
    const reader = create();
    const identity = await searchIdentity(reader, config, new EqualityFilter({ attribute: "sAMAccountName", value: username }));
    if (!identity || identity.username !== canonicalAdUsername(username)) return null;
    try { await create().bind(identity.dn, password); }
    catch (error) { if (error instanceof InvalidCredentialsError) return null; throw error; }
    // Recheck after bind: a reset/disable during verification must not issue a
    // session from the earlier metadata. LDAP and SQL still have no global lock.
    const current = await searchIdentity(reader, config, new EqualityFilter({ attribute: "objectGUID", value: guidBytes(identity.guid) }));
    return current && current.guid === identity.guid && current.passwordStamp === identity.passwordStamp ? current : null;
  });
}
export async function lookupAdGuid(config: AdConfiguration, guid: string, preview = false): Promise<AdIdentity | null> {
  return directoryOperation(config, create => searchIdentity(create(), config, new EqualityFilter({ attribute: "objectGUID", value: guidBytes(guid) }), preview));
}
// Administrator onboarding is a read-only exact lookup using the same verified
// TLS, domain scope, account flags, ambiguity checks and five-second deadline.
export async function lookupAdUsername(config: AdConfiguration, value: string): Promise<AdIdentity | null> {
  const name = canonicalAdUsername(value);
  if (!name) return null;
  return directoryOperation(config, async create => {
    const identity = await searchIdentity(create(), config, new EqualityFilter({ attribute: "sAMAccountName", value: name }), true);
    return identity?.username === name ? identity : null;
  });
}
