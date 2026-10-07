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
  const server = net.createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
function request(port, ca, { host = "tracker.example.test", pathname = "/", method = "GET", headers = {}, body = "", localAddress } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "127.0.0.1", port, servername: "tracker.example.test", ca,
      localAddress, path: pathname, method, headers: { host, ...headers }, timeout: 5000 }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("Synthetic proxy timed out"))); req.end(body);
  });
}

// Model normal NPM Proxy Hosts with its standard headers, no custom Advanced
// location and no upstream SNI. Every endpoint/data/credential is synthetic.
test("standard NPM HTTPS forwarding works while the gateway owns ingress policy", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "assettracker-standard-proxy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const origins = [], observed = [];
  for (const app of ["staff", "qr"]) {
    const origin = http.createServer(async (req, res) => {
      let bytes = 0; for await (const chunk of req) bytes += chunk.length;
      const record = { app, method: req.method, url: req.url, headers: req.headers, bytes };
      observed.push(record); res.end(JSON.stringify(record));
    });
    origin.listen(0, "127.0.0.1"); await once(origin, "listening"); origins.push(origin);
    t.after(() => new Promise(resolve => { origin.close(resolve); origin.closeAllConnections(); }));
  }
  const cert = path.join(directory, "server.pem"), key = path.join(directory, "server.key");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=tracker.example.test", "-addext", "subjectAltName=DNS:tracker.example.test,DNS:qr.example.test",
    "-keyout", key, "-out", cert]);
  const gateway = await freePort(), frontend = await freePort();
  const files = await renderIngress({ staffHostname: "tracker.example.test", qrHostname: "qr.example.test",
    vmAddress: "127.0.0.1", gatewayPort: gateway, staffPort: origins[0].address().port, qrPort: origins[1].address().port,
    vmCertificate: cert, vmCertificateKey: key, proxyMode: "standard", proxySourceAddress: "127.0.0.1" }, directory);
  await writeFile(path.join(directory, "vm-qr-upstream.conf"), files["vm-qr-upstream.conf"], { mode: 0o600 });
  for (const name of ["body", "proxy", "fastcgi", "uwsgi", "scgi"]) await mkdir(path.join(directory, name));
  const config = `worker_processes 1; pid ${directory}/nginx.pid; error_log ${directory}/error.log warn;
    events { worker_connections 64; } http { access_log off;
    client_body_temp_path ${directory}/body; proxy_temp_path ${directory}/proxy;
    fastcgi_temp_path ${directory}/fastcgi; uwsgi_temp_path ${directory}/uwsgi; scgi_temp_path ${directory}/scgi;
    ${files["vm.conf"]}
    server { listen 127.0.0.1:${frontend} ssl; server_name tracker.example.test qr.example.test;
      ssl_certificate ${cert}; ssl_certificate_key ${key};
      # Server-only real-IP rules in the gateway must not alter the outer peer.
      real_ip_header X-Disabled-Real-IP;
      location / {
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_pass https://127.0.0.1:${gateway};
      }
    } }`;
  const filename = path.join(directory, "nginx.conf"); await writeFile(filename, config, { mode: 0o600 });
  const command = process.env.NGINX_BINARY || "nginx";
  const args = ["-p", directory, "-c", filename, "-e", path.join(directory, "error.log")];
  await run(command, [...args, "-t"]);
  const child = spawn(command, [...args, "-g", "daemon off;"], { stdio: "ignore" }), exited = once(child, "exit");
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); await exited; });
  const ca = await readFile(cert), login = files["staff-ingress.env"].trim().split("=")[1], qr = files["qr-ingress.env"].trim().split("=")[1];
  for (let i = 0; ; i++) {
    try { await request(frontend, ca); break; } catch (error) { if (i === 40) throw error; await delay(50); }
  }
  await t.test("normal forwarding reaches both hosts without upstream SNI or custom secrets", async () => {
    for (const [host, app] of [["tracker.example.test", "staff"], ["qr.example.test", "qr"]]) {
      const response = await request(frontend, ca, { host });
      assert.equal(response.status, 200); const record = JSON.parse(response.text);
      assert.equal(record.app, app); assert.equal(record.headers["x-forwarded-proto"], "https");
      assert.equal(record.headers[app === "staff" ? "x-login-proxy-secret" : "x-request-proxy-secret"], app === "staff" ? login : qr);
    }
  });
  await t.test("spoofed private headers and forwarded prefixes do not replace the gateway identity", async () => {
    for (const host of ["tracker.example.test", "qr.example.test"]) {
      const response = await request(frontend, ca, { host, headers: { "X-Forwarded-For": "198.51.100.7",
        "X-Real-IP": "198.51.100.8", "X-Login-Client-IP": "198.51.100.9", "X-Request-Client-IP": "198.51.100.10",
        "X-Login-Proxy-Secret": "spoof", "X-Request-Proxy-Secret": "spoof" } });
      assert.equal(response.status, 200); const h = JSON.parse(response.text).headers, staff = host.startsWith("tracker.");
      assert.equal(h[staff ? "x-login-client-ip" : "x-request-client-ip"], "127.0.0.1");
      assert.equal(h[staff ? "x-login-proxy-secret" : "x-request-proxy-secret"], staff ? login : qr);
      for (const name of ["x-forwarded-for", "x-real-ip", staff ? "x-request-proxy-secret" : "x-login-proxy-secret"])
        assert.equal(h[name], undefined);
    }
  });
  await t.test("untrusted TCP peer cannot enter using spoofed trusted IPs or valid app secrets", async () => {
    const before = observed.length;
    for (const host of ["tracker.example.test", "qr.example.test"])
      assert.equal((await request(gateway, ca, { host, localAddress: "127.0.0.2", headers: {
        "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1", "X-Login-Proxy-Secret": login,
        "X-Request-Proxy-Secret": qr } })).status, 403);
    assert.equal(observed.length, before);
  });
  await t.test("unknown HTTP hosts stay rejected after a successful TLS handshake", async () => {
    const before = observed.length;
    assert.equal((await request(gateway, ca, { host: "unknown.example.test" })).status, 421);
    assert.equal(observed.length, before);
  });
  await t.test("private staff/QR paths and unsupported public methods stay blocked", async () => {
    const before = observed.length;
    for (const pathname of ["/api/service-assets", "/api/%73ervice-assets", "/api/SERVICE-ASSETS/child"])
      assert.equal((await request(frontend, ca, { pathname })).status, 404);
    for (const pathname of ["/api/requests/item", "/api/requests/operations", "/api/unknown"])
      assert.equal((await request(frontend, ca, { host: "qr.example.test", pathname })).status, 404);
    assert.equal((await request(frontend, ca, { host: "qr.example.test", pathname: "/api/requests" })).status, 405);
    assert.equal((await request(frontend, ca, { host: "qr.example.test", pathname: "/api/asset", method: "POST" })).status, 405);
    assert.equal(observed.length, before);
  });
  await t.test("public lookup/request methods retain the QR credential and body ceiling", async () => {
    const options = { host: "qr.example.test" };
    assert.equal((await request(frontend, ca, { ...options, pathname: "/api/asset?id=synthetic" })).status, 200);
    assert.equal((await request(frontend, ca, { ...options, pathname: "/api/requests", method: "POST", body: "{}" })).status, 200);
    const before = observed.length;
    assert.equal((await request(frontend, ca, { ...options, pathname: "/api/requests", method: "POST", body: "x".repeat(8193) })).status, 413);
    assert.equal(observed.length, before);
  });
});
