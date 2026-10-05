import { db, hashPin, newSalt, normalizeUsername, requireUser, validatePin, validateUsername } from "../../../lib/pin-auth";

// Server-only PostgreSQL connections require the Node runtime and fresh responses.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireUser(request, "admin");
  if (auth.response) return auth.response;
  const users = await db().prepare(
    "SELECT id, name, role, active, failed_attempts, locked_until, last_login_at, created_at, updated_at FROM app_users ORDER BY active DESC, lower(name)",
  ).all();
  return Response.json({ users: users.results });
}

export async function POST(request: Request) {
  const auth = await requireUser(request, "admin");
  if (auth.response) return auth.response;
  const body = await request.json() as { name?: string; pin?: string; role?: string };
  const name = normalizeUsername(body.name);
  const pin = String(body.pin || "");
  const role = body.role === "admin" ? "admin" : "user";
  if (!validateUsername(name) || !validatePin(pin))
    return Response.json({ error: "Enter a username such as jdoe and a 4–8 digit PIN." }, { status: 400 });
  const duplicate = await db().prepare("SELECT id FROM app_users WHERE lower(name) = lower($1)").bind(name).first();
  if (duplicate) return Response.json({ error: "That username already exists." }, { status: 409 });
  const salt = newSalt();
  const now = new Date().toISOString();
  try {
    await db().prepare(
      "INSERT INTO app_users (id, name, role, pin_hash, pin_salt, active, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, $7)",
    ).bind(crypto.randomUUID(), name, role, await hashPin(pin, salt), salt, now, now).run();
    await db().prepare(
      "INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES ($1, $2, $3, $4, $5)",
    ).bind(crypto.randomUUID(), auth.user!.id, auth.user!.name, `Added ${role === "admin" ? "administrator" : "user"} ${name}`, now).run();
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "That username already exists." }, { status: 409 });
  }
}

// Administrative account updates currently preserve issued sessions after a PIN
// reset and permit demotion of the last administrator; track both under AUTH-01.
export async function PATCH(request: Request) {
  const auth = await requireUser(request, "admin");
  if (auth.response) return auth.response;
  const body = await request.json() as { id?: string; name?: string; role?: string; active?: boolean; pin?: string; unlock?: boolean };
  const id = String(body.id || "");
  const target = await db().prepare("SELECT id, role, active FROM app_users WHERE id = $1").bind(id).first<{ id: string; role: string; active: number }>();
  if (!target) return Response.json({ error: "User not found." }, { status: 404 });
  if (id === auth.user!.id && body.active === false)
    return Response.json({ error: "You cannot deactivate your own account." }, { status: 400 });
  const name = normalizeUsername(body.name);
  const role = body.role === "admin" ? "admin" : "user";
  const active = body.active === false ? 0 : 1;
  if (!validateUsername(name))
    return Response.json({ error: "Enter a username such as jdoe." }, { status: 400 });
  const now = new Date().toISOString();
  const duplicate = await db().prepare("SELECT id FROM app_users WHERE lower(name) = lower($1) AND id <> $2").bind(name, id).first();
  if (duplicate) return Response.json({ error: "That username already exists." }, { status: 409 });
  if (body.pin) {
    if (!validatePin(body.pin)) return Response.json({ error: "PIN must be 4–8 digits." }, { status: 400 });
    const salt = newSalt();
    await db().prepare(
      "UPDATE app_users SET name = $1, role = $2, active = $3, pin_hash = $4, pin_salt = $5, failed_attempts = 0, locked_until = NULL, updated_at = $6 WHERE id = $7",
    ).bind(name, role, active, await hashPin(body.pin, salt), salt, now, id).run();
  } else {
    await db().prepare(
      `UPDATE app_users
       SET name = $1, role = $2, active = $3,
           failed_attempts = CASE WHEN $4::integer = 1 THEN 0 ELSE failed_attempts END,
           locked_until = CASE WHEN $5::integer = 1 THEN NULL ELSE locked_until END,
           updated_at = $6
       WHERE id = $7`,
    ).bind(name, role, active, body.unlock ? 1 : 0, body.unlock ? 1 : 0, now, id).run();
  }
  await db().prepare(
    "INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES ($1, $2, $3, $4, $5)",
  ).bind(crypto.randomUUID(), auth.user!.id, auth.user!.name, body.unlock ? `Unlocked user ${name}` : `Updated user ${name}`, now).run();
  return Response.json({ ok: true });
}
