# Claude lane sharing and menu bar decision brief

## Decision

Build the menu bar workstream first, after a narrow permit-daemon hygiene patch. This order delivers the missing lane overview without creating a network trust boundary, and it establishes the status model that the later shared authority will expose.

This order is wrong if the first menu release must include observations from both Macs, or if cross-machine concurrency is already causing bursts of Anthropic throttles. In either case, build the shared authority first and let the menu consume it.

## Frozen local-first packet contract

The approved first release is local-first and display-only. It observes only this Mac's A-D loopback permit health and local allowance files. Tailnet transport, authentication, cross-machine aggregation, provider switching, pi-dotfiles changes, and daemon replacement outside an approved idle maintenance window are excluded. Cross-machine account-order confirmation remains deferred to the Tailnet workstream.

H1 freezes daemon compatibility at the real acquire boundary:

- `/health` retains schema `version: 3` and every existing field. New daemons also report `protocolVersion: 1` and the provider passed through `CLAUDE_PERMIT_GATE_PROVIDER`.
- `current` health has `ok: true`, the expected provider, and protocol `1`. `legacy` health has `ok: true` with a missing provider or protocol, remains usable locally, and is labeled “restart when idle.”
- Explicit provider mismatch or unsupported explicit protocol is `incompatible`. Malformed, unavailable, or non-OK health is `invalidOrUnavailable`. Neither status may receive `/acquire`; both remain cancellable and retry under the existing backoff.
- An occupied-port daemon exits with code `3`. The extension re-probes once, clears recovery when a current or legacy owner won the race, and retains code `1` for genuine server failures.
- `/claude-permit` is the doctor surface. It reports schema, protocol, provider, fractional ISO-8601 `startedAt` age, and compatibility status without sending a provider request.
- No automatic termination is allowed. A separately approved maintenance window may replace only an idle legacy daemon after `active === 0` and `queued === 0` are each observed twice, two seconds apart.

This packet retains all ten existing Node tests and may add at most two Node test cases: one for provenance and occupied-port recovery, and one for acquire preflight classification. Legacy daemon replacement remains a separate approval-gated maintenance task.

## What already exists

The permit gate already has the hard local scheduling pieces: per-provider pools, session round-robin queues, long-held acquire requests, renewable leases, abandoned-lease reclamation, adaptive cooldowns, persisted restart state, and fail-closed acquisition. The ten existing tests pass.

The separate `pi-dotfiles` repository already captures Claude subscription allowance from OAuth response headers. It atomically writes one snapshot per provider with 5-hour and 7-day utilization, status, reset, binding window, and observation time. This is the right source for allowance data because no supported endpoint can refresh an individual subscription account without making a Claude request.

The current machine can build a native SwiftUI `MenuBarExtra` with Swift 6.2. No SwiftBar or xbar host is installed. Tailscale Serve is already configured for another localhost service, so the later shared authority can remain bound to loopback.

Before this hygiene packet, the live daemon lifecycle was unhealthy: ports 8790 and 8791 ran health version 3, while 8792 through 8794 were orphaned version 1 processes launched from a deleted extension path. `permit-daemon.mjs` treated `EADDRINUSE` as a successful exit, and `index.ts` accepted any `{ok:true}` daemon, so upgrades could silently leave old code in control. H1 replaces that behavior without changing any live daemon in this packet.

The second Mac is online over Tailscale through DERP, but SSH is disabled. Its package, lane mapping, and credentials could not be inspected remotely.

## Product definition

The menu should show two signals for lanes A through D:

1. **Claude allowance:** last-observed 5-hour and 7-day utilization, reset time, binding window, and observation age.
2. **Permit state:** active requests, queued requests, effective concurrency, cooldown, oldest wait, daemon version, and daemon age.

The UI must call allowance data “last observed.” A missing snapshot means “awaiting first response.” A window whose reset has passed means “awaiting post-reset observation,” never 0%. Each lane keeps its permit and allowance errors independent.

Token totals, conversation cost, context use, and assigned Pi-session counts are outside the first release. The built-in `anthropic` provider should be an optional separate row, not Lane E.

The first menu release should be display-only. Lane switching belongs to the account-lane extension and would turn a read-only status tool into a second configuration owner.

## Menu bar architecture

Create a sibling native app with its own Swift release path. Keep the Node permit package focused on scheduling and transport.

The app owns a versioned `LaneSnapshot` model and a `LaneSnapshotSource` interface. Its first source joins the existing localhost `/health` responses with `~/.pi/agent/usage-windows/<provider>.json`. A later Tailnet source returns the same model from the shared authority, so the view and severity rules do not change.

The first source must parse the existing time units explicitly: allowance `reset` values are epoch seconds, while snapshot `at` is epoch milliseconds. It must omit session IDs, working directories, permit IDs, OAuth data, raw headers, and file paths.

Use `MenuBarExtra` with window style for progress bars and partial-error states. Refresh all sources when the window opens or the user chooses “Refresh local status.” Poll permit health every two seconds only while open, watch the usage directory with a debounce, and recompute age once per minute. Refreshing never sends an Anthropic request.

The menu bar title should show the worst current allowance percentage and a stale or unavailable marker. The dropdown remains the source of detail.

### Menu falsification signals

- If sandboxing prevents reliable access to the usage directory, move only the local source into a small helper and preserve `LaneSnapshot`.
- If a second local consumer needs the same joined data, move aggregation into a shared read-only service.
- If the first release must include both Macs, skip the local source as the product source and build the Tailnet source first.

## Shared Tailnet authority architecture

Keep one authoritative daemon per existing lane port on this always-online Mac. Run them under `launchd`, not as detached children of whichever Pi session happens to start first. Keep each daemon bound to `127.0.0.1` and expose it through private Tailscale Serve HTTPS ports. Do not use Funnel or bind the mutation API to `0.0.0.0`.

Add one optional `CLAUDE_PERMIT_GATE_ORIGIN` while retaining the provider-to-port map. No origin preserves today’s localhost behavior. A non-loopback origin requires explicit client mode, removes every local spawn path, and stays fail-closed with no local fallback.

Require both a narrow Tailscale grant and application authentication when remote access is enabled. Store the bearer secret in macOS Keychain and inject it at runtime; never commit it or place its value in a plist. The existing general Tailscale auth proxy is not the permit gate’s security boundary.

Pass the expected provider name into each daemon and return it from health. A client verifies provider, port, and protocol before acquiring. A mismatch fails closed instead of silently sharing the wrong account pool.

Give each installation a stable random machine ID. The preliminary fairness recommendation is hierarchical round-robin by machine and then Pi session, so a headless fleet on one Mac cannot starve an interactive session on the other. Preserve legacy session-only behavior for old clients during rollout.

Replace connection-owned remote queue position with a reconnect-safe request ID or ticket. The current long poll removes a waiter when its DERP connection closes, which can repeatedly move the remote Mac to the back of the queue.

Track renewal acknowledgements and the server lease deadline. A disconnected client never grants locally. Set the shared deployment’s lease timeout above observed provider-request duration and Tailnet jitter. Document the unavoidable limit: Pi cannot currently fence or abort an Anthropic request that outlives a lost permit.

Publish safe allowance snapshots to the authority after provider responses. The authority stores only the validated allowance fields and exposes the same `LaneSnapshot` contract used by the menu. It never receives OAuth credentials or provider payloads.

### Protocol falsification signals

- If Tailscale Serve cannot support the held or ticketed acquire flow reliably, use a dedicated authenticated HTTPS gateway while keeping the daemons on loopback.
- If pools must move to different hosts or paths, replace one origin plus ports with full per-provider URLs.
- If measured scheduling shows per-session fairness is preferable, retain session-only round-robin and use machine IDs only for observability.
- If normal requests approach the lease timeout, raise the timeout before rollout; never reclaim live work merely to recover capacity faster.

## Execution order

### Foundation: daemon ownership and provenance

1. Make `EADDRINUSE` observable instead of a successful launch.
2. Probe readiness and compatibility before clearing startup recovery.
3. Add provider identity and a distinct protocol version to health.
4. Add a doctor/drain path for legacy detached daemons. Do not kill a daemon with active or queued work.
5. Replace the three orphaned lane processes during an approved maintenance action.

### Workstream 1: menu bar

1. Freeze `LaneSnapshot` v1 and fixture data.
2. Build the SwiftUI app and local source.
3. Render A through D with truthful allowance freshness and independent permit status.
4. Package the app, add launch-at-login, and verify live changes against the local daemons and snapshot files.

### Workstream 2: shared authority

1. Add origin/client-mode transport without changing local defaults.
2. Add provider verification, authentication, machine identity, and reconnect-safe acquisition.
3. Install the `launchd` authority and private Tailscale Serve routes on this Mac.
4. Publish allowance observations to the authority.
5. Configure the second Mac as a client, then point both menu apps at the shared source.
6. Verify that simultaneous requests from both Macs never exceed one central lane limit and that no daemon starts on the client Mac.

## Test budget ceiling

The permit hygiene packet retains all ten existing Node tests and adds at most two load-bearing Node test cases: one for provenance and occupied-port recovery, and one for acquire-boundary compatibility. Later menu and Tailnet packets have separate approved budgets; they do not authorize extra Node tests in this packet.

Manual validation for later packets covers menu layout, accessibility labels, launch at login, Tailnet grant denial, and a real two-Mac request wave.

## Inputs required before implementation

- Confirm that lanes A through D refer to the same four Claude accounts in the same order on both Macs.
- Confirm whether a local-only first menu release is acceptable. If it must reflect responses observed by both Macs immediately, the shared authority moves ahead of the menu app.
- Before the Tailnet workstream, accept strict fail-closed behavior when this Mac or Tailscale is unavailable. A local fallback would defeat the shared concurrency guarantee.
