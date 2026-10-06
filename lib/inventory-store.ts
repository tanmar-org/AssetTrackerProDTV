import type { Database } from "@tanmar/database";
import type { SessionUser } from "./pin-auth.ts";
import { AccessInputError } from "./access-input.ts";
import { canonicalJson, type InventoryState } from "./inventory-state.ts";

export const STATE_ID = "tanmar-receiver-control";
export type StateRow = { revision: number; payload: string; updated_at: string; updated_by: string | null };
export function readInventory(store: Database) {
  return store.prepare("SELECT revision, payload::text AS payload, updated_at, updated_by FROM app_state WHERE id = $1")
    .bind(STATE_ID).first<StateRow>();
}

// Caller holds account lock 728303 followed by inventory lock 728302 and has
// rechecked authentication, revision, schema and role. Recovery and normal saves
// use this one commit path so audit/history failures roll back every mutation.
export async function commitInventory(store: Database, current: StateRow | null, state: InventoryState, actor: SessionUser, action: string) {
  if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) throw new AccessInputError("Inventory request is too large.", 413);
  const currentRevision = current?.revision ?? 0;
  // Debounced/UI retries may contain no actual change. Never manufacture a
  // revision, audit action, or recovery point from a client label alone.
  if (current && canonicalJson(JSON.parse(current.payload)) === canonicalJson(state))
    return { revision: currentRevision, updatedAt: current.updated_at, updatedBy: current.updated_by };

  const nextRevision = currentRevision + 1;
  const updatedAt = new Date().toISOString();
  const updatedBy = actor.name;
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
      throw new AccessInputError("Shared inventory changed. Review again.", 409);
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
    actor.id,
    actor.name,
    action,
    nextRevision,
    updatedAt,
  ).run();
  await store.prepare(
    `DELETE FROM app_state_history
     WHERE id NOT IN (SELECT id FROM app_state_history ORDER BY created_at DESC LIMIT 25)`,
  ).run();

  return { revision: nextRevision, updatedAt, updatedBy };
}
