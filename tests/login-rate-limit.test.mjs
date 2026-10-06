import assert from "node:assert/strict";
import test from "node:test";
import { loginClient, guardLogin } from "../lib/login-rate-limit.ts";

const secret = "1".repeat(64);
const request = headers => new Request("https://staff.example.invalid/api/auth", { headers });
// Synthetic HTTP inputs verify the trust boundary without a database or real IP.
test("unconfigured login ingress ignores all client-supplied IP/secret headers", () => {
  assert.equal(loginClient(request({ "x-forwarded-for": "192.0.2.10", "x-login-client-ip": "192.0.2.20", "x-login-proxy-secret": secret }), ""), null);
});
test("configured login ingress requires both a matching secret and one valid IP", () => {
  for (const headers of [{}, { "x-login-client-ip": "192.0.2.20" },
    { "x-login-proxy-secret": secret, "x-forwarded-for": "192.0.2.20" },
    { "x-login-proxy-secret": "2".repeat(64), "x-login-client-ip": "192.0.2.20" }])
    assert.throws(() => loginClient(request(headers), secret), { status: 503 });
  assert.equal(loginClient(request({ "x-login-proxy-secret": secret, "x-login-client-ip": "192.0.2.20" }), secret), "192.0.2.20");
});
test("login ingress rejects IP lists, hostnames, ports and malformed secret configuration", () => {
  for (const ip of ["", "192.0.2.20, 192.0.2.21", "staff.example.invalid", "192.0.2.20:443", "[2001:db8::1]", "garbage"])
    assert.throws(() => loginClient(request({ "x-login-proxy-secret": secret, "x-login-client-ip": ip }), secret), { status: 503 });
  for (const configured of ["short", "x".repeat(129), "é".repeat(40), "x y".repeat(20)])
    assert.throws(() => loginClient(request({}), configured), { status: 503 });
});
test("equivalent IPv6 source addresses share the same trusted identity", () => {
  const identity = ip => loginClient(request({ "x-login-proxy-secret": secret, "x-login-client-ip": ip }), secret);
  assert.equal(identity("2001:db8::a"), identity("2001:0DB8:0000:0000:0000:0000:0000:000a"));
});
test("cross-site login is rejected before any database reservation", async () => {
  const store = new Proxy({}, { get() { throw new Error("Database must not be used."); } });
  await assert.rejects(guardLogin(request({ "sec-fetch-site": "cross-site" }), "jdoe", store), { status: 403 });
});
