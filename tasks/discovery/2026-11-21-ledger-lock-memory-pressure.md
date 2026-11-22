# Client ledger lock stalls under memory pressure, 2026-11-21

## Symptom
On albot, permit acquisitions stalled for up to 28.5 s and five failed with "authority retry state is locked" during two macOS memory-pressure windows (03:20-05:22Z and 22:13-22:36Z). Calm hours with the same load had no slow ledger step.

## Cause
Every session on a machine shared `authority-client-tickets-v1.json` under one mkdir lock. The holder kept it across about a dozen awaits, two of them fsync, so the hold lasted as long as the slowest step of the slowest process. A holder slowed by paging, a busy event loop, or fsync behind swap writes stalled every session; waiters gave up after 500 tries of 10 ms. Records were never shared between sessions.

## Baseline (albot, `acquire-timing.jsonl`, Nov 20 01:36Z to Nov 22 00:20Z)
| | calm (24,300 acquisitions) | pressure windows (6,480) |
|---|---|---|
| one ledger step, p50 / p99 / max | 5.3 / 110 / 1,398 ms | 7 / 1,866 / 28,508 ms |
| ledger steps over 5 s | 0 | 25 |
| Keychain token read, p99 / max | 291 / 1,661 ms | 2,807 / 6,345 ms |
| acquisition total, p99 | 487 ms | 2,897 ms |
| failed | 0 | 5 |

## Bench (Bun 1.4.4, 14 processes, fake authority, real files; two processes starved)
| scenario | v0.4.30 others p99 / max | v0.4.31 others p99 / max |
|---|---|---|
| no starvation | 90 / 130 ms | 7 / 9 ms |
| two processes stopped 2 s at a time | 2,030 / 2,196 ms | 5 / 8 ms |
| two processes stopped 7 s at a time | 787 / 1,232 ms, 12 failed "locked" | 4 / 11 ms, 0 failed |
| two processes with a blocked event loop | 4,812 / 4,891 ms | 4 / 7 ms |
CPU per acquire-and-complete cycle fell from 4.6-6.7 ms to 1.6-4.7 ms; v0.4.30 rewrote the 159 KB shared file five times per cycle.

## Fix (v0.4.31)
One retry-state file per session under `authority-client-tickets-v2/`, a synchronous critical section, an in-process FIFO per session, fsync in the background after the atomic rename, day-old files pruned under their lock. The Keychain token is kept 15 minutes, refreshed in the background past half age, read once at a time, and prefetched at session start; a refused token starts a fresh read that older reads cannot overwrite. `CLAUDE_PERMIT_GATE_SESSION_LEDGER=0` returns to the shared v1 file.
