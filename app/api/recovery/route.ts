import { db, requireUser } from "../../../lib/pin-auth";

// All API persistence runs on Node and never becomes a cached public response.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const STATE_ID = "tanmar-receiver-control";

export async function GET(request: Request) {
  const auth = await requireUser(request, "admin");
  if (auth.response) return auth.response;
  const rows = await db().prepare(
    `SELECT id, revision, action, created_at, created_by
     FROM app_state_history ORDER BY created_at DESC LIMIT 25`,
  ).all();
  return Response.json({ snapshots: rows.results }, { headers: { "cache-control": "no-store" } });
}

// Restore requires the revision the operator reviewed and shares the state-write
// lock. Snapshot, state, and audit updates either commit together or roll back.
export async function POST(request: Request) {
  const auth = await requireUser(request, "admin");
  if (auth.response) return auth.response;
  const body = await request.json() as { id?: string; baseRevision?: number };
  if (!Number.isInteger(body.baseRevision) || Number(body.baseRevision) < 1)
    return Response.json({ error: "A current revision is required." }, { status: 400 });
  return await db().transaction(async (store) => {
    await store.prepare("SELECT pg_advisory_xact_lock(728302)").run();
    const snapshot = await store.prepare(
      "SELECT id, revision, payload::text AS payload FROM app_state_history WHERE id = $1",
    ).bind(String(body.id || "")).first<{ id: string; revision: number; payload: string }>();
    if (!snapshot) return Response.json({ error: "Recovery point not found." }, { status: 404 });
    const current = await store.prepare(
      "SELECT revision, payload::text AS payload FROM app_state WHERE id = $1",
    ).bind(STATE_ID).first<{ revision: number; payload: string }>();
    if (!current) return Response.json({ error: "Current shared data was not found." }, { status: 404 });
    const conflict = () => Response.json(
      { error: "Shared data changed. Reload before restoring.", conflict: true, revision: current.revision },
      { status: 409 },
    );
    if (current.revision !== body.baseRevision) return conflict();

    const now = new Date().toISOString();
    const nextRevision = current.revision + 1;
    // Retain a revision predicate as protection from writes outside the app's
    // advisory lock; do not create history/log entries if the update loses.
    const result = await store.prepare(
      "UPDATE app_state SET payload = $1, revision = $2, updated_at = $3, updated_by = $4 WHERE id = $5 AND revision = $6",
    ).bind(snapshot.payload, nextRevision, now, auth.user!.name, STATE_ID, current.revision).run();
    if (!result.meta.changes) return conflict();
    await store.prepare(
      "INSERT INTO app_state_history (id, revision, payload, action, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
    ).bind(crypto.randomUUID(), current.revision, current.payload, "Before recovery restore", now, auth.user!.name).run();
    await store.prepare(
      "INSERT INTO app_change_log (id, user_id, user_name, action, revision, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    ).bind(
      crypto.randomUUID(), auth.user!.id, auth.user!.name,
      `Restored shared recovery point r${snapshot.revision}`, nextRevision, now,
    ).run();
    await store.prepare(
      `DELETE FROM app_state_history
       WHERE id NOT IN (SELECT id FROM app_state_history ORDER BY created_at DESC LIMIT 25)`,
    ).run();
    return Response.json({ ok: true, revision: nextRevision, updatedAt: now });
  });
}
