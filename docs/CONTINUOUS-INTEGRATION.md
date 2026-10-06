# Automated repository validation

The [Repository validation workflow](../.github/workflows/validation.yml) reports
the **Validate applications** check for every PR targeting `main` and every push
to `main`. Manual `workflow_dispatch` is also available after the workflow reaches
the default branch. No path or draft filters skip documentation changes. New
commits cancel older runs for the same PR/ref; review the latest commit's result.

## What the check proves

The job runs on disposable GitHub-hosted **Ubuntu 24.04**, using the exact Node
version in `.nvmrc`, with a 30-minute limit. It:

1. Validates workflow syntax with checksum-verified actionlint 1.7.12.
2. Installs both applications with their existing lockfiles (`install:ci`),
   without npm advisory submissions or dependency/lockfile updates.
3. Runs both zero-warning lint gates, including the local vendor-byte/license/SRI
   check before root lint excludes its three exact upstream scripts.
4. Runs `npm test` separately for staff and QR: production webpack builds and
   default synthetic/HTTP regressions. Both dependencies are installed first.
5. Checks both TypeScript scopes after the builds finish replacing `.next/types`.
6. Installs test-only Nginx/OpenSSL with package-service startup blocked, then runs
   the actual loopback HTTPS ingress suite with synthetic certificates/echo origins.
   No live proxy or company infrastructure is used.
7. Runs the complete `test:integration` suite against actual PostgreSQL with
   restricted fixture roles, including permission/concurrency/migration tests,
   durable QR recovery and real paired `pg_dump`/`pg_restore` drills.
8. Checks for leftover generated fixture databases/roles, including after an
   integration failure. GitHub destroys the whole test service when the job ends.
9. Installs test-only Playwright 1.58.2/Chromium outside the application trees and
   runs the complete existing `test:browser` suite with synthetic APIs/GPS and
   outside application requests blocked.
10. Checks diffs and that tracked/unignored repository files stayed unchanged.

Builds finish before either SQL or browser tests serve `.next/`. A failed step
fails the check; there is no `continue-on-error`, automatic merge or deployment.
Console logs provide test outcomes and the failed step. There is no upload of
database dumps, credentials, operational data or build artifacts.

## Test service and credentials

The official PostgreSQL **18.6** service is pinned to manifest
`sha256:fc973eb97c9fd04bfa1840e0f510719a584ccb3be8debfe6a4144637a9dfe8cf`,
verified from Docker Hub on 2026-10-06. It exposes only
`127.0.0.1:55432` on the ephemeral runner. The dedicated database is
`assettracker_test_admin`; the test administrator is `assettracker_ci_admin`.
Service-only trust authentication supports the existing passwordless fixture
roles. This is a disposable test arrangement, not a production authentication
configuration. No production URL, records, migration target or backup destination
is used. Integration helpers retain their local-host/dedicated-database guard.

Matching PostgreSQL client 18 tools are installed on that runner using PGDG's
signed Ubuntu package repository. This keeps real backup/restore clients aligned
with server major 18. No server package/service is installed on the hosting VM.
The apt packages follow the signed repository's current major-18 updates; the
runner image and those packages are not byte-for-byte reproduction of this VM.

The workflow grants only `contents: read`, opts out of persisted checkout
credentials and uses neither repository secrets nor a self-hosted runner. Actions
are pinned to verified commits from their official repositories:

| Tool | Reviewed pin |
| --- | --- |
| actions/checkout v6 | `d23441a48e516b6c34aea4fa41551a30e30af803` |
| actions/setup-node v6 | `249970729cb0ef3589644e2896645e5dc5ba9c38` |
| actionlint 1.7.12 Linux amd64 archive SHA-256 | `8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8` |

Review upstream releases/digests and rerun the complete workflow for intentional
pin changes. Playwright is test tooling only; updating it does not add a runtime
dependency or modify either app's lockfile. The VM's user-local actionlint binary
is at `~/.local/share/assettracker-tools/actionlint-1.7.12/actionlint`.

## Review, reruns and merge rules

Open the PR's Checks tab or the repository's Actions tab and inspect **Validate
applications**. Require a green result for the latest commit; pending, skipped,
canceled and failed runs are not passing evidence. For a transient download/runner
failure, inspect the logs before rerunning; do not remove assertions to get green.
Fork PRs may require a maintainer's workflow approval under GitHub's access policy.

The owner can configure `Validate applications` as a required status check in
the `main` branch rules after the initial successful run. This workflow does not
change repository permissions/rules, grant merge authority or enforce a required
check by itself. The owner still performs final review and merging. Organization
settings, hosted-runner availability and GitHub Actions usage limits can block CI;
the initial read-only check confirmed Actions enabled with all actions allowed.

Successful CI is development evidence. It does not establish production HTTPS,
company access/SSO, approved email delivery, supervised web/reconciler services,
off-server backups, real-data migration, actual phone GPS or printer/scanning
acceptance. Those remain the deployment checklist's owner/operator work.

Authoritative setup references: [GitHub service networking](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers),
[immutable action pins](https://docs.github.com/en/actions/reference/security/secure-use),
[official PostgreSQL Ubuntu packages](https://www.postgresql.org/download/linux/ubuntu/),
[Playwright CI setup](https://playwright.dev/docs/ci-intro) and
[actionlint release](https://github.com/rhysd/actionlint/releases/tag/v1.7.12).

Managed service checks also run in this workflow: default protected-credential/
readiness scenarios, actual restricted-PostgreSQL launcher and worker cases, and
`test:services` offline systemd unit/timer verification after installing test-only
Nginx. CI never installs/enables the supplied production units or uses company AD.
