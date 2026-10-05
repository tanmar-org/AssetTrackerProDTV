# TanMar Receiver Service Request

Companion QR service app, updated from published version 8.

This application needs its own D1 database and an `ADMIN_SHARED_SECRET` matching the tracker. Use `.dev.vars.example` locally. Apply its migrations separately.

See the [root README](../README.md) for setup and [IT handoff guide](../docs/IT-HANDOFF.md) for configuration, migration and hosting.

The public form displays only the asset number and collects requester contact, work site information, error code and GPS. During testing it saves the complete receiver/request details and opens the original full email draft to `TEST_RECIPIENT`, including serial, card, RID, account and rent status; the tester must tap Send. IT will replace this step with server-side lookup and email sending, preserving the full internal email while keeping account/status off the customer's device.
