import type { Database } from "@tanmar/database";
import {
  clearSessionCookie, db, hashPin, newSalt, normalizeUsername, requireUser,
  validatePin, validateUsername, type SessionUser,
} from "../../../lib/pin-auth";
import { AccessInputError, accessError, readAccessBody } from "../../../lib/access-input";
import { authenticationMode, adConfiguration, canonicalAdUsername, lookupAdGuid } from "../../../lib/ad-auth";
import { readAdConfirmation } from "../../../lib/ad-enrollment";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Account = { id: string; name: string; role: "admin" | "user"; active: number; ad_guid?: string | null; ad_directory?: string | null };

function accountError(error: unknown) {
  // A database/operator writer can race the duplicate pre-check. Only an actual
  // uniqueness violation is a conflict; outages must not claim the name is taken.
  if (error && typeof error === "object" && "code" in error && error.code === "23505")
    return Response.json({ error: "That username already exists." }, { status: 409 });
  return accessError(error, "Account service unavailable.");
}

function username(value: unknown) {
  if (authenticationMode() === "ad") {
    const name = canonicalAdUsername(value);
    if (!name) throw new AccessInputError("Enter an AD username such as j.doe.");
    return name;
  }
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

async function reviewedIdentity(request: Request, body: Record<string, unknown>, actor: SessionUser, targetUserId: string | null, name: string) {
  const config = adConfiguration(), approval = readAdConfirmation(body.directoryConfirmation,
    { id: actor.id, context: request.headers.get("x-tracker-session-context")! }, config, targetUserId);
  if (approval.username !== name) throw new AccessInputError("Find and review the AD user again after changing the username.", 409);
  // Verify the reviewed immutable GUID again, never a new object that reuses its
  // username. Directory I/O happens before SQL locks; login still checks AD itself.
  const current = await lookupAdGuid(config, approval.guid, true);
  if (!current || current.guid !== approval.guid || current.username !== approval.username || current.displayName !== approval.displayName)
    throw new AccessInputError("The reviewed AD account changed or is unavailable. Find the user again.", 409);
  return { config, approval };
}

function recheckApproval(request: Request, body: Record<string, unknown>, actor: SessionUser, targetUserId: string | null) {
  // A long account-lock wait or changed runtime binding cannot extend an old
  // review. The token also belongs to the exact currently authorized session.
  return readAdConfirmation(body.directoryConfirmation, { id: actor.id, context: request.headers.get("x-tracker-session-context")! }, adConfiguration(), targetUserId);
}

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request, "admin");
    if (auth.response) return auth.response;
    // Never return PIN hashes/salts or session tokens to the management UI.
    const users = await db().prepare(
      `SELECT id, name, role, active, failed_attempts, locked_until, last_login_at, created_at, updated_at,
        (ad_guid IS NOT NULL AND ad_directory = $1) AS ad_linked FROM app_users ORDER BY active DESC, lower(name)`,
    ).bind(authenticationMode() === "ad" ? adConfiguration().id : null).all();
    return Response.json({ users: users.results, authMode: authenticationMode() }, { headers: { "cache-control": "no-store" } });
  } catch (error) { return accountError(error); }
}

export async function POST(request: Request) {
  try {
    const initial = await requireUser(request, "admin");
    if (initial.response) return initial.response;
    const body = await readAccessBody(request);
    const mode = authenticationMode();
    // Administrators grant app access to a server-looked-up, reviewed AD user;
    // direct GUID/credential writes remain invalid. There is no login auto-link.
    if (body.ad_guid !== undefined || body.ad_directory !== undefined || body.password !== undefined ||
        (mode === "ad" && body.pin !== undefined && body.pin !== ""))
      throw new AccessInputError("Manage directory identities and credentials through your administrator.");
    const name = username(body.name);
    const pin = body.pin;
    const role = roleValue(body.role, "user");
    if (mode === "pin" && body.directoryConfirmation !== undefined) throw new AccessInputError("AD account lookup is not enabled.", 409);
    if (mode === "pin" && !validatePin(pin)) throw new AccessInputError("PIN must be 4–8 digits.");
    const enrollment = mode === "ad" ? await reviewedIdentity(request, body, initial.user!, null, name) : null;
    const salt = newSalt();
    // Preserve historical schema constraints without inventing an AD-mode PIN.
    const pinHash = mode === "ad" ? newSalt() + newSalt() : await hashPin(pin as string, salt);
    return await db().transaction(async (tx) => {
      // Serialize all account mutations before checking the actor or admin count.
      // Authorization outside this transaction can become stale while queued.
      await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const auth = await requireUser(request, "admin", tx);
      if (auth.response) return auth.response;
      if (enrollment) {
        recheckApproval(request, body, auth.user!, null);
        const linked = await tx.prepare("SELECT id FROM app_users WHERE ad_directory=$1 AND ad_guid=$2")
          .bind(enrollment.config.id, enrollment.approval.guid).first();
        if (linked) throw new AccessInputError("This AD account already has an application account. Manage that account instead.", 409);
      }
      const duplicate = await tx.prepare("SELECT id FROM app_users WHERE lower(name) = lower($1)").bind(name).first();
      if (duplicate) return Response.json({ error: "That username already exists." }, { status: 409 });
      const now = new Date().toISOString();
      await tx.prepare("INSERT INTO app_users (id, name, role, pin_hash, pin_salt, active, created_at, updated_at, ad_directory, ad_guid) VALUES ($1, $2, $3, $4, $5, 1, $6, $6, $7, $8)")
        .bind(crypto.randomUUID(), name, role, pinHash, salt, now, enrollment?.config.id ?? null, enrollment?.approval.guid ?? null).run();
      await audit(tx, auth.user!, `Added ${role === "admin" ? "administrator" : "user"} ${name}${enrollment ? " with reviewed AD account link" : ""}`, now);
      return Response.json({ ok: true });
    });
  } catch (error) { return accountError(error); }
}

export async function PATCH(request: Request) {
  try {
    const initial = await requireUser(request, "admin");
    if (initial.response) return initial.response;
    const body = await readAccessBody(request);
    if (body.ad_guid !== undefined || body.ad_directory !== undefined || body.password !== undefined ||
        (authenticationMode() === "ad" && ((body.pin !== undefined && body.pin !== "") || body.unlock === true)))
      throw new AccessInputError("Manage directory identities and credentials through your administrator.");
    if (typeof body.id !== "string" || !body.id || body.id.length > 128)
      throw new AccessInputError("Choose a user to update.");
    const linking = body.directoryConfirmation !== undefined;
    if (linking && authenticationMode() !== "ad") throw new AccessInputError("AD account lookup is not enabled.", 409);
    const adName = linking ? canonicalAdUsername(body.adUsername) : "";
    if (linking && !adName) throw new AccessInputError("Enter the reviewed AD username.");
    const enrollment = linking ? await reviewedIdentity(request, body, initial.user!, body.id, adName) : null;
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
      const target = await tx.prepare("SELECT id, name, role, active, ad_guid, ad_directory FROM app_users WHERE id = $1 FOR UPDATE")
        .bind(body.id).first<Account>();
      if (!target) return Response.json({ error: "User not found." }, { status: 404 });
      if (enrollment) {
        recheckApproval(request, body, auth.user!, target.id);
        if (target.ad_guid || target.ad_directory) throw new AccessInputError("This application user is already linked. Existing links require operator review.", 409);
        const linked = await tx.prepare("SELECT id FROM app_users WHERE ad_directory=$1 AND ad_guid=$2")
          .bind(enrollment.config.id, enrollment.approval.guid).first();
        if (linked) throw new AccessInputError("This AD account already has an application account. Manage that account instead.", 409);
      }
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
        updated_at = $7, ad_directory = COALESCE($9, ad_directory), ad_guid = COALESCE($10, ad_guid) WHERE id = $8`)
        .bind(name, role, active, pinHash, salt, resetPin || body.unlock === true, now, target.id,
          enrollment?.config.id ?? null, enrollment?.approval.guid ?? null).run();
      const revoke = Boolean(enrollment) || resetPin || role !== target.role || active !== target.active;
      if (revoke) await tx.prepare("DELETE FROM app_sessions WHERE user_id = $1").bind(target.id).run();
      const action = enrollment ? `Linked reviewed AD account ${enrollment.approval.username} to user ${name}` : resetPin ? `Reset PIN for user ${name}` : body.unlock ? `Unlocked user ${name}` : `Updated user ${name}`;
      await audit(tx, auth.user!, action, now);
      const reauthenticate = revoke && target.id === auth.user!.id;
      return Response.json({ ok: true, reauthenticate }, {
        ...(reauthenticate ? { headers: { "set-cookie": clearSessionCookie } } : {}),
      });
    });
  } catch (error) { return accountError(error); }
}
