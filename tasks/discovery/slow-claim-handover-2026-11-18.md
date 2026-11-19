# Slow permit hand-over on busy lanes (2026-11-18)

Symptom: on lane C at 16, about 22% of slot time sat in "offered". Offer-to-claim was a median 3.7 s for albot and 1.4 s for aviary.

Cause: authority mutation time grows with lane state size, and mutations run one at a time per lane.
The client and the machine are not the cause.

Evidence (v0.4.22 timing log, synthetic acquire/hold/complete clients on albot, no Anthropic requests):
- Idle lane, one client, per mutation (create, claim, complete): D (0.95 MB) 130-180 ms; A (3.9 MB) 220-260 ms; B (13 MB) 360-370 ms.
- 16 clients on D (ceiling 4): offer-to-claim median 575 ms, claim POST mean 261 ms. Poll interval dominates.
- 28 clients on C (ceiling 16, 12.8 MB): offer-to-claim median 10.3 s; create POST mean 12.2 s, claim POST mean 9.3 s; ticket GET mean 112 ms.
- Client side under the same load: token 21-31 ms, ledger write 21-39 ms, timers at most 4 ms late.
- Lane C state: 3,841 tickets, 3,795 released, oldest terminal 2.5 h; operationResults 8.0 MB, createResponse 1.6 MB, allowancePublishes 1.2 MB.
- Whole-state passes on the authority host for 12.8 MB: structuredClone 42 ms, stringify 34 ms, write+fsync 11 ms, plus validation. Lane C process averaged 40% of a core.
- albot alone on idle lane D matches aviary: offer-to-claim about 170 ms. The earlier albot/aviary gap compared busy periods with quiet ones.

Proposed fix (branch `compact-terminal-records-sooner`, not released): compact terminal records older than ten minutes beyond a 256-record working set.

To repeat: scripts in /tmp/pbench on albot (bench.mjs, run.sh, job.sh, sum.py); job.sh runs the load in the GUI session so the Keychain is readable.

## Fix deployed (v0.4.23, 2026-11-18 20:22 UTC)

- Authority release b764258 installed on all four lanes; one restart each (terms A35, B28, C35, D26), ready since, limits kept (12/12/16/4).
- Lane C state 12.8 MB -> 1.9 MB after its first create. Lane B compacts on its next create.
- Same 28-client burst on lane C: offer-to-claim median 10.3 s -> 0.85 s; claim POST mean 9.3 s -> 1.1 s; create POST mean 12.2 s -> 1.0 s.
- Client now treats 404 not_found on complete as done.
- Pre-install copies of lane states and plists: path in /tmp/permit-backup-path on the server. Roll back one lane with `scripts/install-authority.sh --rollback-lane anthropic-<x>`.
- Remaining: allowancePublishes is 1.2 MB of the 1.9 MB. The CI test "authority authenticates reconnect-stable tickets..." fails intermittently on main (concurrent admin enrollment), unrelated.
