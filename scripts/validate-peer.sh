#!/usr/bin/env bash
set -euo pipefail

readonly PROVIDERS=(anthropic-a anthropic-b anthropic-c anthropic-d)
readonly UUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

usage() {
  cat <<'USAGE'
Usage: scripts/validate-peer.sh --provider <anthropic-a|anthropic-b|anthropic-c|anthropic-d> --peer-command <absolute-readiness-command> [--expected-build <build-id>]

The peer command receives no arguments and must write one JSON object with exactly these fields:
{"mode":"authority-client","buildId":"...","installationId":"uuid","keychainLookup":true,"localListeners":[]}

The command may retrieve this redacted readiness record from the peer. This helper never prints the installation ID, Keychain reference, listener details, command output, or errors from that command.
USAGE
}

fail() { printf 'validate-peer: %s\n' "$*" >&2; exit 1; }
valid_provider() { local provider; for provider in "${PROVIDERS[@]}"; do [ "$provider" = "$1" ] && return 0; done; return 1; }
valid_build() { [[ "$1" =~ ^[A-Za-z0-9._+-]{1,128}$ ]]; }

PROVIDER=""
PEER_COMMAND=""
EXPECTED_BUILD=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --provider|--peer-command|--expected-build)
      [ "$#" -ge 2 ] || fail "missing value for $1"
      option="$1"; value="$2"; shift 2
      case "$option" in
        --provider) PROVIDER="$value" ;;
        --peer-command) PEER_COMMAND="$value" ;;
        --expected-build) EXPECTED_BUILD="$value" ;;
      esac
      ;;
    --help) usage; exit 0 ;;
    *) fail "unknown option" ;;
  esac
done

if [ -n "${CLAUDE_PERMIT_GATE_TEST_PEER_COMMAND:-}" ]; then
  [ "${CLAUDE_PERMIT_GATE_TEST_MODE:-}" = "1" ] || fail "peer command override is unavailable"
  [ -z "$PEER_COMMAND" ] || fail "peer command cannot be combined with the test override"
  PEER_COMMAND="$CLAUDE_PERMIT_GATE_TEST_PEER_COMMAND"
fi

valid_provider "$PROVIDER" || fail "an A-D provider is required"
[[ "$PEER_COMMAND" = /* ]] || fail "an absolute peer command is required"
[ -z "$EXPECTED_BUILD" ] || valid_build "$EXPECTED_BUILD" || fail "expected build is invalid"

peer_timeout=15000
if [ -n "${CLAUDE_PERMIT_GATE_TEST_PEER_TIMEOUT_MS:-}" ]; then
  [ "${CLAUDE_PERMIT_GATE_TEST_MODE:-}" = "1" ] && [[ "$CLAUDE_PERMIT_GATE_TEST_PEER_TIMEOUT_MS" =~ ^[1-9][0-9]*$ ]] && [ "$CLAUDE_PERMIT_GATE_TEST_PEER_TIMEOUT_MS" -le 15000 ] || fail "peer readiness is unavailable for $PROVIDER"
  peer_timeout="$CLAUDE_PERMIT_GATE_TEST_PEER_TIMEOUT_MS"
fi

readiness=""
if ! readiness="$(node --input-type=module - "$PEER_COMMAND" "$peer_timeout" 2>/dev/null <<'NODE'
import { spawn } from "node:child_process";
const [command, timeout] = process.argv.slice(2);
const limit = 64 * 1024;
let child;
try { child = spawn(command, [], { detached: true, stdio: ["ignore", "pipe", "ignore"] }); } catch { process.exit(1); }
const chunks = [];
let length = 0;
let failed = false;
const terminate = () => {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
};
const stop = () => {
  if (failed) return;
  failed = true;
  child.stdout.removeAllListeners("data");
  child.stdout.resume();
  terminate();
};
const deadline = setTimeout(stop, Number(timeout));
child.on("error", stop);
child.stdout.on("data", (chunk) => {
  if (failed) return;
  length += chunk.length;
  if (length > limit) stop();
  else chunks.push(chunk);
});
child.on("close", (code, signal) => {
  clearTimeout(deadline);
  if (failed || code !== 0 || signal !== null) process.exit(1);
  process.stdout.write(Buffer.concat(chunks));
});
NODE
)"; then fail "peer readiness is unavailable for $PROVIDER"; fi

result="$(node --input-type=module - "$EXPECTED_BUILD" 3<<<"$readiness" 2>/dev/null <<'NODE'
import fs from "node:fs";
const [expectedBuild] = process.argv.slice(2);
const fail = () => process.exit(1);
const raw = fs.readFileSync(3, "utf8");
let record;
try { record = JSON.parse(raw); } catch { fail(); }
if (record === null || Array.isArray(record) || typeof record !== "object") fail();
const keys = Object.keys(record).sort();
const expectedKeys = ["buildId", "installationId", "keychainLookup", "localListeners", "mode"];
if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) fail();
if (record.mode !== "authority-client" || typeof record.buildId !== "string" || !/^[A-Za-z0-9._+-]{1,128}$/.test(record.buildId)) fail();
if (expectedBuild && record.buildId !== expectedBuild) fail();
if (typeof record.installationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.installationId)) fail();
if (record.keychainLookup !== true || !Array.isArray(record.localListeners) || record.localListeners.length !== 0) fail();
process.stdout.write(`mode=${record.mode} build=${record.buildId} installation-id=present keychain=available local-listeners=none`);
NODE
)" || fail "peer readiness is invalid for $PROVIDER"

printf '%s %s\n' "$PROVIDER" "$result"
