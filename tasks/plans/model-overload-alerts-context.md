# Context: per-model overload alerts (permit gate → authority → lane sampler / Claude Lane Monitor)

Artifact path (this file, authoritative): `/Users/albertgwo/.pi/agent/sessions/--Users-albertgwo-Repositories-pi-claude-permit-gate--/subagent-artifacts/outputs/a24ffeab-b083-4573-b5f1-9129688f9201/tasks/plans/model-overload-alerts-context.md`
The run gave one output path, so the meta-prompt is in §11 of this file rather than in a separate `meta-prompt.md`.

Read-only pass. No files in either repo were changed.

---

## 0. TL;DR (the facts that shape the design)

1. **The client already knows the model at the point of failure.** In Pi's `message_end`, `event.message` is an `AssistantMessage` with `model: string` and `provider` (`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts:382-398`). The real incident record has `provider:"anthropic-c"`, `model:"claude-fable-5-2"`, `stopReason:"error"`, and `errorMessage:'{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011ChP3f1L2ttp2i1qUr8Bm6"}'`. This was checked against `~/.pi/agent/sessions/--Users-albertgwo-Repositories-albot--/`. Each overload and each retry ends as a separate assistant message, so `message_end` fires once per overload.
2. **The authority never sees a model today.** Create, claim, renew, complete, and await bodies carry no model. In v0.4.34, `index.ts:601` (`providerFailure`) returns `undefined` for overloads, so an overload completes as `released` with `reason:null`, and the authority cannot tell it apart from a success.
3. **Adding a key to any existing request body breaks old authorities.** Every request validator uses `assertExactObject` (`authority-state.mjs:632`; complete body `:1426-1449`) and answers `400 invalid_request`, which is not retryable. If a complete request fails that way, the client's `release()` (`index.ts:608`) catches the error, calls `abandon()`, and drops the record. The lease then runs out its deadline and becomes **`uncertain` quarantined capacity**: the opposite of what we want.
4. **Adding a key to the complete request is also a state-rollback hazard.** The complete request is stored verbatim as the operation fingerprint (`operationFingerprint` `:1393`, `rememberOperation`). `validateState` → `validateOperationResult` (`:803-812`) runs `validateMutationRequest` again on every stored fingerprint whenever the state is opened or committed. If an authority were rolled back to an older build while the state held such a fingerprint, the lane would fail validation (`StateFault`), degrade, and loop in launchd restarts. Fingerprints are retained for 2 minutes to 24 hours.
5. **Adding a top-level key to lane state needs a state-schema bump, which breaks old clients.** `validateState` checks exact keys (`stateKeys()` `:745`, `hasExactKeys`). `STATE_SCHEMA_VERSION = 2` (`:29`) is echoed in health. Old clients reject health unless `stateSchemaVersion === 2` (`index.ts:412` `validAuthorityHealth`), and the monitor rejects a snapshot unless `stateSchemaVersion == 2` (`AuthorityWireModels.swift:236-240`). **Do not persist overloads in lane state, and do not bump STATE_SCHEMA_VERSION.** Lessons also forbid adding work to the commit path.
6. **Read-path tolerance differs by consumer:**
   - `/v1/health`: tolerant consumers. Old Pi clients check only named fields (`index.ts:412`). The lane sampler copies named fields (`scripts/lane-sampler.mjs:53-57`), and `bootstrap-client.mjs:236` reads `status`/`authorityId`. **A new health field is safe on the wire**, but the schema `AuthorityHealthV1` has `additionalProperties:false`, so the schema, docs, and fixtures need updating.
   - `/v1/snapshot`: **intolerant consumer.** The Swift monitor rejects unknown keys (`rejectUnknownAuthorityKeys`, `AuthorityWireModels.swift:22-31`, applied in `AuthorityWireSnapshotV1.init` `:230`). Older monitors on other Macs would show **every lane as "Permit offline/unavailable"** if the snapshot gained a field unconditionally. The exporter (`scripts/authority-exporter.mjs:85`) and syncer (`scripts/allowance-syncer.mjs:57`) read the snapshot tolerantly.
7. **The monitor's overload data must ride in `PermitSnapshot`.** The 2-second (menu open) and 30-second (menu closed) polls call `refreshPermits()` → `[LaneID: PermitSnapshot]` (`MonitorStore.swift:205-226`; `SharedLaneSnapshotSource.swift:37-40`). Data stored anywhere else in `LaneSnapshot` would refresh only on a full refresh, so the alert would not clear on its own.
8. **The capability-negotiation precedent already exists.** In commit `72ec2b3`, `ticket-await` was added as a health capability, and the `x-permit-claim-on-offer` request header is ignored by older lanes. The client keeps the health answer for 60 s (`index.ts:487`, `HEALTH_CACHE_MS`), and `test/ticket-await.test.mjs:116-150` has a transport harness that simulates a lane without a capability or route.
9. **Pre-existing baseline issues** (not caused by this feature):
   - `npm test`: 122 pass, 1 fail. `test/allowance-prober-auth.test.mjs` cannot import `…/pi-coding-agent/dist/core/auth-storage.js` under the mise Node 26 global; this is an environment gap.
   - The monitor's `scripts/test.sh` digest gate **already fails**. The consumer manifest pins schema `d2bbd240…`, but the current schema is `81bd8175…`, changed by ticket-await. `node scripts/validate-authority-contract.mjs --digest-file ../pi-claude-lane-monitor/Tests/ClaudeLaneMonitorTests/Fixtures/authority-v1/consumer-manifest.json` exits 1. `LaneSnapshotTests.swift:716` hard-codes `d2bb…`.

---

## 1. Today's data flows (as-is)

### 1a. Client (Pi extension, `index.ts`, v0.4.34)
- `before_provider_request` (`:653-661`): in authority-client mode it runs `acquireAuthority()` → `client.acquire(provider)` → `GET /v1/health` (kept 60 s) → `POST /v1/tickets` (with `x-permit-claim-on-offer`) → `/await` or claim. `event.payload.model` is available here but is not used. Warm requests are detected by `payload.max_tokens === 1`.
- `after_provider_response` (`:662`): handles only warm permits (`activePermit?.warm`). It treats status 429 as a rate limit, and **529 is now ignored**. The event carries only `status` and `headers` (`types.d.ts:727-731`), with no model.
- `message_end` (`:663`):
  ```ts
  if (!activePermit || event.message.role !== "assistant") return undefined;
  const failure = providerFailure(event.message);
  await release(!!failure, failure ? `assistant-${failure}` : "assistant-end", failure ? cooldown() : undefined, detached);
  ```
  `providerFailure` (`:601`) returns `undefined` when `/overloaded/i` matches. It returns `"rate-limit"` for rate-limit or 429 text that does not mention quota or billing.
- `release()` (`:608`) calls `client.complete(record, failure, signal)` (`:564`). That builds the `complete` additions `{leaseId, generation, outcome, reason[, cooldownMs]}` and runs `operation()`, which retries until acknowledged (`sendOperation`). On failure it abandons. **No later request starts until completion is acknowledged** (the `authorityLifecycle` gate, `:580-596`).
- Client API surface: `return { abandon, acquire, renew, complete, cancel, health, prefetch }` (`:576`).
- Transport helpers inside `createAuthorityClient` (`:447`):
  - `send` (`:480`): one attempt, with token refresh on 401.
  - `sendRetry` (`:481`): retries every retryable response.
  - The `healths` cache (`:486-487`).
  - The token cache (`:466-471`), which reads the Keychain once per 15 minutes by default.
- Env guard: in local mode, any env var named `CLAUDE_PERMIT_GATE_AUTHORITY_*`, `…_ORIGIN`, or `…_DAEMON_MODE` is a **startup error** (`:319-320`). Any new toggle must not use the `CLAUDE_PERMIT_GATE_AUTHORITY_` prefix.

### 1b. Authority (`permit-daemon.mjs` routes → `authority-state.mjs` `AuthorityState`)
- Router `handleAuthorityRequest` (`permit-daemon.mjs:210-299`):
  - `GET /v1/health` (`:228`): any valid token.
  - `GET /v1/snapshot` (`:233`): `snapshot:read`.
  - `POST /v1/tickets/:id/await` (`:240-252`): held outside the mutation queue.
  - Ticket mutations (`:261-283`): the body is read fully first (`authorityRequestBody` `:43-70`), then the mutation goes through `serializeAuthorityMutation` (`:192`).
  - `POST /v1/allowance` (`:284`).
  - Anything else returns `404 not_found` (`:293`).
  - Every route rejects a query string (`:225`), and every POST requires `content-type: application/json` (`:227`).
- `AuthorityState.health()` (`authority-state.mjs:2083-2112`) returns the exact key set, including `capabilities: ["tickets","snapshot","allowance","ticket-await"]` (`:2102`). `snapshot()` (`:2114-2118`) is health minus `capabilities`, plus `laneId` and `allowance`.
- Commit path: `_transition` (`:1821`) → clone, mutate, `_claimAttached`, then `_commit` (`:1717`). `_commit` asserts the stored header, takes the verifier fence, validates, writes durable JSON, and fsyncs. Committing is the expensive part; lessons forbid adding any whole-state pass to it.
- In-memory, non-persisted precedent: `_awaiters` and `_claimIntents` (`:1594-1606`, comment "Neither is persisted: a restart drops the open requests."). This is the pattern to copy for an in-memory overload record.
- Complete handling (`mutateTicket` `:1914-1968`): `outcome:"throttled"` sets `scheduler.cooldownUntilEpochMs`, and `scheduleOffers` (`:1270-1271`) grants nothing during a cooldown. `assistant_overloaded` is still an accepted throttle reason (`:1447`, schema `TicketCompleteRequestV1`), **so an old client (≤ v0.4.33) still pauses the lane on overload.** Only clients on v0.4.34 or later stopped. See risk R1.

### 1c. Lane sampler (`scripts/lane-sampler.mjs`, LaunchAgent `com.longweekendprojects.claude-lane-sampler`, installed by `bootstrap-client.mjs:246`)
- Every 5 s it calls `GET <origin>:<port>/v1/health` for each lane with the `snapshotRead` bearer. It writes one JSONL row per lane to `~/Library/Logs/Claude Permit Authority/lane-samples.jsonl` (rotates at 32 MB). Row fields: `at, provider, up, state, active, offered, uncertain, queued, current, max, laneTerm, instanceId, cooldownUntil, oldestWaitEpochMs, client{records,oldestAgeS,lockAgeS}`. A live row from 2026-11-25T05:21:43Z matches this shape.
- It copies fields by name, so it ignores new health keys until someone adds them to the `row` literal (`:57`).

### 1d. Claude Lane Monitor (Swift, `/Users/albertgwo/Repositories/pi-claude-lane-monitor`)
- Source composition (`SharedLaneSnapshotSource.swift:300-414`): with authority config and `monitorSource == .authority`, it uses `SharedLaneSnapshotSource` wrapped in `BypassMonitoringSource`. Otherwise, or while bypass is on, it uses `LocalLaneSnapshotSource` (local daemon `/health` on 127.0.0.1:8791-8794).
- Authority read: `AuthorityClient.snapshot(for:)` (`AuthorityClient.swift:304-328`) sends `GET /v1/snapshot` with only the Authorization header. Headers are set in `loadHTTPS` (`:352-375`); the request struct `AuthorityAuthenticatedReadRequest` (`:242-245`) holds only `url` and `authorization`. It checks status 200, `Cache-Control: no-store`, the exact `Content-Type`, and ≤ 64 KiB, then `AuthorityWireSnapshotV1.decode` with strict keys (`AuthorityWireModels.swift:172-301`).
- Mapping: `permitSnapshot(from:)` (`SharedLaneSnapshotSource.swift:181-206`) → `PermitSnapshot` (`LaneModels.swift:72-160`, `Codable, Equatable`, all-optional init params).
- Store cadence (`MonitorStore.swift`):
  - `bootstrap()` → `refreshAll`, then background `refreshPermitsInBackground` every 30 s while the menu is closed (`:254-269`).
  - `menuDidOpen` starts a 2 s `refreshHealth` loop (`:241-252`).
  - The menu bar label recomputes `MenuBarPresentation` whenever `snapshots` publishes, plus a 60 s `presentationDate` timer (`ClaudeLaneMonitorApp.swift:70-83`).
- How alerts look today, with **no macOS notifications** (no `UserNotifications` or `UNUserNotificationCenter` anywhere in `Sources/`):
  - **Menu bar title markers**: `!` for a permit problem and `?` for an uncovered allowance (`LaneModels.swift:543-545`). Reasons go into the `tooltip` and `accessibilityLabel` (`:547-575`).
  - **Header warning label**: `Label("Watcher unavailable", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)` (`MenuContentView.swift:180-185`).
  - **Footer error lines**: `credentialMessage`, `bypassMessage`, `loginItemMessage`, red or orange `.caption2` labels (`MenuContentView.swift:253-299`).
  - **Per-card state**: `SignedOutBadge` replaces `LaneStatusBadge`, `observationSummary` is overridden ("Sign-in expired · allowance frozen"), and there is a "Sign in" control beside `PermitPillView` (`MenuContentView.swift:427-553`). Layout heights are fixed (`LaneBoardLayout`, base card height 143 pt, `:307-328`). Adding a row to a card means adjusting `cardHeight`.
  - The `LaneCredentialController` pattern (`LaneCredentialController.swift`) is a file-watched, self-clearing condition that triggers `store.refreshManually()` when it clears. It is the closest analogue to "an alert that clears on its own".
- Monitor lessons (`tasks/lessons.md`): glanceable 2×2 grid with no scrolling. Keep provenance detail in tooltips. One long-lived `URLSession` (`AuthorityClient.authoritySession`). Custom encoding where explicit nulls matter.

---

## 2. Contracts and artifacts this feature touches

| Artifact | Location | Change needed for the recommended shape |
|---|---|---|
| Protocol doc | `docs/authority-protocol-v1.md` (211 lines). Health field list `:82`; snapshot `:84-92`; ticket endpoint table `:100-107`; "Neither endpoint may expose …" `:92` | New capability, new report endpoint row, the health field, the opt-in snapshot field, and retention/semantics |
| Schema | `protocol/authority-v1.schema.json` (`$defs`: `AuthorityHealthV1` with `capabilities` enum and `maxItems:4`; `LaneSnapshotDTOv1`; `TicketCompleteRequestV1`; `HealthResponseFixtureV1`, `SnapshotResponseFixtureV1`) | Add a `ModelOverloadV1` item def, a new request DTO (`ModelOverloadReportRequestV1`), an optional property on health and snapshot, and a capability enum value. **`capabilities.maxItems` is 4 today**, so raise it to 5. |
| Fixtures and manifest | `test/fixtures/authority-v1/{valid,invalid}/*.json`, `manifest.json` (per-file sha256 plus `schemaSha256`; current `81bd8175…`) | New valid fixtures (report request, health and snapshot with overloads). New invalid fixtures (over-bound count, bad model id, unknown key). Re-digest. Keep `invalid/health-unknown-field.json` (`bySession`) invalid. |
| Validator | `scripts/validate-authority-contract.mjs` (339 lines; `semanticErrors` around `:312`) | Possibly new semantics (`lastAtEpochMs <= serverTimeEpochMs`, `count >= 1`, window bound) |
| Contract test | `test/authority-contract.test.mjs` | Re-runs the validator; copy-and-tamper helpers |
| Authority state | `authority-state.mjs` `AuthorityState` (`:1593`); `health()` `:2083`; `snapshot()` `:2114` | In-memory per-model ring; `reportOverload(principal, request)`; health and snapshot projection |
| Authority routes | `permit-daemon.mjs` `handleAuthorityRequest` `:210-299` | New `POST` route (auth `permit:mutate`, read the body fully, **not** `serializeAuthorityMutation`); snapshot opt-in header |
| Client | `index.ts` `:576`, `:601`, `:662-663` | Detect the overload and its model; fire-and-forget report gated on capability |
| Client tests | `test/provider-failure.test.mjs` (12 lines), `test/ticket-await.test.mjs` (transport harness `:116-150`), `test/source-policy.test.mjs` (authority-client tests `:165-708`), `test/permit-daemon.test.mjs` (real authority daemon `authorityDaemon(t)`, e.g. `:1001-1010`) | New tests (see §8) |
| Sampler | `scripts/lane-sampler.mjs:57` | Add the overload field to the row |
| Exporter (optional) | `scripts/authority-exporter.mjs:60-110` (Prometheus metrics from snapshot) | Optional `claude_lane_model_overloads{model=…}` gauge, only if the exporter sends the opt-in header |
| Deploy | `scripts/install-authority.sh:195,262` and `scripts/validate-authority.sh:191` embed and verify the **schema sha256** in deployment manifests | No code change, but the authority must be redeployed on the authority host. The live origin is `https://ruminaider.tail252378.ts.net`; the local `authority-client.json` has `monitorSource: authority`. Pinning the Pi package alone does not update it. |
| Monitor wire | `AuthorityWireModels.swift:172-301` (`AuthorityWireSnapshotV1` CodingKeys and init) | Optional decode of the new key; still reject unknown keys |
| Monitor client | `AuthorityClient.swift:242-245,304-328,352-375` | Send the opt-in header (extend the request struct) |
| Monitor mapping and model | `SharedLaneSnapshotSource.swift:181-206`; `LaneModels.swift` `PermitSnapshot` `:72-160`; `MenuBarPresentation` `:492-575` | Carry `modelOverloads` in `PermitSnapshot`; add a title marker or tooltip text |
| Monitor UI | `MenuContentView.swift` (header `:157-188`, card `:427-553`, `LaneBoardLayout` `:307-328`, `PermitPillView` `:773+`) | Alert presentation |
| Monitor fixtures | `Tests/ClaudeLaneMonitorTests/Fixtures/authority-v1/consumer-manifest.json` (pins `canonicalCommit 7752dfa`, `schemaSha256 d2bb…`); `snapshot-response.json`; `LaneSnapshotTests.swift:713-716` | Re-pin to the new schema digest and add a snapshot-with-overloads fixture. **Already stale today.** |
| Monitor README | `README.md` "What the menu shows" | Document the alert |
| Permit gate docs | `README.md`, `CHANGELOG.md`, `tasks/discovery/2026-11-24-overload-lane-freeze.md` | Changelog entry |

---

## 3. Existing code to reuse or extend (evidence for extend-vs-new)

- **Capability gate plus cached health:** `createAuthorityClient`'s `health(provider)` (`index.ts:487`) returns `{capabilities}`, and `acquireOne` reads `lane.capabilities.includes("ticket-await")` (`:519`). Reuse it for `capabilities.includes("model-overloads")`. *Extend.*
- **Fire-and-forget send:** `send()` (`:480`) does one attempt with token reuse. `sendRetry` retries forever on 503 and 429, which is too aggressive for telemetry. *Use `send` wrapped in a small bounded retry (for example two attempts) with an `AbortSignal.timeout`.*
- **In-memory, non-persisted authority structures:** `_awaiters` and `_claimIntents` (`authority-state.mjs:1601-1605`). *Copy this pattern.*
- **Read-without-mutation route that bypasses the queue:** the await route (`permit-daemon.mjs:240-252`) reads the body fully before acting and is never queued. *Copy it for the report route, minus the hold-open behaviour.*
- **Header opt-in ignored by old lanes:** `x-permit-claim-on-offer` (`permit-daemon.mjs:265`, doc `:102`). *Copy it for snapshot opt-in* (for example `x-permit-snapshot-fields: model-overloads`).
- **Exact-key validation helpers:** `assertExactObject`, `assertUuid`, `assertSchemaVersion`, `assertProvider`, `assertSafeInteger` (`authority-state.mjs:632-660`), and `assertPrincipalMatches` (`:663`). *Reuse them for the new request DTO.*
- **Monitor self-clearing condition:** `LaneCredentialController` with `LaneCredentialFailure.description(for:now:)`, the folded and signed-out UI, and `onStateChanged` → `refreshManually`. *Pattern reference only.* It is file-based and local, so it is not reusable as-is.
- **Monitor title markers:** `MenuBarPresentation` markers `!` and `?` (`LaneModels.swift:543`). *Extend.*
- **Monitor test transports:** `authorityPlan.load` (`LaneSnapshotTests.swift:924,1205,1235`). *Extend for header assertions.*
- **Close but rejected:**
  - (a) Reusing `reason:"assistant_overloaded"` on a `released` completion. Old authorities reject `reason != null` with `released` (`:1446`), and there is still no model.
  - (b) Reusing the local daemon `/throttle` path. Local mode and bypass have no shared view, and the local daemon is a separate protocol.
  - (c) The allowance publish route. Its scope is `allowance:publish`, it is persisted and replay-tracked in lane state, and its semantics are wrong.
  - (d) Tagging `TicketCreateRequestV1` with the model. The create happens before the outcome is known, exact keys break old authorities, and it is persisted in `createResponse` and tickets.

---

## 4. Decision points with options

**D1. How the authority learns of an overload and its model.**
- **(A) New endpoint `POST /v1/model-overloads` (recommended).** Advertised by a new health capability (for example `model-overloads`). Body roughly `{schemaVersion, installationId, provider, accountBindingId, reportId(uuid), model, observedAtEpochMs}`. Requires `permit:mutate` (the client already holds that token) or a new scope; a new scope needs verifier-store and bootstrap changes, so avoid it. Not persisted, not queued, no verifier fence. The client sends only when the kept health lists the capability, so an old authority never sees it. If the authority is downgraded within the 60 s health-cache window, it answers `404 not_found`, which the client ignores.
- (B) Optional `model` key on the `complete` body. **Rejected:** state-rollback hazard (fact 4); the fingerprint grows; it couples telemetry to the commit path; and an old authority answering 400 leads to abandon and `uncertain` capacity.
- (C) Optional `model` on create plus overload outcome on complete. Rejected for the same reasons, made worse.

**D2. Where the record lives on the authority.**
- **(A) In-memory per-lane ring (recommended).** For example `Map<model, number[] timestamps>`, capped at 16 models × 64 timestamps, pruned to the window on write and read. Lost on lane restart; acceptable for a 5-minute alert. No effect on the commit path or the state schema.
- (B) A separate small sidecar file per lane. It survives restarts but adds fsync, a file format, and permissions. It must never be touched by `_commit` or `validateState`. Not needed for an alert window of minutes.
- (C) Lane state: **rejected** (fact 5).

**D3. Window and shape exposed.** The proposed item is `{model, count, firstAtEpochMs, lastAtEpochMs}` with `windowMs` fixed (for example 300 000) and returned explicitly so consumers do not hard-code it. Only models with `count >= 1` inside the window are included, sorted by `lastAtEpochMs` descending. The array is bounded (≤ 16 entries) to stay under the 64 KiB response cap. Options:
- (a) Count reports per distinct `reportId`, the recommended default for idempotent retries.
- (b) Also count distinct installations or sessions. **Do not expose** installation, session, or request IDs: the doc (`:92`) forbids them on health and snapshot.

**D4. Read path.**
- **Health:** add `modelOverloads` unconditionally once the capability exists. Old clients and the sampler tolerate it (fact 6). The schema needs an optional property.
- **Snapshot:** opt-in only (recommended), via a request header such as `x-permit-snapshot-fields: model-overloads`. Without it, the response is byte-identical to today, so old Swift monitors keep working. Alternatives:
  - A new `GET /v1/model-overloads` (`snapshot:read`). This costs four more HTTPS requests per poll (2 s or 30 s).
  - The monitor reads health instead. Health requires a token authorized by the verifier but no specific scope (`permit-daemon.mjs:229` passes `undefined`), so the `snapshotRead` token works, but this doubles requests.
  - A query parameter: **not possible**, because the router rejects any query (`permit-daemon.mjs:225`).

**D5. Client detection point.**
- **(A) `message_end` (recommended).** `stopReason === "error"` and `errorMessage` matches `overloaded_error` or `Overloaded` or a 529. Use `message.model` and `message.provider`, which are authoritative for that request, rather than `ctx.model`, which may have changed.
- (B) `after_provider_response` with `status === 529` is an exact signal but has no model. It would require stashing `event.payload.model` from `before_provider_request` per active permit. It also covers **warm (cache-keepalive) 529s**, which never reach `message_end` (`index.ts:662`). Decide whether warm overloads count: they are real overloads, but extra noise.
- Either way, the report must run **after or alongside `release()` and must never be awaited on the permit path**. Lessons: completion must be acknowledged before the next request, and nothing may block on telemetry.

**D6. Model identifier and display name.**
- (a) Wire carries only the model id (`claude-fable-5-2`, ASCII identifier pattern, ≤ 64 characters). The monitor formats it as "Claude Fable 5.2" with a deterministic formatter: split on `-`, title-case the words, join trailing numeric parts with `.`. Recommended: no free text on the wire. The formatter needs a fallback for odd ids such as dated or `-fast` variants.
- (b) The client also sends `ctx.model.name`, a display string from Pi's models registry, for example "Claude Fable 5.2". This needs ASCII and length validation, may be absent, and differs between Macs.
- (c) The monitor keeps a static map. It goes stale.

**D7. Monitor presentation.**
- Options, any combination:
  - (i) Menu bar title marker, for example `⚠︎` or a new letter, plus a tooltip sentence: "Claude Fable 5.2 overloaded on lane C (6 in the last 5 min)".
  - (ii) An orange header `Label` like "Watcher unavailable" (`MenuContentView.swift:180`).
  - (iii) A per-card line or badge near `PermitPillView`. Needs a `LaneBoardLayout.cardHeight` change, or replaces the observation summary line temporarily.
  - (iv) macOS user notification via `UNUserNotificationCenter`. **Not used anywhere today.** It needs a notification authorization prompt for an ad-hoc-signed `LSUIElement` app, and it fires even with the menu closed. This is the only option that is actually "push". Risky; scope it separately.
- The cadence while the menu is closed is 30 s (background poll), so a title marker appears within about 30 s and clears within about 30 s after the window drains.
- When the authority is unreachable, keep the last overload state labelled stale, or drop it. Recommended: drop it, or show nothing, because reachability is already flagged with `!`. Monitor lessons: never present stale data as current truth.

**D8. "Clears on its own" semantics.** Recommended: the authority computes counts against its own clock and the window, and the monitor shows the alert iff the newest response contains an entry. Optionally require `serverTime - lastAt < windowMs` as well. Alternative: the monitor clears after N minutes of no new `lastAtEpochMs`.

**D9. Local mode and bypass.** Local daemons (`permit-daemon.mjs` local branch, `/health` v3) have no overload record. Options: out of scope (recommended for v1; the monitor shows nothing in local mode), or later a local-daemon `/overload` POST plus a health field.

**D10. Old clients that still throttle on overload (≤ v0.4.33).** The authority still accepts `throttled` + `assistant_overloaded` and pauses the lane (fact in §1b). Options:
- (a) Leave it; this feature only adds alerts.
- (b) The authority treats `reason:"assistant_overloaded"` as release-without-cooldown, while still accepting the body and recording the throttled state. This changes old-client semantics, but "No lane-wide or per-model holding of permits: overloads must never pause capacity" argues for it. It is a separate, small change in `mutateTicket` `:1954-1960`. It must keep `state:"throttled"`, because the stored fingerprint and response validation require `response.state === request.outcome` (`:811`). It cannot count as an overload record, because the model is unknown; at most it could record "unknown model" if desired.
- **Decision owner: planner or user.**

**D11. Versioning.** Client release (patch bump per AGENTS.md) vs. the authority redeploy on ruminaider vs. the monitor release. Any order works if negotiation holds:
- Client without the capability: sends nothing.
- Authority without the header: no snapshot field.
- Monitor against an old authority: header ignored, no field.

---

## 5. Compatibility matrix (target state with D1-A, D2-A, D4 header opt-in)

| Pair | Behaviour |
|---|---|
| New client → old authority | Kept health lacks the capability, so no report is sent. If the authority is downgraded inside the 60 s cache, the report gets `404 not_found` (route unknown), which is ignored. **No effect on permits.** |
| Old client → new authority | Never reports. Its health validation ignores the new key (`index.ts:412`). ≤ v0.4.33 clients still throttle the lane on overload (see D10). |
| New monitor → old authority | The opt-in header is ignored, the snapshot keeps its exact old key set, and the field decodes as absent. No alert. |
| Old monitor → new authority | Sends no header, so the snapshot is unchanged and the strict decoder passes. |
| Lane sampler (any) → new authority | Health has the extra key. Old sampler drops it; new sampler logs it. |
| Exporter and syncer → new authority | Unchanged unless they opt in. |
| Authority rollback | No persisted trace, so the old build opens state cleanly. |

---

## 6. Hard constraints (from `tasks/lessons.md`, AGENTS.md, protocol doc)

- Overloads must never pause capacity: no cooldown, no concurrency decrement, no per-model hold.
- No whole-state pass on the commit or reconcile path. Nothing new in `_commit`, `validateState`, `compactRetainedState`, or `reconcileWouldChange`.
- Never hold a shared lock across an await or fsync. The client's report must not touch the session ledger lock (`sessionLedgerMutator`), and the authority must not queue the report behind `serializeAuthorityMutation`.
- Read the request body fully before acting (`authorityRequestBody`), because a stalled socket destroys silently at 300 s.
- Exact-key validation on the new request DTO. Unknown keys get 400.
- Retry and idempotency: the report is telemetry, so a bounded retry is fine. Use a `reportId` UUID to dedupe retries in memory (bounded set). Never block or retry forever, never reuse the permit-operation ledger, and abort on bypass.
- Old and new compatibility in both directions (§5). Do not bump `STATE_SCHEMA_VERSION` or `protocolVersion`.
- Health and snapshot must not expose installation, session, request, ticket, or lease IDs, account bindings, paths, headers or bodies, or raw errors (doc `:92`). A model id is fine.
- Environment variable naming: no `CLAUDE_PERMIT_GATE_AUTHORITY_*` (local-mode startup error).
- AGENTS.md: a runtime change needs a patch bump, tag, release-notes edit, `pi-package-pin` in `~/Repositories/pi-dotfiles`, and a checkout of the live package. `npm test` must pass before tagging, and a new bug fix needs a test that fails without it.
- The schema and doc are the only protocol owners. The monitor is a digest-checked consumer and must not define its own DTO beyond what the schema says.

---

## 7. Risks

- **R1:** Old clients (≤ v0.4.33) on other Macs still send `throttled` + `assistant_overloaded`, so lane-wide pauses continue until every Mac upgrades (see D10).
- **R2:** The report adds one HTTPS request per overload per session. In a burst (5 sessions × Pi retries) that is about 10-20 requests per minute: trivial. It must still be bounded (timeout, ≤ 2 attempts, no queue growth). The client should also coalesce per model, for example at most one in flight per (provider, model).
- **R3:** In-memory state resets on lane restart, and degraded lanes exit and restart. Counts drop to 0 and the alert may clear early. Acceptable, but document it.
- **R4:** An authenticated caller can inflate counts with fake reports. Bound by caps; the scope is `permit:mutate`, which only installed clients hold.
- **R5:** Clock skew. Record `receivedAt` from the authority clock for windowing. A client `observedAtEpochMs` is optional and informational, and can be rejected if more than 30 s in the future, like the allowance check.
- **R6:** Changing the Swift `PermitSnapshot` `Codable`/`Equatable` shape touches many test constructors. Default parameters keep that small. The monitor's `LaneSnapshot.encodedJSON()` is used in tests.
- **R7:** Monitor schema-digest gate drift already exists (`d2bb…` vs `81bd…`). The monitor change must re-pin to the new digest and update `LaneSnapshotTests.swift:716`, or `scripts/test.sh` keeps failing.
- **R8:** The authority deploy lives on the authority host (ruminaider) through `scripts/install-authority.sh` (immutable staged release, build id `pi-claude-permit-gate-<ver>+git.<sha>`, schema sha in manifest, `validate-authority.sh`). Until it is redeployed, the capability is absent and nothing is shown. This is safe, but the feature is invisible.
- **R9:** `message_end` overload text detection depends on Pi's `errorMessage` format. The incident shows the raw JSON body. Also match `529` and `overloaded`, as v0.4.34's `providerFailure` does with `/overloaded/i`.
- **R10:** If the capability ships in `capabilities` but the route is later removed, a 404 has to be harmless on the client. Design for it.

---

## 8. Validation path

Permit gate:
- `npm test`. Baseline is 122 pass and 1 environmental fail in `allowance-prober-auth.test.mjs`. Proposed new tests:
  - Unit: overload detection plus model extraction (extend `test/provider-failure.test.mjs`), including the exact incident `errorMessage` and non-overload errors.
  - State: `AuthorityState.reportOverload` counts within the window, prunes on read, caps models and entries, dedupes `reportId`, rejects unknown keys and bad model ids, and **never changes `scheduler.cooldownUntilEpochMs` or `currentConcurrency` or writes the state file**. Assert that the state file mtime and bytes are unchanged.
  - Client against the real `AuthorityState` through the `ticket-await.test.mjs`-style transport:
    - The report is sent only when the capability is advertised.
    - A lane without the capability gets zero extra calls.
    - A 404 or a hang never delays `complete` or the next `acquire`.
    - The completion is still `released` with `reason:null`.
  - Daemon (`permit-daemon.test.mjs` `authorityDaemon(t)`):
    - The route requires auth and scope and reads the body first.
    - Health includes `modelOverloads`.
    - The snapshot includes it **only** with the opt-in header, and without the header the snapshot's key set equals today's.
- `node scripts/validate-authority-contract.mjs` with the new fixtures and re-digested manifest.
- Regression: "an overload does not throttle the lane" (`test/provider-failure.test.mjs:7`) still holds.

Monitor:
- `scripts/test.sh` (validator digest gate plus `swift test` with the Command Line Tools frameworks), after re-pinning `consumer-manifest.json`.
- Decoder: a snapshot with `modelOverloads` decodes, and one without it decodes. Unknown nested keys are rejected.
- Client: the opt-in header is present on `/v1/snapshot` requests (transport capture).
- Presentation: the title, tooltip, or card text reads "Claude Fable 5.2 overloaded on lane C (6 in the last 5 min)", and it clears when the next permit refresh returns no entry. This works on the `refreshPermits` path, not only `refresh`.

Live (after deploy, read-only):
- `tail ~/Library/Logs/Claude\ Permit\ Authority/lane-samples.jsonl` shows the new field.
- `curl` health with the `snapshotRead` token. The command is in `scripts/bootstrap-client.mjs:236`.

---

## 9. Suggested approach (direction, not a script)

1. Protocol first. Write the doc and schema: capability `model-overloads`; `ModelOverloadReportRequestV1`; `ModelOverloadV1` item; optional `modelOverloads` (plus `modelOverloadWindowMs`, or put the window in each item) on `AuthorityHealthV1`, and on `LaneSnapshotDTOv1` only when opted in; `capabilities.maxItems` → 5. Add fixtures and re-digest.
2. Authority: in-memory ring on `AuthorityState`; `reportOverload()`, which validates, authorizes the lane, records, and returns `{accepted:true}` or a minimal DTO; projection in `health()` and `snapshot({includeModelOverloads})`; route in `permit-daemon.mjs` placed before the ticket regex, with the header read on the snapshot route.
3. Client: an exported pure `providerOverload(message)` → `{model} | undefined`; a `client.reportOverload(provider, model)` that checks capabilities via `health()`, sends with a short timeout and at most two attempts, never throws, and is not awaited from `message_end` (`void …catch(()=>{})`). Skip it in bypass or local mode. Decide on warm 529s (D5).
4. Sampler: add the field to the row.
5. Monitor: header opt-in → wire decode → `PermitSnapshot.modelOverloads` → `MenuBarPresentation` marker and tooltip, plus a card or header label → re-pin the digest.
6. Release: permit gate patch release per AGENTS.md, authority redeploy on ruminaider, monitor `scripts/install.sh` (behind its maintenance gate).

---

## 10. Resolved questions and assumptions

- Resolved: the model id is available client-side (`message.model`); verified on a real incident message.
- Resolved: health has tolerant consumers; the snapshot has an intolerant Swift consumer (`rejectUnknownAuthorityKeys`).
- Resolved: the monitor's permit-only refresh path carries only `PermitSnapshot`.
- Resolved: no existing per-model or overload state exists anywhere in either repo ("none found" for reuse of an overload record).
- Assumption: a 5-minute window is acceptable (the example text says "in the last 5 min").
- Assumption: losing counts on lane restart is acceptable.
- Assumption: no macOS push notifications in v1 unless the user asks (D7-iv).
- Open for the planner or user: D3 window and count semantics, D5 warm 529s, D6 display-name source, D7 UI surface, D10 old-client overload throttles.

---

## 11. Meta-prompt for the planner

**Goal:** Produce an implementation plan, split across the permit gate repo (client, authority, protocol, sampler) and the lane monitor repo. It must make the authority learn per-model overloads from clients, keep an in-memory per-lane, per-model windowed record, expose it on health (always) and snapshot (opt-in), log it in the lane sampler, and show a self-clearing monitor alert. Overloads must never pause or hold capacity.

**Evidence:** §0-§5 above, with file:line references. Key anchors:
- Client: `index.ts:576,601,608,662-663,487,412`.
- Authority state: `authority-state.mjs:29,745,803-812,1393,1426-1449,1594-1606,1717,1821,1914-1968,2083-2118`.
- Authority routes: `permit-daemon.mjs:43-70,192,210-299`.
- Sampler: `scripts/lane-sampler.mjs:53-57`.
- Monitor: `AuthorityWireModels.swift:22-31,172-301`; `AuthorityClient.swift:242-245,304-375`; `SharedLaneSnapshotSource.swift:95-206`; `MonitorStore.swift:205-269`; `LaneModels.swift:72-160,492-575`; `MenuContentView.swift:157-299,427-553`.

**Success criteria for the plan:**
- Uses a separate report endpoint, or justifies an alternative, without touching persisted lane state, the commit path, or `STATE_SCHEMA_VERSION`.
- Has an explicit compatibility matrix covering all six pairings in §5.
- Lists schema, doc, fixture, and manifest changes and the monitor digest re-pin.
- Specifies the tests that fail without the change, plus an assertion that overloads leave scheduler cooldown and concurrency untouched.
- Takes a position on, or escalates, each of D3, D5, D6, D7, and D10.
- Gives release order and the deploy steps for the authority host.

**Hard constraints:** see §6. Planning only; do not edit either repo.

**Stop and escalation:**
- Escalate via `contact_supervisor` (`need_decision`) if the user must choose D7 (UI surface, especially macOS notifications) or D10 (changing old-client overload-throttle semantics on the authority).
- Do not escalate D3, D5, or D6 if a conservative default is stated.

**Validation:** §8.

---

## Scout Targets

1. **Authority host deployment and rollback path**
   - Question: On ruminaider, what exact steps and gates does `scripts/install-authority.sh` and `scripts/validate-authority.sh` require for a new authority build? Are there maintenance-approval, idle-sample, or `--check` gates? How is rollback to the previous release done?
   - Scope: `scripts/install-authority.sh`, `scripts/validate-authority.sh`, `tasks/validation/shared-authority-deployment.md`, `tasks/handoffs/2026-08-27-shared-claude-permit-authority.md`, `deploy/com.longweekendprojects.claude-permit-lane.plist.in`.
   - Why it matters: the feature is invisible until the authority is redeployed. The plan needs the real release sequence and its gates, and rollback safety backs the "no persisted trace" design.
   - Suggested agent: scout

2. **Contract validator semantics hooks**
   - Question: How does `scripts/validate-authority-contract.mjs` add per-definition semantic checks (`semanticErrors`, `semantics` arrays) and how does it validate `if/then` conditional properties? What is the minimal change to support an optional `modelOverloads` property on health and snapshot, and a new request definition?
   - Scope: `scripts/validate-authority-contract.mjs` (all 339 lines), `test/authority-contract.test.mjs`, `test/fixtures/authority-v1/manifest.json`.
   - Why it matters: the protocol change is the riskiest mechanical part (digest churn, the validator's own JSON-Schema subset may not support every keyword).
   - Suggested agent: scout

3. **Monitor test and presentation surfaces**
   - Question: Which existing Swift tests construct `PermitSnapshot`, `AuthorityWireSnapshotV1`, `MenuBarPresentation`, or `LaneBoardLayout` and would need updating? Where does `authorityPlan.load` capture request headers? What exact title, tooltip, and accessibility strings do tests assert?
   - Scope: `Tests/ClaudeLaneMonitorTests/LaneSnapshotTests.swift` (1864 lines; around 700-1250 for authority), `LaneBoardLayoutTests.swift`, `Fixtures/authority-v1/*`.
   - Why it matters: it sizes the monitor change and finds the tests that pin title markers and layout heights.
   - Suggested agent: scout

4. **Pi `message_end` and retry behaviour for overloads**
   - Question: Does Pi emit `message_end` for every overloaded attempt, including auto-retries, and is `errorMessage` always the raw JSON body for 529s? Does `after_provider_response` fire with `status: 529` for non-warm requests before `message_end`?
   - Scope: `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/**` (retry or agent loop, `after_provider_response` emitter); the incident session logs under `~/.pi/agent/sessions/--Users-albertgwo-Repositories-albot--/` around 2026-11-25T04:52-05:07Z.
   - Why it matters: it decides D5 and whether overload counts match reality (6 failures, 6 reports).
   - Suggested agent: scout

---

## Acceptance

- Artifact written: this file.
- Commands run (read-only):
  - `npm test` in the permit gate: 122 pass, 1 environmental fail in `test/allowance-prober-auth.test.mjs` (missing Pi module under the mise Node global).
  - `node scripts/validate-authority-contract.mjs`: passed, 28 valid and 21 invalid fixtures, schema `81bd8175…`.
  - The same validator with `--digest-file <monitor consumer-manifest>`: failed, pin drift `d2bb…` vs `81bd…`, pre-existing.
