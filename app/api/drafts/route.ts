import { db, requireUser } from "../../../lib/pin-auth";
import { AccessInputError, accessError, readAccessBody } from "../../../lib/access-input";
import { validateInventory, type InventoryState } from "../../../lib/inventory-state";
import { authorizeEveryday } from "../../../lib/inventory-permissions";
import { emptyInventory, mergeInventory } from "../../../lib/inventory-merge";
import { commitInventory, readInventory } from "../../../lib/inventory-store";
import type { Database } from "@tanmar/database";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type DraftRow = { id: string; version: number; base_revision: number; base_state: unknown; draft_state: unknown; label: string; updated_at: Date; expires_at: Date };
const noStore = { "cache-control": "no-store" };
function identifier(input: unknown): string {
  if (typeof input !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input))
    throw new AccessInputError("Invalid draft ID.");
  return input;
}
function revision(input: unknown): number {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 0 || input > 2147483646)
    throw new AccessInputError("Invalid draft version or inventory revision.");
  return input;
}
function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new AccessInputError("Unexpected recovery field.");
}
function summary(row: DraftRow) {
  return { id: row.id, version: row.version, baseRevision: row.base_revision, label: row.label, updatedAt: row.updated_at, expiresAt: row.expires_at };
}
async function owned(store: Database, id: string, userId: string) {
  const row = await store.prepare("SELECT * FROM app_inventory_drafts WHERE id = $1 AND user_id = $2 AND status = 'active' AND expires_at > now()")
    .bind(id, userId).first<DraftRow>();
  if (!row) throw new AccessInputError("Draft is unavailable or has expired.", 404);
  return row;
}

// Every operation derives ownership from the current cookie. Even administrators
// cannot list/read/apply someone else's copies. The account lock serializes quota,
// draft CAS and revocation; inventory application then takes the shared state lock.
async function handle(request: Request) {
  try {
    const initial = await requireUser(request);
    if (initial.response) return initial.response;
    const method = request.method;
    const body = method === "GET" ? null : await readAccessBody(request, { limit: method === "PUT" ? 16 * 1024 * 1024 + 4096 : 8 * 1024 * 1024, label: "Recovery" });
    let base: InventoryState | undefined, draft: InventoryState | undefined;
    if (method === "PUT") {
      fields(body!, ["id", "version", "baseRevision", "baseState", "draftState", "label"]);
      base = validateInventory(body!.baseState); draft = validateInventory(body!.draftState);
      for (const state of [base, draft]) if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024)
        throw new AccessInputError("Inventory request is too large.", 413);
      if (typeof body!.label !== "string" || body!.label.length > 160 || /[\x00-\x1f]/.test(body!.label)) throw new AccessInputError("Invalid draft label.");
    } else if (body) fields(body, method === "POST" ? ["id", "version", "expectedRevision", "choices"] : ["id", "version"]);
    return await db().transaction(async store => {
      await store.prepare("SELECT pg_advisory_xact_lock(728303)").run();
      const auth = await requireUser(request, undefined, store);
      if (auth.response) return auth.response;
      const user = auth.user!;
      await store.prepare("DELETE FROM app_inventory_drafts WHERE user_id = $1 AND expires_at <= now()").bind(user.id).run();
      if (method === "GET") {
        const url = new URL(request.url), id = url.searchParams.get("id");
        if (!id) {
          const rows = await store.prepare("SELECT id, version, base_revision, label, updated_at, expires_at FROM app_inventory_drafts WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC")
            .bind(user.id).all<DraftRow>();
          return Response.json({ drafts: rows.results.map(summary) }, { headers: noStore });
        }
        const row = await owned(store, identifier(id), user.id);
        if (url.searchParams.get("preview") === "1") {
          await store.prepare("SELECT pg_advisory_xact_lock(728302)").run();
          const current = await readInventory(store);
          const shared = current ? validateInventory(JSON.parse(current.payload)) : emptyInventory();
          const plan = mergeInventory(validateInventory(row.base_state), validateInventory(row.draft_state), shared);
          return Response.json({ ...summary(row), expectedRevision: current?.revision ?? 0, changes: plan.changes, unresolved: plan.unresolved }, { headers: noStore });
        }
        return Response.json({ ...summary(row), baseState: validateInventory(row.base_state), draftState: validateInventory(row.draft_state) }, { headers: noStore });
      }
      const id = identifier(body!.id), version = revision(body!.version);
      if (method === "PUT") {
        const baseRevision = revision(body!.baseRevision);
        const existing = await store.prepare("SELECT user_id, version, status FROM app_inventory_drafts WHERE id = $1").bind(id)
          .first<{ user_id: string; version: number; status: string }>();
        if (existing && (existing.user_id !== user.id || existing.status !== "active" || existing.version !== version) || !existing && version !== 0)
          throw new AccessInputError("Draft changed or closed. Refresh saved drafts.", 409);
        if (!existing) {
          const quota = await store.prepare("SELECT count(*) AS total, count(*) FILTER (WHERE status = 'active') AS active FROM app_inventory_drafts WHERE user_id = $1")
            .bind(user.id).first<{ total: string; active: string }>();
          if (Number(quota!.active) >= 5 || Number(quota!.total) >= 20) throw new AccessInputError("Draft limit reached. Export your work and discard an older draft; closed IDs expire after seven days.", 409);
          await store.prepare("INSERT INTO app_inventory_drafts (id, user_id, version, base_revision, base_state, draft_state, label, status, updated_at, expires_at) VALUES ($1,$2,1,$3,$4,$5,$6,'active',now(),now() + interval '7 days')")
            .bind(id, user.id, baseRevision, JSON.stringify(base), JSON.stringify(draft), body!.label).run();
        } else {
          await store.prepare("UPDATE app_inventory_drafts SET version = version + 1, base_revision = $1, base_state = $2, draft_state = $3, label = $4, updated_at = now() WHERE id = $5 AND user_id = $6 AND version = $7 AND status = 'active'")
            .bind(baseRevision, JSON.stringify(base), JSON.stringify(draft), body!.label, id, user.id, version).run();
        }
        return Response.json(summary(await owned(store, id, user.id)), { headers: noStore });
      }
      const row = await owned(store, id, user.id);
      if (row.version !== version) throw new AccessInputError("Draft changed. Refresh saved drafts.", 409);
      let result;
      if (method === "POST") {
        const expected = revision(body!.expectedRevision), choices = body!.choices;
        if (!choices || typeof choices !== "object" || Array.isArray(choices)) throw new AccessInputError("Send recovery choices.");
        await store.prepare("SELECT pg_advisory_xact_lock(728302)").run();
        const current = await readInventory(store);
        if ((current?.revision ?? 0) !== expected) throw new AccessInputError("Shared inventory changed. Review again.", 409);
        const shared = current ? validateInventory(JSON.parse(current.payload)) : emptyInventory();
        const plan = mergeInventory(validateInventory(row.base_state), validateInventory(row.draft_state), shared, choices as Record<string, unknown>);
        if (plan.unresolved) throw new AccessInputError("Choose a value for every conflicting field.", 409);
        const state = validateInventory(plan.state);
        // A draft is a recovery copy, never a grant of bulk-edit authority.
        let action = "Reviewed inventory draft";
        if(user.role !== "admin") {
          try { action = authorizeEveryday(current ? shared : null, state, user.name); }
          catch(error) {
            if(!(error instanceof AccessInputError) || error.status !== 403) throw error;
            // Match normal-save denial auditing while retaining the active copy.
            await store.prepare("INSERT INTO app_change_log (id, user_id, user_name, action, created_at) VALUES ($1,$2,$3,$4,$5)")
              .bind(crypto.randomUUID(), user.id, user.name, "Denied: draft recovery requires administrator", new Date().toISOString()).run();
            return accessError(error, "Draft recovery is unavailable.");
          }
        }
        validateInventory(state);
        result = { ...await commitInventory(store, current, state, user, action), state };
      }
      // Erase private payloads on close; retain just the ID/version tombstone to
      // reject delayed writes. Failure anywhere above leaves the draft active.
      await store.prepare("UPDATE app_inventory_drafts SET status = $1, version = version + 1, base_state = '{}'::jsonb, draft_state = '{}'::jsonb, label = '', updated_at = now() WHERE id = $2 AND user_id = $3")
        .bind(method === "POST" ? "applied" : "discarded", id, user.id).run();
      return Response.json(result ?? { ok: true }, { headers: noStore });
    });
  } catch (error) { return accessError(error, "Draft recovery is unavailable. Keep this tab open or export a snapshot."); }
}
export const GET = handle;
export const PUT = handle;
export const POST = handle;
export const DELETE = handle;
