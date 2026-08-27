#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
BASE="$(mktemp -d /private/tmp/authority-installer-test.XXXXXX)"
trap 'chmod -R u+w "$BASE" 2>/dev/null || true; rm -rf "$BASE"' EXIT
H1="$(git -C "$ROOT" rev-parse 'v0.2.0^{commit}')"
AUTHORITY=11111111-1111-4111-8111-111111111111
BINDINGS=(22222222-2222-4222-8222-222222222222 33333333-3333-4333-8333-333333333333 44444444-4444-4444-8444-444444444444 55555555-5555-4555-8555-555555555555)
PROVIDERS=(anthropic-a anthropic-b anthropic-c anthropic-d)
label() { printf 'com.longweekendprojects.claude-permit-lane.%s' "$1"; }
common=(--authority-id "$AUTHORITY" --account-binding-a "${BINDINGS[0]}" --account-binding-b "${BINDINGS[1]}" --account-binding-c "${BINDINGS[2]}" --account-binding-d "${BINDINGS[3]}" --offer-ttl-ms 15000 --renew-interval-ms 10000 --renew-deadline-ms 30000 --terminal-retention-ms 86400000 --h1-release v0.2.0 --h1-installed-build "$H1" --h1-verified)
expect_fail() { if "$@" >/dev/null 2>&1; then echo "expected failure: $*" >&2; exit 1; fi; }

missing_home="$BASE/missing-home-output"
expect_fail "$ROOT/scripts/install-authority.sh" --dry-run --output "$missing_home" "${common[@]}"
test ! -e "$missing_home"
missing_output_home="$BASE/missing-output-home"
expect_fail "$ROOT/scripts/install-authority.sh" --dry-run --home "$missing_output_home" "${common[@]}"
test ! -e "$missing_output_home"

special_home="$BASE/home space 'quote' \"double\" & pipe| slash\\"
special_output="$BASE/output space 'quote' \"double\" & pipe| slash\\"
"$ROOT/scripts/install-authority.sh" --dry-run --home "$special_home" --output "$special_output" "${common[@]}"
test ! -e "$special_home"
/usr/bin/plutil -lint "$special_output"/LaunchAgents/*.plist >/dev/null
"$ROOT/scripts/validate-authority.sh" --artifacts-only --output "$special_output"
node --input-type=module - "$special_output" "$special_home" <<'NODE'
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const [out, home] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'authority-artifacts-v1.json'), 'utf8'));
for (const lane of manifest.lanes) {
  const decoded = JSON.parse(childProcess.execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', lane.plistPath]));
  if (decoded.WorkingDirectory !== manifest.releasePath || decoded.EnvironmentVariables.CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR !== path.join(home, 'Library', 'Application Support', 'Claude Permit Authority', 'lanes') || decoded.StandardOutPath !== lane.outLogPath || decoded.StandardErrorPath !== lane.errLogPath) throw new Error('special-character path did not decode exactly');
}
NODE

collision="$BASE/collision"; mkdir -p "$collision/LaunchAgents"; printf sentinel > "$collision/LaunchAgents/sentinel"
expect_fail "$ROOT/scripts/install-authority.sh" --dry-run --home "$BASE/collision-home" --output "$collision" "${common[@]}"
test "$(cat "$collision/LaunchAgents/sentinel")" = sentinel

normal_home="$BASE/normal-home"; normal_output="$BASE/normal-output"
"$ROOT/scripts/install-authority.sh" --dry-run --home "$normal_home" --output "$normal_output" "${common[@]}"
manifest="$normal_output/authority-artifacts-v1.json"
release="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).releasePath)' "$manifest")"
for mutation in modified missing extra wrong-type; do
  chmod -R u+w "$release"
  case "$mutation" in
    modified) printf changed >> "$release/README.md" ;;
    missing) rm "$release/README.md" ;;
    extra) printf extra > "$release/unexpected" ;;
    wrong-type) rm "$release/README.md"; mkdir "$release/README.md" ;;
  esac
  expect_fail "$ROOT/scripts/validate-authority.sh" --artifacts-only --output "$normal_output"
  rm -rf "$release"; mkdir "$release"
  git -C "$ROOT" archive --format=tar HEAD | tar -xf - -C "$release"
done
node --input-type=module - "$manifest" <<'NODE'
import fs from 'node:fs';
const file = process.argv[2]; const value = JSON.parse(fs.readFileSync(file)); value.buildId = 'wrong-build'; fs.writeFileSync(file, JSON.stringify(value));
NODE
expect_fail "$ROOT/scripts/validate-authority.sh" --artifacts-only --output "$normal_output"
"$ROOT/scripts/install-authority.sh" --dry-run --home "$BASE/fresh-home" --output "$BASE/fresh-output" "${common[@]}"
plist="$BASE/fresh-output/LaunchAgents/$(label anthropic-a).plist"
node --input-type=module - "$plist" <<'NODE'
import fs from 'node:fs'; const file = process.argv[2]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/(<key>CLAUDE_PERMIT_GATE_BUILD_ID<\/key>\s*<string>)[^<]+/, '$1wrong-build'));
NODE
expect_fail "$ROOT/scripts/validate-authority.sh" --artifacts-only --output "$BASE/fresh-output"

FAKE="$BASE/fake-launchctl"
cat > "$FAKE" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
command="$1"; shift
state="${CLAUDE_PERMIT_GATE_TEST_STATE:?}"
case "$command" in
  print) label="${1##*/}"; test -f "$state/$label" ;;
  bootout) label="${1##*/}"; if [ "${CLAUDE_PERMIT_GATE_TEST_FAIL_BOOTOUT:-}" = "$label" ]; then exit 41; fi; rm -f "$state/$label" ;;
  bootstrap) file="$2"; label="$(basename "$file" .plist)"; if [ "${CLAUDE_PERMIT_GATE_TEST_FAIL_BOOTSTRAP:-}" = "$label" ]; then exit 42; fi; : > "$state/$label" ;;
  *) exit 43 ;;
esac
FAKE
chmod 755 "$FAKE"

prepare_live() {
  LIVE_HOME="$BASE/live-home"; LIVE_STATE="$BASE/live-state"; rm -rf "$LIVE_HOME" "$LIVE_STATE"; mkdir -p "$LIVE_HOME/Library/LaunchAgents" "$LIVE_STATE" "$LIVE_HOME/Library/Application Support/Claude Permit Authority/lanes" "$LIVE_HOME/Library/Logs/Claude Permit Authority/lanes"
  printf preserved > "$LIVE_HOME/Library/Application Support/Claude Permit Authority/lanes/preserved-state"
  printf verifier > "$LIVE_HOME/Library/Application Support/Claude Permit Authority/verifiers-v1.json"
  printf log > "$LIVE_HOME/Library/Logs/Claude Permit Authority/lanes/preserved.log"
  printf old-record > "$LIVE_HOME/Library/Application Support/Claude Permit Authority/deployment-v1.json"
  for provider in "${PROVIDERS[@]}"; do cp "$special_output/LaunchAgents/$(label "$provider").plist" "$LIVE_HOME/Library/LaunchAgents/$(label "$provider").plist"; done
  : > "$LIVE_STATE/$(label anthropic-a)"; : > "$LIVE_STATE/$(label anthropic-c)"
}
live_install() { CLAUDE_PERMIT_GATE_TEST_MODE=1 CLAUDE_PERMIT_GATE_TEST_LAUNCHCTL="$FAKE" CLAUDE_PERMIT_GATE_TEST_STATE="$LIVE_STATE" "$ROOT/scripts/install-authority.sh" --home "$LIVE_HOME" "${common[@]}"; }
for provider in "${PROVIDERS[@]}"; do
  prepare_live
  if CLAUDE_PERMIT_GATE_TEST_MODE=1 CLAUDE_PERMIT_GATE_TEST_LAUNCHCTL="$FAKE" CLAUDE_PERMIT_GATE_TEST_STATE="$LIVE_STATE" CLAUDE_PERMIT_GATE_TEST_FAIL_BOOTSTRAP="$(label "$provider")" "$ROOT/scripts/install-authority.sh" --home "$LIVE_HOME" "${common[@]}" >/dev/null 2>&1; then echo "expected bootstrap failure for $provider" >&2; exit 1; fi
  for restore in "${PROVIDERS[@]}"; do cmp "$special_output/LaunchAgents/$(label "$restore").plist" "$LIVE_HOME/Library/LaunchAgents/$(label "$restore").plist"; done
  test -f "$LIVE_STATE/$(label anthropic-a)"; test ! -f "$LIVE_STATE/$(label anthropic-b)"; test -f "$LIVE_STATE/$(label anthropic-c)"; test ! -f "$LIVE_STATE/$(label anthropic-d)"
  test "$(cat "$LIVE_HOME/Library/Application Support/Claude Permit Authority/deployment-v1.json")" = old-record
  test ! -e "$LIVE_HOME/Library/Application Support/Claude Permit Authority/releases/$(git -C "$ROOT" rev-parse HEAD)"
done
prepare_live
live_install
live_install
for provider in "${PROVIDERS[@]}"; do test -f "$LIVE_STATE/$(label "$provider")"; done
test -f "$LIVE_HOME/Library/Application Support/Claude Permit Authority/lanes/preserved-state"
CLAUDE_PERMIT_GATE_TEST_MODE=1 CLAUDE_PERMIT_GATE_TEST_LAUNCHCTL="$FAKE" CLAUDE_PERMIT_GATE_TEST_STATE="$LIVE_STATE" "$ROOT/scripts/install-authority.sh" --home "$LIVE_HOME" --uninstall
for provider in "${PROVIDERS[@]}"; do test ! -e "$LIVE_HOME/Library/LaunchAgents/$(label "$provider").plist"; done
test -f "$LIVE_HOME/Library/Application Support/Claude Permit Authority/lanes/preserved-state"
test -f "$LIVE_HOME/Library/Application Support/Claude Permit Authority/verifiers-v1.json"
test -f "$LIVE_HOME/Library/Logs/Claude Permit Authority/lanes/preserved.log"
test -d "$LIVE_HOME/Library/Application Support/Claude Permit Authority/releases"
live_install

echo 'authority installer edge matrix passed'
