import assert from "node:assert/strict";
import test from "node:test";
import { mergeInventory } from "../lib/inventory-merge.ts";
import { validateInventory } from "../lib/inventory-state.ts";
import { inventory, history } from "./helpers/inventory-fixture.mjs";

// Exercise actual merge rules, including absent optional fields and deletions.
test("three-way review preserves other people's unrelated edits", () => {
  const base = inventory(), mine = inventory(), shared = inventory();
  mine.master[0].notes = "My note"; shared.master[0].model = "Shared model"; shared.accounts[0].name = "Shared customer";
  const plan = mergeInventory(base, mine, shared);
  assert.equal(plan.unresolved, 0);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.state.master[0].notes, "My note");
  assert.equal(plan.state.master[0].model, "Shared model");
  assert.equal(plan.state.accounts[0].name, "Shared customer");
  validateInventory(plan.state);
});
test("same-field conflict requires explicit choice and rejects stale/foreign choices", () => {
  const base = inventory(), mine = inventory(), shared = inventory();
  mine.master[0].notes = "Mine"; shared.master[0].notes = "Theirs";
  const plan = mergeInventory(base, mine, shared), key = plan.changes[0].key;
  assert.equal(plan.unresolved, 1); assert.equal(plan.state.master[0].notes, "Theirs");
  assert.deepEqual(plan.changes[0].base, { exists: false });
  assert.equal(mergeInventory(base, mine, shared, { [key]: "mine" }).state.master[0].notes, "Mine");
  assert.equal(mergeInventory(base, mine, shared, { [key]: "shared" }).state.master[0].notes, "Theirs");
  assert.throws(() => mergeInventory(base, mine, shared, { [key]: "arbitrary" }), /Invalid recovery choice/);
  assert.throws(() => mergeInventory(base, mine, shared, { foreign: "mine" }), /Review again/);
  shared.master[0].notes = "Mine";
  assert.equal(mergeInventory(base, mine, shared).unresolved, 0);
});
test("record additions/deletions and absent fields are reviewed without resurrecting untouched records", () => {
  const base = inventory(), mine = inventory(), shared = inventory();
  base.master[0].notes = "Old"; mine.master[0].notes = "Edited"; shared.master.shift();
  let plan = mergeInventory(base, mine, shared); assert.equal(plan.unresolved, 1);
  plan = mergeInventory(base, mine, shared, { [plan.changes[0].key]: "mine" });
  assert.equal(plan.state.master.at(-1).notes, "Edited");
  const deleted = structuredClone(base); deleted.master.pop();
  const unchanged = mergeInventory(base, base, deleted); assert.equal(unchanged.state.master.length, 2);
  const removal = structuredClone(base); delete removal.master[0].notes;
  assert.equal("notes" in mergeInventory(base, removal, base).state.master[0], false);
  const added = inventory(4), other = inventory(4); other.master[3].assetNumber = "Other addition";
  assert.equal(mergeInventory(inventory(), added, other).unresolved, 1);
});
test("linked stock and audit values are whole-collection choices", () => {
  const base = inventory(), mine = inventory(), shared = inventory();
  mine.auditState = { fileName: "mine.csv" }; shared.auditState = { fileName: "shared.csv" };
  mine.rentalStock.batches = [{ id: "mine-stock" }]; shared.rentalStock.batches = [{ id: "shared-stock" }];
  const plan = mergeInventory(base, mine, shared); assert.equal(plan.unresolved, 2);
  const choices = Object.fromEntries(plan.changes.map(change => [change.key, "shared"]));
  assert.deepEqual(mergeInventory(base, mine, shared, choices).state, shared);
});
test("new local history precedes newly committed and existing shared history",()=>{
  const base=inventory();base.receiverEvents=[history("old-event")];
  const mine=structuredClone(base),shared=structuredClone(base);
  mine.receiverEvents.unshift(history("my-event"));shared.receiverEvents.unshift(history("shared-event","receiver-1"));
  assert.deepEqual(mergeInventory(base,mine,shared).state.receiverEvents.map(row=>row.id),["my-event","shared-event","old-event"]);
});
