# Implementation Plan: per-model overload alerts

Context report: `/Users/albertgwo/.pi/agent/sessions/--Users-albertgwo-Repositories-pi-claude-permit-gate--/subagent-artifacts/outputs/a24ffeab-b083-4573-b5f1-9129688f9201/tasks/plans/model-overload-alerts-context.md`. All `file:line` anchors were checked against the permit gate at `0f45245` (v0.4.34) and the monitor at its current `main`.

## Goal

The authority learns which model Anthropic reported overloaded on each lane. It keeps a five-minute, in-memory, per-model count, and exposes the count on health and, on request, on the snapshot. The Claude Lane Monitor then shows "Claude Fable 5.2 overloaded on lane C (6 in the last 5 min)", and the alert clears by itself. No overload ever pauses or holds capacity.

## Locked constraints

These come from the user, `tasks/lessons.md`, and the context report. Every task below obeys them.

- An overload never changes `cooldownUntilEpochMs`, `currentConcurrency`, or any persisted lane state.
- Nothing new runs in `_commit`, `validateState`, `compactRetainedState`, or the mutation queue. `STATE_SCHEMA_VERSION` (2) and `protocolVersion` (2) stay as they are.
- No lock is held across an await. The new authority handler is synchronous and in-memory.
- The request body is read in full before the handler acts.
- Compatibility holds in both directions for clients, authorities, monitors, and the sampler. See the matrix below.
- Health and snapshot expose no installation, session, request, ticket, or lease IDs, and no account binding. A model id is allowed.
- No new environment variable uses the `CLAUDE_PERMIT_GATE_AUTHORITY_` prefix. This plan adds none.

## Decisions

Each decision gives the recommendation, the strongest counterargument, and the signal that would prove it wrong.

**D1. How the authority learns the model: a new endpoint, `POST /v1/model-overloads`, advertised by the health capability `model-overloads`.**
- Body: exactly `{schemaVersion: 1, installationId, provider, accountBindingId, model}`. It needs the `permit:mutate` scope, which every client already holds.
- Answer: `200 {"schemaVersion":1,"accepted":true}`.
- The client sends only when the lane's last health answer lists the capability. An old authority therefore never sees the request. If an authority is rolled back within the health-cache minute, it answers `404 not_found`, and the client ignores that.
- Counterargument: an optional `model` key on the `complete` body would avoid a new route and a second request. It was rejected because an old authority answers that body with `400`, the client then abandons the lease, and the lease becomes `uncertain` quarantined capacity. The complete body is also stored as an operation fingerprint, so a rollback would fail state validation (context §0 facts 3 and 4).
- Wrong if: the extra request measurably delays turns. The report is never awaited on the permit path, so this would show up only as a CPU or socket cost.

**D2. Where the record lives: in memory on `AuthorityState`, next to `_awaiters` and `_claimIntents` (`authority-state.mjs:1601-1602`). It is not persisted.**
- Counterargument: a lane restart, including each degraded-lane exit, drops the counts, so an alert can clear early.
- Wrong if: lane restarts during overload episodes make alerts flicker in practice. The fix would then be a sidecar file, never lane state.

**D3. Shape and limits.**
- Wire object: `modelOverloads: {windowMs: 300000, models: [{model, count, firstAtEpochMs, lastAtEpochMs}]}`.
- `models` holds only models with at least one report inside the window, sorted by `lastAtEpochMs`, newest first. The authority clock sets every time, so client clock skew does not matter.
- Limits: at most 16 models per lane, evicting the model with the oldest `lastAtEpochMs`, and at most 256 timestamps per model, dropping the oldest.
- `model` must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`.
- The client makes one attempt with a 5 s timeout and no retry, so the request needs no idempotency ID. The only exception is the existing single resend after a `401`, and a rejected request was never counted.
- Counterargument: a lost report undercounts by one. Real overload episodes produce several reports, so one loss does not hide the alert.
- Wrong if: live counts fall well below the overload errors in the session logs for the same window.

**D4. Read path.**
- Health always includes `modelOverloads` once the capability exists. Every health consumer tolerates an extra key: `validAuthorityHealth` (`index.ts:412`), the sampler (`scripts/lane-sampler.mjs:57`), `bootstrap-client.mjs:236`, and `cutover-ruminaider.sh:107`.
- The snapshot includes `modelOverloads` **only** when the request carries the header `x-permit-model-overloads: 1`. The Swift monitor rejects unknown snapshot keys (`AuthorityWireModels.swift:22-31,226`), so without the opt-in an older monitor would mark every lane offline.
- Trap: `snapshot()` builds itself from `health()` (`authority-state.mjs:2114-2118`). It must strip `modelOverloads` the same way it strips `capabilities`.
- Counterargument: the monitor could read `/v1/health` instead and leave the snapshot alone. That doubles the requests per poll.
- Wrong if: a proxy strips custom headers. The tailnet path already carries `x-permit-claim-on-offer`, so this is unlikely.

**D5. Client detection: in `message_end` only, using `event.message.model` and `event.message.provider`. Warm keep-alive 529s are not reported.**
- Counterargument: warm requests to an overloaded model are real overloads, and they never reach `message_end` (`index.ts:662`).
- Wrong if: lane samples or cache-warm telemetry show warm 529s while no alert appears. The extension would then stash `payload.model` per warm permit in `before_provider_request`.

**D6. Display name: the monitor derives it from the model id.**
- Split the id on `-`. Drop a trailing 8-digit date part. Join each run of numeric parts with `.`, title-case the other parts, and join the groups with spaces.
- Examples: `claude-fable-5-2` becomes "Claude Fable 5.2", and `claude-3-5-sonnet-20241022` becomes "Claude 3.5 Sonnet". If nothing is left, show the raw id.
- No free text goes on the wire.
- Counterargument: Pi's registry name (`ctx.model.name`) is exact. However, it is free text, it may be absent, and it can differ between Macs.
- Wrong if: a real model id formats badly. The fix is a formatter rule, not a protocol change.

**D7. Monitor presentation.**
- Show three things:
  - a title marker `⚠` before the existing `!` and `?` markers;
  - one sentence per model in the tooltip and accessibility label;
  - one orange `Label` in `MenuHeaderView`, beside "Watcher unavailable", showing the newest alert plus "and N more", with every sentence in `.help`.
- Card heights stay as they are (`LaneBoardLayout`), and macOS notifications stay out of v1.
- The alert shows whenever an entry exists (count of 1 or more).
- Counterargument: the user said "alert me", and a menu-bar marker is passive. A `UNUserNotificationCenter` banner is the only real push, but it needs an authorization prompt for an ad-hoc-signed `LSUIElement` app. That is separate work.
- Wrong if: the user misses an episode because the menu was not looked at. **The parent should confirm the no-notification default with the user. It does not block the build.**

**D8. Clearing: the authority filters by its own clock and window on every read. The monitor shows an alert exactly when the newest permit refresh contains an entry.**
- The data rides in `PermitSnapshot`, so the 30 s background refresh (menu closed) and the 2 s refresh (menu open) clear it (`MonitorStore.swift:205-269`).
- An unreachable lane maps to `PermitSnapshot.authorityUnavailable`, which carries no overloads, so stale alerts are never shown.
- Counterargument: a lane with steady single overloads stays lit. That is accurate.

**D9. Local mode and bypass: out of scope.** Local daemons have no record, and the monitor shows nothing there.

**D10. Old clients (v0.4.33 and earlier) still send `throttled` + `assistant_overloaded`, which pauses the lane: the authority stops honouring that reason's scheduler effect.**
- In `mutateTicket` (`authority-state.mjs:1954`), change `if (request.outcome === "throttled")` to `if (request.outcome === "throttled" && request.reason !== "assistant_overloaded")`.
- The ticket still ends `state: "throttled"` with `terminalReason: "assistant_overloaded"`, so the operation fingerprint and the response check (`validateOperationResult`, `:811`) are untouched. Capacity is freed exactly as on a release.
- Effect: deploying the authority alone ends lane-wide overload pauses from every Mac, including unreloaded sessions and the other Mac. The user's rule is "overloads must never pause capacity".
- Counterargument: it changes the documented meaning of a v1 completion ("A throttle outcome changes adaptive concurrency and cooldown once", `docs/authority-protocol-v1.md:105`). The doc must say so. Rolling the authority back restores the old pause.
- Wrong if: a real rate limit is ever reported with reason `assistant_overloaded`. No client does this. The v0.4.33 client used that reason only when the error text matched `/overloaded/i`.
- **The parent may veto this. It is one line plus one test and is independent of the alert work.**

**D11. Versioning.** One permit gate patch release (v0.4.35) carries the client, authority, protocol, and sampler changes. The authority redeploy follows the release, and the monitor release follows that. The order is safe in any sequence (see the matrix), but the plan uses this order.

## Compatibility matrix

| Pair | Behaviour |
|---|---|
| New client → old authority | Health has no `model-overloads`, so no report is sent. After a rollback inside the health-cache minute, `404` is ignored. Permits are unaffected. |
| Old client → new authority | No reports are sent. Health has extra keys, which are ignored. A v0.4.33 overload throttle no longer pauses the lane (D10). |
| New monitor → old authority | The header is ignored, and the snapshot keeps its exact old keys. `modelOverloads` decodes as absent, so no alert appears. |
| Old monitor → new authority | No header is sent, so the snapshot is byte-shape identical to today and the strict decoder passes. |
| Any sampler → new authority | The old sampler drops the key. The new sampler logs `modelOverloads` when it is not empty. |
| Exporter and allowance syncer → new authority | No header is sent, so the snapshot is unchanged. |
| Authority rollback | Nothing was persisted, so the old build opens its state cleanly. The D10 effect reverts. |

## Tasks

### Permit gate repo (`/Users/albertgwo/Repositories/pi-claude-permit-gate`)

1. **Protocol: schema, doc, and fixtures**
   - Files: `protocol/authority-v1.schema.json`, `docs/authority-protocol-v1.md`, `test/fixtures/authority-v1/{valid,invalid}/`, `test/fixtures/authority-v1/manifest.json`.
   - Reuse decision: extend the existing `$defs`, and use the existing validator keywords (`pattern`, `items`, `maxItems`, `required`, `additionalProperties`; `scripts/validate-authority-contract.mjs:54-117`). The validator needs no change.
   - Schema changes:
     - Add `ModelId` (string, ASCII pattern above).
     - Add `ModelOverloadV1`: `{model, count 1..256, firstAtEpochMs, lastAtEpochMs}`, with `additionalProperties:false`.
     - Add `ModelOverloadsV1`: `{windowMs const 300000, models: array maxItems 16 of ModelOverloadV1}`.
     - Add `ModelOverloadReportRequestV1` and `ModelOverloadReportResponseV1` (`{schemaVersion const 1, accepted const true}`).
     - Add an optional `modelOverloads` property to `AuthorityHealthV1` and `LaneSnapshotDTOv1`. It stays out of `required`.
     - Add `"model-overloads"` to the capabilities enum and raise `maxItems` from 4 to 5.
   - Doc changes:
     - The health paragraph (`:82`): add `modelOverloads`.
     - The snapshot paragraph (`:84`): add the opt-in header.
     - A new "Model overload reports" section: the endpoint, scope, body, answers, window, limits, in-memory reset on lane restart, and the statement "never affects scheduling".
     - The complete row (`:105`): the D10 wording.
   - Fixtures:
     - Valid: `model-overload-report-request.json`, plus health and snapshot responses that include `modelOverloads`, using the existing response-fixture wrapper defs.
     - Invalid: a report request with an unknown key, and an overload item with `count: 0`.
     - Add manifest entries and re-digest `schemaSha256`.
   - Acceptance: `node scripts/validate-authority-contract.mjs` passes and prints the new schema digest.

2. **Authority state: the in-memory record and its projection**
   - File: `authority-state.mjs`.
   - Reuse decision: extend `AuthorityState`, following the `_awaiters` and `_claimIntents` pattern. Reuse `assertExactObject`, `assertSchemaVersion`, `assertUuid`, `assertProvider`, and `assertPrincipalMatches` (`:632-668`).
   - Changes:
     - Add constants `MODEL_OVERLOAD_WINDOW_MS = 300_000`, `MODEL_OVERLOAD_MODELS = 16`, and `MODEL_OVERLOAD_EVENTS = 256`.
     - In the constructor, add `this._modelOverloads = new Map()`, mapping each model to an ascending timestamp array.
     - Add `validateModelOverloadRequest(request)`.
     - Add `reportModelOverload(principal, request, now = this._now())`. It is synchronous. It validates the request, runs `assertPrincipalMatches`, and fails with `provider_mismatch` when `request.provider !== this.state.provider`. It prunes the model's array to the window, appends `now`, and caps the array. When a new model would exceed 16, it evicts the model whose newest timestamp is oldest. It returns `{schemaVersion: 1, accepted: true}`. It never calls `_transition` or `_commit` and never reads `this.state.scheduler`.
     - Add `_modelOverloadView(now)`, which returns the `ModelOverloadsV1` object. It filters each array to `now - windowMs`, which also prunes in place and removes empty models, and sorts by last time, newest first.
     - `health()`: add `"model-overloads"` to `capabilities` and add `modelOverloads: this._modelOverloadView(now)`.
     - `snapshot({instanceId, buildId, now, includeModelOverloads = false})`: destructure `{capabilities, modelOverloads, ...common}`, and spread `modelOverloads` back only when `includeModelOverloads` is set.
     - D10: the one-line condition change in `mutateTicket` (`:1954`).
   - Acceptance: Tests P2 and P3.

3. **Authority route**
   - File: `permit-daemon.mjs` (`handleAuthorityRequest`, `:210-299`).
   - Reuse decision: copy the await route's order (principal first, then the full body, then act) without `serializeAuthorityMutation` and without `authorityPrecommitVerifier`, because nothing is committed.
   - Changes:
     - Before the ticket regex, handle `POST /v1/model-overloads`: `authorityPrincipal(req, "permit:mutate", …)`, then `await authorityRequestBody(req)`, then `authorityReply(res, 200, authority.reportModelOverload(authenticated.principal, body))`.
     - On the snapshot route: `authority.snapshot({instanceId, buildId, includeModelOverloads: req.headers["x-permit-model-overloads"] === "1"})`.
   - Acceptance: Test P5.

4. **Client: detection and fire-and-forget report**
   - File: `index.ts`.
   - Reuse decision: extend `createAuthorityClient` with a `reportOverload` method that uses the existing `send` (`:480`) and the existing `healths` map (`:486`). It makes no new health call. Put the exported pure `providerOverload` beside `providerFailure` (`:601`).
   - Changes:
     - `export function providerOverload(message): string | undefined`. It returns `message.model` when `stopReason === "error"`, `errorMessage` matches `/overloaded/i`, and `message.model` matches the `ModelId` pattern. Otherwise it returns `undefined`.
     - In `createAuthorityClient`, add `reportOverload(provider, model)`. It reads `healths.get(provider)?.value` regardless of age, and returns unless `capabilities` includes `"model-overloads"`. It then runs `send("POST", provider, "/v1/model-overloads", {schemaVersion: 1, installationId: config.installationId, provider, accountBindingId: lane.accountBindingId, model}, AbortSignal.timeout(5_000))`, wrapped in `try {} catch {}`. It never throws and never touches the ledger.
     - Add `reportOverload` to the returned API (`:576`).
     - In `message_end` (`:663`), as the **first** statement and before the `activePermit` guard: when `mode.mode === "authority-client"`, the bypass is off, `event.message.provider` is in `AUTHORITY_PROVIDERS`, and `providerOverload(event.message)` returns a model, run `void authorityClient!.reportOverload(event.message.provider, model)`. It must not be awaited.
   - Acceptance: Tests P1 and P4. The existing provider-failure test still passes, and so does the rule that an overload completion is `released` with `reason: null`.

5. **Lane sampler**
   - File: `scripts/lane-sampler.mjs:57`.
   - Reuse decision: extend the row literal.
   - Change: add `modelOverloads: h.modelOverloads?.models?.length ? h.modelOverloads.models : undefined`. `JSON.stringify` drops `undefined`, so quiet rows stay the same size.
   - Acceptance: manual check on the live log after deploy. It needs no unit test, because it is not a contract.

6. **Docs and changelog**
   - Files: `README.md` (a short "Model overload alerts" note), `CHANGELOG.md`, and `tasks/discovery/2026-11-24-overload-lane-freeze.md` (a follow-up line).
   - Acceptance: prose only.

7. **Permit gate release (AGENTS.md steps 1-5)**
   - Run `npm test`. The only known failure is the environmental one in `allowance-prober-auth`.
   - Also run `node scripts/validate-authority-contract.mjs`.
   - Bump to `0.4.35` with `--no-git-tag-version` and commit. Tag `v0.4.35` and push. Edit the release title and notes.
   - In `~/Repositories/pi-dotfiles`, run `./bin/pi-package-pin pi-claude-permit-gate v0.4.35`, then commit and push with the `PATH=/tmp/oldruff:$PATH` hook workaround.
   - Check out `v0.4.35` in `~/.pi/agent/git/github.com/longweekendprojects/pi-claude-permit-gate`.
   - Run `launchctl kickstart -k gui/$(id -u)/com.longweekendprojects.claude-lane-sampler` so the long-running sampler loads the new row.

8. **Authority deploy on ruminaider (this Mac)**
   - Follow the established procedure (`tasks/discovery/acquire-latency-options-2026-11-19.md:190-215`).
   - Back up the four lane state files and lane plists, and record the backup path in `/tmp/permit-backup-path`.
   - Offline check: on copies of the four live lane states, open each with the new code, run a create, a complete, a model-overload report, and health. Then reopen each copy with the v0.4.34 release. This proves the rollback is safe; nothing should differ, because no state changed.
   - From a clean checkout of tag `v0.4.35`, run `scripts/install-authority.sh` with the same flag values as the current deployment. A `--dry-run --home --output` run comes first.
   - Pick a moment when lane samples show empty queues, if one exists. Earlier live deploys restarted all four lanes within about 4 s.
   - Verify:
     - All four lanes are `ready` and each term rises by one.
     - Each lane's health lists `model-overloads` and shows `modelOverloads: {windowMs: 300000, models: []}`.
     - A snapshot without the header has exactly the old key set.
   - Roll back with `scripts/install-authority.sh --rollback-lane anthropic-<x>`.
   - The authority host runs Node 22.x. The new code uses only APIs that Node 22 supports.

### Monitor repo (`/Users/albertgwo/Repositories/pi-claude-lane-monitor`)

9. **Wire decode and opt-in header**
   - Files:
     - `Sources/ClaudeLaneMonitor/AuthorityWireModels.swift`
     - `Sources/ClaudeLaneMonitor/AuthorityClient.swift`
   - Reuse decision: extend `AuthorityWireSnapshotV1` and `AuthorityAuthenticatedReadRequest`. Add small `Decodable` structs `AuthorityWireModelOverloads` and `AuthorityWireModelOverload` that call `rejectUnknownAuthorityKeys`, matching how the allowance structs are written.
   - Changes:
     - Add `case modelOverloads` to `CodingKeys` and decode it with `decodeIfPresent`.
     - Validate `windowMs` (1 or more), `models.count <= 16`, and the `model` pattern with ASCII of at most 64 characters (`AuthorityWireValidation.asciiString`). Require `count >= 1`, safe-integer timestamps, and `firstAt <= lastAt`.
     - Add a `headers: [String: String]` field (default `[:]`) to `AuthorityAuthenticatedReadRequest`. `snapshot(for:)` passes `["x-permit-model-overloads": "1"]`, and `loadHTTPS` sets each header.
   - Acceptance: Test M1.

10. **Model and mapping**
    - Files:
      - `Sources/ClaudeLaneMonitor/LaneModels.swift` (`PermitSnapshot`, `:72-160`)
      - `Sources/ClaudeLaneMonitor/SharedLaneSnapshotSource.swift` (`permitSnapshot(from:)`, `:181-206`)
    - Reuse decision: extend `PermitSnapshot`, because the permit-only refresh path carries only `PermitSnapshot`.
    - Changes:
      - Add `public struct ModelOverload: Codable, Equatable, Sendable { model: String; count: Int; lastAt: Date }`.
      - Add `modelOverloads: [ModelOverload]` and `modelOverloadWindowMilliseconds: Int?` to `PermitSnapshot`, with defaults `[]` and `nil` as the last init parameters, so existing call sites compile unchanged.
      - Map them in `permitSnapshot(from:)`.
    - Acceptance: Test M1.

11. **Presentation**
    - Files:
      - `Sources/ClaudeLaneMonitor/LaneModels.swift` (`MenuBarPresentation`, `:491-585`)
      - `Sources/ClaudeLaneMonitor/MenuContentView.swift` (`MenuHeaderView`, `:157-188`, and its call at `:54`)
      - `README.md` ("What the menu shows")
    - Reuse decision: extend `MenuBarPresentation` (the existing markers, tooltip, and accessibility parts) and `MenuHeaderView` (the "Watcher unavailable" label pattern). Put the D6 formatter in a new `enum ModelDisplayName` in `LaneModels.swift`. It is a small local helper and needs no new file.
    - Changes:
      - Add `public let overloadAlerts: [String]` to `MenuBarPresentation`, built from every current-truth lane with entries and ordered newest first. Each entry reads "`<display name>` overloaded on lane `<LaneID uppercased>` (`<count>` in the last `<windowMs/60000>` min)".
      - The title marker gains a leading `⚠` when the list is not empty.
      - Add the sentences to the tooltip and the accessibility label.
      - `MenuHeaderView` takes `overloadAlerts`. It shows `Label("<first alert, shortened to display name · lane>", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)`, adds "and N more" when there are more, and puts the full sentences in `.help` and the accessibility label.
    - Acceptance: Test M2.

12. **Monitor contract re-pin**
    - Files:
      - `Tests/ClaudeLaneMonitorTests/Fixtures/authority-v1/consumer-manifest.json`
      - a new fixture `snapshot-response-model-overloads.json`, copied byte for byte from the permit gate's valid fixture
      - `Tests/ClaudeLaneMonitorTests/LaneSnapshotTests.swift:713-716`
      - `README.md`
    - Changes: set `canonicalCommit` to the v0.4.35 commit SHA, set `schemaSha256` to the new digest, and add the fixture sha. Update the hard-coded manifest sha, commit, and schema digest in the test, and both README occurrences of the commit. This also repairs the drift that already exists (`d2bb…` against `81bd…`).
    - Acceptance: `scripts/test.sh` passes: the digest gate plus `swift test`.

13. **Monitor build and install**
    - Run `scripts/test.sh`, then `scripts/install.sh` under its maintenance gate.
    - Confirm that `~/Applications/Claude Lane Monitor.app` relaunches under `com.longweekendprojects.claude-lane-monitor`.

### End-to-end verification (after Tasks 7, 8, and 13)

14. **Live check without waiting for Anthropic.**
    - From a small Node script on this Mac, call `createAuthorityClient` with the live authority-client config. Call `client.health("anthropic-d")`, then `client.reportOverload("anthropic-d", "claude-verify-probe-0-1")`.
    - Lane D is idle, and the fake id is plainly a probe.
    - Expected results:
      - Lane D health shows the entry.
      - Within 5 s, `lane-samples.jsonl` has a row with `modelOverloads`.
      - Within about 30 s, the monitor title shows `⚠` and the header reads "Claude Verify Probe 0.1 overloaded on lane D (1 in the last 5 min)".
      - About 5 minutes later, the entry, the row field, and the marker are all gone.
    - Then confirm that a real Fable overload, if one occurs, raises the alert on lane C. Read the session logs and the sampler log for the same minute.

## Test Budget

Ceiling: 5 new or extended tests in the permit gate and 2 in the monitor. Each one names the risk it alone protects.

| Risk (closed list) | Test |
|---|---|
| R1. A real overload is missed or misattributed. The detector must match Pi's real `errorMessage` and take the model from the message. | **P1**: extend `test/provider-failure.test.mjs`. `providerOverload` returns `claude-fable-5-2` for the exact incident message. It returns `undefined` for a rate limit, a success, and an invalid model id. |
| R2. An overload report pauses capacity, persists state, or grows memory without limit. | **P2**: a state-level test in a new block in `test/ticket-await.test.mjs`, reusing its `lane(t)` harness and `principal`. It reports 6 Fable overloads, and `health().modelOverloads.models` shows `count: 6` with the correct times. `cooldownUntilEpochMs`, `currentConcurrency`, and the lane state file bytes stay unchanged. 17 distinct models leave 16 entries. A report with an unknown key gives `invalid_request`. With `now` advanced past 300 s, the list is empty. |
| R3. v0.4.33 and older clients keep pausing the lane on overload (D10). | **P3**, same file: an active lease completed `throttled` with `assistant_overloaded` leaves `cooldownUntilEpochMs` null and concurrency unchanged, and the ticket state is still `throttled`. It fails without the D10 line. The existing rate-limit throttle behaviour stays covered by current tests. |
| R4. The report breaks compatibility, or delays or blocks the permit path. | **P4**: extend the `transport()` in `test/ticket-await.test.mjs` with the route and an option set: capability advertised, capability absent, a route that hangs, and a route that answers 404. Advertised: one `POST /v1/model-overloads` with the exact body. Absent: zero calls. Hanging or 404: `reportOverload` resolves without throwing, and a concurrent `complete` and the next `acquire` finish promptly. |
| R5. The snapshot wire contract breaks older monitors and exporters, or the route skips authentication. | **P5**: extend `test/permit-daemon.test.mjs` with the real daemon (`authorityDaemon(t)`). A `snapshot:read` token on the report route gets `403 forbidden_scope`, and a valid `permit:mutate` report gets `200`. Health includes the entry. A snapshot without the header has exactly the pre-change key set. A snapshot with the header includes `modelOverloads`. |
| R6. The monitor drops the opt-in header, or fails to decode or carry the data on the permit-only refresh. | **M1**: run `SharedLaneSnapshotSource.refreshPermits()` through a capturing transport. The request carries `x-permit-model-overloads: 1`. An overload snapshot maps into `PermitSnapshot.modelOverloads`. A nested unknown key is rejected. Existing fixtures cover the old shape. |
| R7. The alert text is wrong or does not clear. | **M2**: `MenuBarPresentation` with lane C at count 6 gives title `⚠ CLane`, and the tooltip and `overloadAlerts` contain "Claude Fable 5.2 overloaded on lane C (6 in the last 5 min)". The same snapshot with `modelOverloads: []` gives no marker and no alert. Include one formatter assertion for a dated id. |

Contract fixtures (Task 1) are data checked by the existing `authority-contract.test.mjs`, not new tests. The message_end wiring is one line with no existing hook-level harness. Task 14 proves it live instead of adding a hook harness.

## Files to Modify

Permit gate:
- `protocol/authority-v1.schema.json`: new defs, optional health and snapshot property, capability.
- `docs/authority-protocol-v1.md`: endpoint, fields, header, and D10 semantics.
- `test/fixtures/authority-v1/manifest.json` and new fixture files: contract data.
- `authority-state.mjs`: the in-memory record, `reportModelOverload`, the projection, the snapshot opt-in, and D10.
- `permit-daemon.mjs`: the report route and the snapshot header.
- `index.ts`: `providerOverload`, `client.reportOverload`, and the `message_end` call.
- `scripts/lane-sampler.mjs`: the row field.
- `test/provider-failure.test.mjs`, `test/ticket-await.test.mjs`, `test/permit-daemon.test.mjs`: P1-P5.
- `README.md`, `CHANGELOG.md`, `package.json`, `package-lock.json`, and the discovery note.

Monitor:
- `Sources/ClaudeLaneMonitor/AuthorityWireModels.swift`, `AuthorityClient.swift`, `SharedLaneSnapshotSource.swift`, `LaneModels.swift`, `MenuContentView.swift`.
- `Tests/ClaudeLaneMonitorTests/LaneSnapshotTests.swift` (M1, M2, re-pin constants), `Fixtures/authority-v1/consumer-manifest.json`, and a new `Fixtures/authority-v1/snapshot-response-model-overloads.json`.
- `README.md`.

## New Files

- Permit gate fixtures (Task 1) and the monitor fixture (Task 12) only. Fixtures are one file each by convention.
- No new source modules. The closest candidates (`AuthorityState`, `createAuthorityClient`, `MenuBarPresentation`) absorb each change.

## Dependencies

- Task 1 comes before Tasks 2 and 3, because the schema defines the shapes and limits.
- Tasks 2 and 3 come before Task 4's P4 test, because the transport uses the real state methods.
- Tasks 1-6 come before Task 7 (release), and Task 7 comes before Task 8 (deploy from the tag).
- Task 12 needs the v0.4.35 commit SHA and the schema digest from Task 7. Tasks 9-11 can be built and tested in parallel with Tasks 2-6 against a local fixture.
- Task 14 needs Tasks 7, 8, and 13.

## Risks

- **Old monitors elsewhere.** Any monitor that does not send the header must get the old snapshot keys. P5 guards this. If `snapshot()` forgets to strip the field, every older monitor shows every lane offline.
- **D10 is a semantic change to a v1 completion.** It is documented, tested, and reverts with an authority rollback. The parent may drop it without affecting the rest of the plan.
- **Unreloaded sessions and the other Mac.** Without D10, their overloads keep pausing lanes until each session reloads v0.4.34 or later. With D10, the fix takes effect when the authority deploys. In either case those sessions send no reports until they run v0.4.35, so alerts undercount during the transition.
- **Counts reset on a lane restart** (D2). This is documented and accepted.
- **Report inflation.** An installed client holding `permit:mutate` can send fake reports. The caps bound memory, and the doc can say alerts are advisory.
- **Monitor digest gate.** It already fails today. Task 12 must land in the same monitor change, or `scripts/test.sh` stays red.
- **Authority deploy gates.** `install-authority.sh` refuses a dirty checkout. The flag values must match the current deployment. Take a backup first, and keep the rollback command at hand.
- **Needs user confirmation, not blocking:** no macOS notification banner in v1 (D7), and the `⚠` glyph.

## Locked amendments (2026-11-25, after the critique)

These override the plan above where they differ.

- **A1 (critique F1).** The monitor decodes `modelOverloads` on its own. If that field fails to decode, the monitor drops it and keeps the lane valid. A bad advisory field never takes a lane offline. Inside the field, unknown keys are ignored rather than rejected.
- **A2 (F4).** `windowMs` is an integer from 60000 to 3600000, not a constant. The authority sends 300000 today.
- **A3 (F2, F5).** The report body is exactly `{schemaVersion: 1, installationId, provider, accountBindingId, model, source}`. `source` is `"message"` for a real reply and `"warm"` for a cache keep-alive. The client reports warm 529s too: `before_provider_request` records the model of a warm request, and `after_provider_response` reports it when the status is 529. The authority keeps one count per model and ignores `source` in the count.
- **A4 (F3).** D10 ships as its own commit with its own changelog line and test (P3).
- **A5 (strongest counterargument).** The monitor groups alerts by model across lanes. The text reads "Claude Fable 5.2: recent overloads on lanes B, C (6 in the last 5 min, last 1 min ago)". A count of 1 is enough to show it.
- **A6 (F7).** A source-policy test asserts that `message_end` reports without awaiting and before the `activePermit` guard. `reportOverload` takes an injectable timeout (`reportTimeoutMs`). One `MODEL_ID_PATTERN` string is checked in a test against the schema's `ModelId` pattern, in both `index.ts` and `authority-state.mjs`.
- **A7 (F9).** `message_end` runs `providerOverload()` before reading the bypass file. The report uses `baseRequest`, so it never adds a span to an acquire trace.
- **A8 (F8).** Before installing the new monitor, keep a copy of the previous `.app`. After the authority deploy, check that the old monitor still shows all lanes. After the monitor install, check that no lane went offline.
- **A9 (D7, F10).** Version 1 alerts only inside the lane monitor: the menu-bar marker, the header line, and the tooltip. A macOS notification banner and a Netdata alarm are possible follow-ups.
- **A10 (F6).** Reports start only from sessions that load v0.4.35 or later, on each Mac. The other Mac needs a pi-dotfiles pull and a reload.
