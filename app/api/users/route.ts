import type { Database } from "@tanmar/database";
import {
  clearSessionCookie, db, hashPin, newSalt, normalizeUsername, requireUser,
  validatePin, validateUsername, type SessionUser,
} from "../../../lib/pin-auth";
import { AccessInputError, accessError, readAccessBody } from "../../../lib/access-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Account = { id: string; name: string; role: "admin" | "user"; active: number };

function accountError(error: unknown) {
  // A database/operator writer can race the duplicate pre-check. Only an actual
  // uniqueness violation is a conflict; outages must not claim the name is taken.
  if (error && typeof error === "object" && "code" in error && error.code === "23505")
    return Response.json({ error: "That username already exists." }, { status: 409 });
  return accessError(error, "Account service unavailable.");
}

function username(value: unknown) {
  if (typeof value !== "string" || value.length > 128)
    throw new AccessInputError("Enter a username such as jdoe.");
  const name = normalizeUsername(value);
  if (!validateUsername(name)) throw new AccessInputError("Enter a username such as jdoe.");
  return name;
}

function roleValue(value: unknown, fallback: Account["role"]): Account["role"] {
  if (value === undefined) return fallback;
  if (value !== "admin" && value !== "user") throw new AccessInputError("Choose an administrator or regular user role.");
  return value;
}

async function audit(tx: Database, actor: SessionUser, action: string, now: string) {
  await tx.prepare("INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES ($1, $2, $3, $4, $5)")
    .bind(crypto.randomUUID(), actor.id, actor.name, action, now).run();
}

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request, "admin");
    if (auth.response) return auth.response;
    // Never return PIN hashes/salts or session tokens to the management UI.
    const users = await db().prepare(
      "SELECT id, name, role, active, failed_attempts, locked_until, last_login_at, created_at, updated_at FROM app_users ORDER BY active DESC, lower(name)",
    ).all();
    return Response.json({ users: users.results }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return accountError(error); }
}

export async function POST(request: Request) {
  try {
    const initial = await requireUser(request, "admin");
    if (initial.response) return initial.response;
    const body = await readAccessBody(request);
    const name = username(body.name);
    const pin = body.pin;
    const role = roleValue(body.role, "user");
    if (!validatePin(pin)) throw new AccessInputError("PIN must be 4–8 digits.");
    const salt = newSalt();
    const pinHash = await hashPin(pin as string, salt);
    return await db().transaction(async (tx) => {
      // Serialize all account mutations before checking the actor or admin count.
      // Authorization outside this transaction can become stale while queued.
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const auth = await requireUser(request, "admin", tx);
      if (auth.response) return auth.response;
      const duplicate = await tx.prepare("SELECT id FROM app_users WHERE lower(name) = lower($1)").bind(name).first();
      if (duplicate) return Response.json({ error: "That username already exists." }, { status: 409 });
      const now = new Date().toISOString();
      await tx.prepare("INSERT INTO app_users (id, name, role, pin_hash, pin_salt, active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $6)")
        .bind(crypto.randomUUID(), name, role, pinHash, salt, now).run();
      await audit(tx, auth.user!, `Added ${role === "admin" ? "administrator" : "user"} ${name}`, now);
      return Response.json({ ok: true });
    });
  } catch (error) { return accountError(error); }
}

export async function PATCH(request: Request) {
  try {
    const initial = await requireUser(request, "admin");
    if (initial.response) return initial.response;
    const body = await readAccessBody(request);
    if (typeof body.id !== "string" || !body.id || body.id.length > 128)
      throw new AccessInputError("Choose a user to update.");
    const providedName = body.name === undefined ? undefined : username(body.name);
    if (body.active !== undefined && typeof body.active !== "boolean")
      throw new AccessInputError("Active must be true or false.");
    if (body.unlock !== undefined && typeof body.unlock !== "boolean")
      throw new AccessInputError("Unlock must be true or false.");
    // The UI sends an empty optional PIN to mean unchanged; other invalid values
    // must not silently become an unlock or an account activation.
    const resetPin = body.pin !== undefined && body.pin !== "";
    if (resetPin && !validatePin(body.pin)) throw new AccessInputError("PIN must be 4–8 digits.");
    const salt = resetPin ? newSalt() : null;
    const pinHash = resetPin ? await hashPin(body.pin as string, salt!) : null;
    return await db().transaction(async (tx) => {
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const auth = await requireUser(request, "admin", tx);
      if (auth.response) return auth.response;
      // Match login's row lock so a reset cannot leave a session issued against
      // the old PIN. Omitted PATCH properties preserve the existing account.
      const target = await tx.prepare("SELECT id, name, role, active FROM app_users WHERE id = $1 FOR UPDATE")
        .bind(body.id).first<Account>();
      if (!target) return Response.json({ error: "User not found." }, { status: 404 });
      const name = providedName ?? target.name;
      const role = roleValue(body.role, target.role);
      const active = body.active === undefined ? target.active : body.active ? 1 : 0;
      if (target.id === auth.user!.id && active === 0)
        return Response.json({ error: "You cannot deactivate your own account." }, { status: 400 });
      if (target.role === "admin" && target.active === 1 && (role !== "admin" || active === 0)) {
        const admins = await tx.prepare("SELECT COUNT(*) AS total FROM app_users WHERE role = 'admin' AND active = 1").first<{ total: string }>();
        if (Number(admins?.total) <= 1)
          return Response.json({ error: "Keep at least one active administrator." }, { status: 409 });
      }
      const duplicate = await tx.prepare("SELECT id FROM app_users WHERE lower(name) = lower($1) AND id <> $2").bind(name, target.id).first();
      if (duplicate) return Response.json({ error: "That username already exists." }, { status: 409 });
      const now = new Date().toISOString();
      await tx.prepare(`UPDATE app_users SET name = $1, role = $2, active = $3,
        pin_hash = COALESCE($4, pin_hash), pin_salt = COALESCE($5, pin_salt),
        failed_attempts = CASE WHEN $6::boolean THEN 0 ELSE failed_attempts END,
        locked_until = CASE WHEN $6::boolean THEN NULL ELSE locked_until END,
        updated_at = $7 WHERE id = $8`)
        .bind(name, role, active, pinHash, salt, resetPin || body.unlock === true, now, target.id).run();
      const revoke = resetPin || role !== target.role || active !== target.active;
      if (revoke) await tx.prepare("DELETE FROM app_sessions WHERE user_id = $1").bind(target.id).run();
      const action = resetPin ? `Reset PIN for user ${name}` : body.unlock ? `Unlocked user ${name}` : `Updated user ${name}`;
      await audit(tx, auth.user!, action, now);
      const reauthenticate = revoke && target.id === auth.user!.id;
      return Response.json({ ok: true, reauthenticate }, {
        ...(reauthenticate ? { headers: { "set-cookie": clearSessionCookie } } : {}),
      });
    });
  } catch (error) { return accountError(error); }
}
