import assert from "node:assert/strict";
import test from "node:test";
import { readBody, selector, submission } from "../service-request/lib/input.ts";

const payload = () => ({
  assetId: "receiver-01", requesterName: "Synthetic Requester", requesterPhone: "555-0100",
  operatorName: "Test Operator", rigFrac: "Test Rig", lease: "Test Lease", errorCode: "771",
  latitude: 31.9, longitude: -102.2, gpsAccuracy: 7, gpsCapturedAt: new Date().toISOString(),
});

test("public request parser bounds chunked UTF-8 bytes, objects, JSON and media types", async () => {
  const request = (contents, type = "application/json") => new Request("http://localhost/api/requests", {
    method: "POST", headers: { "content-type": type }, body: contents,
  });
  for (const contents of ["null", "[]", "123", "{malformed"])
    await assert.rejects(readBody(request(contents)), { status: 400 });
  await assert.rejects(readBody(request("{}", "text/plain")), { status: 415 });
  // No Content-Length: the multibyte payload is smaller in characters than bytes.
  const bytes = new TextEncoder().encode(JSON.stringify({ content: "é".repeat(5000) }));
  const stream = new ReadableStream({ start(controller) {
    controller.enqueue(bytes.slice(0, 6000)); controller.enqueue(bytes.slice(6000)); controller.close();
  } });
  await assert.rejects(readBody(new Request("http://localhost/", {
    method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half",
  })), { status: 413 });
  assert.deepEqual(await readBody(request('{"name":"Test"}')), { name: "Test" });
});

test("submission rejects private snapshots, unknown fields, controls, long and coerced inputs", () => {
  for (const field of ["serialNumber", "rid", "accessCard", "accountNumber", "accountName", "notes", "status"])
    assert.throws(() => submission({ ...payload(), [field]: "forged" }), { status: 400 });
  for (const changes of [{ assetId: undefined }, { assetNumber: "TEST-01" }, { assetId: "<script>" },
    { requesterName: "a".repeat(121) }, { requesterName: null }, { requesterPhone: 5550100 },
    { operatorName: "\ncontrol" }, { rigFrac: "" }, { lease: "a".repeat(121) }, { errorCode: "a".repeat(81) }])
    assert.throws(() => submission({ ...payload(), ...changes }), { status: 400 });
  assert.deepEqual(selector({ assetNumber: "000001" }), { key: "a", value: "000001" });
});

test("GPS requires numeric coordinate/accuracy bounds and a fresh canonical timestamp", () => {
  for (const changes of [{ latitude: null }, { latitude: "31.9" }, { latitude: 91 }, { latitude: NaN },
    { longitude: -181 }, { gpsAccuracy: -1 }, { gpsAccuracy: 10001 }, { gpsAccuracy: Infinity },
    { gpsCapturedAt: "invalid" }, { gpsCapturedAt: "2026-02-30T00:00:00.000Z" },
    { gpsCapturedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() },
    { gpsCapturedAt: new Date(Date.now() + 6 * 60 * 1000).toISOString() }])
    assert.throws(() => submission({ ...payload(), ...changes }), { status: 400 });
  const result = submission({ ...payload(), latitude: 0, longitude: 0, gpsAccuracy: 0 });
  assert.equal(result.latitude, 0); // The valid equator/prime meridian is not null.
});
