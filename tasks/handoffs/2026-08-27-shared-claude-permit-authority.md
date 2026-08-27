# Shared Claude permit authority handoff

Recorded on 2026-08-27 at 10:58 EDT for the next orchestration session.

## Goal of the lane

Two Macs should share the same Claude Account A-D permit capacity and see the freshest safe allowance observations, so concurrent Pi sessions cannot independently exceed one account’s capacity or show misleading local-only usage. Anthropic provider traffic must remain direct; Ruminaider schedules permits and stores sanitized allowance observations but never proxies provider requests.

Definition of done: Ruminaider runs four authenticated authority jobs for lanes A-D; both Macs use fail-closed `authority-client` mode with no local A-D listener or fallback; A-D account fingerprints match cryptographically across both Macs; private Tailscale Serve exposes only ports 8791-8794 under an audited narrow Tailnet grant; both menus converge on authority-accepted allowance truth; and measured two-Mac tests prove capacity, reconnect stability, machine/session fairness, authentication denial, outage behavior, restart recovery, and rollback safety. A runtime change is complete only after deployment and these efficacy readings pass.

The recommended user-scoped LaunchAgents are available only while Ruminaider’s user is logged in. True pre-login availability would require a separately approved LaunchDaemon, system-account, and secret design and is outside the locked plan.

## Current state

**0 of 4 shared-authority LaunchAgents are deployed, so cross-Mac permit sharing is not live.** Re-pull the headline with:

```sh
find "$HOME/Library/LaunchAgents" -maxdepth 1 -name 'com.longweekendprojects.claude-permit-lane.*.plist' -print | wc -l
```

The build is green at **24 of 24 tests: 21 Node and 3 Swift**. Re-pull it with:

```sh
cd /Users/albertgwo/Repositories/pi-claude-permit-gate && npm test
cd /Users/albertgwo/Repositories/pi-claude-lane-monitor && scripts/test.sh
```

At 10:58 EDT, port 8791 had `active=1, queued=0`; the other A-D ports had `active=0, queued=0`. This changes continuously and must be re-measured before trusting it:

```sh
for p in 8791 8792 8793 8794; do
  curl -sS --max-time 1 "http://127.0.0.1:$p/health" |
    jq -c --argjson port "$p" '{port:$port,version,protocolVersion,provider,instanceId,startedAt,active,queued,current,max}'
done
```

The permit repository is on clean `main` at `b2e9dcc`, 39 commits ahead of `origin/main` (`6d8d41d`). The only expected change after this handoff is this uncommitted handoff file. The monitor repository is on clean `main` at `8b06032`, has no remote, and its latest shared-authority app bundle is built but not installed.

## Completed and verified

- **VERIFIED:** The local menu bar product is installed and running at `~/Applications/Claude Lane Monitor.app`. Evidence: PID 5513 was running that exact binary at 10:59 EDT; local install validation is recorded in `/Users/albertgwo/Repositories/pi-claude-lane-monitor/tasks/validation/local-install.md`.
- **VERIFIED:** The installed menu remains the earlier local-only build, not the latest shared-authority build. Evidence: built binary SHA-256 `2950c852d793dbd3abb451aedd6c149a5f633dd267e18285528b4fbe462816a1` differs from installed binary SHA-256 `a8aec3f24b2cd7896e20b820476ee6e6b411a76587e695b391a4f4a642f7ff35`; recheck with `shasum -a 256 /Users/albertgwo/Repositories/pi-claude-lane-monitor/.build/app/'Claude Lane Monitor.app'/Contents/MacOS/ClaudeLaneMonitor "$HOME/Applications/Claude Lane Monitor.app/Contents/MacOS/ClaudeLaneMonitor"`.
- **VERIFIED:** The shared-authority architecture and execution order are locked in `/Users/albertgwo/Repositories/pi-claude-permit-gate/tasks/plans/shared-authority.md`. It assigns build Tasks 1-9 as complete code work and leaves live Tasks 10-12 behind approval, access, identity, policy, and maintenance gates.
- **VERIFIED:** The canonical wire contract exists at `/Users/albertgwo/Repositories/pi-claude-permit-gate/docs/authority-protocol-v1.md` with schema `/Users/albertgwo/Repositories/pi-claude-permit-gate/protocol/authority-v1.schema.json`. Evidence: `node scripts/validate-authority-contract.mjs` validated 28 valid and 21 invalid fixtures with SHA-256 `d2bbd240177a87fd76bb1f3c89b69d0165cb32d6b39e3f3079fdb668bd2b6816` at 10:59 EDT.
- **VERIFIED:** The authority scheduler implements reconnect-stable tickets, nested machine/session fairness, persisted replay ledgers, lane-term fencing, offer expiry, exact-once completion, cooldown state, and uncertain active-work quarantine. Evidence: the authority cases in `npm test` passed at 10:58 EDT, including replay/compaction, renew/uncertain, throttle completion, fairness/restart, persistence faults, and allowance replay.
- **VERIFIED:** Routine authority startup fails closed when established state is missing. Evidence: commits `315ae40` through `cf7070c` removed permanent bootstrap from generated jobs, require explicit offline bootstrap, and passed `test/authority-install-artifacts.sh`; details are in `/Users/albertgwo/Repositories/pi-claude-permit-gate/tasks/validation/shared-authority-build.md`.
- **VERIFIED:** Read-only authentication durably fences verifier rollback. Evidence: the existing verifier-generation Node case covers observing generation N+1 on a read, rollback to N, and restart; it passed in the 21/21 run at 10:58 EDT.
- **VERIFIED:** The authority supports scoped bearer verification and offline bootstrap, enrollment, rotation, revocation, drain, resume, and uncertain reconciliation without plaintext verifier storage. Evidence: `scripts/authority-admin.mjs`, the canonical protocol, and the passing authentication/restart cases.
- **VERIFIED:** `authority-client` mode is structurally separate from local mode and has no loopback spawn or local fallback path. Evidence: `index.ts` and the passing test `authority-client rejects mixed configuration and resumes one acknowledged ticket without local capability`.
- **VERIFIED:** Allowance publication acknowledgements bind authority, lane/port, provider, account binding, installation, publish ID, sequence, and observation identity. Evidence: current schema fixtures under `pi-claude-lane-monitor/Tests/ClaudeLaneMonitorTests/Fixtures/authority-v1/`, strict Swift decoding, and the passing Node/Swift contract tests. Delayed subagent alerts claiming the response was only `{allowance,replayed}` referred to an earlier commit and are stale.
- **VERIFIED:** The monitor implements authenticated shared snapshot reads, authority-accepted caching, strict no-fallback source composition, sanitized durable publication, explicit null encoding, bounded retry queues, file-watcher recovery, and source/offline/last-observed copy. Evidence: `scripts/test.sh` passed all 3 Swift tests at 10:58 EDT and validated the canonical schema digest first.
- **VERIFIED:** The monitor still has exactly 3 implemented `@Test` methods. Evidence: `rg -n '^@Test' Tests/ClaudeLaneMonitorTests/LaneSnapshotTests.swift | wc -l` returned 3.
- **VERIFIED:** The permit repository still has 21 top-level Node `test()` calls, including all original 12 and nine shared-authority cases. Evidence: `rg -n '^test\(' test | wc -l` returned 21 and `npm test` passed 21/21.
- **VERIFIED:** Immutable authority packaging and safe rollout helpers are implemented. Evidence: package version is `0.3.0`; `deploy/com.longweekendprojects.claude-permit-lane.plist.in`, `scripts/install-authority.sh`, `scripts/validate-authority.sh`, `scripts/account-fingerprint.mjs`, `scripts/validate-peer.sh`, and `deploy/tailscale/permit-authority-grant.hujson.example` are tracked; the isolated installer and policy matrices passed as recorded in `tasks/validation/shared-authority-build.md`.
- **VERIFIED:** No live authority job was installed and no Serve route was added. Evidence: LaunchAgent count returned 0; `Tailscale serve status --json` contained only existing HTTPS/Funnel ports 8443 and 10000 at 10:58 EDT.
- **VERIFIED:** Existing provider traffic remains direct to Anthropic. Evidence: the design and implementation expose scheduling/snapshot endpoints only; no provider proxy is present in the protocol or daemon.
- **VERIFIED:** The live Pi package remains pinned to `git:github.com/longweekendprojects/pi-claude-permit-gate@v0.2.0` in `~/.pi/agent/settings.json`. The unpushed repository package is `0.3.0`; no publication or settings edit occurred.
- **VERIFIED:** Ruminaider is `ruminaider.tail252378.ts.net` at `100.103.181.53`. The likely peer `albert-aviary-mac.tail252378.ts.net` at `100.100.166.117` was online and answered a Tailscale ping over DERP(nyc) in 35 ms at 10:59 EDT.
- **UNVERIFIED:** The second Mac’s Pi installation, lane mapping, local listeners, Keychain readiness, installed build, and monitor mode have not been inspected because no interactive peer access is available.
- **UNVERIFIED:** A-D account identities have not been matched across both Macs. Matching provider aliases is insufficient; the SHA-256 fingerprints must be derived from both `account.uuid` and `organization.uuid` through `scripts/account-fingerprint.mjs`.
- **UNVERIFIED:** Live Keychain provisioning, verifier state, authority state bootstrap, production timing, four LaunchAgents, private Serve listeners, Tailnet grants, two-Mac fairness, allowance convergence, restart recovery, and rollback have not been exercised.
- **UNVERIFIED:** The current Background Task Management registration was not revalidated during this handoff because `sfltool dumpbtm` timed out. Earlier local-install validation passed, but remeasure before changing or reinstalling the app.

## Remaining work

1. **UNVERIFIED, owner decision required:** Confirm that `albert-aviary-mac.tail252378.ts.net` is the intended second Pi Mac and choose either temporary Remote Login or an operator-run redacted readiness/install workflow. Do not infer identity from the hostname alone.
2. **UNVERIFIED, publication approval required:** Review and push the permit repository’s 39 local commits, create the intended immutable `v0.3.0` release/tag, and update both Pi installations from `v0.2.0`. The monitor has no remote; decide whether it remains a local app build or receives an approved distribution path.
3. **UNVERIFIED, peer access required:** Inspect the second Mac with `scripts/validate-peer.sh` or equivalent approved read-only commands. Confirm authority-client-capable build, stable installation identity, Keychain lookup, and no local A-D listeners before cutover.
4. **UNVERIFIED, identity approval required:** Run `scripts/account-fingerprint.mjs` for A-D on both Macs after each access token is naturally valid or deliberately reauthenticated. Compare all four fingerprints out of band, then create random account-binding UUIDs only after all four match.
5. **UNVERIFIED, credential approval required:** Create separate `permit:mutate`, `snapshot:read`, and `allowance:publish` Keychain items for each installation; enroll only SHA-256 verifiers with `scripts/authority-admin.mjs`. Never put bearer values in argv, environment, files, logs, fixtures, chat, or this handoff.
6. **UNVERIFIED, measurement required:** Measure DERP claim p99 and provider-duration p99, verify clocks differ by at most 30 seconds, and choose explicit offer TTL, renewal interval/deadline, and terminal retention values. The installer intentionally has no production timing defaults.
7. **UNVERIFIED, Tailnet-owner approval required:** Replace the unresolved peer placeholder in `deploy/tailscale/permit-authority-grant.hujson.example`, audit the entire existing Tailnet policy for broader matching rules, and approve the narrow self-plus-peer grant to Ruminaider TCP 8791-8794.
8. **UNVERIFIED, maintenance approval required:** For each live lane daemon, record `active=0, queued=0` twice at least two seconds apart immediately before stopping it. Never stop all daemons at once, never stop a busy daemon, and never treat an old reading as approval.
9. **UNVERIFIED, live deployment required:** Explicitly bootstrap four lane states offline, install four immutable LaunchAgents, verify one launchd-owned loopback process per port, and add private Tailscale Serve listeners one lane at a time. Preserve existing 8443 and 10000 Funnel routes byte-for-byte; do not use Funnel, reset, `serve set-config`, or whole-config replacement.
10. **UNVERIFIED, coordinated cutover required:** Install/configure the latest monitor and permit client on both Macs without enabling them, drain old local work, stop second-Mac local A-D daemons, restart every Pi process that loaded old code, then enable authority-client and authority monitor/publisher mode together. Mixed local/shared mutation is prohibited.
11. **UNVERIFIED, efficacy required:** Measure central capacity, durable reconnect, nested fairness, auth denial before mutation, shared allowance convergence, no client-side listeners/fallback, authority outage/logout behavior, verifier rotation/revocation, restart recovery, and lane-isolated rollback. Record exact commands and readings in a deployment validation artifact before calling the lane done.

## Key context

The canonical product decisions are in `/Users/albertgwo/Repositories/pi-claude-permit-gate/tasks/discovery/decision-brief.md`, the implementation order is in `/Users/albertgwo/Repositories/pi-claude-permit-gate/tasks/plans/shared-authority.md`, the wire owner is `/Users/albertgwo/Repositories/pi-claude-permit-gate/docs/authority-protocol-v1.md`, and completed build evidence is `/Users/albertgwo/Repositories/pi-claude-permit-gate/tasks/validation/shared-authority-build.md`.

Permit repository: `/Users/albertgwo/Repositories/pi-claude-permit-gate`, branch `main`, HEAD `b2e9dcc`, `origin/main` `6d8d41d`, 39 commits ahead, remote `https://github.com/longweekendprojects/pi-claude-permit-gate.git`, package `0.3.0`. Released tags are only `v0.1.0` and `v0.2.0`; `v0.2.0` points to `7f3ce00`. No push, new tag, release, or PR was created.

Monitor repository: `/Users/albertgwo/Repositories/pi-claude-lane-monitor`, branch `main`, HEAD `8b06032`, no remote. Built app: `/Users/albertgwo/Repositories/pi-claude-lane-monitor/.build/app/Claude Lane Monitor.app`. Installed older app: `/Users/albertgwo/Applications/Claude Lane Monitor.app`.

Live local endpoints at 10:58 EDT were schema-3 without authority provenance on 8790-8791 and schema-1 legacy on 8792-8794. Exact live PIDs were 8790=`47081`, 8791=`98661`, 8792=`16426`, 8793=`22049`, and 8794=`15142`; PIDs are ephemeral and must be re-pulled with `lsof -nP -iTCP:8790-8794 -sTCP:LISTEN`.

`local` remains the default. `authority-client` must validate complete configuration before registering hooks and must contain no loopback probe, daemon spawn, or local fallback. Both Macs, including Ruminaider, use the private MagicDNS HTTPS authority endpoint during shared operation. The authority schedules permits only; Claude traffic goes directly to Anthropic.

Four independent authority processes on ports 8791-8794 are intentional. One implementation launched four times preserves lane state, cooldown, capacity, and failure isolation without a gateway transaction seam.

A durable ticket owns queue position, not an HTTP connection. Scheduling is round-robin by authenticated installation and then by opaque Pi session. An offered ticket can expire before provider work starts. Active unacknowledged work becomes `uncertain` and continues consuming capacity because the client cannot fence an already-started Anthropic request.

Sanitized allowance files under `~/.pi/agent/usage-windows/<provider>.json` remain last-observed response signals. Never synthesize 0%, overwrite original observation time, publish OAuth data, or treat a passed reset as current. Authority mode shows only authority-accepted data and labels cached data last-observed/offline when unreachable.

Each installation needs separate Keychain references for mutation, snapshot reads, and allowance publication. The authority stores verifiers only. Account lane letters must be cryptographically compared across both machines using both account and organization UUIDs; provider aliases alone do not prove identity.

Private Tailscale Serve must be additive on 8791-8794 and preserve unrelated Funnel routes on 8443 and 10000 exactly. Use `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; do not reuse `/Users/albertgwo/Services/tailscale-auth` as the permit security boundary without a new approved design.

Do not edit `/Users/albertgwo/Repositories/pi-dotfiles` or `/Users/albertgwo/.pi/agent/extensions/usage-windows.ts`. Do not push, publish, add a monitor remote, install shared builds, access live Keychain, change Tailnet/Serve, replace daemons, or stop live work without explicit approval. Never include secrets in configuration; use Keychain/environment references only.

Delayed intercom alerts from old review runs are stale. The final review found and remediated permanent bootstrap, read-only verifier rollback, monitor source/offline wording, stale protocol links, allowance acknowledgement identity, and fixture-count drift. There are no active supervisor requests. Do not restart those old workflows or rebuild fixes they already landed.

The routed Anthropic Oracle and several paired reviewers hit 429 rate limits during final review. Final review coverage was therefore medium rather than fully cross-family, but the evidence-backed findings were remediated and both complete local test ladders pass. Do not report unavailable review coverage as a code failure; rerun a focused review only if a new diff is introduced.

## Diagnosed causes are hypotheses until measured

- **CONFIRMED boundary, HYPOTHESIS cause:** The second Mac is reachable over Tailnet but TCP 22 refused the connection at 10:59 EDT. The refusal is confirmed; “Remote Login is disabled” is only a hypothesis. Recheck with `/Applications/Tailscale.app/Contents/MacOS/Tailscale ping -c 1 --timeout 5s albert-aviary-mac.tail252378.ts.net && nc -vz -w 3 100.100.166.117 22`. If peer-side access is approved, confirm the cause there with `sudo systemsetup -getremotelogin` or `launchctl print system/com.openssh.sshd` rather than assuming it.
- **CONFIRMED boundary, HYPOTHESIS cause:** The latest built and installed monitor binaries differ. The deliberate no-install gate is recorded, but the hashes alone do not identify every behavioral difference. Recheck the two SHA-256 values with the `shasum` command above; install only after explicit approval and then verify the installed hash equals the built hash.
- **CONFIRMED boundary, HYPOTHESIS cause:** Live `/health` responses lack current provider/protocol/instance provenance. Detached older daemon ownership is the leading hypothesis, not a fresh diagnosis. Re-pull `/health`, then inspect without stopping anything: `lsof -nP -iTCP:8790-8794 -sTCP:LISTEN` and `ps -o pid=,ppid=,lstart=,command= -p <pid>`. Do not replace a process until two fresh idle samples and maintenance approval exist.
- **UNVERIFIED hypothesis:** A/C/D OAuth access tokens may still be expired; that was an earlier observation and can change after natural use. Do not inspect or refresh tokens merely to test the theory. After identity work is approved, pipe an already-valid token into `scripts/account-fingerprint.mjs --provider anthropic-a` (then B-D) and use its exit status and redacted SHA-256 output as the terminal signal.
- **UNVERIFIED measurement:** DERP claim p99, provider-duration p99, cross-Mac clock skew, fsync cost under production-sized state, and two-Mac fairness have not been measured. No timing or capacity conclusion should be inherited. Use the live validation ladder in `tasks/plans/shared-authority.md` and record the resulting numbers before choosing production timing or declaring efficacy.

## Recommended next action

Re-measure the undeployed boundary and live daemon occupancy before reading more code or requesting maintenance. Run this read-only snapshot first, save no secrets, and use its fresh output when asking the operator to confirm the peer and choose temporary Remote Login or the manual peer workflow:

```sh
date
find "$HOME/Library/LaunchAgents" -maxdepth 1 -name 'com.longweekendprojects.claude-permit-lane.*.plist' -print | wc -l
for p in 8791 8792 8793 8794; do
  curl -sS --max-time 1 "http://127.0.0.1:$p/health" |
    jq -c --argjson port "$p" '{port:$port,version,protocolVersion,provider,instanceId,startedAt,active,queued,current,max}'
done
/Applications/Tailscale.app/Contents/MacOS/Tailscale ping -c 1 --timeout 5s albert-aviary-mac.tail252378.ts.net
nc -vz -w 3 100.100.166.117 22
```
