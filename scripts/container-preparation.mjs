import { randomBytes, X509Certificate, createPrivateKey, createPublicKey, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareDatabases, protectedOperatorPath } from "./database-provisioning.mjs";
import { managedEnvironment } from "./managed-runtime.mjs";
import { renderIngress } from "./ingress-preparation.mjs";

const fail = () => new Error("Container preparation failed; review protected settings and the Docker runbook.");
const safePath = value => typeof value === "string" && /^\/[A-Za-z0-9_./-]+$/.test(value) && !value.includes("..");
async function input(filename) { await protectedOperatorPath(filename); return readFile(filename, "utf8"); }
async function save(filename, content) { await writeFile(filename, content, { flag: "wx", mode: 0o600 }); }
export async function prepareContainers(settingsFile, output) {
  await protectedOperatorPath(settingsFile); await protectedOperatorPath(path.dirname(output), true);
  const settings = JSON.parse(await readFile(settingsFile, "utf8"));
  const required = ["imagesFile", "namespace", "staffHostname", "qrHostname", "vmAddress", "gatewayPort", "installDirectory", "directory", "adCaFile", "tlsCertificate", "tlsKey", "npmTrustedCa"];
  if (!settings || Array.isArray(settings) || required.some(key => !Object.hasOwn(settings, key)) ||
      Object.keys(settings).some(key => ![...required, "proxySourceAddress"].includes(key)) ||
      !safePath(settings.installDirectory) || !safePath(settings.npmTrustedCa)) throw fail();
  const pins = JSON.parse(await input(settings.imagesFile));
  const pinKeys = ["version", "revision", "publicQrUrl", "platform", "appImage", "postgresImage", "operatorImage", "gatewayImage"];
  if (Object.keys(pins).length !== pinKeys.length || pinKeys.some(key => !Object.hasOwn(pins, key)) || pins.version !== 1 ||
      !/^[a-f0-9]{40}$/.test(pins.revision) || !/^linux\/(amd64|arm64)$/.test(pins.platform) ||
      pins.publicQrUrl !== `https://${settings.qrHostname}/` ||
      ["app", "postgres", "operator", "gateway"].some(kind => !/^sha256:[a-f0-9]{64}$/.test(pins[`${kind}Image`]))) throw fail();
  const directory = settings.directory;
  const directoryKeys = ["AD_DIRECTORY_ID", "AD_LDAP_URL", "AD_BASE_DN", "AD_BIND_DN", "AD_BIND_PASSWORD"];
  if (!directory || Array.isArray(directory) || Object.keys(directory).length !== directoryKeys.length ||
      directoryKeys.some(key => !Object.hasOwn(directory, key))) throw fail();
  const ca = await input(settings.adCaFile), certificate = await input(settings.tlsCertificate), key = await input(settings.tlsKey);
  const leaf = new X509Certificate(certificate), publicKey = leaf.publicKey.export({ type: "spki", format: "der" });
  const privatePublic = createPublicKey(createPrivateKey(key)).export({ type: "spki", format: "der" });
  if (publicKey.length !== privatePublic.length || !timingSafeEqual(publicKey, privatePublic) ||
      Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now() ||
      !leaf.checkHost(settings.staffHostname) || !leaf.checkHost(settings.qrHostname)) throw fail();
  // Renderer validates hostnames/private publishing, generates independent hop
  // credentials, and retains the established private-route/header policy.
  const ingress = await renderIngress({ staffHostname: settings.staffHostname, qrHostname: settings.qrHostname,
    vmAddress: settings.vmAddress, gatewayPort: 8443, staffPort: 5173, qrPort: 5174, backendNetwork: "compose",
    vmCertificate: "/etc/nginx/runtime/tls.pem", vmCertificateKey: "/etc/nginx/runtime/tls.key",
    vmQrInclude: "/etc/nginx/runtime/vm-qr-upstream.conf", npmTrustedCa: settings.npmTrustedCa,
    ...(settings.proxySourceAddress ? { proxySourceAddress: settings.proxySourceAddress } : {}) }, output);
  if (!Number.isInteger(settings.gatewayPort) || settings.gatewayPort < 1024 || settings.gatewayPort > 65535) throw fail();
  await mkdir(output, { mode: 0o700 });
  try {
    await mkdir(path.join(output, "operator"), { mode: 0o700 });
    const operator = path.join(output, "operator"), plan = path.join(operator, "database-plan");
    await save(path.join(operator, "database-settings.json"), JSON.stringify({ namespace: settings.namespace,
      administratorUrl: "postgresql://postgres@localhost:5432/postgres?host=/var/run/postgresql" }));
    await prepareDatabases(path.join(operator, "database-settings.json"), plan);
    // No production database connections occur here. Runtime URLs are generated
    // offline from the same protected plan used later by the operator profile.
    const tracker = JSON.parse(await readFile(path.join(plan, "tracker-runtime.json"), "utf8"));
    const requests = JSON.parse(await readFile(path.join(plan, "requests-runtime.json"), "utf8"));
    const shared = randomBytes(32).toString("base64url");
    const login = ingress["staff-ingress.env"].trim().split("=")[1], request = ingress["qr-ingress.env"].trim().split("=")[1];
    const runtime = {
      staff: { ...tracker, ADMIN_SHARED_SECRET: shared, LOGIN_PROXY_SECRET: login,
        SERVICE_REQUEST_API_URL: "http://qr:5174/api/requests", AUTH_MODE: "ad", ...directory },
      qr: { ...requests, ADMIN_SHARED_SECRET: shared, REQUEST_PROXY_SECRET: request, TRACKER_ASSET_API_URL: "http://staff:5173/api/service-assets" },
      reconciler: { ...tracker, ADMIN_SHARED_SECRET: shared, SERVICE_REQUEST_API_URL: "http://qr:5174/api/requests" },
    };
    for (const [role, value] of Object.entries(runtime)) {
      const check = path.join(output, `.check-${role}`); await mkdir(check, { mode: 0o700 });
      await save(path.join(check, "runtime.json"), JSON.stringify(value));
      if (role === "staff") await save(path.join(check, "ad-ca.pem"), ca);
      await managedEnvironment(role, check, { staff: 5173, qr: 5174 }, { network: "compose" });
      await rm(check, { recursive: true });
      await save(path.join(output, `${role}-runtime.json`), JSON.stringify(value));
    }
    await save(path.join(operator, "identity-directory.json"), JSON.stringify({ directory: directory.AD_DIRECTORY_ID }));
    for (const name of ["npm-staff.conf", "npm-qr.conf", "npm-qr-upstream.conf", "vm.conf", "vm-qr-upstream.conf"])
      await save(path.join(output, name), ingress[name]);
    await save(path.join(output, "postgres-password"), randomBytes(32).toString("base64url"));
    await save(path.join(output, "ad-ca.pem"), ca); await save(path.join(output, "tls.pem"), certificate); await save(path.join(output, "tls.key"), key);
    const variables = { ASSETTRACKER_APP_IMAGE: pins.appImage, ASSETTRACKER_POSTGRES_IMAGE: pins.postgresImage,
      ASSETTRACKER_OPERATOR_IMAGE: pins.operatorImage, ASSETTRACKER_GATEWAY_IMAGE: pins.gatewayImage,
      ASSETTRACKER_VM_ADDRESS: settings.vmAddress, ASSETTRACKER_GATEWAY_PORT: String(settings.gatewayPort), ASSETTRACKER_SECRET_DIR: settings.installDirectory };
    await save(path.join(output, "compose.env"), Object.entries(variables).map(([name, value]) => `${name}=${value}\n`).join(""));
    await save(path.join(output, "manifest.json"), JSON.stringify({ version: 1, namespace: settings.namespace,
      installDirectory: settings.installDirectory, images: pins, mode: settings.namespace.startsWith("assettracker_restore_") ? "restore" : "fresh" }, null, 2));
    return { prepared: true, mode: settings.namespace.startsWith("assettracker_restore_") ? "restore" : "fresh" };
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
}
