import assert from "node:assert/strict";
import test from "node:test";
import { validateInventory } from "../lib/inventory-state.ts";
import { authorizeEveryday } from "../lib/inventory-permissions.ts";
import { inventory, batch, history, service, when } from "./helpers/inventory-fixture.mjs";

const edit = (before, after) => authorizeEveryday(validateInventory(before), validateInventory(after), "syntheticuser");
const forbidden = (before, after) => assert.throws(() => edit(before, after), (error) => error.status === 403);

test("inventory schema protects IDs, types, links, capacities, dates, URLs, and stock", () => {
  const broken = [
    (state) => { state.master[0].id = '\" onclick=bad'; },
    (state) => { state.master[0].rentState = "Unknown"; },
    (state) => { state.master[0].accessCard = 123; },
    (state) => { state.master[1].assetNumber = state.master[0].assetNumber.toLowerCase(); },
    (state) => { state.accounts[1].number = state.accounts[0].number; },
    (state) => { state.master.push({ ...state.master[0] }); },
    (state) => { state.assignments = [{ id: "a", assetId: "missing", accountId: "account-0", assignedAt: when }]; },
    (state) => { state.assignments = [0, 1].map((index) => ({ id: `a${index}`, assetId: "receiver-0", accountId: `account-${index}`, assignedAt: when })); },
    (state) => { state.receiverEvents = [{ ...history("event-0"), mapUrl: "javascript:alert(1)" }]; },
    (state) => { state.receiverEvents = [{ ...history("event-0"), mapUrl: "https://untrusted.test/" }]; },
    (state) => { state.receiverEvents = [{ ...history("event-0"), date: "2026-02-30" }]; },
    (state) => { state.receiverEvents = [history("event-0", "missing")]; },
    (state) => { state.activations = [{ ...service(), status: "Completed", completedAt: null }]; },
    (state) => { state.rentalStock = []; },
    (state) => { state.rentalStock.batches = [{ ...batch(state), originalCount: 50 }]; },
    (state) => { state.rentalStock.batches = [{ ...batch(state), receiverIds: ["missing"] }]; },
    (state) => { state.extraCollection = []; },
    (state) => { state.master[0].unknown = { arbitrary: true }; },
    (state) => { state.auditState = []; },
  ];
  for (const corrupt of broken) {
    const state = inventory(); corrupt(state);
    assert.throws(() => validateInventory(state), (error) => error.status === 400);
  }
  const full = inventory(21);
  full.assignments = full.master.map((row, index) => ({ id: `assignment-${index}`, assetId: row.id, accountId: "account-0", assignedAt: when }));
  assert.throws(() => validateInventory(full), /20-receiver/);
  assert.equal(validateInventory(inventory()).master[0].accessCard, "0000");
});

test("single account, receiver, assignment, and service changes remain permitted", () => {
  for (const change of [
    (state) => { state.accounts[0].name = "Updated synthetic account"; },
    (state) => { state.master[0].model = "H25-500"; },
    (state) => { state.assignments = [{ id: "assignment-0", assetId: "receiver-0", accountId: "account-0", assignedAt: when }]; },
    (state) => { state.activations = [service()]; },
  ]) {
    const before = inventory(), after = structuredClone(before); change(after);
    assert.equal(typeof edit(before, after), "string");
  }
  const before = inventory();
  before.activations = [service()];
  const after = structuredClone(before);
  after.activations[0].status = "Completed"; after.activations[0].completedAt = when;
  after.master[0].rentState = "On Rent"; after.master[0].offRentSince = "";
  after.receiverEvents = [{ ...history("event-0"), kind: "service", changedBy: "forged administrator" }];
  edit(before, after);
  assert.equal(after.receiverEvents[0].changedBy, "syntheticuser");
});

test("bulk, deletion, mixed subjects, and receiver reassignment bypasses are denied", () => {
  for (const change of [
    (state) => { state.master[0].model = "H25"; state.master[1].model = "H25"; },
    (state) => { state.master = []; },
    (state) => { state.accounts = []; },
    (state) => { state.accounts[0].name = "New name"; state.master[0].notes = "Unrelated receiver edit"; },
    (state) => { state.master[0].notes = "One receiver"; state.activations = [{ ...service(), assetId: "receiver-1" }]; },
  ]) { const before = inventory(), after = structuredClone(before); change(after); forbidden(before, after); }
  const before = inventory(); before.activations = [service()];
  const after = structuredClone(before); after.activations = []; forbidden(before, after);
  before.assignments = [{ id: "assignment-0", assetId: "receiver-0", accountId: "account-0", assignedAt: when }];
  const reassigned = structuredClone(before); reassigned.assignments[0].assetId = "receiver-1"; forbidden(before, reassigned);
  assert.throws(() => authorizeEveryday(null, inventory(), "syntheticuser"), (error) => error.status === 403);
});

test("rental issuance permits its history while stock metadata/removal/history rewrites are denied", () => {
  const before = inventory(40), after = structuredClone(before);
  after.rentalStock.batches = [batch(after)];
  after.receiverEvents = after.master.map((row, index) => history(`event-${index}`, row.id));
  assert.match(edit(before, after), /Issued rental batch/);
  for (const change of [
    (state) => { state.rentalStock.batches[0].managerName = "Changed manager"; },
    (state) => { state.rentalStock.batches[0].lowThreshold = 10; },
    (state) => { state.rentalStock.batches = []; },
    (state) => { state.rentalStock.batches[0].receiverIds.reverse(); },
  ]) { const changed = structuredClone(after); change(changed); forbidden(after, changed); }
  const removed = structuredClone(after);
  const stock = removed.rentalStock.batches[0]; stock.receiverIds.shift();
  stock.removedItems = [{ receiverId: "receiver-0", removedAt: when, removedBy: "syntheticuser", reason: "Removal bypass" }];
  Object.assign(stock.items[0], { removedAt: when, removedBy: "syntheticuser", removalReason: "Removal bypass" });
  forbidden(after, removed);
});

test("rent updates permit deterministic release/completion only", () => {
  const before = inventory(); before.rentalStock.batches = [batch(before, ["receiver-0"])];
  const after = structuredClone(before); after.master[0].rentState = "On Rent"; after.master[0].offRentSince = "";
  Object.assign(after.rentalStock.batches[0], { status: "Completed", completedAt: when });
  after.rentalStock.batches[0].items[0].releasedAt = when;
  after.receiverEvents = [{ ...history("event-0"), kind: "rent" }];
  edit(before, after);
  const changed = structuredClone(after); changed.rentalStock.batches[0].issuedAt = "2026-10-01";
  changed.rentalStock.batches[0].items[0].issuedAt = "2026-10-01"; forbidden(before, changed);
});

test("receiver history permits append/pruning but never rewriting/deleting existing events", () => {
  const before = inventory(); before.receiverEvents = Array.from({ length: 20 }, (_, index) => history(`old-${index}`));
  const changed = structuredClone(before); changed.receiverEvents[0].detail = "Forged history"; forbidden(before, changed);
  const deleted = structuredClone(before); deleted.receiverEvents.shift(); forbidden(before, deleted);
  const attribution = structuredClone(before); attribution.receiverEvents[0].changedBy = "forged actor";
  edit(before, attribution);
  assert.equal(attribution.receiverEvents[0].changedBy, before.receiverEvents[0].changedBy);
  const after = structuredClone(before); after.receiverEvents = [history("new-0"), ...after.receiverEvents].slice(0, 20);
  edit(before, after);
  assert.equal(after.receiverEvents.at(-1).id, "old-18");
});

test("audit comparison snapshots are structured and counts remain consistent", () => {
  const before = inventory(), after = structuredClone(before);
  after.auditState = { fileName: "synthetic.csv", importedAt: when, results: [{ accountNumber: "000001", accountName: "Synthetic Account", appCount: 1, auditCount: 0,
    matchedCount: 0, countMatch: false, perfect: false, accountExists: true,
    missingFromAudit: [{ issueId: "issue-0", assetNumber: "TEST-0", accessCard: "0000", rid: "00000", key: "C:0000|R:00000", status: "needs-research", notes: "", updatedAt: "" }], missingFromApp: [] }] };
  edit(before, after);
  const bad = structuredClone(after); bad.auditState.results[0].appCount = 2;
  assert.throws(() => validateInventory(bad), /comparison counts/);
});
