import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startNext } from "../../tests/helpers/next-server.mjs";

// Check the production Node-rendered public form and its local image assets.
test("Node renders the service form and serves its image assets", async (t) => {
  const server = await startNext(fileURLToPath(new URL("../", import.meta.url)), { DATABASE_URL: "" });
  t.after(server.close);
  const response = await fetch(server.url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/html/);
  const html = await response.text();
  assert.match(html, /Service Request/);
  assert.equal(html.includes("fonts.googleapis.com"), false);
  assert.equal(html.includes("fonts.gstatic.com"), false);
  assert.equal((await fetch(`${server.url}/tanmar-emblem-tight.png`)).status, 200);
  assert.equal((await fetch(`${server.url}/api/requests`)).status, 401);
});
