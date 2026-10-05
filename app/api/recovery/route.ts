import { db, requireUser } from "../../../lib/pin-auth";

const STATE_ID = "tanmar-receiver-control";

async function ensureRecoverySchema() {
  const d1 = db();
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS app_state_history (
      id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      payload TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    )`),
    d1.prepare("CREATE INDEX IF NOT EXISTS app_state_history_created_idx ON app_state_history (created_at)"),
  ]);
}

export async function GET(request: Request) {
  const auth = await requireUser(request, "admin");
  if (auth.response) return auth.response;
  await ensureRecoverySchema();
  const rows = await db().prepare(
    `SELECT id, revision, action, created_at, created_by
     FROM app_state_history ORDER BY created_at DESC LIMIT 25`,
  ).all();
  return Response.json({ snapshots: rows.results }, { headers: { "cache-control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await requireUser(request, "admin");
  if (auth.response) return auth.response;
  await ensureRecoverySchema();
  const body = await request.json() as { id?: string };
  const d1 = db();
  const snapshot = await d1.prepare(
    "SELECT id, revision, payload FROM app_state_history WHERE id = ?",
  ).bind(String(body.id || "")).first<{ id: string; revision: number; payload: string }>();
  if (!snapshot) return Response.json({ error: "Recovery point not found." }, { status: 404 });
  const current = await d1.prepare(
    "SELECT revision, payload FROM app_state WHERE id = ?",
  ).bind(STATE_ID).first<{ revision: number; payload: string }>();
  if (!current) return Response.json({ error: "Current cloud data was not found." }, { status: 404 });

  const now = new Date().toISOString();
  const nextRevision = current.revision + 1;
  await d1.batch([
    d1.prepare(
      "INSERT INTO app_state_history (id, revision, payload, action, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), current.revision, current.payload, "Before recovery restore", now, auth.user!.name),
    d1.prepare(
      "UPDATE app_state SET payload = ?, revision = ?, updated_at = ?, updated_by = ? WHERE id = ?",
    ).bind(snapshot.payload, nextRevision, now, auth.user!.name, STATE_ID),
    d1.prepare(
      "INSERT INTO app_change_log (id, user_id, user_name, action, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(), auth.user!.id, auth.user!.name,
      `Restored cloud recovery point r${snapshot.revision}`, nextRevision, now,
    ),
  ]);
  await d1.prepare(
    `DELETE FROM app_state_history
     WHERE id NOT IN (SELECT id FROM app_state_history ORDER BY created_at DESC LIMIT 25)`,
  ).run();
  return Response.json({ ok: true, revision: nextRevision, updatedAt: now });
}
