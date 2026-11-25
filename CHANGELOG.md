# Changelog

## 0.4.35 - 2026-11-25

- Show recent model overloads in the Claude Lane Monitor. Sessions report each overloaded reply to their lane, and the lane counts them per model for five minutes. A report never pauses the lane.
- The authority no longer pauses a lane when an older client (v0.4.33 or earlier) reports an overload. Deploying the authority ends overload pauses from every Mac, including sessions that have not reloaded.

## 0.4.34 - 2026-11-25

- Stop pausing a whole lane after an overload. An overload affects one model, so one overloaded model no longer stalls every other model on the account. Rate limits still pause the lane.
- Remove the `CLAUDE_PERMIT_GATE_OVERLOADED_COOLDOWN_MS` setting.

## 0.4.33 - 2026-11-24

- Reject unexpected Host and Origin headers on local requests and require JSON on control POSTs.
- Let operators require a local token after upgrading daemons and reloading clients.
- Block Claude requests when a local provider-port map is invalid and report the bad entry.
- Use the default local port map for empty or whitespace-only overrides.
- Report why a local permit request was refused without interrupting its wait.
- Count local admission rejections and control POSTs without a valid token in `/health`.
- Write rate-limited rejection messages and token creation failures to the daemon log.
- Show the resolved token directory when a local daemon starts listening.
