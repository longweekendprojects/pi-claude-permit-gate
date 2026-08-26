# Implementation Plan

## Goal

Install a display-only macOS menu bar app that truthfully shows this Mac's last-observed 5-hour and 7-day Claude allowance plus live permit state for lanes A-D, after making daemon provenance observable and safely replacing legacy owners during an explicitly approved idle maintenance window.

## Authority

`tasks/discovery/decision-brief.md` is the authoritative product and scope decision. This plan executes its local-first, display-only, A-D-only release; Tailnet/shared authority and lane switching remain out of scope.

## Canonical Contracts

### H1: Daemon compatibility and acquire precondition

`GET /health` retains `version: 3` and every existing field. New daemons also return `protocolVersion: 1` and the provider passed through `CLAUDE_PERMIT_GATE_PROVIDER`.

The extension classifies health as:

- `current`: `ok === true`, provider equals the expected provider, and `protocolVersion === 1`.
- `legacy`: `ok === true` and provider or protocol is absent. Legacy remains usable locally and is labeled “restart when idle.”
- `incompatible`: health is well-formed but an explicit provider differs or an explicit protocol is unsupported. Incompatible endpoints never receive `/acquire`.
- `invalidOrUnavailable`: timeout, transport failure, malformed JSON, or `ok !== true`. Acquisition stays fail-closed and retries under existing backoff.

`ensureDaemon` returns this typed result. `acquirePermitResponse` must run compatibility preflight before every `/acquire` attempt. It may send `/acquire` only for `current` or `legacy`; `incompatible` and `invalidOrUnavailable` states wait, re-probe, and remain cancellable. `before_provider_request` must not swallow incompatibility and then proceed to transport.

Keep the existing source-policy guard line byte-identical:

```ts
await acquire(ctx, directory, port, provider); return undefined;
```

Classification belongs inside `acquire`/`acquirePermitResponse` and the exported pure classifier, not in a second acquire hook.

### U1: Allowance decoding and truth states

The source file remains unchanged:

```text
~/.pi/agent/usage-windows/anthropic-{a,b,c,d}.json
```

It contains `provider`, optional `fiveHour` and `sevenDay` windows, optional `representative`, and `at`. Each window contains `utilization`, `status`, and optional `reset`.

Field rules:

| Field | Validation and behavior |
| --- | --- |
| `provider` | Must exactly equal the lane's expected provider. Mismatch invalidates the whole snapshot. |
| `at` | Must be a finite positive epoch-millisecond number. More than five minutes in the future invalidates the whole snapshot. Up to five minutes of positive clock skew is accepted with age clamped to zero. |
| `utilization` | Must be finite and non-negative. Preserve values above `1.0` in the model; clamp only progress-bar rendering. Invalid utilization invalidates only that window. |
| `status` | Must be a string when present. Preserve unknown strings. `rejected`, `rate_limited`, or text matching reject/rate-limit/exceeded raises current-window severity to critical; warning text raises it to warning. Empty/unknown status falls back to utilization thresholds. A non-string status invalidates only that window. |
| `reset` | Optional finite positive epoch seconds. Convert independently for each window. Non-finite, non-positive, or unrepresentable values invalidate only that window. Do not invent an upper bound. |
| `representative` | Accept `five_hour`, `seven_day`, or absence. Unknown values remove only the binding marker; they do not invalidate valid windows. |

A valid sibling window remains visible when the other window is invalid. A present snapshot with no valid windows is `invalid`. A missing file is `awaiting first response`.

Freshness is per window:

- Snapshot age under 10 minutes and that window's reset still future or absent: `current`.
- Snapshot age from 10 minutes through 2 hours and reset still future or absent: `aging`.
- Snapshot age over 2 hours: `stale` for both windows.
- A reset at or before now affects only that window and displays `awaiting post-reset observation`; it never creates a synthetic 0%.

The 10-minute marker reuses `usage-windows.ts`; the 2-hour ceiling reuses `cache-warm-handoff`'s `QUOTA_STALE_MS`.

### R1: Refresh and visibility

`MonitorStore` owns menu visibility. `MenuContentView.onAppear` enters a visibility generation and starts one immediate full refresh plus a two-second health poll. `onDisappear` leaves that generation and awaits cancellation before another interval can begin. The poll loop checks the active generation both before and after every sleep.

There are zero periodic health requests while the window is closed. No low-frequency health fallback is allowed. A directory watcher may refresh allowance files while closed, and a one-minute clock tick may recompute ages without network traffic.

If `MenuBarExtra` appearance/disappearance cannot reliably enforce this contract on the target macOS, stop implementation and return to the product decision. Do not silently ship closed-window polling or add a third-party menu framework.

### P1: Local transport and ATS

The app uses only loopback health endpoints and never reads auth data. Before app implementation, run a throwaway packaged-app probe against `http://127.0.0.1:8791/health` with no ATS keys.

- If it succeeds, `Info.plist` contains no `NSAppTransportSecurity` section.
- If it fails specifically with ATS error `NSURLErrorAppTransportSecurityRequiresSecureConnection`, switch the source host to `localhost`, set only `NSAppTransportSecurity -> NSAllowsLocalNetworking = true`, and rerun the packaged probe.
- `NSAllowsArbitraryLoads`, web-content exceptions, and broad exception domains are prohibited.

### L1: Login-item lifecycle

`LoginItemController` uses `SMAppService.Status` as the registration source of truth and handles each status idempotently:

- `.enabled`: show the toggle on and leave registration unchanged.
- `.notRegistered` and `.notFound`: show the toggle off without an error.
- `.requiresApproval`: leave the service unchanged and show “Approve Claude Lane Monitor in System Settings, General, Login Items.” Never churn this status by unregistering or registering it.
- Only an explicit user toggle may call register or unregister. Only thrown register/unregister failures use the error surface.

Do not persist a desired state that triggers launch-time reconciliation. On launch and reinstall, inspect the service status without unregistering and registering it. Reinstall validation verifies exactly one BTM item for the app; if it does not settle, log out and back in before further diagnosis.

## Tasks

1. **Freeze baselines, source contracts, and environment gates**
   - Files: `/Users/albertgwo/Repositories/pi-claude-permit-gate/tasks/discovery/decision-brief.md`, `/Users/albertgwo/Repositories/pi-dotfiles/extensions/usage-windows.ts`, `/Users/albertgwo/Repositories/pi-dotfiles/extensions/cache-warm-handoff/index.ts`, `/Users/albertgwo/Repositories/pi-dotfiles/extensions/anthropic-account-lanes/index.ts` (read-only).
   - Reuse decision: reuse `/health`, current atomic usage files, A-D provider names, and existing freshness precedents. Add no status service or pi-dotfiles producer change.
   - Changes:
     - Record `git status --short --branch` in both existing repositories and preserve unrelated dirty files.
     - Run the ten-test permit baseline and six-test focused usage baseline.
     - Record the decision brief as the scope authority and that cross-machine account-order confirmation is deferred.
     - Create sanitized test fixtures from live health v1/v3 and usage shapes. Remove `bySession`, session strings, cwd, permit IDs, file paths, credentials, and raw headers.
     - Run the P1 packaged-app ATS probe. Record its result in the validation artifact and freeze the selected loopback/Info.plist policy before writing the app source.
     - Confirm SwiftUI `MenuBarExtra`, ServiceManagement, Swift 6.2, and macOS 13+ compilation.
   - Acceptance:
     - Existing Node and pi-dotfiles tests pass.
     - H1, U1, R1, P1, and L1 are the frozen implementation inputs for both repositories.
     - ATS policy is resolved by evidence, with no arbitrary-load permission.

2. **Enforce daemon provenance before permit acquisition**
   - Files: `/Users/albertgwo/Repositories/pi-claude-permit-gate/index.ts`, `permit-daemon.mjs`, `test/permit-daemon.test.mjs`, `test/source-policy.test.mjs`, `README.md`.
   - Reuse decision: extend the existing daemon and acquisition loop because they own all spawn, queue, lease, and fail-closed invariants. Do not add a supervisor, Tailnet code, or replacement service.
   - Changes:
     - Pass `CLAUDE_PERMIT_GATE_PROVIDER` in `daemonEnv`.
     - Preserve health schema `version: 3`; add `protocolVersion: 1` and `provider`.
     - Implement H1 as a pure exported classifier plus typed `ensureDaemon` result.
     - Move preflight to the real acquire boundary. `acquirePermitResponse` probes before each POST and invokes `/acquire` only for current or legacy health.
     - Preserve Esc cancellation and existing retry/backoff. Incompatible health remains blocked with an actionable diagnostic until a later probe becomes current or legacy.
     - Keep the existing `before_provider_request` acquire call and all existing source-policy assertions unchanged; add assertions rather than weakening the payload/noninterference guard.
     - Reserve daemon exit code `3` for `EADDRINUSE`; keep exit `1` for genuine server failures.
     - On child exit `3`, re-probe health once. Clear recovery if a current or legacy daemon now owns the port; record an `incompatible` or `invalidOrUnavailable` result only when the probe proves it. Do not report a benign startup race as a crash.
     - Parse `startedAt` as ISO-8601 with fractional seconds in consumers and document it explicitly.
     - Expand `/claude-permit` to report schema/protocol/provider, started age, and current/legacy/incompatible/`invalidOrUnavailable` status.
     - Name `/claude-permit` as the doctor surface. Document the maintenance gate below; add no automatic kill command.
   - Acceptance:
     - A mismatched endpoint cannot issue a permit, even if its `/acquire` response would contain a permit ID.
     - Legacy health remains usable and visibly labeled.
     - An occupied-port race returns code 3 and clears recovery when the winner is compatible.
     - Ephemeral test daemons prove provider/protocol health; live legacy daemons are not used to prove the new contract.
     - All ten existing tests remain, including the byte-level single-hook/payload guard.

3. **Create the local Swift repository, model, source, and three-test harness**
   - Files:
     - `/Users/albertgwo/Repositories/pi-claude-lane-monitor/.gitignore`
     - `Package.swift`
     - `README.md`
     - `Sources/ClaudeLaneMonitor/LaneModels.swift`
     - `Sources/ClaudeLaneMonitor/LocalLaneSnapshotSource.swift`
     - `Sources/ClaudeLaneMonitor/MonitorStore.swift`
     - `Tests/ClaudeLaneMonitorTests/LaneSnapshotTests.swift`
     - `Tests/ClaudeLaneMonitorTests/Fixtures/{health-v1,health-v3,usage-current,usage-reset}.json`
     - `scripts/test.sh`
   - Reuse decision: add a sibling Swift repository because the closest candidates are Node/Pi extensions with incompatible runtime and release ownership. Initialize local Git only; create no remote.
   - Changes:
     - Use a dependency-free Swift 6.2 package targeting macOS 13.
     - Use Swift Testing (`import Testing`, `@Test`, `#expect`), not XCTest, because this machine has Command Line Tools without XCTest.
     - `scripts/test.sh` invokes `swift test` with the verified CLT Testing-framework `-F` and linker/rpath flags. All gates call this script. Production builds omit those test-only paths.
     - Define lane identity, provider, and label in `LaneModels.swift`. Keep the provider-to-port and usage-file maps private to `LocalLaneSnapshotSource.swift`.
     - Implement U1, independent permit/usage states, fixed A-D ordering, severity, summary text, and `LaneSnapshotSource`.
     - Fetch ports 8791-8794 concurrently with one-second URLSession timeouts under P1.
     - Decode health v1/v3 tolerantly; missing identity is legacy, explicit mismatch is incompatible, malformed data is `invalidOrUnavailable`.
     - Decode `startedAt` with `.withFractionalSeconds`.
     - Ignore unknown health fields. The health fixture includes a populated `bySession` sentinel; encode the resulting `LaneSnapshot` and prove neither the key nor sentinel survives.
     - Join each lane independently. One invalid window leaves its valid sibling visible; one source failure leaves the other source visible.
     - Implement R1 with injected clock, scheduler, loaders, and visibility generation for deterministic testing.
     - Watch the usage directory for atomic rename events with debounce. If absent, show `awaiting first response` and retry watcher installation on the next open/manual refresh.
   - Acceptance:
     - `scripts/test.sh` passes under the installed Command Line Tools; no literal `swift test` remains in gates or docs.
     - No app model can carry session IDs, cwd, permit IDs, auth data, raw headers, or local paths.
     - Closed visibility produces zero health-loader calls across simulated scheduler ticks.
     - The test target implements exactly three Swift test methods.

4. **Build the display-only menu and lifecycle**
   - Files: `Sources/ClaudeLaneMonitor/ClaudeLaneMonitorApp.swift`, `MenuContentView.swift`, `LoginItemController.swift`, `Resources/Info.plist`.
   - Reuse decision: extend `LaneSnapshotSource` and `MonitorStore`; add a small login controller because ServiceManagement state does not belong in the data source or view.
   - Changes:
     - Implement `MenuBarExtra` with `.window` style and `LSUIElement = true`.
     - Apply P1 exactly; prohibit broad ATS settings.
     - Display A-D only. No routing controls or clickable lane actions.
     - Show each lane's independent 5h/7d percentage, status severity, binding marker, reset countdown, last-observed age, active requests and effective concurrency (`current/max`), queue, cooldown, oldest wait, schema/protocol/provider provenance, and daemon age.
     - Clamp only visual progress to 0...1; display the raw percentage when utilization exceeds 100%.
     - Use `awaiting first response` only for a missing file and `awaiting post-reset observation` only for an elapsed window reset.
     - The title shows the worst non-stale current/aging allowance. `?` includes tooltip/accessibility copy with the number of lanes awaiting observation and the newest observation age. `!` indicates invalid or unavailable permit data.
     - State “Local observations on this Mac only” prominently. README and manual validation record that day one may show only lane C as current and `?` once all snapshots age out; that is truthful, not a transport failure.
     - Implement R1 visibility transitions. If target-OS validation shows disappearance is unreliable, stop rather than adding closed polling.
     - Implement L1's status-driven, idempotent handling; only an explicit user toggle may register or unregister.
     - Add accessibility labels that communicate lane, both windows, freshness, occupancy, queue, and errors without relying on color.
   - Acceptance:
     - A-D remain visible with absent, stale, malformed, or partially unavailable data.
     - A fresh snapshot with passed 5h reset and future 7d reset shows 5h awaiting post-reset while retaining the 7d value.
     - The app has no Dock icon and no lane mutation path.
     - Closed menu validation observes zero periodic health requests.
     - All four SMAppService statuses render correctly.

5. **Package and install with a reinstall-safe login item**
   - Files: `scripts/build-app.sh`, `scripts/install.sh`, `README.md`.
   - Reuse decision: add local scripts because SwiftPM emits an executable, not an app bundle. Do not import the unrelated OpenClaw release stack.
   - Changes:
     - Both scripts use `set -euo pipefail`.
     - Build with `swift build -c release` and obtain `BIN=$(swift build -c release --show-bin-path)`; assert the path basename is `release` before copying.
     - Assemble `Claude Lane Monitor.app`, copy the resolved release executable and validated Info.plist, and sign with `codesign --force --sign - --identifier com.longweekendprojects.claude-lane-monitor`.
     - `install.sh` quits the running old app, uses `ditto` to replace `~/Applications/Claude Lane Monitor.app`, verifies signature/plist, and opens the installed app.
     - The installed app reads L1 status without automatic register/unregister reconciliation. The installer never silently turns a previously disabled login item on.
     - Keep notarization, Sparkle, Homebrew, upload automation, and GitHub publication out of version 1.
   - Acceptance:
     - `scripts/test.sh`, `scripts/build-app.sh`, plist validation, and strict signature verification pass.
     - The bundled executable comes from the release directory.
     - First install and reinstall while Launch at Login is enabled leave the enabled service unchanged and preserve exactly one BTM item.
     - The app launches from `~/Applications` without a Dock icon.

6. **Run independent review gates before touching live daemon ownership**
   - Files: both repository diffs; no new production files.
   - Reuse decision: use the existing gate-review, simplification, and wave-review process. Do not widen the test budget for reviewer polish.
   - Changes:
     - Run one gate review for the permit packet and one for the monitor packet.
     - Resolve only critical/important findings within H1, U1, R1, P1, L1, and approved scope.
     - Run the simplifier once across each repository's wave only after blockers are clear.
     - Run the final wave review against the shipping version.
   - Acceptance:
     - No unresolved critical/important finding remains before maintenance and install.
     - Tailnet, built-in Anthropic, lane switching, distribution, and optional visual polish remain absent.

7. **Maintenance approval gate, install, and product validation**
   - Files: `/Users/albertgwo/Repositories/pi-claude-lane-monitor/tasks/validation/local-install.md`, `README.md`.
   - Reuse decision: use `/claude-permit`, `/health`, and existing usage files as truth. Store readings in a dedicated validation artifact, not the decision brief.
   - Changes:
     - Build and test may finish before this gate. Final installation and “foundation complete” status wait here.
     - Query every legacy lane. Ask the operator for explicit approval to restart only legacy daemons after all Pi work on those lanes is paused and `active === 0 && queued === 0` is observed twice two seconds apart.
     - If approval is absent, remain owned-but-waiting. Do not terminate, install as complete, or claim provenance deployed.
     - After approval, send SIGTERM one legacy daemon at a time, wait for the port to close, trigger the current package to spawn, and verify provider/protocol/schema before continuing. If any lane becomes active or queued before SIGTERM, defer that lane.
     - Install the app and open the dropdown. Compare A-D rows with sanitized health and usage commands.
     - While open, start one ordinary Pi request on lane C. Verify the permit row changes within three seconds and returns after completion. Verify the resulting allowance observation matches the local file without affecting other rows.
     - Validate zero health requests for at least ten seconds after closing the dropdown.
     - Enable Launch at Login, confirm the app reports `.enabled`, and visually confirm it under System Settings > General > Login Items > Allow in the Background. Reinstall once while enabled and verify exactly one BTM item represents the app. If it does not settle, use the logout/login fallback and re-check; do not use unregister/register as a reinstall workaround.
     - Use VoiceOver on one healthy, one stale/post-reset, and one unavailable row.
   - Acceptance:
     - Every replaceable legacy daemon is replaced only after explicit approval and quiescence; active work is never killed.
     - The installed app matches local source data and satisfies the efficacy signal.
     - No pi-dotfiles source changed and no GitHub remote exists.
     - Validation evidence, residual legacy lanes, and login-item results are recorded in `tasks/validation/local-install.md`.

## Test Budget

The permit packet may add at most two new Node test cases. The Swift test target implements exactly three Swift test methods. Existing tests may gain assertions but may not be weakened.

### Closed product risks

1. **Wrong or stale daemon grants a permit.**
   - H1 Node test 1: health provider/protocol plus exit-code-3 occupied race and compatible winner re-probe.
   - H1 Node test 2: current, legacy, incompatible, and `invalidOrUnavailable` preflight at the real acquire boundary; a mismatched endpoint's permit response is never requested.

2. **Allowance time or status is misrepresented.**
   - Swift test 1: epoch milliseconds/seconds, five-minute future skew, 10-minute aging, 2-hour stale ceiling, mixed passed-5h/future-7d reset, non-negative unbounded utilization, status severity, and no synthetic zero.

3. **One malformed source erases valid sibling/lane data or leaks identity.**
   - Swift test 2: mixed health v1/v3, fractional `startedAt`, `invalidOrUnavailable` health, provider mismatch, one malformed window with valid sibling, fixed A-D order, and encoded DTO exclusion of populated `bySession` sentinel.

4. **The app polls while closed or refreshes through an Anthropic request.**
   - Swift test 3: injected visibility/scheduler/loaders prove immediate open/manual refresh, cancellation awaited on close, zero loader calls while closed, and one-lane update from an atomic usage replacement. No production type exposes a provider-request capability.

### Existing coverage retained

The current ten Node tests continue protecting bounded concurrency, round-robin fairness, disconnect cleanup, throttle ordering, renewal, restart restoration, lease reclamation, shutdown retry, provider mapping, fail-closed recovery, payload noninterference, and cancellation. The existing six pi-dotfiles usage tests remain unchanged because its producer is unchanged.

## Baseline and Validation Commands

```bash
cd /Users/albertgwo/Repositories/pi-claude-permit-gate
git status --short --branch
npm ci
npm test

cd /Users/albertgwo/Repositories/pi-dotfiles
git status --short --branch
node --experimental-strip-types --test extensions/anthropic-account-lanes/usage-windows.test.ts

swift --version
sw_vers
```

After implementation:

```bash
cd /Users/albertgwo/Repositories/pi-claude-permit-gate
npm test
git diff --check

cd /Users/albertgwo/Repositories/pi-claude-lane-monitor
scripts/test.sh
scripts/build-app.sh
plutil -lint '.build/app/Claude Lane Monitor.app/Contents/Info.plist'
codesign --verify --deep --strict '.build/app/Claude Lane Monitor.app'
scripts/install.sh
```

Source comparison:

```bash
curl -s http://127.0.0.1:8793/health \
  | jq '{active,queued,current,max,cooldownMsRemaining,oldestWaitMs,version,protocolVersion,provider,startedAt}'

jq '{provider,fiveHour,sevenDay,representative,at}' \
  ~/.pi/agent/usage-windows/anthropic-c.json
```

## Implementation Packets

- **Packet A: permit hygiene.** Task 2 in `pi-claude-permit-gate`; parallel-safe with Packet B because the H1 field names are frozen here and repositories do not overlap. Gate: `npm test`.
- **Packet B: Swift model/source/tests.** Tasks 1 and 3 in the new repository; parallel-safe with Packet A and depends only on frozen H1/U1/P1. Gate: `scripts/test.sh`.
- **Packet C: UI, lifecycle, packaging.** Tasks 4 and 5; serial after Packet B. Gate: `scripts/test.sh`, bundle build, plist validation, and signature verification.
- **Packet D: reviews, maintenance, install.** Tasks 6 and 7; serial after A-C. Live process changes require explicit operator approval.

## Files to Modify

- `/Users/albertgwo/Repositories/pi-claude-permit-gate/index.ts` — typed compatibility preflight at the acquire boundary, spawn readiness, and doctor output.
- `/Users/albertgwo/Repositories/pi-claude-permit-gate/permit-daemon.mjs` — provider/protocol health and reserved occupied-port exit.
- `/Users/albertgwo/Repositories/pi-claude-permit-gate/test/permit-daemon.test.mjs` — H1 provenance and occupied-port test.
- `/Users/albertgwo/Repositories/pi-claude-permit-gate/test/source-policy.test.mjs` — H1 acquire-boundary compatibility test without weakening existing guards.
- `/Users/albertgwo/Repositories/pi-claude-permit-gate/README.md` — H1, doctor output, and approved idle replacement procedure.

No pi-dotfiles file changes.

## New Files

- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/.gitignore`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Package.swift`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/README.md`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Sources/ClaudeLaneMonitor/ClaudeLaneMonitorApp.swift`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Sources/ClaudeLaneMonitor/LaneModels.swift`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Sources/ClaudeLaneMonitor/LocalLaneSnapshotSource.swift`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Sources/ClaudeLaneMonitor/MonitorStore.swift`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Sources/ClaudeLaneMonitor/MenuContentView.swift`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Sources/ClaudeLaneMonitor/LoginItemController.swift`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Resources/Info.plist`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/scripts/test.sh`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/scripts/build-app.sh`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/scripts/install.sh`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/Tests/ClaudeLaneMonitorTests/LaneSnapshotTests.swift`
- Sanitized fixtures under `Tests/ClaudeLaneMonitorTests/Fixtures/`
- `/Users/albertgwo/Repositories/pi-claude-lane-monitor/tasks/validation/local-install.md`

The closest existing candidates are the Pi footer, permit extension, and OpenClaw menu app. None can absorb this native product cleanly: the footer is terminal-only, the permit package must remain a scheduler, and OpenClaw brings unrelated runtime and release dependencies.

## Dependencies

- Task 1 freezes contracts and environment policy before either writer begins.
- Tasks 2 and 3 may run in parallel in separate repositories.
- Task 4 depends on Task 3.
- Task 5 depends on Task 4.
- Task 6 depends on both repository implementations.
- Task 7 depends on review approval and explicit operator authority for daemon replacement.

## Rollback

1. Disable Launch at Login in the app.
2. Quit the app and remove `~/Applications/Claude Lane Monitor.app`.
3. Revert the permit hygiene commit only if it regresses local gating. Health additions do not migrate state.
4. Preserve all usage snapshots, credentials, and permit state directories.
5. Do not terminate or replace any daemon during rollback without the same approval and quiescence gate.

## Efficacy Signal

With the dropdown open, a normal lane-C Pi request changes lane C's active/queue display within three seconds. After completion, lane C's 5h/7d values, binding marker, reset, and last-observed age match the local usage JSON. Other lanes remain unchanged. Closing the dropdown yields zero periodic health requests for at least ten seconds.

Day-one legacy readings are valid only until the approved maintenance step. Before replacement, lane C may correctly show health version 1 with absent provider/protocol and “legacy, restart when idle.” After approved replacement, each replaced lane must report provider identity and protocol version 1.

## Residual Risks

- Local v1 cannot observe allowance responses generated only on the other Mac. The UI always labels its scope and observation age.
- The usage file is unversioned. Strict field validation and fixtures bound, but do not remove, future producer-drift risk.
- If MenuBarExtra lifecycle callbacks fail R1 on the target OS, implementation stops for a revised product decision.
- Ad-hoc signing supports this local installation only. Distribution, notarization, and updates remain future work.
- A legacy daemon may remain temporarily if it never reaches the approved maintenance gate; the work remains owned-but-waiting and is not reported complete.
