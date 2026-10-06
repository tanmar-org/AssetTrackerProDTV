import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { renderIngress } from "../../scripts/ingress-preparation.mjs";

const run = promisify(execFile);
async function freePort() {
  const socket = net.createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
function request(port, ca, { hostname = "tracker.example.test", host = hostname, pathname = "/", method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "127.0.0.1", servername: hostname, port, ca, method, path: pathname,
      headers: { host, ...headers }, timeout: 5000 }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("timeout", () => req.destroy(new Error("Synthetic ingress request timed out")));
    req.on("error", reject); req.end(body);
  });
}

// Run real Nginx at both hops using ONLY loopback, an echo origin and temporary
// synthetic certificates. No company DNS, AD, application DB or proxy is used.
async function fixture(t, sourceAddress, qrCertificateName = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-ingress-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origins = [], observed = [];
  for (const application of ["staff", "qr"]) {
    const server = http.createServer(async (req, res) => {
      let bytes = 0; for await (const chunk of req) bytes += chunk.length;
      const record = { application, method: req.method, url: req.url, headers: req.headers, bytes };
      observed.push(record); res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(record));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening"); origins.push(server);
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  }
  const cert = path.join(directory, "server.pem"), key = path.join(directory, "server.key"), wrongCa = path.join(directory, "wrong.pem");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=tracker.example.test",
    "-addext", `subjectAltName=DNS:tracker.example.test${qrCertificateName ? ",DNS:qr.example.test" : ""}`, "-keyout", key, "-out", cert]);
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=untrusted.example.test",
    "-keyout", path.join(directory, "wrong.key"), "-out", wrongCa]);
  const ports = []; while (ports.length < 5) { const port = await freePort(); if (!ports.includes(port)) ports.push(port); }
  const [gateway, staff, qr, badTrust, badName] = ports;
  const settings = { staffHostname: "tracker.example.test", qrHostname: "qr.example.test", vmAddress: "127.0.0.1", gatewayPort: gateway,
    staffPort: origins[0].address().port, qrPort: origins[1].address().port, vmCertificate: cert, vmCertificateKey: key,
    npmTrustedCa: cert, npmQrInclude: path.join(directory, "npm-qr-upstream.conf"),
    ...(sourceAddress ? { proxySourceAddress: sourceAddress } : {}) };
  const files = await renderIngress(settings, directory);
  for (const [name, value] of Object.entries(files)) await writeFile(path.join(directory, name), value, { mode: 0o600 });
  const frontend = (port, snippet) => `server { listen 127.0.0.1:${port} ssl; server_name tracker.example.test qr.example.test;
    ssl_certificate ${cert}; ssl_certificate_key ${key}; set $server 127.0.0.1; set $port ${gateway};
    # Model NPM's access log before Advanced content; each snippet disables it.
    access_log ${directory}/npm-access.log; ${snippet} }`;
  for (const dir of ["body", "proxy", "fastcgi", "uwsgi", "scgi"]) await mkdir(path.join(directory, dir));
  const config = `worker_processes 1; pid ${directory}/nginx.pid; error_log ${directory}/error.log warn;
    events { worker_connections 64; } http {
      # Model inherited real-IP trust; spoofing this header MUST NOT change the
      # authenticated rate-limit identity or the optional gateway source rule.
      set_real_ip_from 127.0.0.1; real_ip_header X-Real-IP; real_ip_recursive on;
      client_body_temp_path ${directory}/body; proxy_temp_path ${directory}/proxy;
      fastcgi_temp_path ${directory}/fastcgi; uwsgi_temp_path ${directory}/uwsgi; scgi_temp_path ${directory}/scgi;
      access_log ${directory}/default-access.log;
      include ${directory}/vm.conf;
      ${frontend(staff, files["npm-staff.conf"])}
      ${frontend(qr, files["npm-qr.conf"])}
      ${frontend(badTrust, files["npm-staff.conf"].replace(`proxy_ssl_trusted_certificate ${cert};`, `proxy_ssl_trusted_certificate ${wrongCa};`))}
      ${frontend(badName, files["npm-staff.conf"].replace("proxy_ssl_name tracker.example.test;", "proxy_ssl_name missing.example.test;"))}
    }`;
  const configPath = path.join(directory, "nginx.conf"); await writeFile(configPath, config, { mode: 0o600 });
  const nginx = process.env.NGINX_BINARY || "nginx";
  await run(nginx, ["-t", "-p", directory, "-c", configPath, "-e", path.join(directory, "error.log")]);
  const child = spawn(nginx, ["-p", directory, "-c", configPath, "-e", path.join(directory, "error.log"), "-g", "daemon off;"], { stdio: "ignore" });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
  });
  const ca = await readFile(cert);
  for (let i = 0; ; i++) {
    try { await request(staff, ca); break; } catch (error) { if (i === 40) throw error; await delay(50); }
  }
  const loginSecret = files["staff-ingress.env"].trim().split("=")[1];
  const requestSecret = files["qr-ingress.env"].trim().split("=")[1];
  return { directory, observed, gateway, staff, qr, badTrust, badName, ca, loginSecret, requestSecret };
}

test("real two-hop ingress enforces headers, route policy, TLS and body bounds", { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await t.test("NPM overwrites spoofed client/secret fields and preserves Secure-origin metadata", async () => {
    const r = await request(f.staff, f.ca, { pathname: "/api/auth", method: "POST", body: "{}", headers: {
      "x-login-client-ip": "198.51.100.7", "x-login-proxy-secret": "attacker", "x-forwarded-for": "198.51.100.8",
      "x-request-proxy-secret": "attacker", "x-forwarded-proto": "http", "x-real-ip": "198.51.100.9",
    } });
    assert.equal(r.status, 200); const origin = JSON.parse(r.text);
    assert.equal(origin.headers["x-login-client-ip"], "127.0.0.1");
    assert.equal(origin.headers["x-login-proxy-secret"], f.loginSecret);
    assert.equal(origin.headers["x-forwarded-proto"], "https");
    for (const field of ["x-forwarded-for", "x-real-ip", "x-request-proxy-secret"]) assert.equal(origin.headers[field], undefined);
  });
  await t.test("direct gateway calls without the right per-host secret never reach either origin", async () => {
    const before = f.observed.length;
    for (const hostname of ["tracker.example.test", "qr.example.test"]) {
      assert.equal((await request(f.gateway, f.ca, { hostname })).status, 403);
      assert.equal((await request(f.gateway, f.ca, { hostname, headers: { "x-login-proxy-secret": "wrong", "x-request-proxy-secret": f.loginSecret } })).status, 403);
    }
    assert.equal(f.observed.length, before);
  });
  await t.test("staff lookup and normalized path variants stay inaccessible at both hops", async () => {
    const before = f.observed.length;
    for (const pathname of ["/api/service-assets", "/api/service-assets/", "/api/SERVICE-ASSETS", "/api/%73ervice-assets", "/api/service-assets/child", "/api/other/../service-assets"]) {
      assert.equal((await request(f.staff, f.ca, { pathname })).status, 404);
      assert.equal((await request(f.gateway, f.ca, { pathname, headers: { "x-login-proxy-secret": f.loginSecret } })).status, 404);
    }
    assert.equal(f.observed.length, before);
  });
  await t.test("QR GET lookup and POST creation work with overwritten distinct ingress headers", async () => {
    for (const options of [{ pathname: "/api/asset?id=synthetic" }, { pathname: "/api/requests", method: "POST", body: "{}" }]) {
      const r = await request(f.qr, f.ca, { hostname: "qr.example.test", ...options, headers: { "x-request-client-ip": "198.51.100.7", "x-request-proxy-secret": "spoof" } });
      assert.equal(r.status, 200); const origin = JSON.parse(r.text);
      assert.equal(origin.application, "qr"); assert.equal(origin.headers["x-request-client-ip"], "127.0.0.1");
      assert.equal(origin.headers["x-request-proxy-secret"], f.requestSecret);
      assert.equal(origin.headers["x-login-proxy-secret"], undefined);
    }
  });
  await t.test("QR staff methods, private/unknown APIs and path aliases are denied at both hops", async () => {
    const before = f.observed.length;
    const cases = [
      ...["GET", "HEAD", "PATCH", "DELETE", "OPTIONS"].map(method => ({ pathname: "/api/requests", method, status: 405 })),
      ...["/api/requests/item", "/api/requests/operations", "/api/requests/", "/api/Requests", "/api/unknown", "/api", "/api/requests%2fitem"].map(pathname => ({ pathname, method: "POST", status: 404 })),
      { pathname: "/api/asset", method: "POST", status: 405 }, { pathname: "/", method: "POST", status: 405 },
    ];
    for (const { status, ...options } of cases) {
      assert.equal((await request(f.qr, f.ca, { hostname: "qr.example.test", ...options })).status, status);
      assert.equal((await request(f.gateway, f.ca, { hostname: "qr.example.test", ...options, headers: { "x-request-proxy-secret": f.requestSecret } })).status, status);
    }
    assert.equal(f.observed.length, before);
  });
  await t.test("QR 8-KiB ceiling is enforced without blocking large staff recovery payloads", async () => {
    const qr = { hostname: "qr.example.test", pathname: "/api/requests", method: "POST" };
    assert.equal((await request(f.qr, f.ca, { ...qr, body: "x".repeat(8192) })).status, 200);
    const before = f.observed.length;
    assert.equal((await request(f.qr, f.ca, { ...qr, body: "x".repeat(8193) })).status, 413);
    assert.equal(f.observed.length, before);
    const large = await request(f.staff, f.ca, { pathname: "/api/drafts", method: "PUT", body: "x".repeat(16 * 1024 * 1024 + 4096) });
    assert.equal(large.status, 200); assert.equal(JSON.parse(large.text).bytes, 16 * 1024 * 1024 + 4096);
  });
  await t.test("untrusted backend CA and incorrect backend certificate name fail closed", async tlsTest => {
    const before = f.observed.length;
    assert.equal((await request(f.badTrust, f.ca)).status, 502);
    assert.equal((await request(f.badName, f.ca)).status, 502);
    assert.equal(f.observed.length, before);
    await assert.rejects(request(f.gateway, f.ca, { hostname: "unknown.example.test" }));
    assert.equal((await request(f.gateway, f.ca, { host: "qr.example.test", headers: { "x-login-proxy-secret": f.loginSecret } })).status, 403);
    // Isolate name verification: backend accepts QR SNI, but the trusted cert
    // covers only staff. Frontend TLS still verifies the staff name correctly.
    const mismatch = await fixture(tlsTest, undefined, false), requestsBefore = mismatch.observed.length;
    assert.equal((await request(mismatch.qr, mismatch.ca, { host: "qr.example.test" })).status, 502);
    assert.equal(mismatch.observed.length, requestsBefore);
  });
  await t.test("host access logs omit private label queries", async () => {
    await request(f.qr, f.ca, { hostname: "qr.example.test", pathname: "/?id=synthetic-private-label" });
    for (const name of ["npm-access.log", "default-access.log"])
      assert.equal(await readFile(path.join(f.directory, name), "utf8"), "");
  });
});
test("optional source allowlist rejects a non-allowed peer despite a valid secret", { timeout: 15000 }, async t => {
  const f = await fixture(t, "10.0.0.10"), before = f.observed.length;
  assert.equal((await request(f.gateway, f.ca, { headers: { "x-login-proxy-secret": f.loginSecret, "x-real-ip": "10.0.0.10" } })).status, 403);
  assert.equal(f.observed.length, before);
});
