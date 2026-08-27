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

The non-dry-run install path uses the same checked inputs, stages an immutable release from the
current clean commit, then loads four per-user LaunchAgents. --rollback-lane and --uninstall
preserve authority state, verifier, logs, and staged releases.
USAGE
}

fail() { printf 'install-authority: %s\n' "$*" >&2; exit 1; }
require_value() { [ "$#" -ge 2 ] || fail "missing value for $1"; }
absolute_path() { case "$1" in /*) ;; *) fail "path must be absolute" ;; esac; }
valid_uuid() { [[ "$1" =~ $UUID_PATTERN ]]; }
valid_integer() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -le 9007199254740991 ]; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"; }

DRY_RUN=0
HOME_DIRECTORY="${HOME:?HOME is required}"
OUTPUT_DIRECTORY=""
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
        --home) HOME_DIRECTORY="$value" ;;
        --output) OUTPUT_DIRECTORY="$value" ;;
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
if [ -n "$OUTPUT_DIRECTORY" ]; then absolute_path "$OUTPUT_DIRECTORY"; fi
if [ -n "$RELEASE_ROOT" ]; then absolute_path "$RELEASE_ROOT"; fi
if [ "$UNINSTALL" -eq 1 ] && { [ "$DRY_RUN" -eq 1 ] || [ -n "$ROLLBACK_LANE" ]; }; then fail "uninstall cannot be combined with dry-run or rollback"; fi
if [ -n "$ROLLBACK_LANE" ] && { [ "$DRY_RUN" -eq 1 ] || [ "$UNINSTALL" -eq 1 ]; }; then fail "rollback cannot be combined with dry-run or uninstall"; fi

AGENT_DIRECTORY="$HOME_DIRECTORY/Library/LaunchAgents"
AUTHORITY_DIRECTORY="$HOME_DIRECTORY/Library/Application Support/Claude Permit Authority"
STATE_DIRECTORY="$AUTHORITY_DIRECTORY/lanes"
LOG_DIRECTORY="$HOME_DIRECTORY/Library/Logs/Claude Permit Authority/lanes"
DEPLOYMENT_RECORD="$AUTHORITY_DIRECTORY/deployment-v1.json"
[ -n "$RELEASE_ROOT" ] || RELEASE_ROOT="$AUTHORITY_DIRECTORY/releases"

if [ "$UNINSTALL" -eq 1 ]; then
  [ "$DRY_RUN" -eq 0 ] || fail "uninstall dry-run is not supported"
  for index in "${!PROVIDERS[@]}"; do
    label="$LABEL_PREFIX.${PROVIDERS[$index]}"
    /bin/launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$AGENT_DIRECTORY/$label.plist"
  done
  rm -f "$DEPLOYMENT_RECORD"
  printf '%s\n' 'authority jobs removed; state, verifiers, logs, and releases were preserved'
  exit 0
fi

if [ -n "$ROLLBACK_LANE" ]; then
  case " ${PROVIDERS[*]} " in *" $ROLLBACK_LANE "*) ;; *) fail "rollback lane is invalid" ;; esac
  label="$LABEL_PREFIX.$ROLLBACK_LANE"
  current="$AGENT_DIRECTORY/$label.plist"
  rollback="$AGENT_DIRECTORY/$label.plist.rollback"
  [ -f "$rollback" ] || fail "no rollback artifact exists for lane"
  /usr/bin/plutil -lint "$rollback" >/dev/null || fail "rollback artifact is invalid"
  /bin/launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  cp -p "$rollback" "$current"
  /bin/launchctl bootstrap "gui/$(id -u)" "$current"
  printf '%s\n' "rolled back $ROLLBACK_LANE without changing authority state"
  exit 0
fi

[ "$DRY_RUN" -eq 0 ] || [ -n "$OUTPUT_DIRECTORY" ] || fail "dry-run requires --output"
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
NODE_PATH="$(command -v node)"
absolute_path "$NODE_PATH"
BUILD_ID="pi-claude-permit-gate-$PACKAGE_VERSION+git.${COMMIT:0:12}"

if [ "$DRY_RUN" -eq 1 ]; then
  ARTIFACT_ROOT="$OUTPUT_DIRECTORY"
  STAGED_RELEASE="$ARTIFACT_ROOT/releases/$COMMIT"
else
  ARTIFACT_ROOT="$AUTHORITY_DIRECTORY/staging/$COMMIT"
  STAGED_RELEASE="$RELEASE_ROOT/$COMMIT"
fi
PLIST_DIRECTORY="$ARTIFACT_ROOT/LaunchAgents"
[ ! -e "$STAGED_RELEASE" ] || fail "immutable release already exists"
umask 077
mkdir -p "$STAGED_RELEASE" "$PLIST_DIRECTORY" "$STATE_DIRECTORY" "$LOG_DIRECTORY"
git -C "$SOURCE_ROOT" archive --format=tar "$COMMIT" | tar -xf - -C "$STAGED_RELEASE"
[ "$(sha256_file "$STAGED_RELEASE/protocol/authority-v1.schema.json")" = "$SCHEMA_SHA256" ] || fail "staged schema hash does not match"
chmod -R a-w "$STAGED_RELEASE"

for index in "${!PROVIDERS[@]}"; do
  provider="${PROVIDERS[$index]}"
  port="${PORTS[$index]}"
  label="$LABEL_PREFIX.$provider"
  plist="$PLIST_DIRECTORY/$label.plist"
  release_xml="$(xml_escape "$STAGED_RELEASE")"
  sed \
    -e "s|__LABEL__|$(xml_escape "$label")|g" \
    -e "s|__NODE_PATH__|$(xml_escape "$NODE_PATH")|g" \
    -e "s|__RELEASE_PATH__|$release_xml|g" \
    -e "s|__PROVIDER__|$provider|g" \
    -e "s|__PORT__|$port|g" \
    -e "s|__AUTHORITY_ID__|$AUTHORITY_ID|g" \
    -e "s|__ACCOUNT_BINDING_ID__|${ACCOUNT_BINDINGS[$index]}|g" \
    -e "s|__STATE_DIRECTORY__|$(xml_escape "$STATE_DIRECTORY")|g" \
    -e "s|__BUILD_ID__|$BUILD_ID|g" \
    -e "s|__OFFER_TTL_MS__|$OFFER_TTL_MS|g" \
    -e "s|__RENEW_INTERVAL_MS__|$RENEW_INTERVAL_MS|g" \
    -e "s|__RENEW_DEADLINE_MS__|$RENEW_DEADLINE_MS|g" \
    -e "s|__TERMINAL_RETENTION_MS__|$TERMINAL_RETENTION_MS|g" \
    -e "s|__OUT_LOG_PATH__|$(xml_escape "$LOG_DIRECTORY/$provider.out.log")|g" \
    -e "s|__ERR_LOG_PATH__|$(xml_escape "$LOG_DIRECTORY/$provider.err.log")|g" \
    "$SOURCE_ROOT/deploy/com.longweekendprojects.claude-permit-lane.plist.in" > "$plist"
  /usr/bin/plutil -lint "$plist" >/dev/null || fail "generated plist is invalid"
done

MANIFEST="$ARTIFACT_ROOT/authority-artifacts-v1.json"
node --input-type=module - "$MANIFEST" "$COMMIT" "$BUILD_ID" "$PACKAGE_VERSION" "$SCHEMA_SHA256" "$H1_RELEASE" "$H1_COMMIT" "$STAGED_RELEASE" "$PLIST_DIRECTORY" "$STATE_DIRECTORY" "$LOG_DIRECTORY" "${PROVIDERS[@]}" <<'NODE'
import fs from "node:fs";
import path from "node:path";
const [manifestPath, commit, buildId, packageVersion, schemaSha256, h1Release, h1Commit, releasePath, plistDirectory, stateDirectory, logDirectory, ...providers] = process.argv.slice(2);
const ports = [8791, 8792, 8793, 8794];
const labelPrefix = "com.longweekendprojects.claude-permit-lane";
const lanes = providers.map((provider, index) => {
  const label = `${labelPrefix}.${provider}`;
  const plistPath = path.join(plistDirectory, `${label}.plist`);
  return { provider, port: ports[index], label, plistPath, plistSha256: "", statePath: path.join(stateDirectory, `lane-${ports[index]}.json`), outLogPath: path.join(logDirectory, `${provider}.out.log`), errLogPath: path.join(logDirectory, `${provider}.err.log`) };
});
for (const lane of lanes) lane.plistSha256 = (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(lane.plistPath)).digest("hex");
fs.writeFileSync(manifestPath, `${JSON.stringify({ schemaVersion: 1, packageName: "pi-claude-permit-gate", packageVersion, commit, buildId, schemaSha256, h1: { release: h1Release, commit: h1Commit, installedBuild: h1Commit, operatorVerified: true }, releasePath, lanes }, null, 2)}\n`, { mode: 0o600 });
NODE

"$SOURCE_ROOT/scripts/validate-authority.sh" --artifacts-only --output "$ARTIFACT_ROOT" --source-root "$SOURCE_ROOT"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '%s\n' "dry-run staged four authority LaunchAgents at $ARTIFACT_ROOT"
  exit 0
fi

mkdir -p "$AGENT_DIRECTORY" "$RELEASE_ROOT"
[ -d "$RELEASE_ROOT/$COMMIT" ] || fail "immutable release staging is unavailable"
for provider in "${PROVIDERS[@]}"; do
  label="$LABEL_PREFIX.$provider"
  source_plist="$PLIST_DIRECTORY/$label.plist"
  destination_plist="$AGENT_DIRECTORY/$label.plist"
  if [ -f "$destination_plist" ]; then cp -p "$destination_plist" "$destination_plist.rollback"; /bin/launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true; fi
  cp -p "$source_plist" "$destination_plist"
  /bin/launchctl bootstrap "gui/$(id -u)" "$destination_plist"
done
cp -p "$MANIFEST" "$DEPLOYMENT_RECORD"
printf '%s\n' "installed four authority jobs from immutable commit $COMMIT"
