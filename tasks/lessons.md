# Project lessons

- Detached permit daemons can outlive the extension path that launched them. A replacement must verify provider and protocol identity after binding; `EADDRINUSE` cannot count as successful startup.
- Health preflight alone cannot prove acquisition provenance. Current clients bind a daemon instance UUID into `/acquire` and verify the grant; legacy clients require an unchanged stable `startedAt` after the grant.
- Claude subscription allowance is a last-observed response signal, not a pollable account balance. Preserve observation age, treat elapsed reset windows as unknown, and never synthesize 0% after reset.
- The current allowance snapshot mixes epoch seconds for window resets with epoch milliseconds for capture time. Any shared contract must normalize and test those units explicitly.
- A connection-owned long-poll queue loses fairness across unstable remote links because disconnecting removes the waiter. Cross-machine acquisition needs a reconnect-stable request ID or ticket before Tailnet rollout.
- Sharing permits does not share OAuth credentials or prove that lane letters map to the same accounts. Cross-machine rollout must verify the provider-to-account mapping separately.
- A remote active lease cannot safely auto-expire when Pi cannot fence the provider request. Missed renewals must quarantine capacity as uncertain until acknowledged completion or approval-gated reconciliation.
- Routine authority startup must never bootstrap missing established state. Bootstrap is an explicit offline administration step; a missing or corrupt state file fails closed.
- Verifier rollback protection must persist the highest generation observed by reads as well as mutations. Verifier updates and lane commits need one cross-process fence so a completed revocation cannot be followed by a stale commit.
- Retry and idempotency state is a durability boundary. Persist request and operation IDs with file and directory fsync, isolate concurrent Pi sessions, reconcile authoritative state after restart, and acknowledge completion before another provider request starts.
- Deployment helpers handle credentials only through bounded stdin or Keychain references. Disable ambient curl configuration, suppress child diagnostics, bound output and time, and force-stop resistant child process groups.
- Read a request body fully before enqueueing a serialized mutation. Node destroys a stalled request socket silently on its 300s request timeout with no end or error event, so a body promise chained ahead of the queue wedges every later write on the lane while the event loop stays idle. Two Macs on a tailnet stall requests often enough to wedge a lane within a minute of use.
- Inspector probes on a hung Node process show unref'd timers as absent and destroyed sockets as gone; calibrate `process._getActiveHandles` probes against a known-good process before concluding no timers or no stalled connections exist.
