import { prepareContainers } from "./container-preparation.mjs";
// Preparation creates private files only, never installs/starts a deployment.
try {
  if (process.argv.length !== 4) throw new Error();
  const result = await prepareContainers(process.argv[2], process.argv[3]);
  console.log(`Container files prepared (${result.mode}); installation and database activation are separate operator actions.`);
} catch { console.error("Container preparation failed; check protected settings and the Docker runbook privately."); process.exitCode = 1; }
