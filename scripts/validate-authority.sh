#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/validate-authority.sh --artifacts-only --output <artifact-directory> [--source-root <repository-directory>] [--release-tree <directory>]
  scripts/validate-authority.sh --release-only --source-root <repository-directory> --release-tree <directory> --commit <commit>

Validation reads artifacts only. It never invokes launchctl, Keychain, listeners, Serve, or Tailnet.
USAGE
}

fail() { printf 'validate-authority: %s\n' "$*" >&2; exit 1; }
absolute_path() { case "$1" in /*) ;; *) fail "path must be absolute" ;; esac; }

ARTIFACTS_ONLY=0
RELEASE_ONLY=0
OUTPUT_DIRECTORY=""
RELEASE_TREE=""
COMMIT_ARGUMENT=""
SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifacts-only) ARTIFACTS_ONLY=1; shift ;;
    --release-only) RELEASE_ONLY=1; shift ;;
    --output|--source-root|--release-tree|--commit)
      [ "$#" -ge 2 ] || fail "missing value"
      option="$1"; value="$2"; shift 2
      case "$option" in
        --output) OUTPUT_DIRECTORY="$value" ;;
        --source-root) SOURCE_ROOT="$value" ;;
        --release-tree) RELEASE_TREE="$value" ;;
        --commit) COMMIT_ARGUMENT="$value" ;;
      esac
      ;;
    --help) usage; exit 0 ;;
    *) fail "unknown option" ;;
  esac
done

[ $((ARTIFACTS_ONLY + RELEASE_ONLY)) -eq 1 ] || fail "choose exactly one validation mode"
absolute_path "$SOURCE_ROOT"
[ -d "$SOURCE_ROOT/.git" ] || fail "source root is not a repository"
if [ "$ARTIFACTS_ONLY" -eq 1 ]; then [ -n "$OUTPUT_DIRECTORY" ] || fail "artifact validation requires --output"; absolute_path "$OUTPUT_DIRECTORY"; fi
if [ -n "$RELEASE_TREE" ]; then absolute_path "$RELEASE_TREE"; fi

MANIFEST="${OUTPUT_DIRECTORY:+$OUTPUT_DIRECTORY/authority-artifacts-v1.json}"
if [ "$ARTIFACTS_ONLY" -eq 1 ]; then
  [ -f "$MANIFEST" ] || fail "artifact manifest is missing"
  COMMIT_ARGUMENT="$(node --input-type=module - "$MANIFEST" <<'NODE'
import fs from "node:fs";
console.log(JSON.parse(fs.readFileSync(process.argv[2], "utf8")).commit ?? "");
NODE
)"
fi
[ -n "$COMMIT_ARGUMENT" ] || fail "commit is required"
COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify "$COMMIT_ARGUMENT^{commit}")" || fail "commit is unavailable"
[ "$COMMIT" = "$(git -C "$SOURCE_ROOT" rev-parse HEAD)" ] || fail "artifacts must match the current immutable commit"
[ -n "$RELEASE_TREE" ] || RELEASE_TREE="$OUTPUT_DIRECTORY/releases/$COMMIT"
[ -d "$RELEASE_TREE" ] && [ ! -L "$RELEASE_TREE" ] || fail "release tree is unavailable"

node --input-type=module - "$SOURCE_ROOT" "$COMMIT" "$RELEASE_TREE" <<'NODE'
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const [sourceRoot, commit, releaseTree] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const tree = childProcess.execFileSync("git", ["-C", sourceRoot, "ls-tree", "-r", "-z", commit]).toString("utf8").split("\0").filter(Boolean);
const expected = new Map(tree.map((entry) => { const match = entry.match(/^(\d+) (\w+) ([0-9a-f]+)\t(.+)$/); if (!match || match[2] !== "blob") fail("commit tree is invalid"); return [match[4], { mode: match[1], hash: match[3] }]; }));
const actual = new Map();
const walk = (directory, prefix = "") => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const file = path.join(directory, entry.name);
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) { actual.set(relative, { type: "directory" }); walk(file, relative); }
    else if (stat.isFile()) actual.set(relative, { type: "file", bytes: fs.readFileSync(file), executable: (stat.mode & 0o111) !== 0 });
    else if (stat.isSymbolicLink()) actual.set(relative, { type: "symlink", bytes: fs.readlinkSync(file, "buffer") });
    else fail("release tree contains an unsupported entry");
  }
};
walk(releaseTree);
for (const [relative, record] of actual) {
  if (record.type === "directory") { if (![...expected.keys()].some((name) => name.startsWith(`${relative}/`))) fail("release tree has an extra directory"); continue; }
  const expectedEntry = expected.get(relative);
  if (!expectedEntry) fail("release tree has an extra entry");
  const expectedSymlink = expectedEntry.mode === "120000";
  if ((expectedSymlink && record.type !== "symlink") || (!expectedSymlink && record.type !== "file")) fail("release tree entry type differs from commit");
  if (!expectedSymlink && ((expectedEntry.mode === "100755") !== record.executable)) fail("release tree entry mode differs from commit");
  const actualHash = childProcess.execFileSync("git", ["-C", sourceRoot, "hash-object", "--stdin"], { input: record.bytes }).toString("utf8").trim();
  if (actualHash !== expectedEntry.hash) fail("release tree entry content differs from commit");
  expected.delete(relative);
}
if (expected.size !== 0) fail("release tree is missing an archived entry");
NODE

if [ "$RELEASE_ONLY" -eq 1 ]; then printf '%s\n' 'authority release tree matches the current immutable commit'; exit 0; fi

[ -f "$SOURCE_ROOT/protocol/authority-v1.schema.json" ] || fail "canonical schema is unavailable"
EXPECTED_H1_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify 'refs/tags/v0.2.0^{commit}')" || fail "immutable H1 release tag is unavailable"
EXPECTED_PACKAGE_VERSION="$(node -p "require('$SOURCE_ROOT/package.json').version")"
node --input-type=module - "$MANIFEST" "$SOURCE_ROOT" "$COMMIT" "$RELEASE_TREE" "$EXPECTED_H1_COMMIT" "$EXPECTED_PACKAGE_VERSION" <<'NODE'
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [manifestPath, sourceRoot, commit, releaseTree, expectedH1Commit, expectedPackageVersion] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const absolute = (value) => typeof value === "string" && path.isAbsolute(value);
const plist = (file) => JSON.parse(childProcess.execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", file]).toString("utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const buildId = `pi-claude-permit-gate-${expectedPackageVersion}+git.${commit.slice(0, 12)}`;
if (manifest.schemaVersion !== 1 || manifest.packageName !== "pi-claude-permit-gate" || manifest.packageVersion !== expectedPackageVersion || manifest.commit !== commit || manifest.buildId !== buildId) fail("manifest build identity is invalid");
if (manifest.schemaSha256 !== hash(path.join(sourceRoot, "protocol/authority-v1.schema.json")) || manifest.schemaSha256 !== hash(path.join(releaseTree, "protocol/authority-v1.schema.json"))) fail("schema hash does not match manifest");
if (!absolute(manifest.releasePath) || !manifest.releasePath.endsWith(`/${commit}`)) fail("release path is not immutable");
if (!manifest.h1 || manifest.h1.release !== "v0.2.0" || manifest.h1.commit !== expectedH1Commit || manifest.h1.installedBuild !== manifest.h1.commit || manifest.h1.operatorVerified !== true) fail("H1 prerequisite evidence is invalid");
const expected = [["anthropic-a", 8791], ["anthropic-b", 8792], ["anthropic-c", 8793], ["anthropic-d", 8794]];
if (!Array.isArray(manifest.lanes) || manifest.lanes.length !== expected.length) fail("lane count is invalid");
const forbidden = /authorization|bearer|token|secret|password|private[ _-]?key|keychain/i;
for (const [index, [provider, port]] of expected.entries()) {
  const lane = manifest.lanes[index]; const label = `com.longweekendprojects.claude-permit-lane.${provider}`;
  if (!lane || lane.provider !== provider || lane.port !== port || lane.label !== label) fail("lane identity is invalid");
  for (const value of [lane.plistPath, lane.statePath, lane.outLogPath, lane.errLogPath]) if (!absolute(value)) fail("lane path is not absolute");
  if (!fs.existsSync(lane.plistPath) || lane.plistSha256 !== hash(lane.plistPath)) fail("plist hash does not match manifest");
  const raw = fs.readFileSync(lane.plistPath, "utf8"); if (forbidden.test(raw) || /__[A-Z_]+__/.test(raw)) fail("plist contains a placeholder or forbidden credential material");
  const decoded = plist(lane.plistPath); const environment = decoded.EnvironmentVariables;
  if (decoded.Label !== label || !Array.isArray(decoded.ProgramArguments) || decoded.ProgramArguments[1] !== `${manifest.releasePath}/permit-daemon.mjs` || decoded.WorkingDirectory !== manifest.releasePath || decoded.RunAtLoad !== true || decoded.KeepAlive?.SuccessfulExit !== false) fail("plist launch definition is invalid");
  if (!environment || environment.CLAUDE_PERMIT_GATE_DAEMON_MODE !== "authority" || environment.CLAUDE_PERMIT_GATE_PROVIDER !== provider || environment.CLAUDE_PERMIT_GATE_PORT !== String(port) || environment.CLAUDE_PERMIT_GATE_BUILD_ID !== buildId || environment.CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR !== path.dirname(lane.statePath) || decoded.StandardOutPath !== lane.outLogPath || decoded.StandardErrorPath !== lane.errLogPath) fail("plist authority identity is invalid");
  for (const key of ["CLAUDE_PERMIT_GATE_OFFER_TTL_MS", "CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS", "CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS", "CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS"]) if (!/^\d+$/.test(environment[key] ?? "")) fail("plist timing is invalid");
}
NODE

for plist in "$OUTPUT_DIRECTORY"/LaunchAgents/com.longweekendprojects.claude-permit-lane.*.plist; do [ -f "$plist" ] || fail "no generated plists found"; /usr/bin/plutil -lint "$plist" >/dev/null || fail "plist lint failed"; done
if grep -RInE 'authorization|bearer|token|secret|password|private[ _-]?key|keychain' "$OUTPUT_DIRECTORY/LaunchAgents" "$MANIFEST" >/dev/null; then fail "generated artifacts contain forbidden credential material"; fi
printf '%s\n' 'authority artifacts are valid: four lintable, credential-free, immutable launchd definitions'
