# Lane B restarts on October 21

Lane B on the authority host restarted twice: near 19:33:00 UTC (term 19 to 20) and near 19:39:34 UTC (term 21). Each time its error log gained the line `authority lane anthropic-b degraded; exiting for restart`. The daemon logs no degrade cause.

## Evidence

- The 19:33 restart hit a completion in flight. That client failed with "request rejected" because a degraded lane answers a non-retryable 503. v0.4.14 makes the client retry every 503.
- The host was under heavy load. Load averages read 13, 19, and 31. Swap held 5.9 GB of 7 GB, and a local model server held 66 GB resident.
- Health sampling showed lane A unresponsive at 19:32:45, 19:32:50, and 19:33:10. All four lanes missed health checks from 19:37:46 to 19:38:01. Lane A recorded no commits from 19:32:40 to 19:33:03.
- Lane A's state is 12.5 MB with 4,002 retained tickets. The protocol bound is 4,096 retained records. One of its commits takes about 110 ms on the idle path. A lane B commit takes about 35 ms.
- Every lane commits while it holds one shared verifier fence. The fence is a polled lock with a three-second timeout and no fairness. In a local test, three workers with 110 ms and 35 ms holds left the short worker waiting 2.3 seconds.

## Cause

A lane that timed out waiting for the verifier fence threw a verifier fault. The commit path then degraded the lane, and the lane exited. A host stall that slows a neighbor's commit therefore restarts the waiting lane. No direct log proves the fault was a fence timeout, because the daemon discards the cause. The timing, the host load, and the test reproduction all point to it.

## Change

A fence wait that times out now refuses only that request with a retryable `503 verifier_unavailable`. The lane stays ready, and the v0.4.14 client retries. Nothing was read or written before the timeout, so no safety check is lost.

## Open items

- The authority host still runs release `826fed5`. The fix takes effect only after a new release is staged and the lanes restart.
- Lane A retains about 4,000 tickets per day against a bound of 4,096. Creates fail with `persistence_unavailable` once the bound is reached.
- To verify the fix, watch `laneTerm` and `instanceId` for each lane in `~/Library/Logs/Claude Permit Authority/lane-samples.jsonl` on the authority host. A lane should keep its term through periods of high host load.

## Allowance prober

The allowance prober on the authority host has logged `Pi OAuth resolver unavailable` for every lane since September 29. Its last successful publish was on October 1. The host's Pi is 1.3.0, and the prober accepted only reviewed Pi releases up to 0.99.2. A review of the 0.99.2 to 1.3.0 changes found the same locked refresh-and-persist sequence, so 1.3.0 is now accepted.
