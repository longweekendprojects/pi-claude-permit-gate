# Project lessons

- Detached permit daemons can outlive the extension path that launched them. A replacement must verify provider and protocol identity after binding; `EADDRINUSE` cannot count as successful startup.
- Health preflight alone cannot prove acquisition provenance. Current clients bind a daemon instance UUID into `/acquire` and verify the grant; legacy clients require an unchanged stable `startedAt` after the grant.
- Claude subscription allowance is a last-observed response signal, not a pollable account balance. Preserve observation age, treat elapsed reset windows as unknown, and never synthesize 0% after reset.
- The current allowance snapshot mixes epoch seconds for window resets with epoch milliseconds for capture time. Any shared contract must normalize and test those units explicitly.
- A connection-owned long-poll queue loses fairness across unstable remote links because disconnecting removes the waiter. Cross-machine acquisition needs a reconnect-stable request ID or ticket before Tailnet rollout.
- Sharing permits does not share OAuth credentials or prove that lane letters map to the same accounts. Cross-machine rollout must verify the provider-to-account mapping separately.
