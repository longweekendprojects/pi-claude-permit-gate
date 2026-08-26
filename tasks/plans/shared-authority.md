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

`pi-claude-lane-monitor` owns sanitized allowance publication. “Display-only” means the UI cannot switch lanes, mutate account configuration, or send Anthropic/provider requests. The app is not described as wholly read-only after it gains the narrow publisher. `pi-dotfiles` and `~/.pi/agent/extensions/usage-windows.ts` remain unchanged.

### Critique dispositions

- `offered` is the canonical protocol name for the architecture review’s `reserved` state.
- Wire `currentConcurrency` is the serialized effective concurrency value.
- The operability review’s `remote-client` maps to canonical `clientMode=authority-client`. A separate `managed-local` client mode is not adopted because both Macs use the authenticated Serve path; adding a third client path would reintroduce local mutation ambiguity. Launchd ownership is expressed by `daemonMode=authority`, not a Pi client mode.
- Active leases do not auto-expire in authority mode. On missed renewal they become `uncertain` and keep consuming capacity because Pi cannot fence an already-started Anthropic request. Local H1 TTL behavior remains unchanged.
- The monitor publisher is adopted because direct evidence shows its installed app already owns the safe file watcher. The contradictory suggestion to edit `usage-windows.ts` is rejected by the hard no-`pi-dotfiles` boundary.

## Canonical protocol decisions for Task 1

The following decisions must be encoded once in `docs/authority-protocol-v1.md` and `protocol/authority-v1.schema.json`. Fixtures in either repository are validated against that schema and carry its SHA-256 digest; they are not independent contract owners.

### Common transport, identity, and errors

All authority requests use HTTPS, UTF-8 JSON, `Content-Type: application/json`, `Cache-Control: no-store`, a 16 KiB request-body ceiling, a 64 KiB response ceiling, rejected unknown keys, integer epoch milliseconds unless named `EpochSeconds`, and JavaScript-safe integers from 0 through `9007199254740991`.

Every authenticated request uses `Authorization: Bearer <tokenId>.<base64url-32-byte-secret>`. Each installation has separate Keychain tokens for `permit:mutate`, `snapshot:read`, and `allowance:publish`. The authority stores only a constant-time-comparable SHA-256 verifier with token ID, immutable installation ID, scope, lane allowlist, generation, issue/expiry, predecessor, and revocation metadata. Machine identity comes from the verified token; a conflicting body `installationId` fails before lookup or mutation.

Every error is:

```json
{"schemaVersion":1,"error":{"code":"error_code","message":"redacted","retryable":false,"retryAfterMs":null}}
```

The closed codes and statuses are:

- 400 `invalid_json|invalid_request|unsupported_schema`.
- 401 `unauthenticated`.
- 403 `forbidden_scope|forbidden_lane`.
- 404 `not_found`, including another principal’s opaque ID.
- 409 `provider_mismatch|authority_mismatch|account_binding_mismatch|stale_revision|invalid_transition|operation_conflict`.
- 429 `principal_limit|lane_limit`, retryable with `Retry-After` and `retryAfterMs`.
- 503 `authority_starting|authority_draining|authority_degraded|persistence_unavailable|verifier_unavailable`, retryable only when the server supplies `Retry-After`.

All successful ticket responses include `ETag: "revision-<n>"`; creates also include `Location: /v1/tickets/<ticketId>`. Replayed successful operations return 200 with `Idempotency-Replayed: true` and the original representation. Retryable errors include both integer-seconds `Retry-After` and matching millisecond JSON guidance.

Client retry rules are fixed: network loss, 429, and retryable 503 reuse the same request/operation ID with capped jittered backoff; 400/401/403 and identity/binding mismatches fail closed; stale revision triggers one authenticated GET before deciding the next legal transition. A lost create response retries create with the same request ID. A lost claim, renew, cancel, or complete response first GETs the ticket and then repeats the same operation ID only if the stored state does not already contain its result. No later provider request starts until completion of the prior ticket is acknowledged.

### Configuration

`CLAUDE_PERMIT_GATE_MODE` is `local|authority-client`, default `local`.

- In `clientMode=local`, `CLAUDE_PERMIT_GATE_ORIGIN`, `CLAUDE_PERMIT_GATE_AUTHORITY_CONFIG`, and authority-only fields must be absent; their presence is a startup error.
- In `clientMode=authority-client`, `CLAUDE_PERMIT_GATE_ORIGIN` and `CLAUDE_PERMIT_GATE_AUTHORITY_CONFIG` are required. Origin must be `https://<dns-host>` with no credentials, port, path, query, or fragment. Provider ports are appended from the existing map.

The 0600 non-secret authority config contains schema version 1, mode, origin, expected authority UUID, stable random installation UUID, Keychain service/account references, `monitorSource`, `publisherEnabled`, and A-D `{port,accountBindingId}` entries. Environment and file origin/mode/ports must agree. Invalid or incomplete configuration is rejected before Pi hooks register.

### Authority operational states

`AuthorityHealthV1.status` is `starting|ready|draining|degraded`.

- `starting`: The OS listener is bound, but state migration, term commit, verifier validation, or readiness checks are incomplete. Health returns 503 `authority_starting`; all other routes return the same error.
- `ready`: All authenticated routes operate normally.
- `draining`: Entered only by the local offline admin command. One transaction changes existing `queued` and `offered` tickets to `cancelled` with reason `authority_draining`; new ticket creates, claims, publishes, and new offers return 503 `authority_draining`. Authenticated GET, cancel retries, renew, and complete remain available so active/uncertain work can finish. The state remains draining after counts reach zero until explicit local `resume` or process replacement. `resume` is allowed only if state, verifier, timing config, and persistence checks pass.
- `degraded`: Entered on state/verifier/config/persistence/term failure. Safe authenticated health/snapshot reads may continue only when verifier and last committed state remain trustworthy; otherwise all routes return generic 503. No ticket, lease, allowance, drain, or resume mutation occurs. Recovery requires successful revalidation plus explicit local admin resume or restart; it is never an empty-state reset.

### Health and shared snapshot

Authenticated `GET /v1/health` returns schema/protocol version, stable authority ID, lane term, process instance UUID, build ID, state schema version, server time, qualified status, provider, port, capabilities, and only aggregate `active`, `offered`, `uncertain`, `queued`, `currentConcurrency`, `maximumConcurrency`, cooldown, and oldest-wait fields.

Authenticated `GET /v1/snapshot` with `snapshot:read` returns `LaneSnapshotDTOv1`: authority provenance plus lane ID/provider, aggregate permit fields, and allowance truth. A window is null or `{utilization,status,resetEpochSeconds}`. `status` is null or one of `allowed|allowed_warning|rejected|active|warning|rate_limited`; empty local status normalizes to null. Derived freshness, age, severity, and post-reset truth remain Swift concerns.

Both responses are exact allowlists. They exclude `bySession`, installation/session/request/ticket/lease IDs, account fingerprints/binding IDs, token/verifier data, paths, OAuth/profile values, headers, bodies, and raw errors.

### Ticket and lease DTOs

`POST /v1/tickets` with `permit:mutate` accepts exactly:

```json
{"schemaVersion":1,"provider":"anthropic-a","accountBindingId":"uuid","installationId":"uuid","sessionId":"uuid","requestId":"uuid","createdAtEpochMs":0}
```

First creation returns 201; duplicate creation returns 200 plus replay header. The idempotency key is `(authenticated installation, provider, requestId)`. A new request timestamp must be within 30 seconds of server time. A known retry remains readable. Terminal records remain at least 24 hours and past the create retry horizon; after compaction, the old timestamp prevents recreation.

Every create, poll, claim, cancel, renew, and complete success returns exact `TicketV1` keys, with nullable keys always present:

```json
{
  "schemaVersion":1,
  "ticketId":"uuid",
  "requestId":"uuid",
  "provider":"anthropic-a",
  "state":"queued",
  "revision":1,
  "createdAtEpochMs":0,
  "enqueuedAtEpochMs":0,
  "offeredAtEpochMs":null,
  "offerExpiresAtEpochMs":null,
  "terminalAtEpochMs":null,
  "terminalReason":null,
  "queueAhead":0,
  "lease":null
}
```

`state` is `queued|offered|active|uncertain|cancelled|released|throttled|offerExpired`. `terminalReason` is null or `client_cancelled|authority_draining|offer_expired|released|assistant_rate_limit|assistant_overloaded|operator_reconciled`. `queueAhead` is an owner-visible non-negative estimate, never a session list.

A non-null `LeaseV1` is:

```json
{
  "leaseId":"uuid",
  "generation":1,
  "claimedAtEpochMs":0,
  "renewSequence":0,
  "renewByEpochMs":0,
  "serverDeadlineEpochMs":0
}
```

`serverDeadlineEpochMs` is the transition to `uncertain`, not automatic capacity release.

Endpoints and bodies are:

- `GET /v1/tickets/:ticketId`: `permit:mutate`, same owner/lane, 200 TicketV1 or owner-hidden 404.
- `POST /v1/tickets/:ticketId/claim`: `{schemaVersion,operationId,expectedRevision,installationId,provider,accountBindingId}`. One compare-and-set changes `offered` to `active`; only then may provider traffic start.
- `POST .../cancel`: the same common mutation body. It changes only `queued|offered` to `cancelled`; `active|uncertain` returns 409 `invalid_transition` and retains capacity.
- `POST .../renew`: common body plus `leaseId`, `generation`, and next `renewSequence`. It applies only to the same active/uncertain lease generation, returns TicketV1 with the acknowledged sequence/deadlines, and may restore `uncertain` to `active` without allocating another slot.
- `POST .../complete`: common body plus `leaseId`, `generation`, `outcome` (`released|throttled`), `reason` (null for release or `assistant_rate_limit|assistant_overloaded`), and optional bounded `cooldownMs`. The first transition frees capacity once; throttle changes adaptive concurrency/cooldown once.

Claim/cancel and all later mutations serialize through revision compare-and-set. Duplicate operation IDs return the original result. A different operation reusing an ID returns 409 `operation_conflict`.

### Fairness, limits, and validation bounds

The scheduler persists FIFO order within session, a session cursor within each authenticated machine, and a machine cursor within the lane. One eligible machine receives one offer before another turn while another machine is eligible. Session IDs are random per loaded Pi process and never appear in shared output.

Fixed v1 bounds are:

- 32 authenticated installation principals per authority; 32 live sessions per principal.
- 16 nonterminal tickets per session, 64 per principal, and 256 per lane.
- 4,096 retained ticket/tombstone records per lane and 32 retained operation results per ticket.
- Effective concurrency configuration from 1 through 64.
- UUID/string fields at most 64 ASCII characters; error message at most 160 redacted ASCII characters.
- Allowance utilization finite from 0 through 1000 inclusive; reset seconds from 1 through 253402300799; observed timestamps within JavaScript-safe range and no more than 30 seconds future.
- Publisher queue: 64 pending snapshots per provider and 256 per installation; newer same-provider observations supersede older unsent entries without deleting an unacknowledged in-flight ID.

Per-principal/session limits return 429 `principal_limit`. A full lane nonterminal queue returns 429 `lane_limit`. A full retained-state ledger that cannot compact without violating 24-hour replay retention returns 503 `persistence_unavailable` and stops creates rather than deleting safety records.

### Lifecycle timing configuration

Authority mode has no production timing defaults. LaunchAgent generation requires measured, explicit integer milliseconds:

- `CLAUDE_PERMIT_GATE_OFFER_TTL_MS`, range 5,000-120,000, greater than measured DERP claim p99 plus margin.
- `CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS`, range 5,000-300,000.
- `CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS`, range 15,000-3,600,000, at least three renew intervals and greater than measured provider-duration p99 plus DERP jitter margin.
- `CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS`, fixed at or above 86,400,000.

Test-only values are passed under temporary HOME/ports and never copied into plist templates. The state stores timing schema and digest. Offer deadlines persist their original value. New renew timing applies only after the next acknowledged renew. Timing changes require drain and restart; startup refuses a timing digest change while any ticket is offered, active, or uncertain.

### Durable state, OS exclusion, and term fencing

The OS-level exclusive lane lock is the listening socket `127.0.0.1:<lane-port>` held for process lifetime with exclusive listen semantics. This avoids a destructively recoverable lock file:

1. Parse non-secret configuration and verifier-store location without writing lane state.
2. Bind the socket in `starting`; `EADDRINUSE` exits code 3 without state changes.
3. While holding the socket, load/bootstrap/migrate state and validate verifier/timing schemas.
4. Atomically increment and fsync `laneTerm`, generate `ownerNonce`, and persist both before becoming `ready`.
5. Before every commit, reread the current state header and require matching authority ID, provider/port, lane term, and owner nonce. Mismatch fences the process into `degraded` and prevents the write.
6. Graceful shutdown stops timers, enters draining when requested, flushes the final commit, and retains the bound socket until all writers stop and the process exits. Replacement waits for process exit; it never removes a lock file. A crash releases the socket in the kernel. Stale owner metadata is replaced only after a new term commits.

The offline admin tool refuses state mutation while `lsof` shows a listener or launchd reports the lane running. A missing state file is accepted only by explicit `bootstrap`. Corrupt, unknown, or unreadable state never becomes an empty scheduler.

One complete lane snapshot stores queue/cursors, tickets/revisions, operation results, offered/active/uncertain leases, capacity/cooldown, replay ledger, allowance, timing digest, verifier generation last observed, counters, term, and owner nonce. Each transition writes a 0600 temporary file, fsyncs it, atomically renames it, and fsyncs the directory before acknowledging.

### Canonical verifier store

All four daemons read one authority-wide file:

`~/Library/Application Support/Claude Permit Authority/verifiers-v1.json`

It is owner-only mode 0600 and contains `schemaVersion`, monotonically increasing `generation`, and verifier records only. `authority-admin.mjs` writes a complete temporary file, fsyncs, renames, and fsyncs the directory. Every authenticated request reads and validates the current generation; every mutation rereads it immediately before durable commit. A generation change therefore applies to all lanes from one atomic rename, and an in-flight request authenticated under a revoked generation cannot commit. Unreadable, malformed, rolled-back, or generation-mismatched verifier state makes the lane degraded/fail-closed. Rotation uses a bounded dual-verifier overlap; revocation of one installation does not affect the other.

### Allowance publication and ordering

`POST /v1/allowance` requires `allowance:publish` and accepts exact safe window fields plus schema version, installation ID, provider, account binding ID, publish UUID, publisher sequence, and observed-at milliseconds. Provider/lane derive from token scope and must match the body. Duplicate publish ID returns the original result.

The authority rejects observations over 30 seconds future and observations more than 30 seconds older than stored. Within the 30-second cross-machine uncertainty window, later authority receipt wins; original observation time still drives freshness. Status normalizes to the closed allowlist above. Unknown/raw fields fail validation.

The monitor watches only `~/.pi/agent/usage-windows/<provider>.json`, validates the already-sanitized atomic file, and queues only the safe DTO. It never reads OAuth credentials, headers, or provider bodies. The queue retries while the app runs and removes an item only after authority acknowledgement.

### Menu source and offline truth

`monitorSource=authority` reads four authenticated snapshots and never falls back to local permit health or unaccepted local usage. Authority loss makes permit state unavailable immediately. The app may retain the last authority-accepted safe allowance cache, labels it “last observed” with authority unreachable, preserves its original age, and retains “awaiting post-reset observation.” The title may retain an eligible percentage only with the unavailable marker. Permit polling remains every two seconds only while the menu is open; publisher traffic is file-event-driven and independent of menu visibility.

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
   - Changes: Define source host aliases for both confirmed Ruminaider (`100.103.181.53`) and the operator-confirmed second Mac to destination Ruminaider TCP 8791-8794. Do not tag the personal Mac. Audit the complete additive policy for broader matches. Document app-bundled CLI commands that add/remove one private listener and prohibit Funnel/reset/config replacement.
   - Acceptance: Policy tests prove authority-host self access and intended peer access, deny another same-user device/other member/public internet, and show no Funnel; if self access cannot be proven under the real policy, deployment stops rather than adding a local bypass.

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
- Buildable now: Tasks 1-9 only, with no `pi-dotfiles` edits.
- Operator/second-Mac gates: identify/access peer, run redacted validation, inspect profiles, reauthenticate if chosen, create/rotate Keychain items, publish/tag package, install/restart clients, stop daemons, install/kickstart jobs, mutate Serve, and run live waves.
- Tailnet-owner gate: inspect the entire additive policy, add/test self plus peer grants, and approve changes.
- Maintenance/destructive gate: replace owners only after two idle samples; reconcile uncertain leases, delete state, roll back to independent local scheduling, or restore service only with fresh explicit approval.
- Administrator gate: only a LaunchDaemon/system-account alternative or writes under `/Library`/`/var/log`; the recommended LaunchAgents remain user-scoped.

## One-Writer Execution Packets

| Packet | Sole writer/surface | Depends on | Status |
|---|---|---|---|
| A. Canonical contract, authority core, Pi client | `pi-claude-permit-gate` | H1 source tests | Build now |
| B. Packaging/admin/fingerprint/grant artifacts | `pi-claude-permit-gate`, after A | A | Build now |
| C. Shared monitor and publisher | `pi-claude-lane-monitor` | A contract/schema | Build now |
| D. Permit package publication | release operator | A-B tests | Approval blocked |
| E. Ruminaider credentials/jobs | Ruminaider operator | D and installed H1 | Approval blocked |
| F. Tailnet policy/Serve | Tailnet owner | E and policy audit | Approval blocked |
| G. Second-Mac fingerprint/install/drain | second-Mac operator | B-D | Access/approval blocked |
| H. Coordinated cutover | one deployment operator controlling both Macs | E-G | Access/approval blocked |
| I. Efficacy/rollback rehearsal | validation operator | H | Deployment blocked |

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

## Review Findings Disposition

- **Resolved blocker:** `tasks/plans/shared-authority.md` is now the canonical plan artifact.
- **Resolved important:** Local client mode now requires authority origin/config to be absent.
- **Resolved important:** H1 publication/installation and L1 regression are explicit prerequisites; shared live deployment cannot overtake them.
- **Resolved important:** One permit-repository protocol document/schema owns wire behavior; READMEs and fixtures validate/link rather than co-own it.
- **Resolved critical/high:** Exact ticket/lease DTOs, operation replay, endpoint errors/retries, drain/degraded states, socket lock/term fencing, shared verifier store, authority-host grant path, bounds, and timing config are frozen above.
- **Resolved terminology:** `offered`, `currentConcurrency`, qualified mode names, and narrow display-only meaning are canonical.
- **Not adopted:** A third `managed-local` Pi client mode conflicts with the direct shared architecture requiring both Macs to use authenticated authority behavior. Launchd ownership remains a daemon concern, and no local mutation bypass is introduced.
- **Not adopted:** Editing `usage-windows.ts` conflicts with the explicit no-`pi-dotfiles` constraint and is unnecessary because the monitor already watches sanitized atomic files.

```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "The final plan contains path- and severity-specific review dispositions, exact protocol and operational resolutions, explicit prerequisites, approval gates, and residual risks."
    }
  ],
  "changedFiles": [
    "tasks/plans/shared-authority.md"
  ],
  "testsAddedOrUpdated": [],
  "commandsRun": [
    {
      "command": "Read reviews/consistency.md, reviews/readiness.md, planner-output.md, and direct cited source evidence",
      "result": "passed",
      "summary": "Resolved every evidence-backed critical or important review gap in one canonical plan write."
    }
  ],
  "validationOutput": [
    "Canonical plan path now exists.",
    "Ticket DTOs/errors/retries, authority states, socket exclusion, verifier consistency, self grant, bounds, timing, H1/L1 gates, and protocol ownership are explicit.",
    "No source repository, pi-dotfiles file, usage-windows.ts, or live configuration was changed."
  ],
  "residualRisks": [
    "An already-started provider request cannot be fenced; uncertain capacity remains quarantined.",
    "Second-Mac identity/account mapping, Tailnet policy, Keychain behavior, and production timing remain operator-gated and unverified.",
    "Per-user LaunchAgents remain unavailable before login."
  ],
  "noStagedFiles": true,
  "diffSummary": "Created the requested canonical plan once, incorporating all evidence-backed critical and important review fixes without source or live-config edits.",
  "reviewFindings": [
    "resolved blocker: tasks/plans/shared-authority.md - canonical plan is materialized.",
    "resolved critical: planner-output.md ticket and lease wire representations, endpoint errors, and retry rules are fully specified in the final plan.",
    "resolved critical: pi-claude-permit-gate/permit-daemon.mjs ownership now uses an exclusive loopback socket plus persisted term/owner fencing.",
    "resolved critical: authority-wide verifier storage and atomic cross-lane rotation/revocation are specified.",
    "resolved important: decision-brief.md H1/L1 prerequisites and no-termination behavior are explicit deployment gates.",
    "resolved important: Ruminaider and the confirmed peer both require policy-tested Serve access; no local mutation bypass exists.",
    "not adopted: managed-local client mode, because both Macs use the authenticated authority path and launchd ownership belongs to daemonMode=authority.",
    "not adopted: usage-windows.ts publication, because it violates the hard no-pi-dotfiles boundary."
  ],
  "manualNotes": "True user, maintenance, Tailnet-owner, credential, second-Mac, and administrator gates remain unresolved by design rather than guessed."
}
```
