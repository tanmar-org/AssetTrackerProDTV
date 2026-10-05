# TanMar Receiver Service Request

Companion public QR form and request API, running with native Next.js/Node and
its own PostgreSQL database/runtime role. No Worker/D1 binding is required.

Configure private `.env.local` runtime settings from `.env.example`, and a separate
`.env.migrate` migration-owner connection. `ADMIN_SHARED_SECRET` must match the
staff tracker. Run `npm run install:ci`, `npm run db:migrate`, and `npm run dev`.
Build/test with `npm test`; run the built server with `npm start` (loopback port 5174).

See the [root README](../README.md), [development guide](../docs/DEVELOPMENT.md),
and [self-hosting setup](../docs/SELF-HOSTING.md) for complete configuration.

The form still collects requester contact, worksite, error code, and GPS, reads
receiver/account metadata from historical label parameters, and opens the current
manual test email draft. Private label metadata, authoritative asset lookup,
public-request abuse controls, and server email delivery remain tracked under
QR-01/SEC-05/MAIL-01. Printed labels and original live databases are not migrated
by this code change.
