#!/usr/bin/env bash
# Live cutover for the Ruminaider authority. Stops the four local A-D daemons only while they
# are provably idle, bootstraps lane state offline, installs the four immutable LaunchAgents,
# and adds private Tailscale Serve listeners one lane at a time. Existing Funnel routes on 8443
# and 10000 are never touched: this script only ever adds 8791-8794.
#
# Run detached. Lane A (8791) carries the Pi session that usually drives this work, so the
# session dies partway through and the script must outlive it.
set -uo pipefail

readonly PROVIDERS=(anthropic-a anthropic-b anthropic-c anthropic-d)
readonly PORTS=(8791 8792 8793 8794)
readonly BINDINGS=(6da67cea-ef88-4093-94b8-54b39c1b1ea2 49c0e5bf-478c-4752-ab23-89f7e8b64626 417c2d6d-edce-4811-bcb2-5567e6fbb683 5f612820-7146-4757-abd0-3cbab41732ee)
readonly AUTHORITY_ID=ce298942-e550-44f2-8566-b45ea813d01c
readonly H1_COMMIT=7f3ce003252d272b6ce1f51033b4255c2bb4379f
readonly REPO=/Users/albertgwo/Repositories/pi-claude-permit-gate
readonly NODE=/Users/albertgwo/.nvm/versions/node/v22.19.0/bin/node
readonly TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
readonly LOG="$HOME/Library/Logs/Claude Permit Authority/cutover-$(date +%Y%m%dT%H%M%S).log"

# `authority-admin` reads lane timing from the environment. Only the generated plists carry
# these values, so an offline bootstrap has to export the same four numbers itself.
export CLAUDE_PERMIT_GATE_OFFER_TTL_MS=15000
export CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS=30000
export CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS=120000
export CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS=86400000

mkdir -p "$(dirname "$LOG")"
exec >>"$LOG" 2>&1
say() { printf '[%s] %s\n' "$(date -u +%FT%TZ)" "$*"; }

say "cutover starting"

# 1. Prove every lane is idle twice, at least two seconds apart, before stopping anything.
for index in "${!PORTS[@]}"; do
  port="${PORTS[$index]}"
  if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    say "lane $port has no listener already; nothing to drain"
    continue
  fi
  for sample in 1 2; do
    reading="$(curl -sS --max-time 2 "http://127.0.0.1:$port/health" | /opt/homebrew/bin/jq -c '{active,queued}' 2>/dev/null)"
    say "lane $port sample $sample: ${reading:-unreachable}"
    if [ "$reading" != '{"active":0,"queued":0}' ]; then
      say "ABORT: lane $port is not idle"
      exit 1
    fi
    [ "$sample" = 1 ] && sleep 2
  done
done
say "all four lanes idle twice"

# 2. Stop the local daemons. Each lane must free its port before bootstrap can reserve it.
for port in "${PORTS[@]}"; do
  pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
  if [ -n "$pid" ]; then
    say "stopping lane $port (pid $pid)"
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 20); do
      lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 || break
      sleep 0.5
    done
  fi
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    say "ABORT: lane $port still has a listener"
    exit 1
  fi
  say "lane $port is offline"
done

# 3. Bootstrap lane state offline. Routine startup fails closed without this.
for index in "${!PROVIDERS[@]}"; do
  provider="${PROVIDERS[$index]}"
  port="${PORTS[$index]}"
  state="$HOME/Library/Application Support/Claude Permit Authority/lanes/lane-$port.json"
  if [ -f "$state" ]; then
    say "lane state already exists for $provider; skipping bootstrap"
    continue
  fi
  if "$NODE" "$REPO/scripts/authority-admin.mjs" bootstrap --provider "$provider" --authority-id "$AUTHORITY_ID"; then
    say "bootstrapped $provider"
  else
    say "ABORT: bootstrap failed for $provider"
    exit 1
  fi
done

# 4. Install the four immutable LaunchAgents.
if "$REPO/scripts/install-authority.sh" \
  --authority-id "$AUTHORITY_ID" \
  --account-binding-a "${BINDINGS[0]}" --account-binding-b "${BINDINGS[1]}" \
  --account-binding-c "${BINDINGS[2]}" --account-binding-d "${BINDINGS[3]}" \
  --offer-ttl-ms 15000 --renew-interval-ms 30000 --renew-deadline-ms 120000 \
  --terminal-retention-ms 86400000 --h1-release v0.2.0 --h1-installed-build "$H1_COMMIT" --h1-verified; then
  say "installed four LaunchAgents"
else
  say "ABORT: installation failed"
  exit 1
fi

# 5. Verify one launchd-owned process per port.
sleep 5
for index in "${!PORTS[@]}"; do
  port="${PORTS[$index]}"
  provider="${PROVIDERS[$index]}"
  count="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | wc -l | tr -d ' ')"
  health="$(curl -sS --max-time 2 "http://127.0.0.1:$port/v1/health" | /opt/homebrew/bin/jq -c '{status,provider,authorityId,protocolVersion}' 2>/dev/null)"
  say "lane $port listeners=$count health=${health:-unreachable}"
  launchctl print "gui/$(id -u)/com.longweekendprojects.claude-permit-lane.$provider" >/dev/null 2>&1 &&
    say "lane $port launchd job is loaded" || say "WARNING: lane $port launchd job is not loaded"
done

# 6. Add private Serve listeners one lane at a time. Additive only: no reset, no set-config.
for port in "${PORTS[@]}"; do
  if "$TAILSCALE" serve --bg --https "$port" "http://127.0.0.1:$port"; then
    say "serve route added for $port"
  else
    say "WARNING: serve route failed for $port"
  fi
  sleep 2
done

say "serve status after cutover:"
"$TAILSCALE" serve status --json

say "cutover finished"
