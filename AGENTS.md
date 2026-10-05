# Instructions for agents and contributors

## Start here

Read this file, [the project journal](<project journal.md>), [TODO.md](TODO.md),
and [the development guide](docs/DEVELOPMENT.md) before changing code. Consult
[the IT handoff](docs/IT-HANDOFF.md) for the exported application's architecture.
The journal records current evidence; older handoff statements may be stale.

## Branches, pull requests, and ownership

- Make every repository change on a branch beginning with **`Dev/`**, for example
  `Dev/fix-request-validation`. Branch from the current `origin/main`; inspect the
  working tree first and preserve unrelated work.
- Agents are authorized to commit, push their `Dev/` branches, and create or update
  pull requests targeting `main` as part of an assigned task.
- **The project owner performs final review and merging.** Do not merge a PR,
  enable automatic merging, push directly to `main`, or bypass branch protections.
- Keep each PR focused and reviewable. Describe the resulting behavior, relevant
  risks, validation performed, and checks that could not be completed.
- Do not deploy to production or modify live databases as part of a development
  task unless the owner explicitly authorizes that action.

## Comments and human review

- All new or changed code must have appropriate comments that help human review.
  Explain intent, assumptions, trust boundaries, persistence semantics, and
  non-obvious tradeoffs. Avoid comments that merely repeat the next statement.
- As existing code is examined for a task, add missing comments around meaningful
  behavior. Prefer a focused section or function comment to comments on every line.
- Keep comments accurate when changing behavior. Label known limitations as
  limitations; do not describe client-side checks as server-enforced security.
- Comment-only work must preserve executable code. Verify the diff and use
  appropriate syntax/build checks without mixing in unrelated fixes.

## Application map and constraints

- Root application: static staff UI in `public/asset-tracker/`, server APIs in
  `app/api/`, PIN/session helpers in `lib/pin-auth.ts`.
- Public QR application: `service-request/`, especially `app/page.tsx` and
  `app/api/requests/route.ts`.
- Both applications currently build as Vinext/Cloudflare Workers and require
  separate D1 `DB` bindings. Ordinary Node hosting is a planned migration, not a
  completed capability. Several routes call the D1 API directly; changing only
  `db/index.ts` is insufficient.
- The tracker stores most operational collections as one JSON state payload.
  The QR application stores service requests in a separate database.
- Current QR links and mail drafts carry receiver/account metadata. Automatic
  server email and a Monday reporting job are not implemented.
- An account-password value was removed from a public template under SEC-01.
  Never reintroduce credentials in browser code or email drafts, or copy historical
  values into documentation, logs, tests, issues, or PR bodies. Removal does not
  erase Git history or rotate a live credential; track owner rotation under SEC-01.
- Repository privacy is intended by the owner, but GitHub reported public
  visibility on 2026-10-05. Treat VIS-01 as an owner action; do not silently change
  repository visibility or permissions.

## Documentation is part of the task

- Update `TODO.md` and `project journal.md` with each substantive task. Record
  decisions, files/areas changed, tests and exact outcomes, remaining blockers,
  branch/PR references, and the next useful action.
- Keep setup, architecture, configuration, and operational instructions current
  when their behavior changes. Historical handoff/validation records are evidence,
  not proof that a new change passed.
- Use stable TODO IDs when reporting progress. Mark an item done only when its
  completion criteria are met; distinguish proposed decisions from approved ones.
- Use dated journal entries with the owner's America/Chicago time context.

## Verification and secrets

- See `docs/DEVELOPMENT.md` for installation and validation commands. Run checks
  appropriate to the change; record pre-existing failures rather than hiding them.
- Never use production data for tests. Keep `.dev.vars`, credentials, database
  files, exports, backups, `node_modules`, and build artifacts out of Git.
- Use isolated test databases and freshly generated local secrets when needed.
  Do not fetch, migrate, overwrite, or delete live data without explicit scope.
- Dependency advisory matches identify affected versions, not proven exploitability
  of every advisory in this application. Review runtime reachability and update
  related packages together. Do not automatically run `npm audit fix --force`.
- Preserve lockfiles for installs. Keep dependency remediation in focused tasks;
  do not mix package upgrades into unrelated fixes or documentation/comment work.
- Add meaningful regression tests when fixing permissions, persistence,
  concurrency, or other consequential behavior. Documentation-only edits do not
  require tests that restate their contents.
