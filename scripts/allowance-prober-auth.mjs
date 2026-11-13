// Resolve allowance bearers through the same Pi installation and credential transaction as Pi itself.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PROVIDERS = ["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"];
const REVIEWED_PI_VERSIONS = new Set(["0.87.1", "0.99.1", "0.99.2", "1.3.0", "1.5.0", "1.5.2"]);
const loadError = () => new Error("Pi OAuth resolver is unavailable");

// launchd's stable Node need not own the Pi installation. Locate Pi without executing its CLI or
// storing a Node-version-specific package location in the job. A mise shim needs `mise which`:
// realpath alone resolves that shim to the mise executable, not to Pi.
function runtimeFromCli(cli) {
  try {
    let file = fs.realpathSync(cli);
    if (path.basename(file) === "mise") {
      file = fs.realpathSync(execFileSync(file, ["which", "pi"], { cwd: os.homedir(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim());
    }
    let directory = path.dirname(file);
    while (directory !== path.dirname(directory)) {
      try {
        if (JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return directory;
      } catch {}
      directory = path.dirname(directory);
    }
  } catch {}
  return undefined;
}

function findRuntime() {
  const cliCandidates = [process.env.PI_CLI_PATH, ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, "pi")), path.join(os.homedir(), ".local/share/mise/shims/pi")];
  for (const cli of cliCandidates) {
    if (!cli) continue;
    const runtime = runtimeFromCli(cli);
    if (runtime) return runtime;
  }
  for (const node of ["/opt/homebrew/bin/node", process.execPath]) {
    const runtime = path.resolve(path.dirname(node), "../lib/node_modules/@earendil-works/pi-coding-agent");
    try {
      if (JSON.parse(fs.readFileSync(path.join(runtime, "package.json"), "utf8")).name === "@earendil-works/pi-coding-agent") return runtime;
    } catch {}
  }
  throw loadError();
}

export async function createAllowanceAuth(authPath, runtimeDir) {
  try {
    runtimeDir ??= findRuntime();
    const aiDir = path.join(runtimeDir, "node_modules/@earendil-works/pi-ai");
    const piPackage = JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8"));
    const aiPackage = JSON.parse(fs.readFileSync(path.join(aiDir, "package.json"), "utf8"));
    // These private paths and their refresh semantics were reviewed in the supported releases.
    // Require matching, reviewed package versions before accessing credentials.
    if (piPackage.name !== "@earendil-works/pi-coding-agent" || aiPackage.name !== "@earendil-works/pi-ai" || !REVIEWED_PI_VERSIONS.has(piPackage.version) || piPackage.version !== aiPackage.version) throw loadError();
    const [{ AuthStorage }, { createModels }, { anthropicOAuth }] = await Promise.all([
      import(pathToFileURL(path.join(runtimeDir, "dist/core/auth-storage.js")).href),
      import(pathToFileURL(path.join(aiDir, "dist/index.js")).href),
      import(pathToFileURL(path.join(aiDir, "dist/auth/oauth/anthropic.js")).href),
    ]);
    if (typeof AuthStorage?.create !== "function" || typeof createModels !== "function" || typeof anthropicOAuth?.refresh !== "function" || typeof anthropicOAuth?.toAuth !== "function") throw loadError();
    const credentials = AuthStorage.create(authPath);
    const models = createModels({ credentials });
    if (typeof models.setProvider !== "function" || typeof models.getAuth !== "function") throw loadError();
    for (const id of PROVIDERS) {
      // This collection resolves auth only; it has no API-key source or inference models.
      models.setProvider({ id, name: id, auth: { oauth: anthropicOAuth }, getModels: () => [] });
    }
    return async (provider) => {
      if (!PROVIDERS.includes(provider)) return undefined;
      try {
        const stored = await credentials.read(provider);
        if (stored?.type !== "oauth" || typeof stored.access !== "string" || !stored.access || typeof stored.refresh !== "string" || !stored.refresh || !Number.isFinite(stored.expires)) return undefined;
        const result = await models.getAuth(provider);
        const token = result?.source === "OAuth" ? result.auth?.apiKey : undefined;
        return typeof token === "string" && token.length > 0 ? token : undefined;
      } catch {
        // Pi's OAuth errors can include response bodies and credential values in their causes.
        throw new Error("Pi OAuth credential resolution failed");
      }
    };
  } catch {
    throw loadError();
  }
}
