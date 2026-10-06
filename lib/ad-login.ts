import { adConfiguration, verifyAdPassword } from "./ad-auth.ts";
import { createSession, db, tokenContext, type SessionUser } from "./pin-auth.ts";

// The caller has validated input and committed traffic budgets. AD verifies only
// identity; explicit operator links and existing app records grant permissions.
export async function adLogin(username: string, password: string) {
  const config = adConfiguration(), identity = await verifyAdPassword(config, username, password);
  // Cache approval from directory verification, never from a later SQL-lock wait.
  const checkedAt = Math.floor(Date.now() / 1000);
  const denied = () => Response.json({ error: "Username or password is incorrect, or access is not authorized." },
    { status: 401, headers: { "cache-control": "no-store" } });
  if (!identity) return denied();
  return db().transaction(async tx => {
    // Serialize with relinking, role/deactivation changes and logout, then lock
    // the linked account through session issuance. Never link on name/email match.
    await tx.prepare("SELECT pg_advisory_xact_lock(728303)").run();
    const user = await tx.prepare(`SELECT id,name,role FROM app_users
      WHERE ad_directory = $1 AND ad_guid = $2 AND active = 1 FOR UPDATE`)
      .bind(config.id, identity.guid).first<SessionUser>();
    if (!user) return denied();
    const now = new Date().toISOString();
    await tx.prepare("DELETE FROM app_sessions WHERE user_id = $1 AND expires_at <= $2").bind(user.id, now).run();
    await tx.prepare("UPDATE app_users SET last_login_at = $1, updated_at = $1 WHERE id = $2").bind(now, user.id).run();
    const session = await createSession(user.id, tx, { identity, binding: config.binding, checkedAt });
    return Response.json({ user, authMode: "ad", sessionContext: await tokenContext(session.token) },
      { headers: { "set-cookie": session.cookie, "cache-control": "no-store" } });
  });
}
