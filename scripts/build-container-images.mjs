import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { protectedOperatorPath } from "./database-provisioning.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Shell-free arguments: the only deployment build input is a public QR origin.
// Images carry a source revision and are selected by immutable local image IDs.
async function main() {
  const [origin, output] = process.argv.slice(2), url = new URL(origin);
  if (process.argv.length !== 4 || url.protocol !== "https:" || !url.hostname.includes(".") ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
  if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) throw new Error();
  await protectedOperatorPath(path.dirname(output), true);
  await mkdir(output, { mode: 0o700 });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error();
  const pins = { version: 1, revision, publicQrUrl: url.href };
  for (const target of ["app", "postgres", "operator", "gateway"]) {
    const tag = `assettracker-${target}:${revision}`;
    await new Promise((resolve, reject) => {
      const child = spawn("docker", ["build", "--file", "deploy/docker/Dockerfile", "--target", target,
        "--build-arg", `PUBLIC_QR_URL=${url.href}`, "--build-arg", `SOURCE_REVISION=${revision}`, "--tag", tag, "."],
      { cwd: root, stdio: "inherit" });
      child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error()));
    });
    const [info] = JSON.parse(execFileSync("docker", ["image", "inspect", tag], { encoding: "utf8" }));
    if (!/^sha256:[a-f0-9]{64}$/.test(info.Id) || info.Config.Labels?.["org.opencontainers.image.revision"] !== revision) throw new Error();
    const platform = `${info.Os}/${info.Architecture}`;
    if (pins.platform && pins.platform !== platform) throw new Error();
    pins.platform = platform; pins[`${target}Image`] = info.Id;
  }
  await writeFile(path.join(output, "images.json"), `${JSON.stringify(pins, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log("Four immutable container images built; image IDs recorded in the protected output directory.");
}
main().catch(() => { console.error("Container image build failed; inspect build/tool access privately."); process.exitCode = 1; });
