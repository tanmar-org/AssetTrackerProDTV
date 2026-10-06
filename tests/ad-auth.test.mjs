import assert from "node:assert/strict";
import test from "node:test";
import { adConfiguration, authenticationMode, canonicalAdUsername, guidBytes, guidText, verifyAdPassword, lookupAdGuid, directoryDeadlineMs } from "../lib/ad-auth.ts";
import { createLdapDirectory, directoryBytes, directoryGuid, syntheticAdEntry } from "./helpers/ldap-directory.mjs";

test("AD mode cannot silently fall back from unknown or partial configuration", () => {
  assert.equal(authenticationMode({}), "pin"); assert.equal(authenticationMode({ AUTH_MODE: "ad" }), "ad");
  for (const env of [{ AUTH_MODE: "unknown" }, { AD_DIRECTORY_ID: "synthetic-ad" }, { AD_LDAP_URL: "ldaps://localhost" }])
    assert.throws(() => authenticationMode(env), { status: 503 });
});
test("AD selectors preserve dots/dashes and reject filter syntax and domain aliases", () => {
  assert.equal(canonicalAdUsername("  J.Doe-007  "), "j.doe-007");
  for (const value of ["jdoe@domain.invalid", "DOMAIN\\jdoe", "john doe", "*)(objectClass=*)", "a".repeat(65), null])
    assert.equal(canonicalAdUsername(value), "");
});
test("AD GUID conversion preserves known mixed-endian bytes including high-bit octets", () => {
  assert.deepEqual(guidBytes(directoryGuid), directoryBytes); assert.equal(guidText(directoryBytes), directoryGuid);
  assert.throws(() => guidText(Buffer.alloc(15)), { status: 503 });
});

// Real TLS and LDAP wire encoding; never a mock of the production Client.
test("private LDAPS credential and status adapter", { timeout: 30000 }, async t => {
  const directory = await createLdapDirectory(), config = adConfiguration(directory.env), model = directory.model;
  t.after(async () => { await directory.close(); assert.deepEqual(directory.errors, []); });
  const reset = () => { model.entries = [syntheticAdEntry()]; model.requests = []; model.onUserBind = null;
    model.stall = false; model.duplicate = false; model.referral = false; model.omit = null; model.operationDelayMs = 0; };
  await t.test("valid password binds the returned DN and searches exact binary GUID under bounded options", async () => {
    reset(); const entry = model.entries[0], identity = await verifyAdPassword(config, entry.username, entry.password);
    assert.equal(identity.guid, directoryGuid); assert.equal(identity.passwordStamp, entry.stamp);
    const searches = model.requests.filter(value => value.type === "search");
    assert.equal(searches.length, 2);
    for (const search of searches) {
      assert.equal(search.sizeLimit, 2); assert.equal(search.timeLimit, 2); assert.equal(search.aliases, 0);
      assert.ok(search.attributes.includes("msDS-User-Account-Control-Computed"));
    }
    assert.deepEqual(searches[1].conditions.find(value => value.attribute === "objectguid").value, directoryBytes);
    assert.equal((await lookupAdGuid(config, directoryGuid)).guid, directoryGuid);
  });
  await t.test("empty/incorrect credentials and nonexistent users cannot perform successful user binds", async () => {
    reset(); assert.equal(await verifyAdPassword(config, "j.doe", ""), null); assert.equal(model.requests.length, 0);
    assert.equal(await verifyAdPassword(config, "j.doe", "wrong synthetic password"), null);
    model.requests = []; assert.equal(await verifyAdPassword(config, "missing", "Synthetic AD password 007!"), null);
    assert.ok(model.requests.every(value => value.type !== "bind" || value.reader));
  });
  await t.test("disabled, locked, password-expired, must-change and expired accounts fail before user bind", async () => {
    for (const override of [{ flags: "514" }, { flags: "4096" }, { computed: "16" }, { computed: "8388608" }, { stamp: "0" }, { expires: "1" }]) {
      reset(); model.entries = [syntheticAdEntry(override)];
      assert.equal(await verifyAdPassword(config, "j.doe", model.entries[0].password), null);
      assert.ok(model.requests.every(value => value.type !== "bind" || value.reader));
    }
  });
  await t.test("missing control attributes, ambiguity and referrals fail closed without exposing directory diagnostics", async () => {
    for (const property of ["omit", "duplicate", "referral"]) {
      reset(); model[property] = property === "omit" ? "msDS-User-Account-Control-Computed" : true;
      await assert.rejects(lookupAdGuid(config, directoryGuid), { status: 503, message: "Directory sign-in unavailable." });
    }
  });
  await t.test("password reset or disable between credential bind and metadata recheck denies identity", async () => {
    for (const property of ["stamp", "flags"]) {
      reset(); model.onUserBind = entry => { entry[property] = property === "stamp" ? "134000000000000001" : "514"; };
      assert.equal(await verifyAdPassword(config, "j.doe", model.entries[0].password), null);
    }
  });
  await t.test("TLS rejects an untrusted CA and a certificate for a different hostname", async () => {
    reset(); const wrong = await createLdapDirectory({ certificateHost: "wrong.example.invalid" });
    try {
      await assert.rejects(lookupAdGuid({ ...config, ca: adConfiguration(wrong.env).ca }, directoryGuid), { status: 503 });
      await assert.rejects(lookupAdGuid(adConfiguration(wrong.env), directoryGuid), { status: 503 });
      assert.equal(wrong.model.requests.length, 0);
    } finally { await wrong.close(); }
  });
  await t.test("unsafe or incomplete settings are rejected before any connection", () => {
    for (const override of [{ AD_LDAP_URL: "ldap://localhost" }, { AD_LDAP_URL: "ldaps://name:password@localhost" },
      { AD_LDAP_URL: "ldaps://localhost/?query=1" }, { AD_CA_FILE: "relative.pem" }, { AD_BIND_PASSWORD: "" }, { AD_BASE_DN: "not-a-dn" }])
      assert.throws(() => adConfiguration({ ...directory.env, ...override }), { status: 503 });
  });
  await t.test("stalled directory operations terminate within the shared wall-clock budget", async () => {
    reset(); model.stall = true; const began = Date.now();
    await assert.rejects(lookupAdGuid(config, directoryGuid), { status: 503 });
    assert.ok(Date.now() - began < directoryDeadlineMs + 1000);
  });
  await t.test("a slow sequence of individually timely operations still cannot extend the total deadline", async () => {
    reset(); model.operationDelayMs = 1150; const began = Date.now();
    await assert.rejects(verifyAdPassword(config, "j.doe", model.entries[0].password), { status: 503 });
    const elapsed = Date.now() - began; assert.ok(elapsed >= 4500 && elapsed < directoryDeadlineMs + 1000);
  });
});
