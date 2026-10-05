import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

const trackerUrl = new URL("../public/asset-tracker/app.js", import.meta.url);
const source = await readFile(trackerUrl, "utf8");
const parsed = ts.createSourceFile("app.js", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "deactivationEmailBody",
);
assert.ok(declaration, "The deactivation email formatter must exist.");

// Evaluate the actual formatter in isolation so no browser, user data, or live
// service is needed. Never include real credentials in fixtures or failure output.
const emailBody = vm.runInNewContext(`(${declaration.getText(parsed)})`);
const rows = [
  {
    receiver: { assetNumber: "TEST-ASSET-01", accessCard: "000001", serial: "TEST-SN-01", rid: "000101" },
    account: { number: "TEST-ACCOUNT-01" },
  },
  {
    receiver: { assetNumber: "TEST-ASSET-02", accessCard: "000002", serial: "TEST-SN-02", rid: "000102" },
    account: { number: "TEST-ACCOUNT-02" },
  },
];

test("deactivation drafts omit account credentials while retaining receiver details", () => {
  const body = emailBody(rows);
  // Assert a boolean rather than printing a complete draft on failure: a future
  // accidental credential regression must not expose its value in test logs.
  assert.equal(/account\s*password\s*:/i.test(body), false, "Draft must omit the account-password field.");
  assert.equal(/deactivation of the following receivers/.test(body), true);
  for (const { receiver, account } of rows) {
    for (const value of [...Object.values(receiver), account.number]) {
      assert.equal(body.includes(value), true, "Draft must retain each requested receiver identifier.");
    }
  }
});

test("served tracker JavaScript has no embedded account-password template", () => {
  assert.equal(/account\s*password\s*:/i.test(source), false, "Public source must omit the account-password field.");
});

test("built public tracker asset omits the account-password template", async () => {
  // The build copies public files into the deployed asset tree. Check that output
  // as well as source so the deployment artifact is covered by the normal suite.
  const builtSource = await readFile(new URL("../dist/client/asset-tracker/app.js", import.meta.url), "utf8");
  assert.equal(/account\s*password\s*:/i.test(builtSource), false, "Built asset must omit the account-password field.");
});
