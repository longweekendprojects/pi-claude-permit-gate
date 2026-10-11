# Lane session limit and refused-create fix (2026-10-11)

Symptom: Pi sessions on lane A failed with `request rejected` while five or six fanned-out agents ran.

Cause: lane A held 32 live sessions from one machine, the per-machine session limit. The client retried refused creates under the same request id and timestamp; after 30 seconds the authority rejected the stale timestamp outright.

Client fix (v0.4.7, commit 94ecfd4): a refused create retries under a fresh request id and timestamp, and a record that never got a ticket is removed when acquisition fails.

Authority change (commit 826fed5): per-machine limits raised to 128 live sessions and 128 nonterminal tickets per lane. Installed with `scripts/install-authority.sh` at 13:10 EDT; all four lanes run release 826fed5, lane A is `ready`, no new lane error log entries, footprints 26 to 73 MB.

Check: `launchctl print gui/$(id -u)/com.longweekendprojects.claude-permit-lane.anthropic-a | grep releases/` and count live sessions per installation in `lane-8791.json`.
