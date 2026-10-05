import {
  clearSessionCookie,
  createSession,
  db,
  deleteSession,
  getSessionUser,
  hashPin,
  normalizeUsername,
  validatePin,
  validateUsername,
} from "../../../lib/pin-auth";

// Server-only PostgreSQL connections require the Node runtime and fresh responses.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const body = await request.json() as { action?: string; name?: string; pin?: string };
    // HTTP never creates the first administrator, even against an empty DB.
    // Only the server operator's local provisioning command can bootstrap users.
    if (body?.action === "setup")
      return Response.json({ error: "Initial administrator setup requires the server operator." }, { status: 403 });
    if (body?.action !== "login")
      return Response.json({ error: "Unsupported authentication action." }, { status: 400 });
    const name = normalizeUsername(body.name);
    const pin = String(body.pin || "");
    if (!validateUsername(name) || !validatePin(pin))
      return Response.json({ error: "Enter a username such as jdoe and a 4–8 digit PIN." }, { status: 400 });

    let user = await db().prepare(
      "SELECT id, name, role, pin_hash, pin_salt, active, failed_attempts, locked_until FROM app_users WHERE lower(name) = lower($1)",
    ).bind(name).first<{
      id: string; name: string; role: "admin" | "user"; pin_hash: string; pin_salt: string;
      active: number; failed_attempts: number; locked_until: string | null;
    }>();
    // Older accounts may use display names. Resolve their normalized username
    // and rename only when it would not collide with another account.
    if (!user) {
      const users = await db().prepare(
        "SELECT id, name, role, pin_hash, pin_salt, active, failed_attempts, locked_until FROM app_users",
      ).all<{
        id: string; name: string; role: "admin" | "user"; pin_hash: string; pin_salt: string;
        active: number; failed_attempts: number; locked_until: string | null;
      }>();
      user = users.results.find((candidate) => normalizeUsername(candidate.name) === name) || null;
      if (user) {
        const duplicate = await db().prepare("SELECT id FROM app_users WHERE lower(name) = lower($1) AND id <> $2")
          .bind(name, user.id).first();
        if (!duplicate) {
          await db().prepare("UPDATE app_users SET name = $1, updated_at = $2 WHERE id = $3")
            .bind(name, new Date().toISOString(), user.id).run();
          user.name = name;
        }
      }
    }
    if (!user || !user.active)
      return Response.json({ error: "Username or PIN is incorrect." }, { status: 401 });
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now())
      return Response.json({ error: "This account is temporarily locked. Try again later." }, { status: 423 });
    const valid = (await hashPin(pin, user.pin_salt)) === user.pin_hash;
    if (!valid) {
      const attempts = Number(user.failed_attempts || 0) + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000).toISOString() : null;
      await db().prepare("UPDATE app_users SET failed_attempts = $1, locked_until = $2, updated_at = $3 WHERE id = $4")
        .bind(attempts >= 5 ? 0 : attempts, lockedUntil, new Date().toISOString(), user.id).run();
      return Response.json({ error: lockedUntil ? "Too many attempts. Account locked for 15 minutes." : "Username or PIN is incorrect." }, { status: 401 });
    }
    const signedInAt = new Date().toISOString();
    await db().prepare("UPDATE app_users SET failed_attempts = 0, locked_until = NULL, last_login_at = $1, updated_at = $2 WHERE id = $3")
      .bind(signedInAt, signedInAt, user.id).run();
    const session = await createSession(user.id);
    return Response.json({ user: { id: user.id, name: user.name, role: user.role } }, { headers: { "set-cookie": session.cookie } });
  } catch {
    return Response.json({ error: "Unable to sign in." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  await deleteSession(request);
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie } });
}
