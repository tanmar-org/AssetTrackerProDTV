import { database } from "./database.ts";
import type { Database } from "@tanmar/database";

export type SessionUser = {
  id: string;
  name: string;
  role: "admin" | "user";
};

const SESSION_COOKIE = "tanmar_session";
const encoder = new TextEncoder();

// Web requests use the restricted PostgreSQL runtime connection; they never run DDL.
export const db = database;

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return hex(bytes);
}

async function sha256(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

// A domain-separated digest identifies this browser session without revealing
// its bearer token or the database token hash. It is never authentication itself.
export async function sessionContext(request: Request) {
  const token = cookieValue(request, SESSION_COOKIE);
  return token ? sha256(`tanmar-browser-session:${token}`) : null;
}

export function tokenContext(token: string) { return sha256(`tanmar-browser-session:${token}`); }

// Salted PBKDF2 protects stored PINs; the small PIN space still requires effective
// login throttling. Never log the supplied PIN or derived hash.
export async function hashPin(pin: string, salt: string) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode(salt), iterations: 100000 },
    key,
    256,
  );
  return hex(new Uint8Array(bits));
}

export function validatePin(pin: unknown) {
  return typeof pin === "string" && /^\d{4,8}$/.test(pin);
}

export function normalizeUsername(value: unknown) {
  const parts = String(value || "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  if (!parts.length) return "";
  const username = parts.length > 1 ? `${parts[0][0]}${parts.at(-1)}` : parts[0];
  return username.replace(/[^a-z0-9]/g, "");
}

export function validateUsername(value: unknown) {
  return typeof value === "string" && /^[a-z][a-z0-9]{1,39}$/.test(value);
}

export function newSalt() {
  return randomHex(16);
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") || "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      // Malformed/foreign cookies are unauthenticated input, not server errors.
      try {
        const token = decodeURIComponent(value.join("="));
        return /^[a-f0-9]{64}$/.test(token) ? token : "";
      } catch { return ""; }
    }
  }
  return "";
}

// Only the token hash is stored. Join against the current user record so account
// deactivation and role changes apply to existing sessions on their next request.
export async function getSessionUser(request: Request, connection?: Database): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await (connection ?? db()).prepare(
    `SELECT u.id, u.name, u.role
     FROM app_sessions s JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = 1`,
  ).bind(tokenHash, new Date().toISOString()).first<SessionUser>();
  return row || null;
}

export async function requireUser(request: Request, role?: "admin", connection?: Database) {
  const user = await getSessionUser(request, connection);
  if (!user) return { user: null, response: Response.json({ error: "Sign in required." }, { status: 401 }) };
  // Cookies are shared across tabs. Bind every mutation to the session that
  // loaded its UI, including same-user re-logins. Reads check a supplied context
  // too; missing context on writes requires older tabs/integrations to reload.
  const expected = request.headers.get("x-tracker-session-context");
  if ((!['GET', 'HEAD', 'OPTIONS'].includes(request.method) || expected !== null) &&
      (!expected || expected !== await sessionContext(request)))
    return { user: null, response: Response.json({ error: "Session changed. Sign in again." }, { status: 401 }) };
  if (role === "admin" && user.role !== "admin") {
    await (connection ?? db()).prepare(
      "INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES ($1, $2, $3, $4, $5)",
    ).bind(
      crypto.randomUUID(),
      user.id,
      user.name,
      "Denied: administrator-only access",
      new Date().toISOString(),
    ).run();
    return { user: null, response: Response.json({ error: "Administrator access required." }, { status: 403 }) };
  }
  return { user, response: null };
}

// The browser receives a 12-hour bearer cookie; HttpOnly keeps it out of client
// JavaScript and Secure requires HTTPS outside localhost development handling.
// Login supplies its transaction so session issuance and account checks commit
// together. PIN/role updates lock the same user row before revoking sessions.
export async function createSession(userId: string, connection: Database = db()) {
  const token = randomHex(32);
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  await connection.prepare(
    "INSERT INTO app_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)",
  ).bind(crypto.randomUUID(), userId, await sha256(token), expires.toISOString(), now.toISOString()).run();
  return {
    token,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
  };
}

export async function deleteSession(request: Request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await db().transaction(async (tx) => {
    // Serialize with authorized staff writes. A save either commits before the
    // sign-out or rechecks the revoked session afterwards; preserve lock order.
    await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
    await tx.prepare("DELETE FROM app_sessions WHERE token_hash = $1").bind(await sha256(token)).run();
  });
}

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
