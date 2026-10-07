# HTTPS through Nginx Proxy Manager

Production now uses [Docker Compose](DOCKER-DEPLOYMENT.md), as selected by the owner
for datacenter portability. Native setup below remains an alternative/development
reference. Compose uses its own private service network and Unix-socket PostgreSQL;
follow its runbook for activation and [datacenter moves](DATACENTER-MOVE.md).


The owner chose separate staff/QR names, an existing Nginx Proxy Manager (NPM),
and its existing wildcard certificate. Actual infrastructure values remain in
protected operator notes. Both names returned NXDOMAIN at 2026-10-06 preflight.
The owner subsequently selected a self-signed certificate generated on the VM for
the private backend connection. NPM keeps the wildcard for public HTTPS. On
October 7, 2026 the owner required ordinary Proxy Hosts with an empty Advanced
tab and no NPM file transfers. Select `proxyMode: "standard"` with the explicit
private NPM source address. The gateway accepts HTTPS without SNI, enforces the
TCP peer allowlist and injects the application's credentials locally. NPM's normal
self-signed backend connection does not verify the backend certificate; public
wildcard validation and verified AD/LDAPS remain enabled. No owner private-key
transfer is needed. The older authenticated mode remains supported for proxies
that explicitly provide matching private headers.
This tooling prepares files only: it installs nothing, requests no certificate,
changes no DNS/firewall and starts no service. Review/merge and separately approved
deployment remain necessary; the empty AD preview stays private and separate.

## Traffic and trust

```text
Browser -- HTTPS / existing wildcard --> NPM
NPM -- HTTPS / separate ingress secrets --> private VM gateway
VM gateway -- loopback HTTP --> staff Node / QR Node
staff Node <--> QR Node: loopback URLs and separate ADMIN_SHARED_SECRET
```

The VM gateway bridges the remote proxy to loopback-only Node servers. It binds
an explicit private IPv4 address on port 8443 by default. Every route, including
static files, requires its matching per-host secret; unknown TLS names are rejected.
In standard mode, `proxySourceAddress` is mandatory and restricts the original
TCP peer before any forwarding; only the gateway supplies app ingress secrets.
In authenticated mode the source restriction is optional and the external proxy
must provide the per-host secret. TLS and independent app secrets remain mandatory. Never publicly
port-forward the gateway or Node ports. Restrict backend network reachability to
NPM where practical; the source restriction can be filled in after staging.

Authenticated proxy snippets forward `$realip_remote_addr`, the original TCP peer. NPM's default configuration
trusts real-IP headers from private/CDN ranges; using the original address avoids
authenticating a spoofed value under those inherited settings. This policy assumes
NPM is the internet edge behind ordinary firewall NAT. If Cloudflare orange-cloud
or another proxy precedes NPM, rate limits group visitors by that proxy's address,
potentially rejecting legitimate visitors. Use **DNS-only records** for this
topology, or separately validate an explicit trusted upstream chain first.

Standard mode uses ordinary NPM `X-Forwarded-For` appending instead. The gateway
trusts that header only from its configured TCP peer, selects the last appended
address with `real_ip_recursive off`, and discards the remaining external identity/
secret headers. This assumes the proxy's own client-IP configuration is correct;
an additional trusted CDN or NAT that hides client addresses needs separate review.

Both hops block staff `/api/service-assets`. QR exposes only GET `/api/asset` and
POST `/api/requests`; listing/mutation/item/operation APIs and unknown `/api` routes
are denied. QR pages/assets permit GET/HEAD. Private loopback APIs retain bearer
guards. Staff sessions, AD checks, CSRF/session-context checks and SQL budgets remain
mandatory. QR bodies are capped at 8 KiB; staff permits 17 MiB for the existing
16-MiB-plus-overhead recovery envelope, with smaller application-level ceilings.
Timeouts are bounded; caching and write retries are disabled.

Access logs are disabled for these hosts because NPM's default format records
query strings. Error logs can still contain request paths: protect them and avoid
debug/header/body logging. Redacted metrics/logging and alerts remain HOST-04.

## Prepare protected files

Create an operator-owned directory outside all Git worktrees/web roots, mode 0700,
and a settings file inside it, mode 0600. This synthetic example contains no secret:

```json
{
  "staffHostname": "tracker.example.test",
  "qrHostname": "qr.example.test",
  "vmAddress": "10.0.0.20",
  "gatewayPort": 8443,
  "staffPort": 5173,
  "qrPort": 5174,
  "vmCertificate": "/private/tls/fullchain.pem",
  "vmCertificateKey": "/private/tls/server.key",
  "npmTrustedCa": "/data/nginx/custom/assettracker-backend-ca.pem",
  "npmQrInclude": "/data/nginx/custom/assettracker-qr-upstream.conf"
}
```

Replace values with approved deployment settings. Optional `proxySourceAddress`
is one private IPv4 address. No public/all-interface bind or CIDR is accepted.
Optional `vmQrInclude` selects the final absolute gateway include path, allowing
staging outside system directories before copying files into their final location.
Otherwise the VM snippet references the generated output directory as before.
Ports must be distinct, 1024–65535. Paths must be absolute without whitespace,
variables or directive syntax. Unknown fields fail to catch typos. This first
preparer does not support IPv6; AAAA records need a separately validated path.

```bash
npm run ingress:prepare -- /private/ingress/settings.json /private/ingress/release-1
```

The parent must already exist with mode 0700. The output directory must be new;
reruns refuse replacement to prevent silent rotation of active secrets. Eight
mode-0600 files are created inside a mode-0700 directory:

| Output | Destination/use |
| --- | --- |
| `npm-staff.conf` | Staff NPM host's Advanced tab |
| `npm-qr.conf` | QR NPM host's Advanced tab |
| `npm-qr-upstream.conf` | Protected file at `npmQrInclude` inside NPM |
| `vm.conf` | Include in VM Nginx `http` context |
| `vm-qr-upstream.conf` | Its generated absolute include path on the VM |
| `staff-ingress.env` | Merge `LOGIN_PROXY_SECRET` into protected staff settings |
| `qr-ingress.env` | Merge `REQUEST_PROXY_SECRET` into protected QR settings |
| `browser-config.js` | Deployment artifact's `public/asset-tracker/config.js` |

Two independent 256-bit URL-safe secrets are generated and never printed. The
environment files are partial: merge them rather than replacing database/AD
settings. No operator database URL belongs in a web service. NPM Advanced config,
its database/backups and generated files contain secrets; protect them and never
paste them into a PR/chat. The generated browser config contains only the public
QR HTTPS destination. Certificate files/paths are not inspected during staging.

## Owner-selected standard NPM setup

Create two Proxy Hosts using scheme **https**, the private VM address and gateway
port **8443**. Select the existing wildcard certificate, enable **Force SSL** and
leave caching/Websockets Support off. Use no Custom Locations and leave the
Advanced tab empty. Save normally; no snippets or additional files are required.
The VM gateway retains route/method limits, restricts the proxy source and supplies
the private app credentials and checked client IPs in its forwarding locations.
Point public DNS at the existing NPM entry point, then complete acceptance below.

NPM's normal upstream uses `proxy_ssl_verify off`: backend traffic remains
encrypted, but NPM does not authenticate the VM certificate/hostname. This is the
owner-approved deployment choice, separate from browser wildcard validation and
mandatory AD certificate validation. Earlier custom-header snippets are superseded
for this rollout. No NPM shell access or file transfer is required.

For native ingress preparation, add `"proxyMode": "standard"` and a validated
private `"proxySourceAddress"` to settings. The generated VM default TLS server
serves the backend certificate without requiring SNI, then rejects unknown HTTP
hosts. Generated `npm-*.conf` files contain comments only in this mode.

## Generated verified-backend alternative during approved deployment

1. Use the locally generated self-signed VM TLS certificate/key with SAN covering
   both approved names. Keep the key on the VM and mount only the public backend
   certificate at `npmTrustedCa` inside NPM for explicit trust. The existing
   wildcard stays selected for public SSL; this backend trust file is separate
   from NPM's SSL Certificates UI. The AD CA export is not a TLS
   server leaf/private key. Keep upstream chain/hostname verification enabled.
2. Install/supervise production VM Nginx and include `vm.conf` in `http`. Preserve
   the generated VM include path or regenerate against its intended final location.
   Give its master access to the protected includes/certificate/key. Keep production
   Node apps loopback-only with the corresponding ports and ingress settings.
   Run `nginx -t` before any approved reload.
3. Copy/mount the QR upstream include and CA bundle into NPM's protected persistent
   storage with the master's required read access. Confirm the installed NPM version
   supports Advanced `location /` replacement. Use **no Custom Locations**. Never
   edit auto-generated proxy-host files: NPM overwrites them on UI saves.
4. Create two Proxy Hosts, one per approved name: Scheme **https**, Forward Host
   the VM private address, Forward Port the gateway port (default 8443). Select
   the existing wildcard certificate, verify SAN/expiry/chain and enable **Force SSL**.
   Disable asset caching and Websockets Support. Paste each rendered host snippet
   into its Advanced tab. They own the full forwarding location because NPM's default
   location would discard server-level header additions. Confirm both hosts are
   online and the actual container's `nginx -t` passes without location conflicts.
5. Copy the public browser config into the approved staff release before its build.
   New labels/legacy redirects then target the QR HTTPS host. Preserve local
   development's localhost destination. Use private loopback app-to-app URLs and
   a separate freshly generated shared credential; never commit rendered secrets.
6. DNS A/CNAME records target the proxy's public entry point, not the VM private
   address. No public entry IP was supplied during preparation. Use DNS-only for
   this direct-edge policy and forward public HTTPS only to NPM. Activate DNS,
   proxy/services only within approved deployment scope.

Acceptance must verify public TLS/HTTP redirect, Secure cookies, AD sign-in/out,
rate-limit client identities and denial of private methods/paths. Scan a synthetic
new QR label on a phone and verify HTTPS GPS/submission. Never log passwords/tokens/
secrets. Recovery admins/directory policy, original data/old labels, supervised
reconciliation, off-server backups, monitoring and rollback remain deployment work.

## Developer checks and primary references

`npm test` includes four operator staging checks. `npm run test:ingress` requires
Nginx with HTTP real-IP/SSL modules and OpenSSL on PATH (or `NGINX_BINARY`). It runs
actual Nginx at both hops with synthetic certificates/echo origins on loopback,
testing forged headers under inherited real-IP rules, private route/method denial,
QR/staff body sizes, backend TLS failures, source filtering and empty access logs.
It needs no company AD, DB, production certificate or NPM access. CI runs it without
skips. A user-local test binary is not a supervised production ingress service.

References: [NPM custom configuration](https://nginxproxymanager.com/advanced-config/),
[NPM host generation](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/backend/internal/nginx.js),
[NPM real-IP defaults](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/docker/rootfs/etc/nginx/nginx.conf),
[Nginx proxy settings](https://nginx.org/en/docs/http/ngx_http_proxy_module.html),
[original peer variable](https://nginx.org/en/docs/http/ngx_http_realip_module.html)
and [access-log override](https://nginx.org/en/docs/http/ngx_http_log_module.html).
Current upstream source informed these snippets; the owner's installed version
and saved configuration still require operator verification.
