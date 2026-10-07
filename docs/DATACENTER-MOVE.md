# Move between datacenters

Docker is the production packaging choice. A move needs four things: the reviewed
release/images, a complete paired database backup, protected configuration/trust,
and destination DNS/proxy/private AD reachability. Docker does not transfer the
firewall, wildcard certificate, directory, DNS records or backup vault automatically.
Use an approved maintenance window; this procedure is not zero-downtime failover.

1. Prepare the destination VM with reviewed Docker Engine/Compose. Preserve the
   existing NPM public entry point or arrange its separately reviewed move. Check
   private LDAPS DNS/routing/CA trust, destination storage/capacity, CPU architecture,
   backend TLS leaf/key/trust and host gateway binding. Keep destination apps offline.
2. Transfer the clean reviewed release and exact four image IDs. Run `docker image
   save` with the IDs in the private images manifest into a private archive. Transfer
   archive, manifest and configuration through an approved encrypted channel; then
   `docker image load` at the destination and compare every ID, platform and revision.
   Never publish private configuration with an image. Prefer verifying an independently
   retained transfer checksum; a checksum traveling beside an untrusted file alone
   does not establish authenticity. Keep images/release for rollback.
3. Generate a NEW destination configuration using `docker:prepare`: new private VM
   address/project/installation path and an `assettracker_restore_*` namespace, same
   public hostnames and verified image manifest. Preserve the reviewed directory ID
   so imported AD links remain usable, supply its protected reader credential/trust,
   and regenerate all application/database/hop secrets. Never reuse source PG volumes.
   Install the files with the root installer; start only `database`, then operator
   `seed` and `restore-empty`. The latter creates only fresh empty recovery databases
   with fresh roles; app/backup CONNECT remains denied. It never migrates before restore.
4. Stop source gateway, reconciliation, staff and QR services, leaving the source
   database running. Confirm no outside integrations/operators keep writing. Run
   source operator `backup` for the final paired set. This closes the source writer
   window across both logical database snapshots. Keep source writers stopped.
5. Export ONLY that completed directory from `/operator/backups`, for example with
   a one-off operator entrypoint `tar -C /operator/backups -cf - BACKUP_BASENAME` and
   redirect binary output to a private host file (`umask 077`). Transfer encrypted.
   On destination use a one-off operator to create `/operator/incoming` mode 0700 and
   extract the trusted directory there. A temporary read-only bind of the private
   archive supports import (`run --volume /private/move.tar:/transfer.tar:ro
   --entrypoint tar operator -C /operator/incoming -xf /transfer.tar`). Extraction is
   for the trusted self-generated bundle only; never extract arbitrary untrusted tar
   files into operator storage. Confirm UID 999/private modes; do not loosen access.
6. Run destination `operator restore BACKUP_BASENAME`. Existing recovery guards
   validate BOTH targets, checksums, migrations, schema, complete snapshot contents,
   PostgreSQL major, encoding/locale/collation, owner and runtime permissions. Restores
   never overwrite source/occupied DBs. Old sessions are revoked; unfinished QR
   operations remain paused (`restore_review`) for explicit admin approval. Account
   IDs/roles/AD links and owner-specific drafts are retained. After a verified pair,
   SELECT-only backup access is restored too. Ordinary failure means keep apps offline
   and privately review partial state; do not bypass guards or automatically retry.
7. Compare source/destination counts and representative leading-zero identifiers,
   requests/history/audit/stock/drafts and account links. Confirm old cookies fail,
   reviewed real AD login succeeds, and the destination can create a verified backup.
   Only then start destination staff/QR/reconciliation/gateway and update the NPM
   backend/private trust and matching new hop secrets. Keep only ONE writer pair.
   Complete external HTTPS, phone GPS/scan and owner acceptance before opening use.
8. Retain source stopped and its reviewed release/backup/config for a defined rollback
   window. Before any destination writes, rollback can redirect to the stopped source
   and explicitly start it. After destination writes, source is stale: stop the new
   writers, back up/reconcile the new records and plan recovery before redirecting.
   Never start both stacks and assume independent PostgreSQL copies synchronize.

Use the exact Compose project name, file and protected env file for every command,
as shown in [Docker deployment](DOCKER-DEPLOYMENT.md). Command names above are passed
through `docker compose run --rm --no-deps operator ...`. Image manifests contain
public build URLs/revisions and infrastructure metadata; keep them private with
operational artifacts. Backups contain confidential records and credential hashes.
A working local move drill is not evidence of encrypted off-server retention,
production AD reachability, actual datacenter failover or a completed rollout.
