type RuntimeEnv = { DB?: D1Database };

export type SessionUser = {
  id: string;
  name: string;
  role: "admin" | "user";
};

const SESSION_COOKIE = "tanmar_session";
const encoder = new TextEncoder();

export function db() {
  const runtime = (
    globalThis as typeof globalThis & { __ASSET_TRACKER_ENV__?: RuntimeEnv }
  ).__ASSET_TRACKER_ENV__;
  if (!runtime?.DB) throw new Error("Cloud database is unavailable.");
  return runtime.DB;
}

export async function ensureAuthSchema() {
  const d1 = db();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      role TEXT NOT NULL CHECK (role IN ('admin','user')),
      pin_hash TEXT NOT NULL,
      pin_salt TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      failed_attempts INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_change_log (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      user_name TEXT NOT NULL,
      action TEXT NOT NULL,
      revision INTEGER,
      created_at TEXT NOT NULL
    )`),
    d1.prepare("CREATE INDEX IF NOT EXISTS app_sessions_token_idx ON app_sessions (token_hash)"),
    d1.prepare("CREATE INDEX IF NOT EXISTS app_change_log_created_idx ON app_change_log (created_at)"),
  ]);
  const columns = await d1.prepare("PRAGMA table_info(app_users)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "last_login_at"))
    await d1.prepare("ALTER TABLE app_users ADD COLUMN last_login_at TEXT").run();
}

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

export async function getSessionUser(request: Request): Promise<SessionUser | null> {
  await ensureAuthSchema();
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await db().prepare(
    `SELECT u.id, u.name, u.role
     FROM app_sessions s JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1`,
  ).bind(tokenHash, new Date().toISOString()).first<SessionUser>();
  return row || null;
}

export async function requireUser(request: Request, role?: "admin") {
  const user = await getSessionUser(request);
  if (!user) return { user: null, response: Response.json({ error: "Sign in required." }, { status: 401 }) };
  if (role === "admin" && user.role !== "admin") {
    await db().prepare(
      "INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES (?, ?, ?, ?, ?)",
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

export async function createSession(userId: string) {
  const token = randomHex(32);
  const now = new Date();
  const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);
  await db().prepare(
    "INSERT INTO app_sessions (id, user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), userId, await sha256(token), expires.toISOString(), now.toISOString()).run();
  return {
    token,
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
  };
}

export async function deleteSession(request: Request) {
  const token = cookieValue(request, SESSION_COOKIE);
  if (token) await db().prepare("DELETE FROM app_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
}

export const clearSessionCookie = `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
