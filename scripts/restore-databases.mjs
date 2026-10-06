import { BackupError, configuration, restoreDatabases, operatorCancellation } from "./postgresql-backups.mjs";

// Restores only to separately provisioned, empty assettracker_restore_* databases.
// A successful drill does not deploy applications or perform a production cutover.
const cancellation = operatorCancellation();
try {
  if(process.argv.length !== 2 || !process.env.BACKUP_SET_DIRECTORY) throw new BackupError("Configure BACKUP_SET_DIRECTORY; this command accepts no arguments.");
  const config = await configuration(process.env,"restore");config.signal = cancellation.signal;
  await restoreDatabases(config,process.env.BACKUP_SET_DIRECTORY);
  console.log("Both database restores verified; old sessions revoked and restricted runtime grants applied. Keep applications offline until approved cutover.");
} catch(error) {
  console.error(error instanceof BackupError ? error.message : "Restore failed. Keep destinations offline and inspect private operator configuration; no production cutover was performed.");
  process.exitCode = 1;
} finally {cancellation.close();}
