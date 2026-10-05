import {
  clearSessionCookie,
  createSession,
  db,
  deleteSession,
  ensureAuthSchema,
  getSessionUser,
  hashPin,
  newSalt,
  normalizeUsername,
  validatePin,
  validateUsername,
} from "../../../lib/pin-auth";

export async function GET(request: Request) {
  try {
    await ensureAuthSchema();
    const count = await db().prepare("SELECT COUNT(*) AS count FROM app_users").first<{ count: number }>();
    const user = await getSessionUser(request);
    return Response.json({ needsSetup: Number(count?.count || 0) === 0, user }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Access service unavailable." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    await ensureAuthSchema();
    const body = await request.json() as { action?: string; name?: string; pin?: string };
    const name = normalizeUsername(body.name);
    const pin = String(body.pin || "");
    if (!validateUsername(name) || !validatePin(pin))
      return Response.json({ error: "Enter a username such as jdoe and a 4–8 digit PIN." }, { status: 400 });

    if (body.action === "setup") {
      const count = await db().prepare("SELECT COUNT(*) AS count FROM app_users").first<{ count: number }>();
      if (Number(count?.count || 0) !== 0)
        return Response.json({ error: "Initial administrator already exists." }, { status: 409 });
      const id = crypto.randomUUID();
      const salt = newSalt();
      const now = new Date().toISOString();
      await db().prepare(
        "INSERT INTO app_users (id, name, role, pin_hash, pin_salt, active, last_login_at, created_at, updated_at) VALUES (?, ?, 'admin', ?, ?, 1, ?, ?, ?)",
      ).bind(id, name, await hashPin(pin, salt), salt, now, now, now).run();
      const session = await createSession(id);
      return Response.json({ user: { id, name, role: "admin" } }, { headers: { "set-cookie": session.cookie } });
    }

    let user = await db().prepare(
      "SELECT id, name, role, pin_hash, pin_salt, active, failed_attempts, locked_until FROM app_users WHERE name = ? COLLATE NOCASE",
    ).bind(name).first<{
      id: string; name: string; role: "admin" | "user"; pin_hash: string; pin_salt: string;
      active: number; failed_attempts: number; locked_until: string | null;
    }>();
    if (!user) {
      const users = await db().prepare(
        "SELECT id, name, role, pin_hash, pin_salt, active, failed_attempts, locked_until FROM app_users",
      ).all<{
        id: string; name: string; role: "admin" | "user"; pin_hash: string; pin_salt: string;
        active: number; failed_attempts: number; locked_until: string | null;
      }>();
      user = users.results.find((candidate) => normalizeUsername(candidate.name) === name);
      if (user) {
        const duplicate = await db().prepare("SELECT id FROM app_users WHERE name = ? COLLATE NOCASE AND id <> ?")
          .bind(name, user.id).first();
        if (!duplicate) {
          await db().prepare("UPDATE app_users SET name = ?, updated_at = ? WHERE id = ?")
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
      await db().prepare("UPDATE app_users SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE id = ?")
        .bind(attempts >= 5 ? 0 : attempts, lockedUntil, new Date().toISOString(), user.id).run();
      return Response.json({ error: lockedUntil ? "Too many attempts. Account locked for 15 minutes." : "Username or PIN is incorrect." }, { status: 401 });
    }
    const signedInAt = new Date().toISOString();
    await db().prepare("UPDATE app_users SET failed_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?")
      .bind(signedInAt, signedInAt, user.id).run();
    const session = await createSession(user.id);
    return Response.json({ user: { id: user.id, name: user.name, role: user.role } }, { headers: { "set-cookie": session.cookie } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to sign in." }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  await deleteSession(request);
  return Response.json({ ok: true }, { headers: { "set-cookie": clearSessionCookie } });
}
