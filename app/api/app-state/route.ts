import { db, requireUser } from "../../../lib/pin-auth";
import { AccessInputError, accessError, readAccessBody } from "../../../lib/access-input";
import { canonicalJson, validateInventory } from "../../../lib/inventory-state";
import { authorizeEveryday } from "../../../lib/inventory-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const STATE_ID = "tanmar-receiver-control";

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;
    const row = await db()
      .prepare(
        "SELECT payload::text AS payload, revision, updated_at, updated_by FROM app_state WHERE id = $1",
      )
      .bind(STATE_ID)
      .first<{
        payload: string;
        revision: number;
        updated_at: string;
        updated_by: string | null;
      }>();

    if (!row)
      return Response.json(
        { state: null, revision: 0, updatedAt: null, updatedBy: null },
        { headers: { "cache-control": "no-store" } },
      );

    return Response.json(
      {
        state: validateInventory(JSON.parse(row.payload)),
        revision: row.revision,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) { return accessError(error, "Database read failed."); }
}

// PUT replaces the document (imports/restore/clear); PATCH permits only checked
// everyday edits. HTTP method and persisted differences determine authority.
async function writeState(request: Request, replacement: boolean) {
  try {
    const initial = await requireUser(request, replacement ? "admin" : undefined);
    if (initial.response) return initial.response;
    const body = await readAccessBody(request, { limit: 8 * 1024 * 1024, label: "Inventory" });
    const state = validateInventory(body.state);
    const baseRevision = body.baseRevision;
    if (typeof baseRevision !== "number" || !Number.isSafeInteger(baseRevision) || baseRevision < 0)
      return Response.json({ error: "Invalid revision." }, { status: 400 });

    return await db().transaction(async (store) => {
      // Account mutations use the first lock too. Check authorization after
      // waiting and hold it through commit so a queued demotion cannot race us.
      await store.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const auth = await requireUser(request, replacement ? "admin" : undefined, store);
      if (auth.response) return auth.response;
      await store.prepare("SELECT pg_advisory_xact_lock(728302)").run();
      const current = await store
        .prepare("SELECT revision, payload::text AS payload, updated_at, updated_by FROM app_state WHERE id = $1")
        .bind(STATE_ID)
        .first<{ revision: number; payload: string; updated_at: string; updated_by: string | null }>();
      const currentRevision = current?.revision ?? 0;

      if (currentRevision !== baseRevision)
        return Response.json(
          { error: "Cloud data changed.", conflict: true, revision: currentRevision },
          { status: 409 },
        );

      let action = typeof body.action === "string" ? body.action.slice(0, 160) : "Administrator inventory replacement";
      if (!replacement) {
        try {
          const before = current ? validateInventory(JSON.parse(current.payload)) : null;
          action = authorizeEveryday(before, state, auth.user!.name);
          validateInventory(state); // Validate server-stamped attribution too.
        } catch (error) {
          if (!(error instanceof AccessInputError) || error.status !== 403) throw error;
          await store.prepare("INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES ($1, $2, $3, $4, $5)")
            .bind(crypto.randomUUID(), auth.user!.id, auth.user!.name, "Denied: inventory operation requires administrator", new Date().toISOString()).run();
          return accessError(error, "Database save failed.");
        }
      }

      // Debounced/UI retries may contain no actual change. Never manufacture a
      // revision, audit action, or recovery point from a client label alone.
      if (current && canonicalJson(JSON.parse(current.payload)) === canonicalJson(state))
        return Response.json({ revision: currentRevision, updatedAt: current.updated_at, updatedBy: current.updated_by });

      const nextRevision = currentRevision + 1;
      const updatedAt = new Date().toISOString();
      const updatedBy = auth.user!.name;
      const payload = JSON.stringify(state);

      // Revision checks and all related writes share one locked transaction.
      // A failed audit/history write rolls back the state change as well.
      if (current) {
        const result = await store
          .prepare(
            `UPDATE app_state
             SET payload = $1, revision = $2, updated_at = $3, updated_by = $4
             WHERE id = $5 AND revision = $6`,
          )
          .bind(
            payload,
            nextRevision,
            updatedAt,
            updatedBy,
            STATE_ID,
            currentRevision,
          )
          .run();
        if (!result.meta.changes)
          return Response.json(
            { error: "Cloud data changed.", conflict: true },
            { status: 409 },
          );
        await store.prepare(
          "INSERT INTO app_state_history (id, revision, payload, action, created_at, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        ).bind(
          crypto.randomUUID(), currentRevision, current.payload, `Before ${action}`, updatedAt, updatedBy,
        ).run();
      } else {
        await store
          .prepare(
            `INSERT INTO app_state (id, payload, revision, updated_at, updated_by)
             VALUES ($1, $2, $3, $4, $5)`,
          )
          .bind(STATE_ID, payload, nextRevision, updatedAt, updatedBy)
          .run();
      }

      await store.prepare(
        "INSERT INTO app_change_log (id, user_id, user_name, action, revision, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      ).bind(
        crypto.randomUUID(),
        auth.user!.id,
        auth.user!.name,
        action,
        nextRevision,
        updatedAt,
      ).run();
      await store.prepare(
        `DELETE FROM app_state_history
         WHERE id NOT IN (SELECT id FROM app_state_history ORDER BY created_at DESC LIMIT 25)`,
      ).run();

      return Response.json({ revision: nextRevision, updatedAt, updatedBy });
    });
  } catch (error) { return accessError(error, "Database save failed."); }
}

export function PUT(request: Request) { return writeState(request, true); }
export function PATCH(request: Request) { return writeState(request, false); }
