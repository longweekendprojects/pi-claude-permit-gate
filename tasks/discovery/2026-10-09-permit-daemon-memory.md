# Permit daemon memory investigation (2026-10-09)

## Observed

- The lane monitor menu bar app is Swift and uses 52 MB. It is not the problem.
- The four Node permit daemons (`permit-daemon.mjs`, one per lane) use most of the memory:

| Lane | Port | Footprint | Peak | State file | Retained tickets |
|---|---|---|---|---|---|
| anthropic-a | 8791 | 761 MB | 1.0 GB | 9.6 MB | 2,580 |
| anthropic-b | 8792 | 596 MB | 830 MB | 6.6 MB | 1,549 |
| anthropic-c | 8793 | 128 MB | 131 MB | 0.7 MB | 1 |
| anthropic-d | 8794 | 147 MB | 149 MB | 0.8 MB | 10 |

- Memory scales with the size of the lane state file, not with uptime or connections. Each daemon holds only one or two local sockets.
- For lane a, `vmmap` shows about 200 MB of V8 heap and about 480 MB of native malloc memory. The malloc zone reports 100% fragmentation: about 520 MB is freed but not returned to the OS.
- Lane a rewrites its state file about every 5 seconds under normal use.

## Cause

Every state change processes the whole state several times:

1. `_transition` deep-copies the full state with `structuredClone`.
2. `_assertStoredHeader` reads the full file from disk and parses it.
3. It validates the stored copy, then serializes both the stored and in-memory state with `canonical()`, a recursive sorted-key string builder, and compares the two strings.
4. `_commit` validates the new state again and writes it with `JSON.stringify`.

With a 9.6 MB file, one change creates roughly 50 to 100 MB of short-lived strings, buffers, and objects. Large strings and file buffers live outside the V8 heap in native malloc. At one change every few seconds, the allocator fragments and keeps the peak, so memory settles near the high-water mark.

The state is large because terminal tickets are kept for 24 hours (`CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS=86400000`). Each ticket keeps up to 32 operation results, and each result embeds a full copy of the ticket response. A busy lane holds about 2,500 released tickets of 4 to 35 KB each. Up to about 950 allowance publish replays add 0.8 MB per lane.

Old tickets are pruned only when a new ticket is created, so idle lanes keep stale state. Lane c still holds a ticket released 430 hours ago.

The 130 MB floor on idle lanes comes from the Node runtime (about 40 to 50 MB), the reconcile timer that runs every second, and the retained replay records.

## Reproduction

A standalone script ran the same per-change steps (clone, reread, parse, two canonical strings, stringify) 40 times against copies of the live state files:

- Lane a state (9.6 MB): RSS grew from 89 MB to 577 MB, peak 661 MB.
- Lane c state (0.7 MB): RSS grew from 43 MB to 157 MB, peak 180 MB.

This matches the live daemons, which confirms the per-change processing is the cause.

## Implications for a rewrite

- The main cost is the algorithm, not the language. A Rust or Go port that still copies, rereads, and re-serializes the whole state on every change would use less memory but still churn.
- The fix in any language: keep state in memory, verify file ownership with a cheap check (inode, size, mtime, or a stored hash) instead of a full reread and canonical compare, and store operation results without embedding full ticket copies.
- Four processes each pay runtime overhead. One process serving all four ports would remove three copies of that overhead.

## Interim fix (deployed 2026-10-09 12:37 EDT, commit c9c0720)

- Skip the full ownership reread when the state file stat matches the one this process last wrote.
- Validate committed state once per swap instead of on every call.
- Dry-run reconcile on live tickets only; copy the full state only when a sweep changes it.
- Run lanes with `MallocSpaceEfficient=1` and `--max-semi-space-size=2`.

Harness against a copy of lane a under create/claim/renew/complete load: peak 684 MB before, 285 MB after.

Live footprint 7 minutes after deploy: a 41 MB, b 28 MB, c 20 MB, d 20 MB (was 853, 666, 128, 147 MB). No new entries in lane error logs. Daemon tests: same 39 pass; the same 4 OAuth prober tests fail before and after.

Check: `for p in $(pgrep -f permit-daemon.mjs); do vmmap --summary $p | grep 'Physical footprint:'; done`

Not yet done: the state file still grows to about 10 MB because each operation result embeds a full ticket copy. Each commit still clones and serializes the whole state.
