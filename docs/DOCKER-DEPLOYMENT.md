# Docker deployment

Docker Compose is the owner's chosen production deployment, including PostgreSQL.
Native npm development and the existing private AD preview continue unchanged.
The older systemd instructions describe an alternative, not a prerequisite for
Compose. Installation of Docker tools does not deploy this application.

## Images and services

`deploy/docker/Dockerfile` builds four digest-pinned official base images into
immutable local images. The common app image runs staff (UID 10001), public QR
(10002), and reconciliation (10003) as separate containers with individual private
JSON files. Gateway Nginx runs as 10004. Database and the separate operator profile
run as PostgreSQL UID 999. All drop capabilities and enable no-new-privileges;
apps/gateway/operator use read-only roots. No container mounts Docker's API.

Staff alone has outbound networking for verified private LDAPS. QR, reconciliation
and staff communicate on an internal Compose network. PostgreSQL has no TCP
listener or network: services connect through a private shared Unix socket using
SCRAM passwords. Peer administrator access is confined to the operator UID/profile.
Only gateway HTTPS is published, on an explicit private VM address and high port;
web app and database ports are never published. Existing NPM remains the public
HTTPS entry point with the owner's wildcard certificate and separate authenticated
hop credentials. Backend TLS still needs its own matching leaf/key and NPM trust.

The PostgreSQL 18 parent `/var/lib/postgresql` is a project-scoped persistent volume;
its versioned PGDATA is `/var/lib/postgresql/18/docker`. Socket consumers disable
volume copy-up so an empty socket directory keeps PostgreSQL ownership on recreation.
Operator configuration and
backups persist separately. Ordinary `docker compose down` retains these volumes.
**Never use `down --volumes`, `docker volume prune` or global cleanup on production.**
Volumes preserve data across recreation; they are not off-server backups.

## Build a reviewed release

Use a clean checkout of the owner-merged revision and the pinned Node version.
Run Docker with an appropriately authorized daemon account; on this VM Docker
administration requires interactive sudo. Do not add a user to the docker group
just to avoid authentication: daemon access is equivalent to root access.

```bash
# Create a private output parent OUTSIDE every Git worktree.
install -d -m 700 /path/to/private-release
# Use a fresh output directory; supply the real PUBLIC QR origin at rollout.
npm run docker:build -- https://qr.example.com/ /path/to/private-release/images
# On this VM, use this alternative from your interactive terminal instead:
npm run docker:build -- --sudo https://qr.example.com/ /path/to/private-release/images
```

`--sudo` must precede the two inputs and elevates only fixed Docker commands.
Run npm as your ordinary account; sudo handles authentication in your terminal.
Git, Node and private release-file writes retain your account's permissions.
No password enters the helper, command arguments or saved configuration. The
helper checks daemon access before creating the output directory. Do not run both
alternatives against the same output: release output is deliberately never replaced.

The helper refuses a dirty checkout and builds both apps from unchanged lockfiles,
prunes build dependencies, labels the revision, and records the four exact local
`sha256:` image IDs, public QR origin and platform in `images/images.json`.
Compose uses these IDs with `pull_policy: never`. The public destination is set
inside the builder only; the host checkout/preview is not rewritten. Runtime
credentials never enter build arguments. The build context excludes Git, tests,
dotenv, dependencies/builds, certificate/key files and private operator files.
Review new build inputs when changing `.dockerignore`.

Bases are pinned in the Dockerfile: Node 24.21.0 / Debian bookworm, PostgreSQL
18.6 / bookworm, and Nginx 1.30.5 / trixie. Updates require a reviewed rebuild and
validation; installing host Docker does not update an existing application image.
Copied image archives require the same Linux CPU architecture. Rebuilding for a
different architecture requires its own validation; amd64 is exercised in CI.

## Prepare files offline

Create a private 0600 settings JSON outside Git, under a private 0700 directory.
Every referenced input must also be an operator-owned private regular file and
canonical path outside Git. Passwords belong in the protected file, never shell
arguments, chat, Git, CI secrets or PR descriptions. Example schema (placeholders):

```json
{
  "imagesFile": "/private/release/images/images.json",
  "namespace": "assettracker_launch",
  "staffHostname": "tracker.example.com",
  "qrHostname": "qr.example.com",
  "vmAddress": "10.0.0.20",
  "gatewayPort": 8443,
  "installDirectory": "/etc/assettracker/launch",
  "directory": {
    "AD_DIRECTORY_ID": "reviewed-directory",
    "AD_LDAP_URL": "ldaps://dc.example.com:636",
    "AD_BASE_DN": "DC=example,DC=com",
    "AD_BIND_DN": "CN=Reader,OU=Service Accounts,DC=example,DC=com",
    "AD_BIND_PASSWORD": "PRIVATE READER PASSWORD"
  },
  "adCaFile": "/private/ad-ca.pem",
  "tlsCertificate": "/private/backend-fullchain.pem",
  "tlsKey": "/private/backend.key",
  "npmTrustedCa": "/data/private/backend-ca.pem"
}
```

Optional `proxySourceAddress` adds a private source-IP restriction; TLS and both
hop secrets remain mandatory without it. The leaf must be current, match the
private key, and cover both selected hostnames. NPM must independently verify its
issuer/hostname when forwarding HTTPS. The image public QR origin must match the
selected QR hostname. `vmAddress` must be private/loopback; wildcard publication is
refused. All generated paths are new and never overwritten.

```bash
npm run docker:prepare -- /private/settings.json /private/staged-launch
```

This creates fresh paired DB plans and six owner/runtime/backup credentials, private
app-to-app and ingress secrets, role-specific runtime JSON, copied TLS/AD trust,
NPM snippets and a protected `compose.env`. It makes no database or AD connection,
starts no service, and imports no records. Reader credentials go only to staff.
Initial inventory/import choice remains an owner decision.

## Approved installation and initialization

The following is an operator deployment procedure, **not an action performed by a
code-review PR**. First review protected settings, backend certificate trust,
private AD routing/DNS, actual VM port availability, launch data and recovery plan.
Ensure Node/npm dependencies exist in the reviewed tooling checkout for preparation.
The installer uses the host Node executable; container commands use image Node.

```bash
sudo install -d -m 700 /etc/assettracker
sudo "$(command -v node)" scripts/install-container-files.mjs /private/staged-launch
# Set a stable, unique project name and retain it across ordinary restarts.
# Run these commands from the clean reviewed checkout.
sudo docker compose -p assettracker_launch --env-file /etc/assettracker/launch/compose.env \
  -f deploy/docker/compose.yaml config --quiet
sudo docker compose -p assettracker_launch --env-file /etc/assettracker/launch/compose.env \
  -f deploy/docker/compose.yaml up -d --wait database
sudo docker compose -p assettracker_launch --env-file /etc/assettracker/launch/compose.env \
  -f deploy/docker/compose.yaml run --rm --no-deps operator seed
sudo docker compose -p assettracker_launch --env-file /etc/assettracker/launch/compose.env \
  -f deploy/docker/compose.yaml run --rm --no-deps operator initialize
```

Installer copies a fixed allowlist into a new root 0700 destination with individual
0400 files owned by each numeric service UID. File-backed Compose secrets retain
host permissions; YAML secret uid/gid settings cannot fix them. Never expose the
parent or make secrets world-readable. A partial installation is preserved for
private diagnosis, never automatically deleted/replaced. Keep the private stage
until installation is verified; secure its retention like credentials.

Operator `seed` copies configuration to a NEW private operator volume, refuses
existing content, and makes no DB connection. `initialize` reuses the reviewed
fresh-database guards: only absent paired names/roles, socket-only PG18, strict HBA,
NOLOGIN through migrations, explicit runtime DML and SELECT-only backup grants,
real wrong-password checks, then login verification. Failure preserves partial
state and contains created credentials; no automatic deletion/retry/adoption.

Provision the initial AD app administrator interactively with operator `admin`,
then operator `link-ad --user-id APP_ID --guid REVIEWED_GUID` using a reviewed
AD objectGUID. Those commands receive only owner DB access and the directory ID;
no PIN fallback or automatic username linking. Existing imports need their own
approved reconciliation procedure. See [staff authentication and AD rollout](STAFF-AUTHENTICATION.md).

Only after database/admin/data review, start `staff qr reconciler gateway` using
`up -d --wait`, install the matching NPM snippets/CA, and complete HTTPS/domain,
real AD login/logout, mobile QR/GPS, printed labels and reboot acceptance.
Certificate/DNS/proxy setup and production activation remain owner-approved work.

## Operations and limits

The host Docker daemon starts at boot; `unless-stopped` restarts enabled containers
on daemon recovery/process crashes. An explicitly stopped container remains stopped.
`docker compose up --wait` observes staff/QR/DB readiness; ordinary health failures
alone do not restart a running process. Worker supervision restarts process failure,
not a backlog. Gateway checks Nginx configuration at start. External HTTPS/AD/backlog
monitoring, alert delivery and real reboot tests remain rollout requirements.
Logs use Docker's local bounded rotation; application/gateway paths retain existing
redaction/query logging restrictions. Do not print protected JSON/env files.

Back up with `run --rm --no-deps -T operator backup`. It prints only the completed
backup directory basename; dumps/manifests persist under `/operator/backups` and
are verified by the existing paired read-only snapshot tool. Scheduling, retention,
encryption and off-server storage are separate required operations. The backup
catalog includes inventory/history/audit, accounts/AD links, sessions, recovery
copies, login counters, QR records/counters and durable operation receipts/intents.

Use [the datacenter move procedure](DATACENTER-MOVE.md), not a live PGDATA copy.
Follow [database recovery](DATABASE-BACKUPS.md) for fail-closed recovery limitations.
CI builds/runs two actual independent synthetic stacks, exercises TLS/AD/QR,
crash restart, volume retention and paired restore. No production secrets, images
published to a registry or VM stack are part of those tests.
