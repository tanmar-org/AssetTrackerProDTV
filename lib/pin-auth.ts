import { database } from "./database.ts";

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
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return "";
}

// Only the token hash is stored. Join against the current user record so account
// deactivation and role changes apply to existing sessions on their next request.
export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await db().prepare(
    `SELECT u.id, u.name, u.role
     FROM app_sessions s JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > $2 AND u.active = 1`,
  ).bind(tokenHash, new Date().toISOString()).first<SessionUser>();
  return row || null;
}

export async function requireUser(request: Request, role?: "admin") {
  const user = await getSessionUser(request);
  if (!user) return { user: null, response: Response.json({ error: "Sign in required." }, { status: 401 }) };
  if (role === "admin" && user.role !== "admin") {
    await db().prepare(
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
export async function createSession(userId: string) {
  const token = randomHex(32);
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  await db().prepare(
    "INSERT INTO app_sessions (id, user_id, token_hash, expires_at, created_at) VALUES ($1, $2, $3, $4, $5)",
  ).bind(crypto.randomUUID(), userId, await sha256(token), expires.toISOString(), now.toISOString()).run();
  return {
    token,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
  };
}

export async function deleteSession(request: Request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await db().prepare("DELETE FROM app_sessions WHERE token_hash = $1").bind(await sha256(token)).run();
}

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
