// Resolve allowance bearers through the same Pi installation and credential transaction as Pi itself.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROVIDERS = ["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"];
const REVIEWED_PI_VERSION = "0.87.1";
const runtimeFromNode = () => path.resolve(path.dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
const loadError = () => new Error("Pi OAuth resolver is unavailable");

export async function createAllowanceAuth(authPath, runtimeDir = runtimeFromNode()) {
  try {
    const aiDir = path.join(runtimeDir, "node_modules/@earendil-works/pi-ai");
    const piPackage = JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8"));
    const aiPackage = JSON.parse(fs.readFileSync(path.join(aiDir, "package.json"), "utf8"));
    // These private paths and their refresh semantics were reviewed together in 0.87.1.
    // Stop on an upgrade until the integration has been checked against the new Pi release.
    if (piPackage.name !== "@earendil-works/pi-coding-agent" || aiPackage.name !== "@earendil-works/pi-ai" || piPackage.version !== REVIEWED_PI_VERSION || aiPackage.version !== REVIEWED_PI_VERSION) throw loadError();
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
