# Critique: per-model overload alerts plan

Artifact path (authoritative): /Users/albertgwo/.pi/agent/sessions/--Users-albertgwo-Repositories-pi-claude-permit-gate--/subagent-artifacts/outputs/a24ffeab-b083-4573-b5f1-9129688f9201/tasks/plans/model-overload-alerts-critique.md

This was a read-only review. No repo files were changed.

## Verdict

The core design is sound and the plan can be locked once four changes are made.

The parts that hold up:
- A separate `POST /v1/model-overloads` endpoint, gated by a health capability.
- An in-memory record that never touches lane state, `_commit`, or `STATE_SCHEMA_VERSION`.
- `modelOverloads` always present on health, and on the snapshot only when the client asks for it with a header.
- A fire-and-forget client report that never touches the ledger.

I checked the main claims against the code and they are correct:
- Old authorities answer an unknown POST with `404` (`permit-daemon.mjs:293`).
- `health()` has no other caller that would leak the field (`allowancePublishResponse` builds its own object).
- Every health consumer reads named fields only.
- The Swift snapshot decoder is strict (`AuthorityWireModels.swift:22-31,230`).
- `const`, `pattern` and `maxItems` are supported by `validate-authority-contract.mjs`.
- No existing test or fixture uses `assistant_overloaded`, so D10 breaks no current test.

Change before lock:
1. **F1:** a decode failure inside `modelOverloads` must not invalidate the whole snapshot.
2. **F2:** resolve the lane-B evidence below before freezing D5 and the report body.
3. **F3:** ship D10 as its own commit with its own changelog line and test.
4. **Strongest counterargument:** fix the alert meaning — group by model, show how long ago, and say "recent".

## Strongest counterargument

The alert counts attempts that sessions reported. It is keyed per lane and clears when reports stop. That answers "did a session on lane X get a 529 in the last 5 minutes?", not "is model M overloaded now?".

- **It clears when the operator stops using the model, not when the model recovers.** If the operator switches away from Fable because of the alert, no more reports arrive and the alert clears while Fable is still down.
- **The count mostly measures Pi's retries.** One session's 10/20/40 s retries alone produce 3–4 reports in the window. "6 in the last 5 min" says more about how many sessions kept retrying than about how bad the overload is.
- **One Anthropic event shows up as several alerts.** Anthropic's 529 is a model-level condition, so the same overload on lanes B and C appears as one headline plus "and 1 more".

Fixes that stay inside the plan:
- The monitor groups by model across lanes: "Claude Fable 5.2 overloaded on lanes B, C (6 in the last 5 min, last 1 min ago)".
- The tooltip shows how long ago the last overload was (`lastAt` is already on the wire).
- The wording says "recent overloads".
- Optional, and only if F5 adds a `kind` field: the client reports the first success for a model after an overload, so the alert can clear on recovery instead of on silence.

## Findings (by severity)

**F1. High: a malformed advisory field can take every lane offline on new monitors.**
- M1 requires that a nested unknown key is rejected. `rejectUnknownAuthorityKeys` throws out the whole `AuthorityWireSnapshotV1`, and the lane then maps to unavailable.
- Any later authority change triggers this: an extra item key, more than 16 models (the Swift side checks `models.count <= 16`), or a different window.
- A telemetry field would then show every lane as "Permit offline" on every Mac running the new monitor. That is the exact failure the header opt-in exists to prevent for old monitors.
- Fix, either of:
  - Decode `modelOverloads` in isolation. On failure, drop it, keep the lane valid, and note it in the tooltip.
  - Or keep it strict, but make the header value a frozen shape version: `x-permit-model-overloads: 1` means exactly this shape and these limits forever, and the authority only ever adds a new header value.
- I recommend isolation. It is the one deliberate exception to strict decoding, and it is justified because the field is advisory.

**F2. High: evidence that D5 and the client-only design miss real overload sources.**
- `lane-samples.jsonl` shows ~60 s cooldowns on **lane B**: 04:53:08Z, 04:54:13Z, 04:55:13Z, 04:56:13Z, 04:56:18Z. 60 s is v0.4.33's overload cooldown; a rate limit is 20 s.
- No session on this Mac has a lane-B `stopReason:error` message in that window. I scanned every session file modified in the last 120 minutes; the only errors are the six lane-C Fable overloads.
- `cache-ttl.jsonl` has no lane-B warm activity in 04:50–05:00Z.
- So those lane-B overloads came from one of:
  - the other Mac (`albert-aviary-mac`);
  - a run that writes no session log;
  - a warm keep-alive 529 (v0.4.33 maps a warm 529 to `assistant_overloaded`; see `after_provider_response` in v0.4.33).
- The discovery note's line "Lane B served Opus normally" leaves this out.
- Consequences:
  - (a) Warm 529s cannot be dismissed as noise until this is explained.
  - (b) Most of the signal may come from the other Mac, which reports nothing until it runs v0.4.35.
  - (c) The overload probably was not lane-C-only, which supports grouping by model.
- Action: before locking D5, find out which model and which host produced the lane-B throttles.

**F3. High/medium: D10 is a scheduler change bundled into a telemetry release.**
- The change itself is right, matches the user's rule, and is small.
- Rollback is the problem: rolling the authority back to undo an alert bug also restores lane pauses, and rolling back for D10 also drops the alerts.
- Ship it as a separate commit with its own changelog line and test (P3), and say in the doc that it applies to all v1 clients.
- Its effect cannot be measured today, because the authority does not log throttle reasons. The only proxy is sample cooldown length (≈60 s means overload, ≈20 s means rate limit).
  - Lane A at 05:20–05:24Z shows 16–19 s cooldowns. Those are real rate limits after v0.4.34 and must keep working.
  - Consider an in-memory per-reason throttle counter on health. Without one, nobody can tell when old clients are gone.
- Edge case D10 misses: v0.4.33 classifies error text that contains `529` but not "overloaded" as `assistant_rate_limit`. This is rare, because Anthropic's body contains `overloaded_error`.

**F4. Medium: the window is a schema `const` but consumers are told to read it.**
- `windowMs const 300000` contradicts the reason `windowMs` is on the wire, and the monitor already formats `windowMs/60000`.
- Use a bounded range (for example 60000..3600000, a multiple of 60000) so the authority can tune it without a schema change and without tripping F1.

**F5. Medium: the report body is frozen from day one.**
- Exact-key validation plus a capability name means any later field needs a new capability and route. Examples: `source: message|warm` (needed if F2 shows warm 529s matter), `kind: overload|recovered`, or an optional `reportId`.
- Decide now. My recommendation is to add `source` (an enum, at most two values) now. Leave the others unless the recovery signal is wanted.

**F6. Medium: alerts will barely appear for a long time after release.**
- Reports come only from sessions started after v0.4.35 is checked out, on each Mac. Pi sessions are long-lived.
- The plan updates only this Mac (Task 7). It has no step for the other Mac (pull pi-dotfiles, pin, checkout).
- Until then, Task 14's synthetic probe is the only proof. Write this expectation into the plan.

**F7. Medium: testing gaps.**
- The plan says there is no hook-level harness. That is only partly true:
  - `test/source-policy.test.mjs` already runs the extension with a fake `pi.on` (`:44,54`).
  - It also checks `index.ts` wiring by regex (`:551-555`).
  - Add a source-policy regex that asserts the call is `void`-ed and comes before the `activePermit` guard.
- P4's hanging-route case waits a real 5 s unless the timeout can be injected. Add a `reportTimeoutMs` option.
- The model-id pattern now lives in four places: the schema, `index.ts`, `authority-state.mjs`, and Swift. A mismatch would silently drop every report, because the client swallows all errors. Share one constant in JS and test it against the schema pattern.

**F8. Medium: monitor rollback and deploy order.**
- The order is safe on paper, but F1-type breakage only appears once the new monitor meets the new authority.
- Add these steps:
  - Keep the previous `.app` bundle.
  - After the authority deploys, check that the old monitor on both Macs still shows all lanes.
  - After the monitor installs, check that no lane went offline.

**F9. Low: client side-effects.**
- In `message_end`, run `providerOverload()` before `bypassState()`. Otherwise every assistant message pays for a bypass-file read.
- The report goes through the traced `request` wrapper, so a report still in flight can add a `POST /v1/model-overloads` span to an acquire-timing trace. Use `baseRequest`, or accept it.
- A report that gets a `401` calls `freshToken()`. That clears the shared token cache for concurrent permit operations; this is the existing behaviour.
- In `pi -p` runs, an open report socket can delay exit by up to 5 s.
- Overloads during compaction or branch summaries use Pi's summarization retry path (`agent-session.js` `_summarizationRetryCallbacks`). They may never reach `message_end`, so document the undercount.

**F10. Low: a push channel already exists and the plan does not consider it.**
- `deploy/netdata/health-claude_permit_authority.conf` already defines Netdata alarms on exporter metrics.
- The exporter could send the opt-in header and emit `claude_lane_model_overloads{model}`. That would give a real push alert without the `UNUserNotificationCenter` authorization problem.
- Present this to the user next to D7's notification question.

**F11. Low: header naming.**
- A single header listing fields and versions, such as `x-permit-snapshot-fields: model-overloads.1`, scales better than one header per field. It also carries the shape version F1 needs.
- This is optional.

**F12. Low: the Task 14 probe is visible everywhere.**
- It puts a fake model on the shared production view of every new monitor on both Macs and writes it into the sampler log permanently.
- Announce it, and keep it on idle lane D as planned.

## Compatibility holes not in the matrix

| Pair | Behaviour |
|---|---|
| New monitor and a later authority whose `modelOverloads` shape or limits change | Every lane goes offline on new monitors. Closed by F1. |
| v0.4.34 clients (the bulk while sessions restart) and the new authority | They send no report and no throttle, so overloads from those sessions are invisible. |
| Other Mac, any client version below v0.4.35 | Sends no reports. Per F2, this may be most of the signal. |
| v0.4.33 client, 529 text without "overloaded" | Still a 20 s lane throttle under D10. Rare. |
| One lane rolled back (`--rollback-lane`) | Safe. Capability is read per lane from that lane's health. |
| Authority restart or degraded-exit loop | Counts reset and the alert clears early (D2). Already accepted. |
| Exporter and syncer | Unchanged. They get the data only if they opt in (F10). |

## Hidden assumptions to state in the plan

- An overload is per lane. F2 suggests it is per model and crosses lanes.
- Every overload reaches `message_end`. Warm requests and possibly summarization requests do not.
- Absence of reports means recovery. It does not; see the strongest counterargument.
- Count 1 deserves an alert. A single 529 then lights `⚠` for 5 minutes. Accept that or set a threshold, and let the user decide together with D7.
- Every Pi model id matches `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. This holds for every built-in Claude id in pi-ai, including dotted ones such as `claude-opus-5.5`. A custom provider model that does not match is dropped silently.