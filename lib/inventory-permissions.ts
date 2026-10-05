import { AccessInputError } from "./access-input.ts";
import { canonicalJson, type InventoryRecord, type InventoryState } from "./inventory-state.ts";

type Change = { before?: InventoryRecord; after?: InventoryRecord };
function changes(before: InventoryRecord[], after: InventoryRecord[]): Change[] {
  const old = new Map(before.map((row) => [row.id, row]));
  const next = new Map(after.map((row) => [row.id, row]));
  return [...new Set([...old.keys(), ...next.keys()])]
    .filter((id) => canonicalJson(old.get(id)) !== canonicalJson(next.get(id)))
    .map((id) => ({ before: old.get(id), after: next.get(id) }));
}
function denied(): never {
  throw new AccessInputError("This change requires an administrator. Regular users may edit one account/receiver/service request or issue one rental batch at a time.", 403);
}
const rows = (value: unknown) => value as Record<string, unknown>[];

// Permit only the UI's deterministic stock reconciliation: release an existing
// item when its receiver is On Rent, and complete the batch when exhausted.
// Client timestamps are schema-checked, but never authorize stock removal/editing.
function reconciledStock(before: InventoryState, after: InventoryState) {
  const expected = structuredClone(before.rentalStock);
  const rent = new Map(after.master.map((row) => [row.id, row.rentState]));
  const released = new Set<string>();
  const active = expected.batches.find((batch) => batch.status === "Active");
  if (active) {
    const submitted = after.rentalStock.batches.find((batch) => batch.id === active.id);
    if (!submitted) denied();
    const submittedItems = new Map(rows(submitted.items).map((item) => [item.receiverId, item]));
    for (const item of rows(active.items)) {
      if (item.removedAt || rent.get(item.receiverId as string) !== "On Rent" || item.releasedAt) continue;
      const candidate = submittedItems.get(item.receiverId);
      if (!candidate?.releasedAt) denied();
      item.releasedAt = candidate.releasedAt;
      released.add(item.receiverId as string);
    }
    if ((active.receiverIds as string[]).every((id) => rent.get(id) === "On Rent")) {
      active.status = "Completed";
      active.completedAt = submitted.completedAt;
      if (!active.completedAt) denied();
    }
  }
  return { expected, released };
}

// Full replacements use admin-only PUT. PATCH is authorized from the persisted
// before/after records, never a client action label or a total-record heuristic.
// These permissions also apply to admin PATCH; admins use PUT for bulk work.
export function authorizeEveryday(before: InventoryState | null, after: InventoryState, actor: string): string {
  if (!before) denied();
  const master = changes(before.master, after.master);
  const accounts = changes(before.accounts, after.accounts);
  const assignments = changes(before.assignments, after.assignments);
  const activations = changes(before.activations, after.activations);
  if (master.length > 1 || accounts.length > 1 || assignments.length > 1 || activations.length > 1 ||
      master.some((row) => !row.after) || accounts.some((row) => !row.after) || activations.some((row) => !row.after)) denied();

  const { expected, released } = reconciledStock(before, after);
  const oldBatches = new Set(before.rentalStock.batches.map((batch) => batch.id));
  const added = after.rentalStock.batches.filter((batch) => !oldBatches.has(batch.id));
  const retained = after.rentalStock.batches.filter((batch) => oldBatches.has(batch.id));
  if (added.length > 1 || canonicalJson(retained) !== canonicalJson(expected.batches)) denied();
  const allowedEvents = new Set(released);
  let description = "Updated audit research";

  if (added.length) {
    // Issuing a named batch may include many receiver history entries, but cannot
    // mutate inventory, remove stock, or rewrite any previous batch's metadata.
    if (master.length || accounts.length || assignments.length || activations.length || expected.batches.some((batch) => batch.status === "Active")) denied();
    const batch = added[0];
    if (batch.batchNumber !== Math.max(0, ...before.rentalStock.batches.map((item) => item.batchNumber as number)) + 1 ||
        rows(batch.removedItems ?? []).length || !(batch.receiverIds as string[]).length ||
        rows(batch.items).some((item) => item.removedAt || item.removedBy || item.removalReason)) denied();
    const rent = new Map(after.master.map((row) => [row.id, row.rentState]));
    const allReleased = (batch.receiverIds as string[]).every((id) => rent.get(id) === "On Rent");
    if ((batch.status === "Completed") !== allReleased || rows(batch.items).some((item) => Boolean(item.releasedAt) !== (rent.get(item.receiverId as string) === "On Rent"))) denied();
    (batch.receiverIds as string[]).forEach((id) => allowedEvents.add(id));
    description = `Issued rental batch ${batch.batchNumber}`;
  } else if (accounts.length) {
    if (master.length || assignments.length || activations.length) denied();
    description = `${accounts[0].before ? "Updated" : "Added"} account ${accounts[0].after!.number}`;
  } else {
    const subjects = new Set<string>();
    for (const change of master) subjects.add((change.after ?? change.before)!.id);
    for (const change of assignments) {
      // Moving the same assignment between accounts is permitted; changing its
      // receiver identity would move two receivers in one apparent record edit.
      if (change.before && change.after && change.before.assetId !== change.after.assetId) denied();
      subjects.add((change.after ?? change.before)!.assetId as string);
    }
    if (activations.length) {
      const change = activations[0];
      if ((master.length || assignments.length) && change.before && change.after && change.before.assetId !== change.after.assetId) denied();
      subjects.add((change.after ?? change.before)!.assetId as string);
      if (!master.length && !assignments.length && change.before) allowedEvents.add(change.before.assetId as string);
    }
    if (subjects.size > 1) denied();
    subjects.forEach((id) => allowedEvents.add(id));
    if (subjects.size) description = activations.length ? "Updated receiver service request" : "Updated receiver/assignment";
  }

  const oldEvents = new Map(before.receiverEvents.map((row) => [row.id, row]));
  // Attribution is server-owned. Restore it on existing rows before comparing:
  // a browser can still hold its old display name after an account rename, or
  // after a prior save stamped new entries with the current session identity.
  for (const row of after.receiverEvents) {
    const previous = oldEvents.get(row.id);
    if (previous && Object.hasOwn(previous, "changedBy")) row.changedBy = previous.changedBy;
    else if (previous) delete row.changedBy;
  }
  const addedEvents = after.receiverEvents.filter((row) => !oldEvents.has(row.id));
  if (!master.length && !accounts.length && !assignments.length && !activations.length && !added.length) {
    // QR archival and audit correction can add history without changing a local
    // activation. Still constrain them to one receiver plus derived stock events.
    const subjects = new Set(addedEvents.filter((row) => !released.has(row.receiverId as string)).map((row) => row.receiverId as string));
    if (subjects.size > 1) denied();
    subjects.forEach((id) => allowedEvents.add(id));
    if (subjects.size) description = "Added receiver service/audit history";
  }
  const addedCounts = new Map<string, number>();
  for (const row of addedEvents) {
    const id = row.receiverId as string;
    if (!allowedEvents.has(id)) denied();
    addedCounts.set(id, (addedCounts.get(id) ?? 0) + 1);
    if (addedCounts.get(id)! > 4) denied();
    // Attribution comes from the current authenticated account, not the browser.
    row.changedBy = actor;
  }
  const counts = new Map<string, number>();
  const expectedEvents = [...addedEvents, ...before.receiverEvents].filter((row) => {
    const id = row.receiverId as string;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    return counts.get(id)! <= 20;
  }).slice(0, 20000);
  if (canonicalJson(after.receiverEvents) !== canonicalJson(expectedEvents)) denied();
  return description;
}
