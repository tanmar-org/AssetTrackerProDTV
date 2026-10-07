import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { protectedOperatorPath } from "./database-provisioning.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// Shell-free arguments: the only deployment build input is a public QR origin.
// Images carry a source revision and are selected by immutable local image IDs.
async function main() {
  const args = process.argv.slice(2);
  // Elevate only Docker, never Node/npm/Git or protected output writes. An
  // explicit option preserves direct-daemon use in CI and prompts in the
  // operator's terminal on VMs where daemon access requires sudo.
  const useSudo = args[0] === "--sudo";
  if (useSudo) args.shift();
  const [origin, output] = args, url = new URL(origin);
  if (args.length !== 2 || url.protocol !== "https:" || !url.hostname.includes(".") ||
      url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
  if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) throw new Error();
  await protectedOperatorPath(path.dirname(output), true);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error();
  const command = useSudo ? "sudo" : "docker";
  const dockerArgs = args => useSudo ? ["--", "docker", ...args] : args;
  const runDocker = args => new Promise((resolve, reject) => {
    const child = spawn(command, dockerArgs(args), { cwd: root, stdio: "inherit" });
    child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error()));
  });
  // Check daemon authorization before creating any release output. Passwords
  // are handled by sudo's terminal prompt, never read by this helper or saved.
  await runDocker(["version", "--format", "{{.Server.Version}}"]);
  await mkdir(output, { mode: 0o700 });
  const pins = { version: 1, revision, publicQrUrl: url.href };
  for (const target of ["app", "postgres", "operator", "gateway"]) {
    const tag = `assettracker-${target}:${revision}`;
    await runDocker(["build", "--file", "deploy/docker/Dockerfile", "--target", target,
        "--build-arg", `PUBLIC_QR_URL=${url.href}`, "--build-arg", `SOURCE_REVISION=${revision}`, "--tag", tag, "."]);
    // Capture only Docker's image metadata; retain terminal input/stderr so a
    // renewed sudo authentication still belongs to the human operator.
    const [info] = JSON.parse(execFileSync(command, dockerArgs(["image", "inspect", tag]),
      { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] }));
    if (!/^sha256:[a-f0-9]{64}$/.test(info.Id) || info.Config.Labels?.["org.opencontainers.image.revision"] !== revision) throw new Error();
    const platform = `${info.Os}/${info.Architecture}`;
    if (pins.platform && pins.platform !== platform) throw new Error();
    pins.platform = platform; pins[`${target}Image`] = info.Id;
  }
  await writeFile(path.join(output, "images.json"), `${JSON.stringify(pins, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  console.log("Four immutable container images built; image IDs recorded in the protected output directory.");
}
main().catch(() => { console.error("Container image build failed; inspect build/tool access privately."); process.exitCode = 1; });
