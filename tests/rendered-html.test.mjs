import assert from "node:assert/strict";
import test from "node:test";

// Existing smoke coverage exercises the built redirect with stubbed assets.
// It does not test authenticated APIs, real D1 state, or staff workflows (QA-01).
test("routes the primary URL to receiver control", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 307);
  assert.equal(
    new URL(response.headers.get("location"), "http://localhost").pathname,
    "/asset-tracker/index.html",
  );
});
