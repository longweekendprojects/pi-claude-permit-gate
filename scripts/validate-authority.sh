#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/validate-authority.sh --artifacts-only --output <artifact-directory> [--source-root <repository-directory>]

Validates generated authority artifacts only. It never invokes launchctl, touches Keychain,
opens listeners, or changes Serve/Tailnet state.
USAGE
}

fail() { printf 'validate-authority: %s\n' "$*" >&2; exit 1; }
absolute_path() { case "$1" in /*) ;; *) fail "path must be absolute" ;; esac; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }

ARTIFACTS_ONLY=0
OUTPUT_DIRECTORY=""
SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --artifacts-only) ARTIFACTS_ONLY=1; shift ;;
    --output|--source-root)
      [ "$#" -ge 2 ] || fail "missing value"
      option="$1"; value="$2"; shift 2
      case "$option" in
        --output) OUTPUT_DIRECTORY="$value" ;;
        --source-root) SOURCE_ROOT="$value" ;;
      esac
      ;;
    --help) usage; exit 0 ;;
    *) fail "unknown option" ;;
  esac
done

[ "$ARTIFACTS_ONLY" -eq 1 ] || fail "only artifact validation is supported"
[ -n "$OUTPUT_DIRECTORY" ] || fail "artifact validation requires --output"
absolute_path "$OUTPUT_DIRECTORY"
absolute_path "$SOURCE_ROOT"
MANIFEST="$OUTPUT_DIRECTORY/authority-artifacts-v1.json"
[ -f "$MANIFEST" ] || fail "artifact manifest is missing"
[ -f "$SOURCE_ROOT/protocol/authority-v1.schema.json" ] || fail "canonical schema is unavailable"
EXPECTED_H1_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify 'refs/tags/v0.2.0^{commit}')" || fail "immutable H1 release tag is unavailable"
EXPECTED_PACKAGE_VERSION="$(node -p "require('$SOURCE_ROOT/package.json').version")"

node --input-type=module - "$MANIFEST" "$SOURCE_ROOT" "$EXPECTED_H1_COMMIT" "$EXPECTED_PACKAGE_VERSION" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [manifestPath, sourceRoot, expectedH1Commit, expectedPackageVersion] = process.argv.slice(2);
const fail = (message) => { throw new Error(message); };
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const absolute = (value) => typeof value === "string" && path.isAbsolute(value);
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (manifest.schemaVersion !== 1 || manifest.packageName !== "pi-claude-permit-gate" || manifest.packageVersion !== expectedPackageVersion) fail("manifest identity is invalid");
if (!/^[0-9a-f]{40}$/i.test(manifest.commit) || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(manifest.packageVersion) || !/^[\x20-\x7e]{1,64}$/.test(manifest.buildId)) fail("manifest build identity is invalid");
if (manifest.schemaSha256 !== hash(path.join(sourceRoot, "protocol/authority-v1.schema.json"))) fail("canonical schema hash does not match manifest");
if (!absolute(manifest.releasePath) || !manifest.releasePath.endsWith(`/${manifest.commit}`)) fail("release path is not immutable");
if (manifest.schemaSha256 !== hash(path.join(manifest.releasePath, "protocol/authority-v1.schema.json"))) fail("staged schema hash does not match manifest");
if (!manifest.h1 || manifest.h1.release !== "v0.2.0" || manifest.h1.commit !== expectedH1Commit || manifest.h1.installedBuild !== manifest.h1.commit || manifest.h1.operatorVerified !== true) fail("H1 prerequisite evidence is invalid");
const expected = [["anthropic-a", 8791], ["anthropic-b", 8792], ["anthropic-c", 8793], ["anthropic-d", 8794]];
if (!Array.isArray(manifest.lanes) || manifest.lanes.length !== expected.length) fail("lane count is invalid");
const forbidden = /authorization|bearer|token|secret|password|private[ _-]?key|keychain/i;
for (const [index, [provider, port]] of expected.entries()) {
  const lane = manifest.lanes[index];
  const label = `com.longweekendprojects.claude-permit-lane.${provider}`;
  if (!lane || lane.provider !== provider || lane.port !== port || lane.label !== label) fail("lane identity is invalid");
  for (const value of [lane.plistPath, lane.statePath, lane.outLogPath, lane.errLogPath]) if (!absolute(value)) fail("lane path is not absolute");
  if (!fs.existsSync(lane.plistPath) || lane.plistSha256 !== hash(lane.plistPath)) fail("plist hash does not match manifest");
  const plist = fs.readFileSync(lane.plistPath, "utf8");
  if (forbidden.test(plist) || /__[A-Z_]+__/.test(plist)) fail("plist contains a placeholder or forbidden credential material");
  for (const required of [label, manifest.releasePath, `${manifest.releasePath}/permit-daemon.mjs`, "CLAUDE_PERMIT_GATE_DAEMON_MODE", "authority", "CLAUDE_PERMIT_GATE_PROVIDER", provider, "CLAUDE_PERMIT_GATE_PORT", String(port), "CLAUDE_PERMIT_GATE_OFFER_TTL_MS", "CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS", "CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS", "CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS", "RunAtLoad", "SuccessfulExit", path.dirname(lane.statePath), lane.outLogPath, lane.errLogPath]) if (!plist.includes(required)) fail("plist is missing a required authority field");
  if (!plist.includes("<false/>")) fail("plist does not keep failed exits alive");
}
NODE

for plist in "$OUTPUT_DIRECTORY"/LaunchAgents/com.longweekendprojects.claude-permit-lane.*.plist; do
  [ -f "$plist" ] || fail "no generated plists found"
  /usr/bin/plutil -lint "$plist" >/dev/null || fail "plist lint failed"
done

if grep -RInE 'authorization|bearer|token|secret|password|private[ _-]?key|keychain' "$OUTPUT_DIRECTORY"/LaunchAgents "$MANIFEST" >/dev/null; then fail "generated artifacts contain forbidden credential material"; fi
printf '%s\n' 'authority artifacts are valid: four lintable, credential-free, immutable launchd definitions'
