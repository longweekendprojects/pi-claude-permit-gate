# Authority lane stalls (2026-10-15)

## Symptom

- Two sessions failed with "request rejected" at 15:24 UTC. Both offers were made at 15:23:46 and expired at 15:24:01 with no claim recorded.
- The lane sampler saw lane a stop answering health checks from 15:23:46 to 15:23:56. Lanes b, c, and d also missed checks at 15:23:46.
- The client defect that turned a late claim into a session error is fixed separately (commit f26d3cd).

## Stall pattern

- The sampler logged 88 missed health checks since the log rotated on Oct 14: 40 on lane a, 21 on b, 14 on c, 13 on d.
- Many stalls hit several lanes at once (for example, all four lanes for 25 seconds at 08:35 UTC on Oct 15). A per-lane cause cannot explain those.
- A 1-second probe at 16:10:43 saw lane b answer locally in 124 ms but take 2,931 ms through Tailscale Serve. Four seconds later, lane a took 2,667 ms locally while lane b took 4 ms.
- Stalls therefore come from at least two places: the Tailscale Serve proxy, and the lane a process itself.

## Host state during the investigation

- Swap: 20.9 GB used of 22.5 GB. Load average about 15 on 20 cores. Docker's `com.docker.sailor` used about 260% CPU.

## Lane a process

- The state file is 10.6 MB with 2,691 retained tickets. Operation results are 7.0 MB of it, because each result embeds a full ticket copy.
- Per commit on that file: structuredClone about 30 ms, validateState about 50 ms, JSON.stringify about 22 ms, write about 26 ms, fsync about 9 ms. That totals about 140 ms of work. It cannot by itself explain multi-second stalls on an idle host.
- One `sample` capture during a 1.26-second local stall showed the main thread idle in kevent for about 74% of samples and the libuv workers idle. The capture started at least 400 ms into the stall, so it may have missed the busy part.

## Not established

- Whether lane a's own stalls come from memory pressure (paging its heap back in) or from commit work.
- Why Tailscale Serve adds multi-second delays.

## Next checks

- Rerun the stall probe while swap usage is normal, to separate host pressure from lane cost.
- Start `sample` at the moment a request begins rather than after 400 ms.
- Shrinking operation results (store the response fields that change rather than a full ticket copy) would cut lane a's commit cost by about two thirds. Do it only once a probe shows the commit cost matters.
