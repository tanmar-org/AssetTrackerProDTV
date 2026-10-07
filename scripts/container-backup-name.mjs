// Accept exactly the paired backup producer's UTC timestamp + UUID directory.
// Milliseconds contain a dot; accepting arbitrary dots would permit traversal.
export function isContainerBackupName(value) {
  return typeof value === "string" && /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
}
