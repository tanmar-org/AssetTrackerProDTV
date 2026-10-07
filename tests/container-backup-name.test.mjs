import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { isContainerBackupName } from "../scripts/container-backup-name.mjs";
// Exercise the actual producer format and dangerous path forms, rather than
// loosening restore validation to accept arbitrary names after the timestamp dot.
test("container recovery accepts real generated backup basenames and rejects traversal", () => {
  const generated = `backup-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  assert.equal(isContainerBackupName(generated), true);
  for (const value of [undefined, "backup-..", `${generated}/..`, `../${generated}`, `${generated}\n`, `/${generated}`, `${generated};echo`, "backup-latest"])
    assert.equal(isContainerBackupName(value), false);
});
