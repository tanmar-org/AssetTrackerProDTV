import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("../", import.meta.url));
const templates = new URL("../deploy/nginx/", import.meta.url);
function invalid() { throw new Error("Invalid ingress settings; see docs/HTTPS-INGRESS.md."); }
function hostname(value) {
  if (typeof value !== "string" || value.length > 253 || !value.includes(".") ||
      !value.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid();
  return value;
}
function filePath(value) {
  // Nginx config is code: reject whitespace, quotes, semicolons and variables,
  // rather than attempting ad-hoc shell/Nginx escaping of operator settings.
  if (typeof value !== "string" || !/^\/[A-Za-z0-9_./-]+$/.test(value) || value.includes("..")) invalid();
  return value;
}
function port(value) {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) invalid();
  return String(value);
}
function privateAddress(value) {
  if (isIP(value) !== 4) invalid();
  const [a, b] = value.split(".").map(Number);
  if (!(a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) invalid();
  return value;
}

export async function renderIngress(settings, outputDirectory) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) invalid();
  const allowed = new Set(["staffHostname", "qrHostname", "vmAddress", "gatewayPort", "staffPort", "qrPort",
    "vmCertificate", "vmCertificateKey", "npmTrustedCa", "npmQrInclude", "proxySourceAddress"]);
  if (Object.keys(settings).some(key => !allowed.has(key))) invalid();
  if (Object.hasOwn(settings, "proxySourceAddress")) privateAddress(settings.proxySourceAddress);
  const staff = hostname(settings.staffHostname), qr = hostname(settings.qrHostname);
  if (staff === qr) invalid();
  const staffPort = settings.staffPort ?? 5173, qrPort = settings.qrPort ?? 5174;
  const gatewayPort = settings.gatewayPort ?? 8443;
  if (new Set([staffPort, qrPort, gatewayPort]).size !== 3) invalid();
  const loginSecret = randomBytes(32).toString("base64url");
  const requestSecret = randomBytes(32).toString("base64url");
  const values = {
    STAFF_HOST: staff, QR_HOST: qr, VM_LISTEN: privateAddress(settings.vmAddress),
    VM_PORT: port(gatewayPort), STAFF_PORT: port(staffPort), QR_PORT: port(qrPort),
    VM_CERT: filePath(settings.vmCertificate), VM_KEY: filePath(settings.vmCertificateKey),
    NPM_CA: filePath(settings.npmTrustedCa),
    NPM_QR_UPSTREAM: filePath(settings.npmQrInclude ?? "/data/nginx/custom/assettracker-qr-upstream.conf"),
    VM_QR_UPSTREAM: filePath(path.join(outputDirectory, "vm-qr-upstream.conf")),
    SOURCE_RESTRICTION: settings.proxySourceAddress ? `if ($realip_remote_addr != "${privateAddress(settings.proxySourceAddress)}") { return 403; }` :
      "# No source-IP allowlist supplied. Every route still requires the ingress secret over verified TLS.",
    LOGIN_SECRET: loginSecret, REQUEST_SECRET: requestSecret,
  };
  const files = {};
  for (const name of ["npm-staff", "npm-qr", "npm-qr-upstream", "vm", "vm-qr-upstream"]) {
    const source = await readFile(new URL(`${name}.conf.template`, templates), "utf8");
    files[`${name}.conf`] = source.replace(/@@([A-Z_]+)@@/g, (_, key) => {
      if (!(key in values)) invalid();
      return values[key];
    });
  }
  // Merge these settings into the appropriate protected runtime environment;
  // these files deliberately contain no AD, database or app-to-app credential.
  files["staff-ingress.env"] = `LOGIN_PROXY_SECRET=${loginSecret}\n`;
  files["qr-ingress.env"] = `REQUEST_PROXY_SECRET=${requestSecret}\n`;
  files["browser-config.js"] = `// Public label destination; generated for this deployment only.\nwindow.TANMAR_CONFIG = ${JSON.stringify({ serviceRequestUrl: `https://${qr}/` })};\n`;
  return files;
}

function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function prepareIngress(settingsPath, outputPath) {
  const input = path.resolve(settingsPath), output = path.resolve(outputPath);
  const info = await lstat(input);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid())
    throw new Error("Settings must be an operator-owned regular file with mode 0600.");
  const inputReal = await realpath(input), parent = await realpath(path.dirname(output));
  const repositoryReal = await realpath(repository);
  if (within(repositoryReal, inputReal) || within(repositoryReal, parent))
    throw new Error("Keep settings and generated secrets outside the repository and web roots.");
  // Also reject a different Git checkout/worktree, not just this script's repo.
  for (const start of [path.dirname(inputReal), parent]) {
    for (let directory = start; ; directory = path.dirname(directory)) {
      const git = await lstat(path.join(directory, ".git")).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      // Some VM tooling reserves empty read-only .git directories at writable
      // roots. A Git directory requires HEAD; a worktree pointer is a file.
      const head = git?.isDirectory() ? await lstat(path.join(directory, ".git", "HEAD")).catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      }) : null;
      if (git?.isFile() || head) throw new Error("Keep ingress settings and secrets outside all Git worktrees.");
      if (directory === path.dirname(directory)) break;
    }
  }
  const parentInfo = await lstat(parent);
  if (parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o077) !== 0)
    throw new Error("Output parent must be operator-owned with mode 0700.");
  if (parent !== path.dirname(output))
    throw new Error("Output parent must be a canonical path, without symlinks.");
  const settings = JSON.parse(await readFile(inputReal, "utf8"));
  const files = await renderIngress(settings, output);
  // Refuse replacement, including symlinks. Each run generates fresh secrets;
  // overwriting active config could silently break the matching app environment.
  await mkdir(output, { mode: 0o700 });
  try {
    for (const [name, content] of Object.entries(files))
      await writeFile(path.join(output, name), content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  return { files: Object.keys(files).length, sourceRestricted: Boolean(settings.proxySourceAddress) };
}
