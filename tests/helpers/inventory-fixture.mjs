// Synthetic inventory only: stable IDs and leading-zero identifiers make link,
// capacity, history, and rental-stock regressions reproducible without live data.
export const when = "2026-10-05T18:00:00.000Z";
export function inventory(count = 3) {
  return {
    master: Array.from({ length: count }, (_, index) => ({ id: `receiver-${index}`, assetNumber: `TEST-${index}`, rentState: "Off Rent", accessCard: `000${index}`, rid: `0000${index}`, offRentSince: when })),
    accounts: [{ id: "account-0", number: "000001", name: "Synthetic Account" }, { id: "account-1", number: "000002", name: "Second Synthetic Account" }],
    assignments: [], activations: [], receiverEvents: [], auditState: null, rentalStock: { batches: [] },
  };
}
export function batch(state, ids = state.master.map((row) => row.id)) {
  return { id: "batch-0", batchNumber: 1, managerName: "Synthetic Manager", lowThreshold: 5, issuedAt: when, completedAt: "", status: "Active", originalCount: ids.length, receiverIds: ids,
    items: ids.map((receiverId) => ({ receiverId, issuedAt: when, releasedAt: "" })) };
}
export function history(id, receiverId = "receiver-0") {
  return { id, receiverId, title: "Synthetic receiver event", kind: "assignment", date: when, changedBy: "syntheticuser" };
}
export function service() {
  return { id: "activation-0", assetId: "receiver-0", accountId: "account-0", action: "Activate", requestedAt: "2026-10-05", status: "Pending", completedAt: null, notes: "Synthetic request" };
}
