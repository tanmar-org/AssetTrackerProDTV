# Development and review workflow

Read [AGENTS.md](../AGENTS.md), [the journal](<../project journal.md>), and
[TODO.md](../TODO.md) first. Every repository change belongs on a `Dev/` branch;
agents may push that branch and open a PR. The owner performs final review and merging.

## VM tools

Installed for `itadmin` on 2026-10-05:

- Node v24.21.0 LTS, with npm v11.19.0 and npx.
- GitHub CLI v2.102.0.
- Existing Git, Python 3, curl, tar/xz, flock, timeout, sha256sum, and GPG.

Node/GitHub CLI were downloaded from their official release endpoints, checked
against published SHA-256 checksums, and installed under
`~/.local/share/assettracker-tools/`. Executable links are in `~/.local/bin/`, which
is on this VM's PATH. No passwordless sudo is available; this setup did not install
system services, a database server, or a production reverse proxy.

Check tools with `node --version`, `npm --version`, `gh --version`, and
`git --version`. The repository's minimum Node version is 22.13; `.nvmrc` pins
the LTS version used for this baseline.

Git fetch/push uses the repository's dedicated SSH alias and deploy key. This
checkout's `core.sshCommand` uses the user's SSH configuration explicitly. Those
machine-local settings and keys are not repository files. GitHub CLI API operations
need separate authentication (`gh auth login`); an SSH deploy key does not authorize
PR creation through the API. Use an authorized GitHub integration or CLI account
for PR operations; never paste access tokens or passwords into chat.

## Install dependencies

Each application has its own lockfile and install environment. From the repository
root:

```bash
npm run install:ci
cd service-request
npm run install:ci
```

The reviewed helpers use isolated writable caches and bounded installs. They do
not upgrade dependency versions. Several locked packages have known advisories;
see DEP-01/DEP-02 before public deployment. Do not expose a development server
publicly or run `npm audit fix --force` as part of routine setup.

## Build and existing tests

Run in **each** application directory:

```bash
npm test
```

This builds, validates the exported Worker/Sites artifact, and runs the existing
Node tests. If a build already passed and no code changed, the existing test can
be run separately with `node --test tests/rendered-html.test.mjs`.

Additional checks as appropriate:

```bash
npm run lint
npx tsc --noEmit --incremental false
```

The inherited tests verify a root redirect and service-page metadata, not application
security or data correctness. Record exact results, including existing failures.
On 2026-10-05 both builds/tests passed; lint and TypeScript checks failed on inherited
issues. See [the baseline validation](reviews/2026-10-05-validation.md) and QA-02.
The build uses workerd/Miniflare; a restricted execution sandbox may prevent runtime
startup. Use the approved VM execution context when required and explain failures.

Browser scripts can be checked without running the UI:

```bash
node --check public/asset-tracker/app.js
node --check public/asset-tracker/service-request.js
```

Builds create ignored `dist/`, `.sites-runtime/`, and `.wrangler/` files. Check
`git status` afterward: committed font-cache files may also be touched. Keep generated
artifacts and local credentials out of PRs; preserve unrelated user changes.

## Local applications and data

The current applications still require local Cloudflare Worker/D1 emulation.
Follow the root README for isolated local database migrations and development
ports 5173 (tracker) and 5174 (QR service). A root `npm start` does not complete
the planned self-hosting migration.

Copy each `.dev.vars.example` only when local API testing needs it. Generate a new
random shared credential, configure the tracker to call the local QR endpoint,
and keep all credentials/database files ignored. Never copy production data or
sessions into a development environment. Public deployment must wait for the
security, runtime, configuration, migration, and acceptance items in TODO.md.

## Finishing a task

1. Verify changes and run checks appropriate to their risk and scope.
2. Update the journal and TODO status; include decisions, unresolved items, validation,
   and the next step. Update other relevant documentation when behavior changes.
3. Review `git diff --check` and ensure no secrets, data, caches, or unrelated changes
   are staged. Commit on the task's `Dev/` branch.
4. Push the branch and open/update a PR targeting `main`. Explain the final change,
   test results, and any limits. Add the PR reference to the journal.
5. Leave final review and merging to the owner.
