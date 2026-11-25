# One overloaded model froze lane C (2026-11-24)

## What happened

From 23:52:15 to 23:56:20 EST (04:52:15Z to 04:56:20Z on 2026-11-25), Anthropic answered every Claude Fable 5.2 request on lane C with `overloaded_error` (HTTP 529).

Six failures came from two albot sessions. Request IDs: `req_011ChP3f1L2ttp2i1qUr8Bm6`, `req_011ChP3jXLRs7AQisSNtotQK`, `req_011ChP3jXLvQeoFiA7gHFT5D`, `req_011ChP3p6gkbdpE3Zyutb428`, `req_011ChP3p6ruyqdswZ6g8pvLY`, `req_011ChP3tgniC888QFSXcENeu`.

On the same account, every Claude Opus 5.5 and Claude Sonnet 5.5 request that went out succeeded. Lane B served Opus 5.5 normally.

Each overload completed its lease as `throttled` with reason `assistant_overloaded` and the default 60-second overload cooldown. The authority applies that cooldown to the whole lane: the completion sets `scheduler.cooldownUntilEpochMs`, and `scheduleOffers` grants nothing until it passes.

The lane samples for `anthropic-c` show up to five waiting sessions and no active lease during each cooldown. When a cooldown ended, every waiting session got a permit. The Fable retries failed again and extended the cooldown to 04:53:15Z, 04:54:16Z, 04:55:18Z, and 04:56:20Z.

The healthy Opus and Sonnet sessions on lane C therefore got one request per minute for four minutes. The lane recovered when the Fable retries stopped.

It recurred at 05:05:29Z. One albot session resumed Fable, got one success at 05:04:56Z, then an overload that paused lane C until 05:06:29Z.

Pi's first three retry waits (10, 20, and 40 seconds) were shorter than the 60-second cooldown, so the cooldown set the retry pace.

"Retry cancelled" is Pi's message when a pending retry is stopped, for example by Esc. The gate never aborts a run, and the cache-warm extension logged no abort in this window.

The cache-warm extension did not contribute. It swapped summaries into both Fable sessions at 04:50:42Z and 04:51:27Z, and nine Fable requests succeeded after that. At 04:54:32Z it cancelled one Pi threshold compaction because the real request was 190k tokens against a 900k threshold. That check runs only after a retry has already ended, so it followed the cancellation and did not cause it.

## Cause

An overload is a capacity signal for one model, not a quota signal for the account. The gate treats it like a rate limit and pauses the whole account lane. One overloaded model therefore stalls every model on the account, and synchronized retries keep the pause alive.

## Recommended fix

Release the permit normally after an overload, and keep the lane pause for rate limits (HTTP 429) only. Pi's own retry backoff already spaces the failing session's retries.

## Sources

- `~/Library/Logs/Claude Permit Authority/lane-samples.jsonl`, provider `anthropic-c`, 04:49Z to 04:59Z.
- Pi session logs under `~/.pi/agent/sessions/--Users-albertgwo-Repositories-albot--/` for the same window.
- 2026-11-25: Follow-up shipped. Lanes now count overload reports per model, the lane monitor shows them, and the authority ignores the lane pause that older clients request on an overload. Design: tasks/plans/model-overload-alerts.md.

## Deployed v0.4.35 (2026-11-25 05:57 UTC)
- Client v0.4.35 pinned in pi-dotfiles (9d7586a) and checked out in the live package directory. Lane sampler restarted.
- Authority installed from b3ecdd7 on ruminaider. All four lanes restarted ready: terms A45, B36, C43, D30, limits kept (28/24/24/4). The install now runs the lanes on Homebrew Node 26.13.1 instead of nvm Node 22.19, because scripts/launchd-node.mjs prefers /opt/homebrew/bin/node; the suite and the offline check pass on both.
- Offline check before install, on copies of the four live lane states: v0.4.35 opened each, ran create, claim, complete, and an overload report; v0.4.29 then reopened every copy.
- Live probe on lane D: a report for claude-verify-probe-0-1 appeared on health, in lane-samples.jsonl, and on the opted-in snapshot. A snapshot without the header kept its 21 old keys. The new monitor's decoding and presentation code, fed the live snapshots, showed all four lanes current and the alert "Claude Verify Probe 0.1: recent overloads on lane D".
- Lane monitor aaa20b4 installed; previous app kept at ~/.local/share/claude-lane-monitor-backups/.
- Pre-install copies: path in /tmp/permit-backup-path. Roll back one lane with scripts/install-authority.sh --rollback-lane anthropic-<x>.
