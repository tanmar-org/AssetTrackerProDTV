import path from "node:path";
import { BackupError, backupDatabases, configuration, operatorCancellation } from "./postgresql-backups.mjs";

// Operator-only CLI: no web endpoint, database URL arguments or secret output.
const cancellation = operatorCancellation();
try {
  if(process.argv.length !== 2 || !process.env.BACKUP_DIRECTORY) throw new BackupError("Configure BACKUP_DIRECTORY; this command accepts no arguments.");
  const config = await configuration();config.signal = cancellation.signal;
  const directory = await backupDatabases(config,process.env.BACKUP_DIRECTORY);
  console.log(`Both database backups published: ${path.basename(directory)}. A restore drill is still required.`);
} catch(error) {
  console.error(error instanceof BackupError ? error.message : "Backup failed. Check private operator paths, configuration and storage. Do not rely on this run as a complete backup.");
  process.exitCode = 1;
} finally {cancellation.close();}
