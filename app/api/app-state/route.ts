import { db, requireUser } from "../../../lib/pin-auth";
import { AccessInputError, accessError, readAccessBody } from "../../../lib/access-input";
import { validateInventory } from "../../../lib/inventory-state";
import { STATE_ID, commitInventory } from "../../../lib/inventory-store";
import { authorizeEveryday } from "../../../lib/inventory-permissions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

      return Response.json(await commitInventory(store, current, state, auth.user!, action));
    });
  } catch (error) { return accessError(error, "Database save failed."); }
}

export function PUT(request: Request) { return writeState(request, true); }
export function PATCH(request: Request) { return writeState(request, false); }
