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
Node tests. The tracker suite also checks deactivation drafts and the built public
JavaScript for the removed account-password field. After a successful unchanged
build, run the tracker tests with `node --experimental-strip-types --test tests/*.test.mjs`; the QR smoke test
can be run separately with `node --test tests/rendered-html.test.mjs`.

Additional checks as appropriate:

```bash
npm run lint
npx tsc --noEmit --incremental false
```

The inherited smoke tests verify a root redirect and service-page metadata. The
tracker's SEC-01 tests additionally cover credential-field removal and retained
receiver details. SEC-02 covers rejected HTTP setup, local provisioning, concurrent
initial creation, and normal login/session behavior. Broader security/data behavior
still needs QA-01 coverage. The suite uses Node's SQLite module with synthetic data;
CLI/test commands enable TypeScript stripping for the existing PIN helper on Node 22.13+.
Record exact results, including existing failures.
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

## Initial administrator provisioning

Public `/api/auth` only accepts login; `action: "setup"` returns 403 even against
an empty database. GET reports `needsProvisioning` so the UI asks users to contact
their administrator instead of offering public administrator creation.

An operator with shell access provisions the first account after applying tracker
migrations. Stop the local app while performing maintenance and use the same
local persistence directory as the dev server:

```bash
npx wrangler d1 migrations apply DB --local --config wrangler.local.json --persist-to .wrangler/state
npm run admin:provision
```

The command prompts for username, PIN, and PIN confirmation. PIN input is hidden;
never pass it on the command line, in environment variables, or in chat. The shared
PIN helper creates a salted PBKDF2 hash. Wrangler reads a mode-0600 temporary SQL
file inside a private temporary directory, which is removed after the operation.
Wrangler logs/error details are withheld so hashes do not reach routine output.

One conditional SQL INSERT creates an administrator only when **no users exist**.
Concurrent attempts cannot create multiple initial accounts. A following ID lookup
reports whether this attempt succeeded; it does not authorize creation. Existing
users, including inactive/regular users, cause refusal without changing any account.
Later account management uses the authenticated administrator UI/API. Loss of all
active administrators requires explicit operator recovery, not public bootstrap.

For an isolated test directory:

```bash
npm run admin:provision -- --persist-to /absolute/local/test-directory
```

Apply migrations to that directory first. This tool always passes `--local` and
does not support remote D1 provisioning. The selected VM production database needs
a trusted operator provisioning adapter during HOST-02; do not re-enable HTTP setup
to work around an unprovisioned deployment. No live accounts are created by development tests.

## Finishing a task

1. Verify changes and run checks appropriate to their risk and scope.
2. Update the journal and TODO status; include decisions, unresolved items, validation,
   and the next step. Update other relevant documentation when behavior changes.
3. Review `git diff --check` and ensure no secrets, data, caches, or unrelated changes
   are staged. Commit on the task's `Dev/` branch.
4. Push the branch and open/update a PR targeting `main`. Explain the final change,
   test results, and any limits. Add the PR reference to the journal.
5. Leave final review and merging to the owner.
