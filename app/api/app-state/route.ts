import { db, requireUser } from "../../../lib/pin-auth";

// Server-only PostgreSQL connections require the Node runtime and fresh responses.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Operational collections share one JSON payload and revision, so any edit can
// conflict with another user's edit to an otherwise unrelated collection.
type AppState = {
  master: unknown[];
  accounts: unknown[];
  assignments: unknown[];
  activations: unknown[];
  receiverEvents: unknown[];
  auditState: unknown | null;
};

const STATE_ID = "tanmar-receiver-control";

// This checks only outer shapes. It does not validate individual records, links,
// business rules, or rentalStock; stronger server validation belongs to SEC-03.
function validState(value: unknown): value is AppState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    Array.isArray(state.master) &&
    Array.isArray(state.accounts) &&
    Array.isArray(state.assignments) &&
    Array.isArray(state.activations) &&
    Array.isArray(state.receiverEvents) &&
    (state.auditState === null || typeof state.auditState === "object")
  );
}

const ADMIN_ONLY_ACTIONS = [
  "Import receivers to account",
  "Restore app backup",
  "Clear all app data",
];

// JSONB can reorder object keys. Compare content canonically so a database
// round-trip does not count every unchanged record as a regular-user edit.
function canonicalJson(value: unknown) {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item))
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    return item;
  });
}

function changedRecordCount(before: unknown[], after: unknown[]) {
  const beforeMap = new Map(before.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return [String(record?.id || index), canonicalJson(item)];
  }));
  const afterMap = new Map(after.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return [String(record?.id || index), canonicalJson(item)];
  }));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  let changed = 0;
  for (const key of keys) if (beforeMap.get(key) !== afterMap.get(key)) changed += 1;
  return changed;
}

// This inherited heuristic trusts client action labels and counts changed records.
// It omits rentalStock and cannot express operation-specific permissions (SEC-03).
function regularUserCanSave(before: AppState | null, after: AppState, action: string) {
  if (ADMIN_ONLY_ACTIONS.includes(action) || action.startsWith("Apply ")) return false;
  if (!before) return false;

  const collections: Array<keyof Pick<AppState, "master" | "accounts" | "assignments" | "activations" | "receiverEvents">> = [
    "master", "accounts", "assignments", "activations", "receiverEvents",
  ];
  let changed = canonicalJson(before.auditState) === canonicalJson(after.auditState) ? 0 : 1;
  for (const key of collections) {
    if (before[key].length - after[key].length > 1) return false;
    changed += changedRecordCount(before[key], after[key]);
  }
  return changed <= 8;
}

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
        state: JSON.parse(row.payload),
        revision: row.revision,
        updatedAt: row.updated_at,
        updatedBy: row.updated_by,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Database read failed." },
      { status: 503 },
    );
  }
}

export async function PUT(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.response) return auth.response;
    const body = (await request.json()) as {
      state?: unknown;
      baseRevision?: unknown;
      action?: unknown;
    };
    if (!validState(body.state))
      return Response.json({ error: "Invalid app state." }, { status: 400 });

    const state = body.state; // Preserve validation narrowing inside the transaction.
    const baseRevision = Number(body.baseRevision);
    if (!Number.isInteger(baseRevision) || baseRevision < 0)
      return Response.json({ error: "Invalid revision." }, { status: 400 });

    return await db().transaction(async (store) => {
      // Serialize first inserts and updates, including history/audit writes.
      await store.prepare("SELECT pg_advisory_xact_lock(728302)").run();
      const current = await store
        .prepare("SELECT revision, payload::text AS payload FROM app_state WHERE id = $1")
        .bind(STATE_ID)
        .first<{ revision: number; payload: string }>();
      const currentRevision = current?.revision ?? 0;

      if (currentRevision !== baseRevision)
        return Response.json(
          { error: "Cloud data changed.", conflict: true, revision: currentRevision },
          { status: 409 },
        );

      const action = String(body.action || "Data change").slice(0, 160);
      const currentState = current ? JSON.parse(current.payload) as AppState : null;
      if (auth.user!.role !== "admin" && !regularUserCanSave(currentState, state, action)) {
        await store.prepare(
          "INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES ($1, $2, $3, $4, $5)",
        ).bind(
          crypto.randomUUID(),
          auth.user!.id,
          auth.user!.name,
          `Denied: ${action}`,
          new Date().toISOString(),
        ).run();
        return Response.json(
          { error: "Administrator access is required for bulk, restore, clear, or multi-record changes." },
          { status: 403 },
        );
      }

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
  } catch {
    return Response.json(
      { error: "Database save failed." },
      { status: 503 },
    );
  }
}
