import { AccessInputError } from "./access-input.ts";
import { canonicalJson, type InventoryState, type InventoryRecord } from "./inventory-state.ts";

type Value = { exists: boolean; value?: unknown };
export type DraftChange = { key: string; collection: string; id: string; field: string | null; base: Value; mine: Value; shared: Value; conflict: boolean };
const collections = ["master", "accounts", "assignments", "activations", "receiverEvents"] as const;
const value = (input: unknown): Value => input === undefined ? { exists: false } : { exists: true, value: input };
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
export const emptyInventory = (): InventoryState => ({ master: [], accounts: [], assignments: [], activations: [], receiverEvents: [], auditState: null, rentalStock: { batches: [] } });

// A three-way merge considers only changes from the employee's original copy.
// Unedited shared fields remain untouched. Arrays join by stable ID rather than
// position; add/delete conflicts treat the entire record as one choice. Audit
// and stock are reviewed as whole collections because they contain linked data.
export function mergeInventory(base: InventoryState, mine: InventoryState, shared: InventoryState, choices: Record<string, unknown> = {}) {
  const state = structuredClone(shared);
  const changes: DraftChange[] = [];
  let unresolved = 0;
  function change(collection: string, id: string, field: string | null, original: unknown, local: unknown, remote: unknown, apply: (input: unknown) => void) {
    if (equal(original, local)) return;
    const key = JSON.stringify([collection, id, field]);
    const conflict = !equal(original, remote) && !equal(local, remote);
    changes.push({ key, collection, id, field, base: value(original), mine: value(local), shared: value(remote), conflict });
    const choice = choices[key];
    if (choice !== undefined && choice !== "mine" && choice !== "shared") throw new AccessInputError("Invalid recovery choice.");
    if (conflict && choice === undefined) { unresolved++; return; }
    if (choice !== "shared") apply(local);
  }
  for (const collection of collections) {
    const originals = new Map(base[collection].map(row => [row.id, row]));
    const locals = new Map(mine[collection].map(row => [row.id, row]));
    const remotes = new Map(shared[collection].map(row => [row.id, row]));
    const merged = new Map(state[collection].map(row => [row.id, row]));
    for (const id of new Set([...originals.keys(), ...locals.keys()])) {
      const original = originals.get(id), local = locals.get(id), remote = remotes.get(id);
      if (!original || !local || !remote) {
        change(collection, id, null, original, local, remote, input => {
          if (input === undefined) merged.delete(id); else merged.set(id, structuredClone(input) as InventoryRecord);
        });
        continue;
      }
      for (const field of new Set([...Object.keys(original), ...Object.keys(local)])) {
        if (field === "id") continue;
        change(collection, id, field, original[field], local[field], remote[field], input => {
          const row = merged.get(id)!;
          if (input === undefined) delete row[field]; else row[field] = structuredClone(input);
        });
      }
    }
    if(collection === "receiverEvents") {
      // Everyday authorization requires new local events before existing shared
      // history (including events another employee just committed). Preserve the
      // draft's newest-first order without treating array positions as conflicts.
      const added = mine.receiverEvents.filter(row => !remotes.has(row.id) && merged.has(row.id));
      state.receiverEvents = [...added.map(row => merged.get(row.id)!), ...[...merged.values()].filter(row => remotes.has(row.id))];
    } else state[collection] = [...merged.values()];
  }
  for (const collection of ["auditState", "rentalStock"] as const) {
    change(collection, "", null, base[collection], mine[collection], shared[collection], input => {
      // Both inputs were schema-validated; retain their collection types.
      if (collection === "auditState") state.auditState = structuredClone(input) as InventoryState["auditState"];
      else state.rentalStock = structuredClone(input) as InventoryState["rentalStock"];
    });
  }
  const known = new Set(changes.map(row => row.key));
  if (Object.keys(choices).some(key => !known.has(key))) throw new AccessInputError("Recovery choices changed. Review again.", 409);
  return { state, changes, unresolved };
}
