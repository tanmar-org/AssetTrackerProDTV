import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile), script = fileURLToPath(new URL("../scripts/check-managed-readiness.mjs", import.meta.url));
test("managed readiness requires both private no-store endpoints and never follows redirects or echoes errors", async t => {
  const state = { status: 200, cache: "no-store", calls: 0 };
  const servers = [];
  for (let i = 0; i < 2; i++) {
    const server = http.createServer((req, res) => {
      state.calls++; assert.equal(req.url, "/api/health"); assert.equal(req.headers.authorization, undefined);
      res.writeHead(state.status, { "cache-control": state.cache, location: `http://127.0.0.1:${servers[0].address().port}/should-not-follow` });
      res.end("synthetic-private-diagnostic-must-not-echo");
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); servers.push(server);
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  }
  const env = { PATH: process.env.PATH, ASSETTRACKER_STAFF_PORT: String(servers[0].address().port), ASSETTRACKER_QR_PORT: String(servers[1].address().port) };
  assert.match((await run(process.execPath, [script], { env })).stdout, /readiness passed/);
  for (const [status, cache] of [[503, "no-store"], [200, "public"], [302, "no-store"]]) {
    state.status = status; state.cache = cache; const before = state.calls;
    await assert.rejects(run(process.execPath, [script], { env }), error => {
      assert.equal(error.code, 1); assert.match(error.stderr, /readiness failed/);
      assert.ok(!`${error.stdout}${error.stderr}`.includes("synthetic-private-diagnostic")); return true;
    });
    assert.equal(state.calls - before, 2);
  }
});
