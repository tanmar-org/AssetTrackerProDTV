import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { provisionAdmin } from "../scripts/admin-provisioning.mjs";

// API/persistence/concurrency coverage runs against real PostgreSQL and Node
// servers in tests/integration/postgresql.test.mjs; do not retain D1 mock tests.
test("invalid operator credentials are rejected before database work", async () => {
  const database = { transaction() { throw new Error("Database must not be called."); } };
  for (const invalid of [{ name: "a", pin: "482631" }, { name: "jdoe", pin: "abc" }, { name: "jdoe", pin: "123" }])
    await assert.rejects(provisionAdmin(database, invalid), /Enter a username/);
});

test("the public auth gate hides input until provisioning and restores ordinary sign-in", async () => {
  const source = await readFile(new URL("../public/asset-tracker/app.js", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "showAuthGate");
  const elements = new Map();
  const state = { readSignOutMarker: () => null, authNeedsProvisioning: false, $: (id) => {
    if (!elements.has(id)) elements.set(id, {});
    return elements.get(id);
  }, document: { body: { classList: { add() {} } } } };
  const show = vm.runInNewContext(`(${declaration.getText(parsed)})`, state);
  show(true);
  assert.equal(elements.get("authForm").hidden, true);
  assert.equal(elements.get("authSubmit").textContent, "Sign In");
  assert.equal(state.authNeedsProvisioning, true);
  show(false);
  assert.equal(elements.get("authForm").hidden, false);
  assert.equal(state.authNeedsProvisioning, false);
});
