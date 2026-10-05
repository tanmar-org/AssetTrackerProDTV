type AppState = {
  master: unknown[];
  accounts: unknown[];
  assignments: unknown[];
  activations: unknown[];
  receiverEvents: unknown[];
  auditState: unknown | null;
};

const STATE_ID = "tanmar-receiver-control";

function runtime() {
  return (
    globalThis as typeof globalThis & {
      __ASSET_TRACKER_ENV__?: { DB?: D1Database };
    }
  ).__ASSET_TRACKER_ENV__;
}

function db() {
  const d1 = runtime()?.DB;
  if (!d1) throw new Error("Cloud storage is unavailable.");
  return d1;
}

async function ensureSchema() {
  const d1 = db();
  await d1.batch([
    d1
      .prepare(
        `CREATE TABLE IF NOT EXISTS app_state (
          id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          updated_at TEXT NOT NULL,
          updated_by TEXT
        )`,
      ),
    d1.prepare(
      "CREATE INDEX IF NOT EXISTS app_state_updated_at_idx ON app_state (updated_at)",
    ),
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

function changedRecordCount(before: unknown[], after: unknown[]) {
  const beforeMap = new Map(before.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return [String(record?.id || index), JSON.stringify(item)];
  }));
  const afterMap = new Map(after.map((item, index) => {
    const record = item && typeof item === "object" ? item as Record<string, unknown> : null;
    return [String(record?.id || index), JSON.stringify(item)];
  }));
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);
  let changed = 0;
  for (const key of keys) if (beforeMap.get(key) !== afterMap.get(key)) changed += 1;
  return changed;
}

function regularUserCanSave(before: AppState | null, after: AppState, action: string) {
  if (ADMIN_ONLY_ACTIONS.includes(action) || action.startsWith("Apply ")) return false;
  if (!before) return false;

  const collections: Array<keyof Pick<AppState, "master" | "accounts" | "assignments" | "activations" | "receiverEvents">> = [
    "master", "accounts", "assignments", "activations", "receiverEvents",
  ];
  let changed = JSON.stringify(before.auditState) === JSON.stringify(after.auditState) ? 0 : 1;
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
    await ensureSchema();
    const row = await db()
      .prepare(
        "SELECT payload, revision, updated_at, updated_by FROM app_state WHERE id = ?",
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
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Cloud read failed." },
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

    const baseRevision = Number(body.baseRevision);
    if (!Number.isInteger(baseRevision) || baseRevision < 0)
      return Response.json({ error: "Invalid revision." }, { status: 400 });

    await ensureSchema();
    const d1 = db();
    const current = await d1
      .prepare("SELECT revision, payload FROM app_state WHERE id = ?")
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
    if (auth.user!.role !== "admin" && !regularUserCanSave(currentState, body.state, action)) {
      await d1.prepare(
        "INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES (?, ?, ?, ?, ?)",
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
    const payload = JSON.stringify(body.state);

    if (current) {
      await d1.prepare(
        "INSERT INTO app_state_history (id, revision, payload, action, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        crypto.randomUUID(), currentRevision, current.payload, `Before ${action}`, updatedAt, updatedBy,
      ).run();
      const result = await d1
        .prepare(
          `UPDATE app_state
           SET payload = ?, revision = ?, updated_at = ?, updated_by = ?
           WHERE id = ? AND revision = ?`,
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
    } else {
      await d1
        .prepare(
          `INSERT INTO app_state (id, payload, revision, updated_at, updated_by)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(STATE_ID, payload, nextRevision, updatedAt, updatedBy)
        .run();
    }

    await d1.prepare(
      "INSERT INTO app_change_log (id, user_id, user_name, action, revision, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      crypto.randomUUID(),
      auth.user!.id,
      auth.user!.name,
      action,
      nextRevision,
      updatedAt,
    ).run();
    await d1.prepare(
      `DELETE FROM app_state_history
       WHERE id NOT IN (SELECT id FROM app_state_history ORDER BY created_at DESC LIMIT 25)`,
    ).run();

    return Response.json({ revision: nextRevision, updatedAt, updatedBy });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Cloud save failed." },
      { status: 503 },
    );
  }
}
import { requireUser } from "../../../lib/pin-auth";
