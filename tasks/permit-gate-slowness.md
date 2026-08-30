# Why the Claude permit gate is slow

Measured 2026-08-15 against the live daemons on this machine, then adversarially reviewed. Sources: `/health` on each lane, `~/.pi/agent/claude-permit-gate/permit-daemon.log`, `~/.pi/agent/anthropic-permit-gate/permit-daemon.log`, `lsof` port ownership, and raw provider errors in `~/.pi/agent/sessions`.

## Summary

The gate is slow for two unrelated reasons on two different lanes, and the fix that looks obvious would make one of them worse.

1. **The throttled lane throws away what Anthropic tells it.** Anthropic returns an explicit retry delay on its 429s. The gate discards that number and substitutes a flat 20-second cooldown, then re-probes every 20 seconds through a reset window that is often minutes to hours long. This is the dominant cause of the visible stalls.
2. **The queue-bound lane is simply too narrow.** Lane 8791 runs a ceiling of 2 with 7 sessions queued behind it, the oldest waiting 454 seconds, and it is not being rate-limited at all (8 throttles against 10,140 grants).
3. **The two busiest lanes do not run this code.** Ports 8791 and 8792 are held by the retired `anthropic-permit-gate` daemon, which speaks an older protocol that cannot renew this client's permits.

## Correction: the cooldown recommendation did not survive measurement

An earlier draft of this document claimed the gate should honor Anthropic's requested retry delay via a `blockedUntil` state, and that doing so would be faster. **That claim was not measured, and testing it showed it is wrong for most of the observed traffic.** It is recorded here rather than deleted because being wrong in both directions is the useful finding.

Method: across 68 session logs, pair each 429 that carried a requested delay with the next successful assistant message in the same session, and compare the gap against the requested delay. 53 pairs.

| Requested delay bucket | n | Median requested | Median actual gap to success | Recovered before delay elapsed |
| --- | --- | --- | --- | --- |
| 120-600 s | 13 | 279 s | 3,570 s | 0 / 13 |
| 600-3,600 s | 8 | 1,529 s | 240,631 s | 0 / 8 |
| > 3,600 s | 32 | 138,422 s | 27,532 s | 32 / 32 |

Two conclusions, one firm and one negative:

1. **Large requested delays are not trustworthy.** The median request in the top bucket is 38 hours, and every one of those 32 cases recovered sooner. Observed values include 67,097 s, 132,940 s, and 514,863 s. Honoring these verbatim would idle a lane for hours or days. The client's existing clamp to 120 s is protective, not a bug.
2. **The measurement cannot judge the small-delay cases, so no cooldown change is justified yet.** "Time to next success in the same session" is dominated by human idle time, not by provider recovery: the 600-3,600 s bucket shows a median gap of 2.8 days, which is plainly someone not using the session rather than a rate limit clearing. That confound makes the small buckets unusable in either direction.

So the honest position is that the fixed 20-second cooldown is unvalidated, not proven harmful. Settling it requires lane-level telemetry that records, per throttle, the requested delay and the time to the next **successful grant on that lane**, which removes session idle time from the signal. That telemetry must land before any cooldown policy change, in either direction.

What survives measurement unchanged is Cause 2 (the queue-bound lane) and Cause 3 (the legacy protocol mismatch). Neither depends on cooldown behavior.

## Cause 1: discarded provider reset metadata (unproven, see correction above)

Anthropic's 429s carry a specific reset delay. A frequency count of raw provider errors in local session logs:

| Requested delay | Occurrences |
| --- | --- |
| 173 s | 34 |
| 1,787 s | 18 |
| 67,097 s | 17 |
| 2,436 s | 15 |
| 971 s | 14 |

Every one of these arrives as `Server requested Ns retry delay (max: 120s)`, so the client first clamps the provider's instruction to 120 seconds. `providerFailure()` and `cooldown()` in `index.ts` then reduce it further to the `rate-limit` class and a fixed 20,000 ms.

On lane 8794 the errors at 09:19 asked for 2,436 seconds and by 09:43 were asking for 971 seconds, both pointing at roughly the same 10:00 reset. The gate spent that window probing every 20 seconds and logging `concurrency 1 -> 1` 65 times. The lane then recovered at 10:02, which matches the provider's reset, not any internal healing.

One consequence is firm, and one earlier consequence has been withdrawn:

- **The 18.5-minute recovery is not evidence of a healing bug**, so timer-driven concurrency growth remains unjustified. It would have raised concurrency at 09:45 while the provider was still rejecting.
- **Withdrawn:** the claim that shortening cooldowns is harmful and that honoring `blockedUntil` is the fix. Per the correction above, the requested delays are often wildly conservative, and the available data cannot separate probe waste from user idle time. Treat the fixed 20-second cooldown as unvalidated in both directions until lane-level telemetry exists.

## Cause 2: the queue-bound lane

`MAX` defaults to 2, `START` 2, `MIN` 1, against Codex's 6 / 3 / 2. Lane 8791 sampled at active 2, queued 7, oldest wait 454 s, peak wait 1,203 s, with only 8 throttles in 10,140 grants. That lane is starved of slots rather than rate-limited.

This does not license copying the Codex ceiling of 6. Codex is a different provider with different limits, and its higher grant count reflects different demand, not proof that its ceiling caused the throughput. The defensible step is a per-lane canary at `MAX=3, START=2` on the queue-bound lane, holding the throttled lane at 2 until a full reset-window measurement exists.

## Cause 3: legacy daemons speak an incompatible protocol

Ports 8791 and 8792 are owned by `~/.pi/agent/extensions/anthropic-permit-gate/permit-daemon.mjs`, running since Aug 13 and reporting `version: 1` where this repo reports `version: 3`. `ensureDaemon` only spawns when `/health` fails, `/health` asserts no identity or version, and a new daemon exits 0 on `EADDRINUSE`, so the old process owns the port indefinitely.

This is worse than stale behavior. The current client starts permit renewal only when `/acquire` returns `permitTtlMs`. The legacy daemon returns no TTL, implements no `/renew`, and expires permits by original grant age. Any request running longer than five minutes is therefore reclaimed while still in flight, and the replacement permit issued into that freed slot creates real provider concurrency above the reported maximum. The 93 expirations on 8791 are partly live requests, not abandoned ones.

Automatic retirement is not safe to build now: an identity mismatch must never authorize killing a foreign listener, and the legacy daemon has no drain, fencing, or lease-transfer protocol. Retire version 1 once, under control, then design future self-upgrade around authenticated identity, a single-upgrader lock, queue drain, and lease handoff.

## Additional findings

- **The `activePermit` singleton can fail open.** `acquire()` returns immediately when the module-global `activePermit` is already set, so any overlapping same-process provider request proceeds ungated. Confirm Pi's serialization guarantee or make ownership request-scoped before raising any ceiling.
- **Do not port Codex incident mode verbatim.** Its recovery factor is computed only while enough throttle timestamps remain inside the sliding window, so incident mode unlatches as soon as old entries age out. The live Codex log shows an incident at 19:35:44 followed by a clean increase at 19:36:45, well inside the advertised 3x quiet period. Incident state needs to latch into open/half-open and clear on a successful probe.
- **Session-keyed queues are a fairness defect.** Of the 7 identities queued on lane 8791, four belong to one orchestration (root `019ff299` plus three descendants). Grouping by orchestration root fixes interactive tail latency but adds no aggregate throughput.
- **Capacity is stranded across accounts.** Lane A held 7 queued while B and C sat idle and D had spare slots. Auto-routed work should avoid a pool with a long `blockedUntil`.
- **Synchronous persistence is last and possibly not a cause.** State files are hundreds of bytes, each port has its own event loop, and the busiest lane does not persist at all. Persistence also earns its keep once `blockedUntil` must survive a restart, so do not blindly make grant writes async.

## Revised plan

1. Retire the legacy version-1 daemons once, under control. Add service identity and protocol capability to `/health` and fail closed on mismatch. Defer automatic retirement.
2. Add windowed outcome telemetry: model, failure class, provider retry delay, service duration, renew failures.
3. Fix lease compatibility and request ownership before touching capacity, including the `activePermit` fail-open.
4. Only after step 2 produces lane-level recovery data, revisit cooldown policy. Any use of the provider's requested delay must be bounded (the observed median request in the large bucket is 38 hours against a 7.6-hour actual recovery), so an unbounded `blockedUntil` is ruled out by measurement.
5. Group queues by orchestration root, and let Auto routing avoid long-blocked pools.
6. Canary capacity per lane, starting at 3 on the queue-bound lane only.
7. Keep recovery success-driven. Do not add an idle timer that ramps concurrency without a successful probe.
8. Profile persistence last.

## Falsification

The first proposed signal was invalid: `peakOldestWaitMs` is monotonic and cannot fall, and `granted` counts failed attempts. Use windowed successful completions, end-to-end latency percentiles, 429 rate per grant, and time-to-quota-exhaustion across a full provider reset cycle. Reject a higher ceiling if it does not raise successful work, or if it merely exhausts the account sooner.

The cooldown question needs its own signal, which does not exist today: per throttle, the requested delay and the time to the next successful grant **on that lane**. Session-scoped timing cannot answer it, as the correction section shows.

## Confidence

- **Measured and firm:** lane 8791 is queue-bound at a ceiling of 2 with 7 queued and 454 s waits against 8 throttles per 10,140 grants; the legacy daemon on 8791 and 8792 has no `/renew` and reclaims live requests at five minutes; large provider retry delays are unreliable.
- **Unvalidated:** whether any cooldown change helps, in either direction.
- **Rejected by measurement:** honoring the provider's retry delay verbatim, and timer-driven concurrency growth.
