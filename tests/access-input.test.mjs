import assert from "node:assert/strict";
import test from "node:test";
import { readAccessBody } from "../lib/access-input.ts";
import { getSessionUser } from "../lib/pin-auth.ts";

// Exercise the actual streaming parser: Content-Length is absent on chunked
// bodies, and multibyte text must be limited by bytes rather than JS characters.
test("access input limits chunked UTF-8 before JSON parsing", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"name":"'));
      controller.enqueue(new TextEncoder().encode("é".repeat(2100)));
    },
    cancel() { cancelled = true; },
  });
  await assert.rejects(readAccessBody(new Request("http://localhost/api/auth", {
    method: "POST", headers: { "content-type": "application/json" }, body, duplex: "half",
  })), (error) => error.status === 413);
  assert.equal(cancelled, true);
});

test("access input rejects malformed/non-object JSON and unsupported content types", async () => {
  for (const text of ["null", "[]", "false", "{broken"]) {
    await assert.rejects(readAccessBody(new Request("http://localhost/api/auth", {
      method: "POST", headers: { "content-type": "application/json" }, body: text,
    })), (error) => error.status === 400);
  }
  await assert.rejects(readAccessBody(new Request("http://localhost/api/auth", {
    method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
  })), (error) => error.status === 415);
  assert.deepEqual(await readAccessBody(new Request("http://localhost/api/auth", {
    method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: '{"name":"jdoe"}',
  })), { name: "jdoe" });
});

test("malformed session cookies are denied before touching the database", async () => {
  const database = { prepare() { throw new Error("Invalid cookies must not query PostgreSQL."); } };
  for (const value of ["%", "%E0%A4%A", "other-token", "a".repeat(63)])
    assert.equal(await getSessionUser(new Request("http://localhost/api/auth", {
      headers: { cookie: `tanmar_session=${value}` },
    }), database), null);
});
