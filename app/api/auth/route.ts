import { timingSafeEqual } from "node:crypto";
import {
  clearSessionCookie, createSession, db, deleteSession, getSessionUser,
  hashPin, normalizeUsername, validatePin, validateUsername,
} from "../../../lib/pin-auth";
import { accessError, readAccessBody } from "../../../lib/access-input";

// Server-only PostgreSQL connections require the Node runtime and fresh responses.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LoginUser = {
  id: string; name: string; role: "admin" | "user"; pin_hash: string; pin_salt: string;
  active: number; failed_attempts: number; locked_until: string | null;
};
const loginColumns = "id, name, role, pin_hash, pin_salt, active, failed_attempts, locked_until";

export async function GET(request: Request) {
  try {
    const count = await db().prepare("SELECT COUNT(*) AS count FROM app_users").first<{ count: number }>();
    const user = await getSessionUser(request);
    return Response.json({ needsProvisioning: Number(count?.count || 0) === 0, user }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ error: "Access service unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await readAccessBody(request);
    // HTTP never creates the first administrator, even against an empty DB.
    if (body.action === "setup")
      return Response.json({ error: "Initial administrator setup requires the server operator." }, { status: 403 });
    if (body.action !== "login")
      return Response.json({ error: "Unsupported authentication action." }, { status: 400 });
    const name = typeof body.name === "string" && body.name.length <= 128 ? normalizeUsername(body.name) : "";
    const pin = body.pin;
    if (!validateUsername(name) || !validatePin(pin))
      return Response.json({ error: "Enter a username such as jdoe and a 4–8 digit PIN." }, { status: 400 });

    return await db().transaction(async (tx) => {
      // A row lock serializes attempts for this account across server processes.
      // Hold it through session insertion: a concurrent PIN reset either precedes
      // this verification or follows it and revokes the newly committed session.
      let user = await tx.prepare(`SELECT ${loginColumns} FROM app_users WHERE lower(name) = lower($1) FOR UPDATE`)
        .bind(name).first<LoginUser>();
      if (!user) {
        // Preserve legacy display-name login without silently renaming users or
        // reading every PIN hash. Ambiguous aliases must be corrected by an admin.
        const candidates = await tx.prepare("SELECT id, name FROM app_users").all<{ id: string; name: string }>();
        const matches = candidates.results.filter((candidate) => normalizeUsername(candidate.name) === name);
        if (matches.length === 1) {
          user = await tx.prepare(`SELECT ${loginColumns} FROM app_users WHERE id = $1 FOR UPDATE`)
            .bind(matches[0].id).first<LoginUser>();
          if (user && normalizeUsername(user.name) !== name) user = null;
        }
      }
      if (!user || !user.active)
        return Response.json({ error: "Username or PIN is incorrect." }, { status: 401 });
      const now = new Date();
      if (user.locked_until && new Date(user.locked_until).getTime() > now.getTime())
        return Response.json({ error: "This account is temporarily locked. Try again later." }, { status: 423 });
      const derived = Buffer.from(await hashPin(pin as string, user.pin_salt), "hex");
      const stored = Buffer.from(user.pin_hash, "hex");
      const valid = derived.length === stored.length && timingSafeEqual(derived, stored);
      if (!valid) {
        const attempts = user.failed_attempts + 1;
        const lockedUntil = attempts >= 5 ? new Date(now.getTime() + 15 * 60 * 1000).toISOString() : null;
        await tx.prepare("UPDATE app_users SET failed_attempts = $1, locked_until = $2, updated_at = $3 WHERE id = $4")
          .bind(attempts >= 5 ? 0 : attempts, lockedUntil, now.toISOString(), user.id).run();
        return Response.json({ error: lockedUntil ? "Too many attempts. Account locked for 15 minutes." : "Username or PIN is incorrect." }, { status: 401 });
      }
      await tx.prepare("UPDATE app_users SET failed_attempts = 0, locked_until = NULL, last_login_at = $1, updated_at = $1 WHERE id = $2")
        .bind(now.toISOString(), user.id).run();
      // Expired sessions for this account are no longer useful bearer records.
      await tx.prepare("DELETE FROM app_sessions WHERE user_id = $1 AND expires_at <= $2")
        .bind(user.id, now.toISOString()).run();
      const session = await createSession(user.id, tx);
      return Response.json({ user: { id: user.id, name: user.name, role: user.role } }, { headers: { "set-cookie": session.cookie } });
    });
  } catch (error) { return accessError(error, "Unable to sign in."); }
}

export async function DELETE(request: Request) {
  try {
    await deleteSession(request);
    return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie } });
  } catch { return Response.json({ error: "Unable to sign out." }, { status: 503 }); }
}
