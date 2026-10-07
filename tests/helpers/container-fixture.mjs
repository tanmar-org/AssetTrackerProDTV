import { execFile } from "node:child_process";
import { chmod, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);
// Synthetic certificate/credentials only. The operator never reads VM AD or TLS
// files; fixture output is private and generated independently for each drill.
export async function containerSettings(directory, ldap, pins, { namespace = "assettracker_container", installDirectory, gatewayPort = 8443 } = {}) {
  const certificate = path.join(directory, "gateway.pem"), key = path.join(directory, "gateway.key"), ca = path.join(directory, "ad.pem"), images = path.join(directory, "images.json");
  await run("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", certificate, "-days", "2",
    "-subj", "/CN=tracker.example.test", "-addext", "subjectAltName=DNS:tracker.example.test,DNS:qr.example.test"]);
  await chmod(certificate, 0o600); await chmod(key, 0o600);
  await writeFile(ca, await readFile(ldap.caFile), { mode: 0o600 });
  await writeFile(images, JSON.stringify(pins), { mode: 0o600 });
  const ad = Object.fromEntries(["AD_DIRECTORY_ID", "AD_LDAP_URL", "AD_BASE_DN", "AD_BIND_DN", "AD_BIND_PASSWORD"].map(key => [key, ldap.env[key]]));
  const settings = { imagesFile: images, namespace, staffHostname: "tracker.example.test", qrHostname: "qr.example.test",
    vmAddress: "127.0.0.1", gatewayPort, installDirectory: installDirectory || `/tmp/assettracker-installed-${namespace}`,
    directory: { ...ad, AD_LDAP_URL: ldap.env.AD_LDAP_URL.replace("localhost", "directory.example.test") },
    adCaFile: ca, tlsCertificate: certificate, tlsKey: key, npmTrustedCa: "/data/assettracker-ca.pem" };
  const file = path.join(directory, "settings.json"); await writeFile(file, JSON.stringify(settings), { mode: 0o600 });
  return { settings, file, certificate, key };
}
export const fakeImagePins = { version: 1, revision: "a".repeat(40), publicQrUrl: "https://qr.example.test/", platform: "linux/amd64",
  ...Object.fromEntries(["app", "postgres", "operator", "gateway"].map((kind, index) => [`${kind}Image`, `sha256:${String(index + 1).repeat(64)}`])) };
