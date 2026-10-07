# Production service preparation

Production now uses [Docker Compose](DOCKER-DEPLOYMENT.md), as selected by the owner
for datacenter portability. Native setup below remains an alternative/development
reference. Compose uses its own private service network and Unix-socket PostgreSQL;
follow its runbook for activation and [datacenter moves](DATACENTER-MOVE.md).


These files make startup/restart, private credentials and readiness checks
reviewable. They install/enable nothing. The working AD preview uses different
loopback ports/databases and remains separate. Owner-approved deployment, TLS,
actual NPM/DNS configuration, data decisions and recovery acceptance remain required.

## What runs

| Unit | Purpose and access |
| --- | --- |
| `assettracker-staff.service` | Staff Next server; tracker runtime role, AD reader/CA, staff ingress secret |
| `assettracker-qr.service` | QR Next server; separate QR runtime role/ingress secret; no AD password |
| `assettracker-reconciler.service` | Existing `--watch` coordinator; tracker runtime role and private QR bearer only |
| `assettracker-gateway.service` | Private TLS Nginx gateway on the approved VM address/8443; dedicated non-root UID |
| `assettracker-readiness.timer` + `.service` | Both loopback readiness endpoints once a minute; no credential or database mutation |

The three Node services use distinct non-login OS accounts. systemd copies each
protected JSON file into that service's credential directory. The launcher passes
only the allowed settings to its child, fixes Node environment/loopback listeners,
and never forwards manager/operator settings. Staff alone receives the AD CA/reader.
JSON preserves password spaces/quotes/backslashes without shell/dotenv interpolation.
No service receives a migration-owner URL or runs a migration.

Before launching, the supervisor rejects a different Node version than `.nvmrc`,
dotenv files in the release, unsafe/extra settings, exposed/symlinked credentials,
public app-to-app URLs, PIN fallback and app-to-app/ingress secret reuse. Read-only
PostgreSQL catalog checks reject elevated role flags/memberships, database/table
ownership, persistent CREATE rights or any migration-table grant. Membership is
checked even without inheritance because SET ROLE could otherwise elevate access.
This checks the connected role; it does not establish server-side SCRAM/TLS or
replace the operator's grants/other-database isolation review.

Services restart after crashes/startup failures with a five-second pause, including
prolonged dependency outages. Explicit stop does not restart them. The supervisor
forwards TERM/INT to its child; `KillMode=mixed` supplies a forced-stop deadline
only if graceful shutdown stalls. Worker stop permits an in-flight bounded attempt
to finish rather than interrupting a committed QR receipt's tracker completion.
Type `exec` indicates process execution, not readiness or live AD availability.

Filesystem protection makes releases read-only except each app's own `.next/cache`.
Separate UIDs, empty capabilities, private temporary directories, hidden home
directories and limited process/address-family access restrict cross-service access.
V8 JIT memory stays enabled. Initial caps are 1 GiB per web app, 512 MiB for the
worker and 256 MiB for the gateway; production sizing/load acceptance is still needed.

## Files and credentials

The supplied units use this fixed layout; change reviewed copies consistently if
the approved paths/ports differ. No actual infrastructure values belong in Git.

```text
/opt/assettracker/node/bin/node             pinned, root-owned Node executable
/opt/assettracker/releases/<revision>/     built, root-owned complete release
/opt/assettracker/current                  operator-controlled release symlink
/etc/assettracker/                         root:root 0711 (traversal only for runtime users)
/etc/assettracker/staff-runtime.json        root:root 0600
/etc/assettracker/qr-runtime.json           root:root 0600
/etc/assettracker/reconciler-runtime.json   root:root 0600
/etc/assettracker/ad-ca.pem                 root:root 0600
/etc/assettracker/gateway/                  root:assettracker-gateway 0750
```

Create the runtime JSON files privately using a JSON serializer or protected editor.
Never hand-escape/paste a real password into a shell command, chat, journal or PR.
The launcher requires exactly these nonempty string fields:

| Credential file | Fields |
| --- | --- |
| Staff | `DATABASE_URL`, `ADMIN_SHARED_SECRET`, `SERVICE_REQUEST_API_URL`, `LOGIN_PROXY_SECRET`, `AUTH_MODE`, `AD_DIRECTORY_ID`, `AD_LDAP_URL`, `AD_BASE_DN`, `AD_BIND_DN`, `AD_BIND_PASSWORD` |
| QR | `DATABASE_URL`, `ADMIN_SHARED_SECRET`, `TRACKER_ASSET_API_URL`, `REQUEST_PROXY_SECRET` |
| Reconciler | `DATABASE_URL`, `ADMIN_SHARED_SECRET`, `SERVICE_REQUEST_API_URL` |

Staff `AUTH_MODE` must be `ad`. `AD_CA_FILE` is injected from systemd's private CA
credential, not supplied in JSON. Use the approved reader/settings; do not read
them from web-release files. The reconciler uses the tracker runtime connection,
not its owner connection or the QR database. DATABASE_URL requires a username and
password, even if a disposable test cluster ignores that password. Use password
authentication on production PostgreSQL and a local protected `/run/postgresql`
socket or approved loopback path. Preview/test sockets under `/tmp` are hidden by
`PrivateTmp`; never repurpose the preview as a production database.

`ADMIN_SHARED_SECRET` must match between these services and differ from each
ingress secret; require 32–128 URL-safe characters. Merge the generated staff/QR
ingress values from [HTTPS preparation](HTTPS-INGRESS.md). Default internal URLs:

```text
SERVICE_REQUEST_API_URL=http://127.0.0.1:5174/api/requests
TRACKER_ASSET_API_URL=http://127.0.0.1:5173/api/service-assets
```

The unit `ASSETTRACKER_STAFF_PORT`/`ASSETTRACKER_QR_PORT` settings must agree across
Node/readiness units, both JSON internal URLs and the prepared ingress config.
Only loopback HTTP/exact API paths are accepted. TLS terminates at the private
gateway; internal HTTP never leaves this VM. Protect source JSON files/parents
from runtime users; systemd's credential copy supplies only the selected file.

## Approved installation sequence

Do this only after a release/deployment is approved and required data/recovery
decisions are complete. This runbook does not authorize a production cutover.

1. Prepare supervised production PostgreSQL separately. Use restricted runtime
   roles and distinct databases from [self-hosting](SELF-HOSTING.md). The guarded
   [fresh database command](PRODUCTION-DATABASES.md) stages private credentials and
   initializes only new paired targets after approval. Apply each
   migration with operator credentials, provision/link reviewed identities and
   validate recovery administrators. Confirm empty-versus-existing-data handling;
   importing old inventory is not implicit in a fresh preview or service install.
   PostgreSQL must return after reboot; `After=postgresql.service` is ordering,
   not provisioning a cluster or proving its availability.
2. Install the pinned Node release and distribution Nginx binary under root-owned
   system paths. Keep Node out of an interactive user's home because services use
   `ProtectHome`. A user-local test Nginx/Node wrapper is not the production install.
   Prevent the distribution's default public Nginx service from claiming ports or
   overlapping this dedicated private gateway when installing its package.
3. Build a clean, reviewed release with both lockfiles and no real `.env*` files.
   Before its staff build, apply the generated public QR destination to the
   deployment artifact. Keep the full repository/dependency/build layout; do not
   run `npm ci`/build inside an active release. Verify builds/types/lint/tests first.
4. Install `deploy/systemd/assettracker.sysusers.conf` under `/etc/sysusers.d/`
   and run systemd-sysusers on that file during approved installation. Release
   source/node_modules/builds remain root-owned and readable to the service UIDs;
   `.next/cache` directories alone belong to their respective staff/QR accounts.
   Keep cache paths consistent with `ReadWritePaths`; neither app may edit code,
   the other app's cache, runtime settings or release-selection symlink.
5. Write the three protected runtime JSON files and staff CA at the paths above.
   Keep parents root-owned/nonwritable; 0711 on `/etc/assettracker` permits gateway
   traversal while JSON/CA source files remain root-only readable. Do not store owner connections there or
   share a credential file across services. LoadCredential copies them at startup;
   applying a credential change requires a coordinated restart.
6. Prepare private ingress in its final location using [HTTPS ingress](HTTPS-INGRESS.md).
   Stage outside system directories in an operator-owned mode-0700 parent, with
   `vmQrInclude=/etc/assettracker/gateway/vm-qr-upstream.conf` and certificate/key
   paths in that same final gateway directory. Afterwards install only `vm.conf`, its QR include, `gateway-main.conf` as
   `main.conf`, and the backend TLS leaf/key into the gateway directory. Those
   files must be root-owned, group `assettracker-gateway`, mode 0640, with directory
   0750. Render the VM include/certificate paths for that final directory. NPM
   files/partial env outputs stay operator-only elsewhere. Gateway read access
   does not grant it staff/QR JSON or AD credentials.
7. Copy the six service/timer units into `/etc/systemd/system/`. Verify them with
   `systemd-analyze verify`; run the gateway's `nginx -t` as its dedicated UID
   with access to its intended runtime/state directories. Install/enable the
   four long-running units and readiness timer only during the approved activation.
   No existing public/default Nginx service should own this gateway's private port.
8. Confirm restricted role preflight, loopback-only Node listeners, both 200
   readiness responses and clean worker counts before NPM/DNS activation. Verify
   public TLS, authenticated ingress, AD sign-in/out, private-path denial and a
   synthetic phone QR/GPS submission. Complete startup/reboot/crash acceptance
   with these actual UIDs, filesystem protection and production dependencies.

The readiness timer reports status locally in systemd/journal. It checks database/
configuration readiness, not live AD, certificates, QR lookup availability or
worker backlog. It never follows redirects, echoes response bodies, grants access
or restarts apps merely because dependencies are unavailable. Route failed checks,
service crash loops, old unfinished operations, backup failures and disk pressure
to an approved alert destination; none is configured by this PR. Protect journal
access/retention and inspect operational details privately.

## Release change and rollback

Build releases separately and verify them before changing the root-owned `current`
symlink. Stop the reconciler first, finish bounded work, then stop gateway/apps;
switch the release and compatible protected configuration, recheck syntax/runtime
grants, start QR/staff, verify readiness, then start reconciler/gateway and test
authenticated ingress. Browser tabs need the matching UI/server version. A release
switch is not a database rollback: review migration compatibility first. Paired
backup recovery remains [the separate restoration runbook](DATABASE-BACKUPS.md)
with fresh targets/paused unfinished intents. Never automatically overwrite data
or resume restored work to make a service appear healthy.

Developer checks: default tests cover credential/settings/release/readiness
boundaries; `test:integration` uses real restricted synthetic PostgreSQL roles,
built Next apps and the actual worker to verify startup rejection and graceful
shutdown. `npm run test:services` uses systemd-analyze on every supplied unit/timer,
without installing them; missing systemd/Nginx tools fail instead of skipping.
CI runs this after its test-only Nginx installation. A separate VM smoke used a
unique transient user-systemd unit to verify credential delivery, crash restart
and stop; it is not proof of installed system units or a production reboot.

Primary references: [systemd execution/credentials](https://github.com/systemd/systemd/blob/v259/man/systemd.exec.xml),
[restart and shutdown](https://github.com/systemd/systemd/blob/v259/man/systemd.service.xml)
and [Next production CLI](https://nextjs.org/docs/app/api-reference/cli/next).
