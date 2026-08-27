#!/usr/bin/env bash
set -euo pipefail

readonly PROVIDERS=(anthropic-a anthropic-b anthropic-c anthropic-d)
readonly PORTS=(8791 8792 8793 8794)
readonly LABEL_PREFIX="com.longweekendprojects.claude-permit-lane"
readonly UUID_PATTERN='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

usage() {
  cat <<'USAGE'
Usage:
  scripts/install-authority.sh --dry-run --home <temporary-home> --output <temporary-output> \
    --authority-id <uuid> --account-binding-a <uuid> --account-binding-b <uuid> \
    --account-binding-c <uuid> --account-binding-d <uuid> \
    --offer-ttl-ms <ms> --renew-interval-ms <ms> --renew-deadline-ms <ms> \
    --terminal-retention-ms <ms> --h1-release v0.2.0 --h1-installed-build <commit> --h1-verified

A dry run requires explicit --home and --output. It writes only below --output. Live installation
stages an immutable commit release and atomically applies four user LaunchAgents with recovery.
USAGE
}

fail() { printf 'install-authority: %s\n' "$*" >&2; exit 1; }
require_value() { [ "$#" -ge 2 ] || fail "missing value for $1"; }
absolute_path() { case "$1" in /*) ;; *) fail "path must be absolute" ;; esac; }
valid_uuid() { [[ "$1" =~ $UUID_PATTERN ]]; }
valid_integer() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -le 9007199254740991 ]; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
label_for() { printf '%s.%s' "$LABEL_PREFIX" "$1"; }

DRY_RUN=0
HOME_DIRECTORY="${HOME:?HOME is required}"
HOME_EXPLICIT=0
OUTPUT_DIRECTORY=""
OUTPUT_EXPLICIT=0
RELEASE_ROOT=""
AUTHORITY_ID=""
ACCOUNT_BINDINGS=("" "" "" "")
OFFER_TTL_MS=""
RENEW_INTERVAL_MS=""
RENEW_DEADLINE_MS=""
TERMINAL_RETENTION_MS=""
H1_RELEASE=""
H1_INSTALLED_BUILD=""
H1_VERIFIED=0
ROLLBACK_LANE=""
UNINSTALL=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --home|--output|--release-root|--authority-id|--offer-ttl-ms|--renew-interval-ms|--renew-deadline-ms|--terminal-retention-ms|--h1-release|--h1-installed-build|--rollback-lane)
      require_value "$@"; option="$1"; value="$2"; shift 2
      case "$option" in
        --home) HOME_DIRECTORY="$value"; HOME_EXPLICIT=1 ;;
        --output) OUTPUT_DIRECTORY="$value"; OUTPUT_EXPLICIT=1 ;;
        --release-root) RELEASE_ROOT="$value" ;;
        --authority-id) AUTHORITY_ID="$value" ;;
        --offer-ttl-ms) OFFER_TTL_MS="$value" ;;
        --renew-interval-ms) RENEW_INTERVAL_MS="$value" ;;
        --renew-deadline-ms) RENEW_DEADLINE_MS="$value" ;;
        --terminal-retention-ms) TERMINAL_RETENTION_MS="$value" ;;
        --h1-release) H1_RELEASE="$value" ;;
        --h1-installed-build) H1_INSTALLED_BUILD="$value" ;;
        --rollback-lane) ROLLBACK_LANE="$value" ;;
      esac
      ;;
    --account-binding-a|--account-binding-b|--account-binding-c|--account-binding-d)
      require_value "$@"; option="$1"; value="$2"; shift 2
      case "$option" in
        --account-binding-a) ACCOUNT_BINDINGS[0]="$value" ;;
        --account-binding-b) ACCOUNT_BINDINGS[1]="$value" ;;
        --account-binding-c) ACCOUNT_BINDINGS[2]="$value" ;;
        --account-binding-d) ACCOUNT_BINDINGS[3]="$value" ;;
      esac
      ;;
    --h1-verified) H1_VERIFIED=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --help) usage; exit 0 ;;
    *) fail "unknown option" ;;
  esac
done

absolute_path "$HOME_DIRECTORY"
if [ "$OUTPUT_EXPLICIT" -eq 1 ]; then absolute_path "$OUTPUT_DIRECTORY"; fi
if [ -n "$RELEASE_ROOT" ]; then absolute_path "$RELEASE_ROOT"; fi
if [ "$DRY_RUN" -eq 1 ] && { [ "$HOME_EXPLICIT" -ne 1 ] || [ "$OUTPUT_EXPLICIT" -ne 1 ]; }; then fail "dry-run requires explicit --home and --output"; fi
if [ "$UNINSTALL" -eq 1 ] && { [ "$DRY_RUN" -eq 1 ] || [ -n "$ROLLBACK_LANE" ]; }; then fail "uninstall cannot be combined with dry-run or rollback"; fi
if [ -n "$ROLLBACK_LANE" ] && { [ "$DRY_RUN" -eq 1 ] || [ "$UNINSTALL" -eq 1 ]; }; then fail "rollback cannot be combined with dry-run or uninstall"; fi

AGENT_DIRECTORY="$HOME_DIRECTORY/Library/LaunchAgents"
AUTHORITY_DIRECTORY="$HOME_DIRECTORY/Library/Application Support/Claude Permit Authority"
STATE_DIRECTORY="$AUTHORITY_DIRECTORY/lanes"
LOG_DIRECTORY="$HOME_DIRECTORY/Library/Logs/Claude Permit Authority/lanes"
DEPLOYMENT_RECORD="$AUTHORITY_DIRECTORY/deployment-v1.json"
[ -n "$RELEASE_ROOT" ] || RELEASE_ROOT="$AUTHORITY_DIRECTORY/releases"

launchctl_bin() {
  if [ "${CLAUDE_PERMIT_GATE_TEST_MODE:-}" = "1" ] && [ -n "${CLAUDE_PERMIT_GATE_TEST_LAUNCHCTL:-}" ]; then
    printf '%s' "$CLAUDE_PERMIT_GATE_TEST_LAUNCHCTL"
  else
    [ -z "${CLAUDE_PERMIT_GATE_TEST_LAUNCHCTL:-}" ] || fail "test launchctl override requires test mode"
    printf '%s' /bin/launchctl
  fi
}
launchctl_call() { "$(launchctl_bin)" "$@"; }

if [ "$UNINSTALL" -eq 1 ]; then
  for provider in "${PROVIDERS[@]}"; do
    label="$(label_for "$provider")"
    launchctl_call bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$AGENT_DIRECTORY/$label.plist"
  done
  rm -f "$DEPLOYMENT_RECORD"
  printf '%s\n' 'authority jobs removed; state, verifiers, logs, releases, and rollback artifacts were preserved'
  exit 0
fi

if [ -n "$ROLLBACK_LANE" ]; then
  case " ${PROVIDERS[*]} " in *" $ROLLBACK_LANE "*) ;; *) fail "rollback lane is invalid" ;; esac
  label="$(label_for "$ROLLBACK_LANE")"
  current="$AGENT_DIRECTORY/$label.plist"
  rollback="$AGENT_DIRECTORY/$label.plist.rollback"
  [ -f "$rollback" ] || fail "no rollback artifact exists for lane"
  /usr/bin/plutil -lint "$rollback" >/dev/null || fail "rollback artifact is invalid"
  launchctl_call bootout "gui/$(id -u)/$label" 2>/dev/null || true
  cp -p "$rollback" "$current"
  launchctl_call bootstrap "gui/$(id -u)" "$current"
  printf '%s\n' "rolled back $ROLLBACK_LANE without changing authority state"
  exit 0
fi

valid_uuid "$AUTHORITY_ID" || fail "authority ID is invalid"
for binding in "${ACCOUNT_BINDINGS[@]}"; do valid_uuid "$binding" || fail "account binding ID is invalid"; done
for value in "$OFFER_TTL_MS" "$RENEW_INTERVAL_MS" "$RENEW_DEADLINE_MS" "$TERMINAL_RETENTION_MS"; do valid_integer "$value" || fail "timing must be an integer millisecond value"; done
[ "$OFFER_TTL_MS" -ge 5000 ] && [ "$OFFER_TTL_MS" -le 120000 ] || fail "offer TTL is outside protocol bounds"
[ "$RENEW_INTERVAL_MS" -ge 5000 ] && [ "$RENEW_INTERVAL_MS" -le 300000 ] || fail "renew interval is outside protocol bounds"
[ "$RENEW_DEADLINE_MS" -ge 15000 ] && [ "$RENEW_DEADLINE_MS" -le 3600000 ] && [ "$RENEW_DEADLINE_MS" -ge $((RENEW_INTERVAL_MS * 3)) ] || fail "renew deadline is unsafe"
[ "$TERMINAL_RETENTION_MS" -ge 86400000 ] || fail "terminal retention is unsafe"

SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
[ -f "$SOURCE_ROOT/deploy/com.longweekendprojects.claude-permit-lane.plist.in" ] || fail "deployment template is unavailable"
[ -z "$(git -C "$SOURCE_ROOT" status --porcelain)" ] || fail "source checkout must be clean to stage an immutable release"
COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify HEAD^{commit})"
PACKAGE_VERSION="$(node -p "require('$SOURCE_ROOT/package.json').version")"
EXPECTED_H1_RELEASE="$(node -p "require('$SOURCE_ROOT/package.json').authorityDeployment.h1Release")"
[ "$H1_RELEASE" = "$EXPECTED_H1_RELEASE" ] || fail "H1 release does not match package deployment metadata"
[ "$H1_VERIFIED" -eq 1 ] || fail "H1 installation verification is required"
H1_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse --verify "refs/tags/$H1_RELEASE^{commit}")" || fail "H1 release tag is unavailable"
[ "$H1_INSTALLED_BUILD" = "$H1_COMMIT" ] || fail "H1 installed build does not match the immutable release"
git -C "$SOURCE_ROOT" merge-base --is-ancestor "$H1_COMMIT" "$COMMIT" || fail "H1 release is not an ancestor of this build"
node "$SOURCE_ROOT/scripts/validate-authority-contract.mjs" >/dev/null || fail "authority schema validation failed"
SCHEMA_SHA256="$(sha256_file "$SOURCE_ROOT/protocol/authority-v1.schema.json")"
NODE_PATH="$(command -v node)"; absolute_path "$NODE_PATH"
BUILD_ID="pi-claude-permit-gate-${PACKAGE_VERSION}+git.${COMMIT:0:12}"

safe_output_root() {
  local parent base
  parent="$(dirname "$OUTPUT_DIRECTORY")"; base="$(basename "$OUTPUT_DIRECTORY")"
  [ -d "$parent" ] || fail "output parent does not exist"
  [ ! -L "$parent" ] || fail "output parent must not be a symlink"
  OUTPUT_DIRECTORY="$(cd "$parent" && pwd -P)/$base"
  [ ! -L "$OUTPUT_DIRECTORY" ] || fail "output must not be a symlink"
  if [ -e "$OUTPUT_DIRECTORY" ] && [ ! -d "$OUTPUT_DIRECTORY" ]; then fail "output is not a directory"; fi
}

generate_plist() {
  node --input-type=module - "$@" <<'NODE'
import fs from "node:fs";
const [file, label, nodePath, releasePath, provider, port, authorityId, bindingId, stateDirectory, buildId, offerTtl, renewInterval, renewDeadline, terminalRetention, outLog, errLog] = process.argv.slice(2);
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
const string = (value) => `    <string>${escape(value)}</string>`;
const environment = [["CLAUDE_PERMIT_GATE_DAEMON_MODE", "authority"], ["CLAUDE_PERMIT_GATE_PROVIDER", provider], ["CLAUDE_PERMIT_GATE_PORT", port], ["CLAUDE_PERMIT_GATE_AUTHORITY_ID", authorityId], ["CLAUDE_PERMIT_GATE_ACCOUNT_BINDING_ID", bindingId], ["CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR", stateDirectory], ["CLAUDE_PERMIT_GATE_AUTHORITY_BOOTSTRAP", "1"], ["CLAUDE_PERMIT_GATE_BUILD_ID", buildId], ["CLAUDE_PERMIT_GATE_OFFER_TTL_MS", offerTtl], ["CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS", renewInterval], ["CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS", renewDeadline], ["CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS", terminalRetention]];
const xml = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>", "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">", "<plist version=\"1.0\">", "<dict>", "  <key>Label</key>", `  <string>${escape(label)}</string>`, "  <key>ProgramArguments</key>", "  <array>", string(nodePath), string(`${releasePath}/permit-daemon.mjs`), "  </array>", "  <key>WorkingDirectory</key>", `  <string>${escape(releasePath)}</string>`, "  <key>EnvironmentVariables</key>", "  <dict>", ...environment.flatMap(([key, value]) => [`    <key>${key}</key>`, string(value)]), "  </dict>", "  <key>RunAtLoad</key>", "  <true/>", "  <key>KeepAlive</key>", "  <dict>", "    <key>SuccessfulExit</key>", "    <false/>", "  </dict>", "  <key>StandardOutPath</key>", `  <string>${escape(outLog)}</string>`, "  <key>StandardErrorPath</key>", `  <string>${escape(errLog)}</string>`, "</dict>", "</plist>", ""];
fs.writeFileSync(file, xml.join("\n"), { mode: 0o600, flag: "wx" });
NODE
}

write_manifest() {
  node --input-type=module - "$@" <<'NODE'
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const [manifestPath, commit, buildId, packageVersion, schemaSha256, h1Release, h1Commit, releasePath, plistDirectory, stateDirectory, logDirectory, ...providers] = process.argv.slice(2);
const ports = [8791, 8792, 8793, 8794];
const prefix = "com.longweekendprojects.claude-permit-lane";
const lanes = providers.map((provider, index) => { const label = `${prefix}.${provider}`; const plistPath = path.join(plistDirectory, `${label}.plist`); return { provider, port: ports[index], label, plistPath, plistSha256: crypto.createHash("sha256").update(fs.readFileSync(plistPath)).digest("hex"), statePath: path.join(stateDirectory, `lane-${ports[index]}.json`), outLogPath: path.join(logDirectory, `${provider}.out.log`), errLogPath: path.join(logDirectory, `${provider}.err.log`) }; });
fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, packageName: "pi-claude-permit-gate", packageVersion, commit, buildId, schemaSha256, h1: { release: h1Release, commit: h1Commit, installedBuild: h1Commit, operatorVerified: true }, releasePath, lanes }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
NODE
}

build_artifacts() {
  local root="$1" release_path="$2" release_tree="$3" plist_directory="$root/LaunchAgents" manifest="$root/authority-artifacts-v1.json"
  mkdir -p "$release_tree" "$plist_directory"
  git -C "$SOURCE_ROOT" archive --format=tar "$COMMIT" | tar -xf - -C "$release_tree"
  [ "$(sha256_file "$release_tree/protocol/authority-v1.schema.json")" = "$SCHEMA_SHA256" ] || fail "staged schema hash does not match"
  chmod -R a-w "$release_tree"
  for index in "${!PROVIDERS[@]}"; do
    local provider="${PROVIDERS[$index]}" port="${PORTS[$index]}" label plist
    label="$(label_for "$provider")"; plist="$plist_directory/$label.plist"
    generate_plist "$plist" "$label" "$NODE_PATH" "$release_path" "$provider" "$port" "$AUTHORITY_ID" "${ACCOUNT_BINDINGS[$index]}" "$STATE_DIRECTORY" "$BUILD_ID" "$OFFER_TTL_MS" "$RENEW_INTERVAL_MS" "$RENEW_DEADLINE_MS" "$TERMINAL_RETENTION_MS" "$LOG_DIRECTORY/$provider.out.log" "$LOG_DIRECTORY/$provider.err.log"
    /usr/bin/plutil -lint "$plist" >/dev/null || fail "generated plist is invalid"
  done
  write_manifest "$manifest" "$COMMIT" "$BUILD_ID" "$PACKAGE_VERSION" "$SCHEMA_SHA256" "$H1_RELEASE" "$H1_COMMIT" "$release_path" "$plist_directory" "$STATE_DIRECTORY" "$LOG_DIRECTORY" "${PROVIDERS[@]}"
  "$SOURCE_ROOT/scripts/validate-authority.sh" --artifacts-only --output "$root" --source-root "$SOURCE_ROOT" --release-tree "$release_tree"
}

if [ "$DRY_RUN" -eq 1 ]; then
  safe_output_root
  mkdir -p "$OUTPUT_DIRECTORY"
  FINAL_RELEASE="$OUTPUT_DIRECTORY/releases/$COMMIT"; FINAL_PLISTS="$OUTPUT_DIRECTORY/LaunchAgents"; FINAL_MANIFEST="$OUTPUT_DIRECTORY/authority-artifacts-v1.json"
  for destination in "$FINAL_RELEASE" "$FINAL_PLISTS" "$FINAL_MANIFEST"; do [ ! -e "$destination" ] || fail "artifact destination already exists"; done
  STAGE_DIRECTORY="$(mktemp -d "$OUTPUT_DIRECTORY/.authority-stage.XXXXXX")"
  published_releases=0; published_plists=0; published_manifest=0; succeeded=0
  cleanup_dry() { status=$?; if [ "$succeeded" -ne 1 ]; then [ "$published_manifest" -eq 0 ] || rm -f "$FINAL_MANIFEST"; [ "$published_plists" -eq 0 ] || rm -rf "$FINAL_PLISTS"; [ "$published_releases" -eq 0 ] || rm -rf "$OUTPUT_DIRECTORY/releases"; fi; rm -rf "$STAGE_DIRECTORY"; exit "$status"; }
  trap cleanup_dry EXIT
  build_artifacts "$STAGE_DIRECTORY" "$FINAL_RELEASE" "$STAGE_DIRECTORY/release"
  mkdir -p "$OUTPUT_DIRECTORY/releases"
  mv "$STAGE_DIRECTORY/release" "$FINAL_RELEASE"; published_releases=1
  mv "$STAGE_DIRECTORY/LaunchAgents" "$FINAL_PLISTS"; published_plists=1
  mv "$STAGE_DIRECTORY/authority-artifacts-v1.json" "$FINAL_MANIFEST"; published_manifest=1
  succeeded=1
  printf '%s\n' "dry-run staged four authority LaunchAgents at $OUTPUT_DIRECTORY"
  exit 0
fi

# Live work is preflighted before any job mutation. It is intentionally not exercised by this task.
STAGE_PARENT="$AUTHORITY_DIRECTORY/staging"
mkdir -p "$STAGE_PARENT"
STAGE_DIRECTORY="$(mktemp -d "$STAGE_PARENT/.authority-stage.XXXXXX")"
FINAL_RELEASE="$RELEASE_ROOT/$COMMIT"
RELEASE_WAS_PRESENT=0
if [ -e "$FINAL_RELEASE" ]; then
  [ -d "$FINAL_RELEASE" ] && [ ! -L "$FINAL_RELEASE" ] || fail "immutable release collision is invalid"
  "$SOURCE_ROOT/scripts/validate-authority.sh" --release-only --source-root "$SOURCE_ROOT" --release-tree "$FINAL_RELEASE" --commit "$COMMIT"
  RELEASE_WAS_PRESENT=1
fi
build_artifacts "$STAGE_DIRECTORY" "$FINAL_RELEASE" "$STAGE_DIRECTORY/release"

prior_present=(); prior_loaded=(); prior_rollback_present=()
for index in "${!PROVIDERS[@]}"; do
  provider="${PROVIDERS[$index]}"; label="$(label_for "$provider")"; current="$AGENT_DIRECTORY/$label.plist"; rollback="$current.rollback"
  if [ -e "$current" ]; then [ -f "$current" ] && [ ! -L "$current" ] || fail "existing plist is invalid"; /usr/bin/plutil -lint "$current" >/dev/null || fail "existing plist is invalid"; prior_present[$index]=1; mkdir -p "$STAGE_DIRECTORY/prior"; cp -p "$current" "$STAGE_DIRECTORY/prior/$index.plist"; else prior_present[$index]=0; fi
  if [ -e "$rollback" ]; then [ -f "$rollback" ] && [ ! -L "$rollback" ] || fail "existing rollback artifact is invalid"; /usr/bin/plutil -lint "$rollback" >/dev/null || fail "existing rollback artifact is invalid"; prior_rollback_present[$index]=1; mkdir -p "$STAGE_DIRECTORY/prior"; cp -p "$rollback" "$STAGE_DIRECTORY/prior/$index.rollback"; else prior_rollback_present[$index]=0; fi
  if launchctl_call print "gui/$(id -u)/$label" >/dev/null 2>&1; then prior_loaded[$index]=1; else prior_loaded[$index]=0; fi
done
if [ -e "$DEPLOYMENT_RECORD" ]; then [ -f "$DEPLOYMENT_RECORD" ] && [ ! -L "$DEPLOYMENT_RECORD" ] || fail "deployment record is invalid"; mkdir -p "$STAGE_DIRECTORY/prior"; cp -p "$DEPLOYMENT_RECORD" "$STAGE_DIRECTORY/prior/deployment.json"; deployment_present=1; else deployment_present=0; fi

recovery_failures=""
restore_attempt() {
  set +e
  for index in "${!PROVIDERS[@]}"; do
    provider="${PROVIDERS[$index]}"; label="$(label_for "$provider")"; current="$AGENT_DIRECTORY/$label.plist"; rollback="$current.rollback"
    launchctl_call bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
    if [ "${prior_present[$index]}" = 1 ]; then cp -p "$STAGE_DIRECTORY/prior/$index.plist" "$current" || recovery_failures="$recovery_failures plist:$provider"; else rm -f "$current" || recovery_failures="$recovery_failures remove:$provider"; fi
    if [ "${prior_rollback_present[$index]}" = 1 ]; then cp -p "$STAGE_DIRECTORY/prior/$index.rollback" "$rollback" || recovery_failures="$recovery_failures rollback:$provider"; else rm -f "$rollback" || recovery_failures="$recovery_failures remove-rollback:$provider"; fi
    if [ "${prior_loaded[$index]}" = 1 ]; then launchctl_call bootstrap "gui/$(id -u)" "$current" >/dev/null 2>&1 || recovery_failures="$recovery_failures load:$provider"; fi
  done
  if [ "$deployment_present" = 1 ]; then cp -p "$STAGE_DIRECTORY/prior/deployment.json" "$DEPLOYMENT_RECORD" || recovery_failures="$recovery_failures deployment"; else rm -f "$DEPLOYMENT_RECORD" || recovery_failures="$recovery_failures remove-deployment"; fi
  if [ "$RELEASE_WAS_PRESENT" = 0 ]; then rm -rf "$FINAL_RELEASE" || recovery_failures="$recovery_failures release"; fi
  set -e
}

attempt_active=1
on_live_exit() { status=$?; trap - EXIT; if [ "$attempt_active" = 1 ]; then restore_attempt; printf 'install-authority: rollout failed (exit %s); restoration failures:%s\n' "$status" "${recovery_failures:- none}" >&2; fi; rm -rf "$STAGE_DIRECTORY"; exit "$status"; }
trap on_live_exit EXIT
mkdir -p "$AGENT_DIRECTORY" "$RELEASE_ROOT" "$STATE_DIRECTORY" "$LOG_DIRECTORY"
if [ "$RELEASE_WAS_PRESENT" = 0 ]; then mv "$STAGE_DIRECTORY/release" "$FINAL_RELEASE"; fi
for index in "${!PROVIDERS[@]}"; do
  provider="${PROVIDERS[$index]}"; label="$(label_for "$provider")"; source_plist="$STAGE_DIRECTORY/LaunchAgents/$label.plist"; destination_plist="$AGENT_DIRECTORY/$label.plist"
  if [ "${prior_loaded[$index]}" = 1 ]; then launchctl_call bootout "gui/$(id -u)/$label"; fi
  cp -p "$source_plist" "$destination_plist"
  launchctl_call bootstrap "gui/$(id -u)" "$destination_plist"
  if [ "${prior_present[$index]}" = 1 ]; then cp -p "$STAGE_DIRECTORY/prior/$index.plist" "$destination_plist.rollback"; fi
done
cp -p "$STAGE_DIRECTORY/authority-artifacts-v1.json" "$DEPLOYMENT_RECORD"
attempt_active=0
trap - EXIT
rm -rf "$STAGE_DIRECTORY"
printf '%s\n' "installed four authority jobs from immutable commit $COMMIT"
