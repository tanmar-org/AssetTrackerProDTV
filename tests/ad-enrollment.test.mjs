import assert from "node:assert/strict";
import test from "node:test";
import { issueAdConfirmation, readAdConfirmation, enrollmentLifetimeMs } from "../lib/ad-enrollment.ts";

const env = { ADMIN_SHARED_SECRET: "synthetic-onboarding-secret-" + "1".repeat(32) };
const config = { id: "synthetic-ad", binding: "a".repeat(64) };
const actor = { id: "synthetic-admin", context: "b".repeat(64) };
const identity = { guid: "12345678-90ab-cdef-8123-456789abcdef", username: "j.doe", displayName: "Synthetic Staff" };
const now = 1000000;

// Security-sensitive proof checks, independent of the UI or directory mocks.
test("AD enrollment approvals bind exact identity, actor, session, target and configuration", () => {
  const value = issueAdConfirmation(identity, actor, config, null, now, env);
  assert.equal(readAdConfirmation(value, actor, config, null, now + 1, env).guid, identity.guid);
  const changed = JSON.parse(Buffer.from(value.split(".")[0], "base64url").toString());
  changed.guid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const forged = Buffer.from(JSON.stringify(changed)).toString("base64url") + "." + value.split(".")[1];
  for (const [token, who, directory, target] of [[forged, actor, config, null],
    [value, { ...actor, id: "other-admin" }, config, null], [value, { ...actor, context: "c".repeat(64) }, config, null],
    [value, actor, { ...config, id: "other-ad" }, null], [value, actor, { ...config, binding: "d".repeat(64) }, null],
    [value, actor, config, "existing-user"]])
    assert.throws(() => readAdConfirmation(token, who, directory, target, now + 1, env), { status: 409 });
  const link = issueAdConfirmation(identity, actor, config, "existing-user", now, env);
  assert.equal(readAdConfirmation(link, actor, config, "existing-user", now + 1, env).username, "j.doe");
  assert.throws(() => readAdConfirmation(link, actor, config, null, now + 1, env), { status: 409 });
});
test("AD enrollment approvals expire, reject malformed proofs and require protected signing material", () => {
  const value = issueAdConfirmation(identity, actor, config, null, now, env);
  for (const time of [now - 1, now + enrollmentLifetimeMs])
    assert.throws(() => readAdConfirmation(value, actor, config, null, time, env), { status: 409 });
  for (const token of [null, "", "a".repeat(3501), value + "x"])
    assert.throws(() => readAdConfirmation(token, actor, config, null, now, env), { status: 409 });
  assert.throws(() => issueAdConfirmation(identity, actor, config, null, now, {}), { status: 503 });
  assert.throws(() => readAdConfirmation(value, actor, config, null, now, { ADMIN_SHARED_SECRET: "2".repeat(43) }), { status: 409 });
});
// JSON bodies are bounded at 4 KiB; a Unicode name and long valid identifiers
// must still round-trip without rejecting the server's own reviewed proof.
test("bounded Unicode directory names round-trip in a reviewed proof", () => {
  const reviewed = { ...identity, username: "a".repeat(64), displayName: "漢".repeat(256) };
  const who = { ...actor, id: "a".repeat(128) }, directory = { ...config, id: "a".repeat(64) }, target = "a".repeat(128);
  const time = Date.now(), value = issueAdConfirmation(reviewed, who, directory, target, time, env);
  assert.ok(value.length < 3500);
  assert.equal(readAdConfirmation(value, who, directory, target, time, env).displayName, reviewed.displayName);
});
