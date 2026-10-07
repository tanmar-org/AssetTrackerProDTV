import { writeFile } from "node:fs/promises";

// Build-time public destination only. Never rewrite the active VM checkout or
// accept credentials/query parameters that could end up on printed QR labels.
try {
  if (process.argv.length !== 3) throw new Error("Invalid arguments.");
  const url = new URL(process.argv[2]);
  if (url.protocol !== "https:" || !url.hostname.includes(".") || url.username || url.password ||
      url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid public URL.");
  await writeFile(new URL("../public/asset-tracker/config.js", import.meta.url),
    `// Public deployment destination; contains no runtime credentials.\nwindow.TANMAR_CONFIG = ${JSON.stringify({ serviceRequestUrl: url.href })};\n`);
} catch { console.error("Container build requires a public QR HTTPS origin."); process.exitCode = 1; }
