# Implementation Plan

## Goal

Create a fail-closed shared permit authority for Claude lanes A-D on Ruminaider, with durable fair scheduling, authenticated two-Mac clients, safe shared allowance observations, and truthful menu status without editing `pi-dotfiles` or `usage-windows.ts`.

## Authority and prerequisites

The product source of truth remains `/Users/albertgwo/Repositories/pi-claude-permit-gate/tasks/discovery/decision-brief.md`. If this plan differs from that brief, the brief wins. Task 1 creates the implementation source of truth at `pi-claude-permit-gate/docs/authority-protocol-v1.md` plus a machine-validatable schema at `pi-claude-permit-gate/protocol/authority-v1.schema.json`; READMEs and monitor documentation link to that contract and contain only component-specific guidance.

The brief’s local-first order is not waived. Direct discovery evidence shows the local monitor is installed and validated, but H1 provenance code is unpublished and not installed. Shared code Tasks 1-9 may be built against the passing H1 source, but no live authority replacement, Serve exposure, or two-Mac cutover may begin until:

1. The frozen H1 contract passes all 12 existing Node tests, is correctly versioned, published, installed, and verified on Ruminaider.
2. H1 still provides `/health` schema version 3 with all existing fields, protocol 1/provider/valid instance UUID provenance, acquire preflight/response verification, stable-startedAt legacy handling, occupied-port exit code 3 plus re-probe, `/claude-permit` doctor output, fail-closed incompatible/invalid health, and no automatic daemon termination.
3. Any legacy daemon replacement has explicit maintenance approval and two `active=0, queued=0` observations at least two seconds apart.
4. The frozen L1 login-item lifecycle remains unchanged: desired-state reconciliation, `.requiresApproval` handling, and reinstall/BTM validation must continue to pass after publisher startup is added.

## Architecture

Use one authority-capable `permit-daemon.mjs` binary launched four times, once per lane port 8791-8794. Each process owns one lane’s scheduler, durable tickets, leases, cooldown, allowance snapshot, and safe API. Do not add a gateway or consolidate lanes: a gateway would split ticket and permit commits, while consolidation would replace the proven per-port failure boundary.

Run four per-user LaunchAgents on Ruminaider. Each daemon binds only to `127.0.0.1`; Tailscale Serve exposes four additive private HTTPS listeners on ports 8791-8794. A LaunchAgent is unavailable before login, so all clients fail closed while the user is logged out. A LaunchDaemon requires a separate administrator-approved system-account and secret design and is not part of this plan.

Use qualified mode names throughout:

- `daemonMode=local` preserves the frozen H1 protocol-1 held-request service.
- `daemonMode=authority` disables legacy unauthenticated routes and exposes authenticated protocol 2 only. Serve must never front `daemonMode=local`.
- `clientMode=local` is the default Pi behavior. `CLAUDE_PERMIT_GATE_ORIGIN` and all authority-only settings must be absent.
- `clientMode=authority-client` requires complete authority configuration, uses protocol 2, and has no loopback probe, daemon spawn, or local fallback capability.
- `monitorSource=local|authority` selects display truth explicitly. `monitorSource=authority` never reads loopback permit state or presents unaccepted local allowance as authority truth.

Both Macs, including Ruminaider, use `clientMode=authority-client` during shared operation. The authority-host Pi client and monitor reach the same MagicDNS HTTPS Serve endpoints as the peer and use distinct per-install credentials.

`pi-claude-lane-monitor` owns sanitized allowance publication. “Display-only” means the UI cannot switch lanes, mutate account configuration, or send Anthropic/provider requests. The app is not described as wholly read-only after it gains the narrow publisher.

## Contract ownership

`docs/authority-protocol-v1.md` owns the normative transport, identity, error, DTO, scheduling, timing, durable-state, verifier, allowance, and deployment-precondition rules. `protocol/authority-v1.schema.json` owns the machine-readable form. This plan links to those sections instead of restating the wire contract:

- [Transport, identity, and errors](../../docs/authority-protocol-v1.md#transport-identity-and-errors)
- [Authority lifecycle and durable state](../../docs/authority-protocol-v1.md#authority-lifecycle-and-durable-state)
- [Tickets, leases, fairness, and limits](../../docs/authority-protocol-v1.md#tickets-leases-fairness-and-limits)
- [Verifier store and authentication](../../docs/authority-protocol-v1.md#verifier-store-and-authentication)
- [Allowance publication and monitor truth](../../docs/authority-protocol-v1.md#allowance-publication-and-monitor-truth)
- [Deployment preconditions](../../docs/authority-protocol-v1.md#deployment-preconditions)

Tasks below own implementation order, dependencies, and build-only acceptance outcomes.

## Tasks

1. **Create the single protocol owner and contract validation**
   - Files: new `pi-claude-permit-gate/docs/authority-protocol-v1.md`, new `pi-claude-permit-gate/protocol/authority-v1.schema.json`, new canonical fixtures under `pi-claude-permit-gate/test/fixtures/`, contract-digest fixtures under `pi-claude-lane-monitor/Tests/ClaudeLaneMonitorTests/Fixtures/`, both READMEs.
   - Reuse decision: extend repository documentation and fixtures; add one protocol document/schema because the plan, two READMEs, and copied fixtures cannot safely co-own a public wire contract.
   - Changes: Encode the decisions above, validate fixtures against the schema, and make monitor fixtures record/check the canonical schema digest. READMEs link rather than repeat DTOs.
   - Acceptance: Schema validation and digest checks fail on key, enum, status, timestamp, nullability, error, or fixture drift.

2. **Implement authority scheduling and checked durable state**
   - Files: `pi-claude-permit-gate/permit-daemon.mjs`, new `authority-state.mjs`, `test/permit-daemon.test.mjs`.
   - Reuse decision: extend the current capacity/cooldown/provenance/bind core; add a state module because migration, fsync transactions, queues, replay, term fencing, and allowance persistence would make the HTTP daemon a god-object.
   - Changes: Add qualified daemon modes, socket exclusion, state schema 2, lifecycle states, nested fairness, tickets/leases, strict uncertain quarantine, exact limits, safe DTOs, and fail-closed faults. Preserve every H1 local invariant.
   - Acceptance: No uncommitted offer is visible, no active/uncertain lease auto-frees, restart preserves order/results, EADDRINUSE changes no state, and all existing H1 tests pass.

3. **Implement authority-wide authentication and offline administration**
   - Files: `permit-daemon.mjs`, new `scripts/authority-admin.mjs`, `README.md`, `test/permit-daemon.test.mjs`.
   - Reuse decision: extend request dispatch; add an offline admin tool because bootstrap, verifier rotation/revocation, drain/resume, and uncertain reconciliation must not be remote routes.
   - Changes: Implement the shared verifier store, per-role/lane ownership, precommit generation recheck, Keychain enrollment via stdin/in-memory pipe, independent revocation, drain/resume, and approval-gated reconciliation. Never accept secret values in argv or persist plaintext.
   - Acceptance: Cross-role/owner/lane access fails before mutation; an atomic verifier generation affects all four test daemons; stale/unreadable verifier state blocks; one token revocation leaves the other installation working.

4. **Implement explicit Pi client modes and complete ticket retry behavior**
   - Files: `pi-claude-permit-gate/index.ts`, `test/source-policy.test.mjs`, `README.md`.
   - Reuse decision: extend the existing transport, health classifier, acquire boundary, and single provider hook.
   - Changes: Enforce the configuration matrix; add HTTPS/Keychain transport; create/poll/claim/renew/cancel/complete using exact DTOs and retry rules; generate opaque session/request/operation IDs; persist unresolved local ticket state; verify authority/provider/port/protocol/binding; omit `cwd`. Construct no spawn or loopback capability in authority-client.
   - Acceptance: Invalid authority-client configuration blocks hooks, authority outage performs zero local probe/spawn calls, response-loss resumes one ticket, no stale response starts provider work, and provider payloads remain unchanged.

5. **Package four login-scoped authority jobs without live changes**
   - Files: new `deploy/com.longweekendprojects.claude-permit-lane.plist.in`, new `scripts/install-authority.sh`, new `scripts/validate-authority.sh`, `package.json`, `package-lock.json`, `README.md`.
   - Reuse decision: add generated deployment artifacts because detached spawning cannot provide launchd ownership.
   - Changes: Correct package versioning; stage immutable releases by commit; generate four plist files with absolute paths, `daemonMode=authority`, explicit measured timing, provider/port/state/log paths, `RunAtLoad`, failed-exit KeepAlive, and no secret values. Add dry-run, schema/hash check, H1 prerequisite check, install, lane rollback, and uninstall that preserves state.
   - Acceptance: Dry-run produces four distinct labels, rejects absent production timing, lints plists, finds no secrets, and changes no launchd/Serve state.

6. **Align monitor provenance and implement authority reads**
   - Files: `LaneModels.swift`, `LocalLaneSnapshotSource.swift`, `ClaudeLaneMonitorApp.swift`, new `AuthorityWireModels.swift`, new `AuthorityClient.swift`, new `SharedLaneSnapshotSource.swift`, `LaneSnapshotTests.swift`.
   - Reuse decision: extend `LaneSnapshot`, source protocol, strict decoder, and store; add an authority source because authenticated non-loopback transport cannot fit a local-only source without fallback ambiguity.
   - Changes: Require valid instance UUID for current local H1 health; decode canonical DTOs; retrieve only the read token; verify authority identity; expose qualified source/reachability metadata; cache only authority-accepted allowance. Authority errors never invoke local loaders.
   - Acceptance: Node/Swift provenance agrees, strict schema/digest fixtures pass, A-D order remains fixed, and closed-menu remote status polling is zero.

7. **Publish sanitized observations from the monitor without changing L1**
   - Files: new `AllowancePublisher.swift`, `LocalLaneSnapshotSource.swift`, `ClaudeLaneMonitorApp.swift`, `MonitorStore.swift`, `MenuContentView.swift`, `LaneSnapshotTests.swift`, `README.md`.
   - Reuse decision: reuse/extract the existing directory watcher and decoder; add a publisher because mutation authority and durable retries do not belong in the read-only source/store.
   - Changes: Start an event-driven publisher at app launch when configured; normalize only canonical fields; allocate durable IDs/sequences; use only publish scope; maintain bounded queue/cache; update UI copy to “display-only UI” plus sanitized publishing. Do not change `LoginItemController` reconciliation or install registration behavior.
   - Acceptance: File replacement publishes once across retry/restart, raw fields never cross the wire, closed menu performs no periodic status read, and frozen L1 login-item/reinstall checks remain unchanged and green.

8. **Add account fingerprint and peer readiness gates**
   - Files: new `scripts/account-fingerprint.mjs`, new `scripts/validate-peer.sh`, `README.md`.
   - Reuse decision: add deployment-only helpers because runtime scheduling and the monitor must not own OAuth credentials.
   - Changes: With an already-valid access token, call read-only `GET https://api.anthropic.com/api/oauth/profile`, canonicalize `profile-v1\0<lowercase-account-uuid>\0<lowercase-organization-uuid>`, print only SHA-256 provider fingerprint, and never refresh/store raw values. Compare A-D out of band and issue random account binding IDs only after matches. Peer output is redacted and verifies mode/build/installation-ID presence/Keychain lookup/no local listeners.
   - Acceptance: Swapped lanes, organization-only changes, expired tokens, malformed profiles, or missing peer access block the affected lane without refresh or disclosure.

9. **Prepare additive Serve and Tailnet grant artifacts**
   - Files: new `deploy/tailscale/permit-authority-grant.hujson.example`, `scripts/validate-authority.sh`, `README.md`.
   - Reuse decision: add a lintable service policy example because no live policy repository is in scope.
   - Changes: Define aliases for confirmed Ruminaider (`100.103.181.53`) and the explicitly unresolved `operator-supplied-peer` placeholder to destination Ruminaider TCP 8791-8794. Do not tag the personal Mac. Tasks 10-11 may replace the placeholder only after peer confirmation and Tailnet-policy approval. Document app-bundled CLI commands that add or remove one private listener and prohibit Funnel, reset, and whole-config replacement.
   - Acceptance: Policy tests prove authority-host self access and the placeholder peer rule, deny another same-user device, another member, and public paths, and show no Funnel. Deployment remains blocked until Tasks 10-11 confirm the peer and approve the policy.

10. **Deploy Ruminaider authority under explicit approval**
    - Surfaces: Keychain, Application Support state/verifier files, four LaunchAgents, Tailscale policy, Serve state.
    - Dependencies: Tasks 1-9, published/installed H1, complete policy audit, operator-approved timing measurements.
    - Changes: Provision role tokens; verify clocks within 30 seconds; measure DERP claim and provider-duration p99; write explicit timing; save Serve config; bootstrap states; install jobs. Replace owners only under the two-sample idle gate. Add each Serve listener after authenticated ready health while preserving existing 8443/10000 entries byte-for-byte.
    - Acceptance: Four launchd PIDs own four loopback listeners; authority and peer HTTPS paths authenticate; existing Funnel entries are unchanged; logout produces documented fail-closed unavailability.

11. **Perform coordinated two-Mac cutover**
    - Surfaces: both Macs’ non-secret authority config, Keychain, running Pi processes, installed monitor apps.
    - Dependencies: Task 10, confirmed second Mac, four matching profile fingerprints, operator authority.
    - Changes: Install without enabling; drain all local work; stop second-Mac local daemons; restart or stop every Pi process holding old code; enable A-D authority-client and authority monitor/publisher on both Macs. Never expose a lane while a legacy mutation client can use it.
    - Acceptance: Distinct principals authenticate; Ruminaider and peer reach Serve under policy; second Mac has no A-D listener; DERP reconnect resumes one ticket; two-Mac waves respect capacity and fairness; menus converge.

12. **Validate efficacy and rollback**
    - Surfaces: deployed jobs/routes/config/state backups and redacted validation records.
    - Changes: Exercise auth denial, state/verifier failure, restart, partition, process loss, monitor outage, skew/replay, rotation, drain/resume, and lane rollback. Return to independent local scheduling only after separate explicit all-client quiescent approval; never automatically fall back.
    - Acceptance: Signals below pass, no sensitive sentinel reaches response/state/logs, and a rollback leaves clients blocked rather than spawning another authority.

## Test Budget

Ceiling: **10 new or materially modified Node cases in `pi-claude-permit-gate`**. Retain all 12 existing Node cases. The Swift target remains at **exactly 3 implemented `@Test` methods**; extend those methods with the shared-source, publisher, and lifecycle assertions below rather than adding test methods. Matrices are assertions inside these cases, not extra smoke tests.

Closed consequential risks:

1. Authority-client reaches loopback/spawn/fallback.
2. Uncommitted, duplicated, replayed, or stale-term work consumes extra capacity.
3. Claim/cancel/renew/complete/restart races apply effects twice or lose ownership.
4. Persistence or verifier faults acknowledge unsafe state or restore empty.
5. Active work is reclaimed after acknowledgement loss.
6. Machine/session fairness changes across restart.
7. Wrong/revoked role, owner, lane, binding, or authority crosses boundaries.
8. Shared responses/logs disclose sensitive or correlating data.
9. Stale/skewed/replayed allowance replaces accepted truth.
10. Node and Swift disagree on protocol/provenance/timestamps.
11. Monitor authority outage falls back or mislabels cached truth.
12. Publisher lifecycle breaks L1 or closed-menu polling behavior.

Node cases (10): mode/config/H1 compatibility; role/owner/revocation/shared-generation auth; create replay/compaction; claim/cancel/reconnect; renew/uncertain; exactly-once completion/throttle; nested fairness/restart; migration/EIO/ENOSPC/socket/term faults; exact response/log allowlists and bounds; allowance scope/skew/replay/restart.

Swift methods (3): extend the allowance-truth method with canonical fixture and authority provenance parity; extend the source/privacy method with shared-source authority/error/cache/no-fallback and publisher allowlist/retry assertions; extend the visibility method with visible-only polling, publisher debounce/lifecycle, and frozen L1 behavior.

Automated commands:

```sh
cd /Users/albertgwo/Repositories/pi-claude-permit-gate && npm test
cd /Users/albertgwo/Repositories/pi-claude-lane-monitor && scripts/test.sh
# Contract validator checks canonical schema plus the monitor-recorded schema digest.
```

## Live Validation Ladder and Efficacy Signals

1. Build/test both repositories, lint plists/scripts, dry-run install, validate schema digests, scan for secrets, and run `git diff --check`.
2. Under temporary HOME/ports, fault every transition, state/verifier load, bounds, drain/degraded state, and timing change.
3. After H1 and maintenance approval, install four jobs without Serve. Verify `launchctl print gui/$(id -u)/<label>` and `lsof -nP -iTCP:8791-8794 -sTCP:LISTEN` show one launchd owner per loopback port.
4. Save and compare `/Applications/Tailscale.app/Contents/MacOS/Tailscale serve get-config`; add one private route; verify `serve status --json` contains no new `AllowFunnel` and preserves 8443/10000.
5. From Ruminaider, intended peer, another same-user device, and public/non-member path, test the policy matrix plus valid/missing/invalid/wrong-role tokens.
6. Run A-D fingerprint helper on both Macs only after natural refresh or approved reauthentication. Four matches are mandatory; expired tokens block without refresh.
7. Canary create/poll/claim/renew/complete across DERP, response loss, daemon restart, rotation, drain/resume, and partition.
8. Restart all loaded Pi clients, cut over, and verify the second Mac remains listener-free with `lsof` and `pgrep`.
9. Keep both machines and multiple sessions backlogged. Read redacted health: `capacityInUse = offered + active + uncertain <= currentConcurrency`; no machine receives a second offer while another eligible machine has received none.
10. Produce normal responses on each Mac. Both `/v1/snapshot` DTO hashes and menus converge; original observation time drives reset/age; older/skewed replay is rejected.
11. Test authority outage/logout/reboot. Pi blocks without spawning; permit becomes unavailable; only accepted allowance remains marked last-observed/offline.
12. Drain and roll back one lane. Other lanes and existing Funnel routes remain unchanged; an incompatible prior binary is not started against state schema 2.

Post-deploy efficacy is complete only when commands record: central capacity never exceeded; no client-side listener; same ticket/lease across reconnect; fairness order; all auth denials before state change; identical accepted allowance; private-only Serve exposure; restart retains authority ID/state while term increments and process instance changes.

## Compatibility, Cutover, Rollback, and Approval Gates

- Correct package/tag/build metadata before publication; installed `buildId`, not the current mismatched tag/version, proves behavior.
- Local protocol 1 remains default for unconfigured users. Authority protocol 2 requires all clients to restart; mixed legacy/shared mutation is prohibited.
- Monitor source rollback is explicit and visibly local. Permit rollback never silently changes to local scheduling.
- Never restore older state over live/uncertain work. If an older binary cannot read schema 2, keep the current binary fail-closed.
- Buildable now: Tasks 1-9 only.
- Operator/second-Mac gates: identify/access peer, run redacted validation, inspect profiles, reauthenticate if chosen, create/rotate Keychain items, publish/tag package, install/restart clients, stop daemons, install/kickstart jobs, mutate Serve, and run live waves.
- Tailnet-owner gate: inspect the entire additive policy, add/test self plus peer grants, and approve changes.
- Maintenance/destructive gate: replace owners only after two idle samples; reconcile uncertain leases, delete state, roll back to independent local scheduling, or restore service only with fresh explicit approval.
- Administrator gate: only a LaunchDaemon/system-account alternative or writes under `/Library`/`/var/log`; the recommended LaunchAgents remain user-scoped.

## One-Writer Execution Packets

| Packet | Tasks | Sole writer/surface | Depends on | Status |
|---|---|---|---|---|
| A. Canonical contract, authority core, administration, and Pi client | 1, 2, 3, 4 | `pi-claude-permit-gate` | H1 source tests | Build now |
| B. Packaging, fingerprint, and grant artifacts | 5, 8, 9 | `pi-claude-permit-gate` | Packet A | Build now |
| C. Shared monitor and publisher | 6, 7 | `pi-claude-lane-monitor` | Packet A contract/schema | Build now |
| D. Permit package publication | 10 prerequisite | release operator | Packets A-B tests | Approval blocked |
| E. Ruminaider credentials/jobs | 10 | Ruminaider operator | D and installed H1 | Approval blocked |
| F. Tailnet policy/Serve | 10 | Tailnet owner | E and policy audit | Approval blocked |
| G. Second-Mac fingerprint/install/drain | 11 | second-Mac operator | B-D | Access/approval blocked |
| H. Coordinated cutover | 11 | one deployment operator controlling both Macs | E-G | Access/approval blocked |
| I. Efficacy/rollback rehearsal | 12 | validation operator | H | Deployment blocked |

No packets write the same repository or live surface concurrently.

## Files to Modify

### `pi-claude-permit-gate`

- `index.ts` - client modes, config, authenticated ticket transport, retries, acknowledgements, no fallback.
- `permit-daemon.mjs` - qualified daemon modes, authority HTTP/auth/scheduler integration, safe DTOs, H1 preservation.
- `test/permit-daemon.test.mjs`, `test/source-policy.test.mjs` - ten load-bearing cases while retaining existing coverage.
- `package.json`, `package-lock.json` - correct release metadata and include new artifacts without a native database dependency.
- `README.md` - links to canonical contract and component deployment guidance only.

### `pi-claude-lane-monitor`

- `LaneModels.swift` - source/reachability and offline truth.
- `LocalLaneSnapshotSource.swift` - instance UUID parity and reusable decoder/watcher.
- `MonitorStore.swift`, `ClaudeLaneMonitorApp.swift`, `MenuContentView.swift` - explicit composition, publisher lifecycle, truthful wording, unchanged L1 reconciliation.
- `LaneSnapshotTests.swift` - shared-authority assertions within the existing three `@Test` methods.
- `scripts/build-app.sh`, `README.md` - authority-safe packaging checks and consumer guidance without duplicating protocol.

## New Files

### `pi-claude-permit-gate`

- `docs/authority-protocol-v1.md` and `protocol/authority-v1.schema.json` - single normative protocol owner; README/plan copies cannot safely own the contract.
- `authority-state.mjs` - durable transaction, migration, term/fence, and state API; `permit-daemon.mjs` cannot absorb this without becoming a god-object.
- `scripts/authority-admin.mjs` - offline verifier/bootstrap/drain/reconcile owner; these operations must not be remote daemon endpoints.
- `scripts/install-authority.sh`, `scripts/validate-authority.sh` - checked immutable launchd deployment and redacted validation; no current executable owner exists.
- `scripts/account-fingerprint.mjs`, `scripts/validate-peer.sh` - narrow OAuth-profile and inaccessible-peer deployment helpers; runtime components must not gain those responsibilities.
- `deploy/com.longweekendprojects.claude-permit-lane.plist.in` - generated four-job template; detached spawning cannot express managed ownership.
- `deploy/tailscale/permit-authority-grant.hujson.example` - lintable service-specific policy example; live policy remains operator-owned.
- Canonical test fixtures under `test/fixtures/` - schema examples and error/ticket representations.

### `pi-claude-lane-monitor`

- `AuthorityWireModels.swift` - strict canonical DTO consumer; synthesized `LaneModels` encoding is not a wire contract.
- `AuthorityClient.swift` - HTTPS, Keychain read token, expected-authority checks, and safe cache transport; local source cannot own remote authenticated transport.
- `SharedLaneSnapshotSource.swift` - authority implementation of the existing source seam; extending local source would risk hidden fallback.
- `AllowancePublisher.swift` - scoped writer and durable bounded queue; read/display owners must not gain mutation behavior.
- Contract-digest fixtures - consumer verification of the permit repository’s canonical schema.

## Dependencies

Task 1 precedes all consumers. Tasks 2-3 precede Task 4 and deployment tooling. Task 6 depends on Task 1; Task 7 depends on Tasks 3 and 6. Tasks 5, 8, and 9 use the final contract/build IDs. Live Task 10 requires published/installed H1, all tests, explicit timing, credentials, policy audit, and authority. Task 11 additionally requires peer access and four fingerprint matches. Task 12 requires cutover plus approval for destructive fault or rollback actions.

## Residual Risks

- **Critical:** Pi cannot fence an already-started Anthropic request. `uncertain` quarantine preserves exclusion but can exhaust a lane until completion or approval-gated reconciliation.
- **Critical:** The second Mac and A-D account mapping remain unverified; provider names are insufficient.
- **Critical:** Any old loaded Pi client can spawn/use an independent local daemon until it is restarted or stopped.
- **Important:** The current Tailnet policy is unavailable and additive; a broader rule can defeat a narrow grant.
- **Important:** User LaunchAgents are unavailable before login.
- **Important:** Keychain access after login may prompt/fail; deployment stops rather than using a plaintext fallback.
- **Important:** Cross-Mac allowance ordering requires clocks within 30 seconds.
- **Important:** Strict file-snapshot durability is viable only while bounded state commits remain acceptably fast; measured failure requires a transactional store before rollout, not weaker fsync.
- **Important:** State schema 2 may prevent binary rollback; stale state must never be restored.
- **Medium:** DERP polling/reconnect latency and production timing remain unmeasured human deployment gates.
