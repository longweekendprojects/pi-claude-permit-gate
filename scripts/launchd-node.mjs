// Keep the symlink spelling: process.execPath resolves Homebrew's link into a versioned Cellar.
import { spawnSync } from "node:child_process";

export function resolveLaunchdNode() {
  const node = ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath].find((candidate) =>
    spawnSync(candidate, ["-e", 'if (Number(process.versions.node.split(".")[0]) < 22 || typeof fetch !== "function") process.exit(1)'], { stdio: "ignore", timeout: 5000 }).status === 0);
  if (!node) throw new Error("LaunchAgents require a working Node 22 or newer");
  return node;
}
