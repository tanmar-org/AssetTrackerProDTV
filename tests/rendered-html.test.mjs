import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startNext } from "./helpers/next-server.mjs";

// Smoke the actual production Node server and public static asset serving.
test("Node routes the primary URL to receiver control and serves its UI", async (t) => {
  const server = await startNext(fileURLToPath(new URL("../", import.meta.url)), { DATABASE_URL: "" });
  t.after(server.close);
  const response = await fetch(server.url, { redirect: "manual" });
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("location"), server.url).pathname, "/asset-tracker/index.html");
  const page = await fetch(`${server.url}/asset-tracker/index.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /authForm/);
  const unavailable = await fetch(`${server.url}/api/health`);
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { status: "unavailable" });
});
