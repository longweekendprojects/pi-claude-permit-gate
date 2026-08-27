# Shared authority deployment validation

Live-deployment evidence for the shared Claude permit authority lane. Build evidence stays in `shared-authority-build.md`; this file records only readings taken against real machines during rollout.

## Machines

| Role | Host | Tailnet address | Local user | Home |
| --- | --- | --- | --- | --- |
| Authority + client | ruminaider.tail252378.ts.net | 100.103.181.53 | albertgwo | /Users/albertgwo |
| Client (peer) | albert-aviary-mac.tail252378.ts.net | 100.100.166.117 | albert | /Users/albert |

The peer's local user is `albert`, not `albertgwo`. Confirmed on 2026-08-27 that the repository contains no hardcoded `/Users/albertgwo` paths, so generated jobs and configuration must continue to resolve `$HOME` rather than a literal home directory.

## 2026-08-27 pre-cutover readings

### Ruminaider baseline, 11:06 EDT

Zero lane LaunchAgents installed, so shared authority is not live:

```sh
find "$HOME/Library/LaunchAgents" -maxdepth 1 -name 'com.longweekendprojects.claude-permit-lane.*.plist' -print | wc -l   # 0
```

Local daemon occupancy (`/health` on 8791-8794): 8791 `active=1, queued=0, current=2, max=2`, started 2026-08-24T19:43:46Z, schema 3; 8792 `active=0, queued=0, current=1`, started 2026-08-06T06:01:15Z, schema 1; 8793 `active=0, queued=0, current=1`, started 2026-07-20T03:38:11Z, schema 1; 8794 `active=0, queued=0, current=2`, started 2026-07-30T22:00:51Z, schema 1. None reported `protocolVersion`, `provider`, or `instanceId`, consistent with detached pre-authority daemons.

Test ladders green: 21 of 21 Node cases, 3 of 3 Swift cases, with the canonical schema digest `d2bbd240177a87fd76bb1f3c89b69d0165cb32d6b39e3f3079fdb668bd2b6816` validated before the Swift run.

### Peer readiness, 11:10 EDT

Operator-run read-only workflow, because TCP 22 on the peer refuses connections and Remote Login was deliberately not enabled.

- Identity: `albert-aviary-mac`, tailnet address 100.100.166.117, owned by `albertgwo@`. Confirmed as the intended second Pi Mac.
- Permit gate pin: `git:github.com/longweekendprojects/pi-claude-permit-gate@v0.2.0`, checked out at `7f3ce00`, matching the released `v0.2.0` tag.
- Mode: no `CLAUDE_PERMIT_GATE_*` variables in the environment or in `~/.zshrc`, `~/.zshenv`, `~/.zprofile`. The peer is in default `local` mode.
- Local listeners: five node daemons on 127.0.0.1 ports 8790-8794. All four A-D listeners must be stopped before the peer enters authority-client mode.
- Lane LaunchAgents: 0.
- Keychain: `claude-permit-authority-permit-mutate`, `claude-permit-authority-snapshot-read`, and `claude-permit-authority-allowance-publish` all absent.
- Runtime: node v25.9.0 (satisfies `engines.node >=22`), pi 0.84.3 on both machines.

### Publication, 11:17 EDT

`origin/main` advanced from `6d8d41d` to `b2e9dcc` (39 commits) and the annotated tag `v0.3.0` was created at `b2e9dcc`. Verified independently by cloning the tag into a scratch directory: `git rev-parse HEAD` returned `b2e9dcc04f621fbd39d873addd23a9b7fe60d745` and `package.json` reported `0.3.0`. This repository publishes tags only; `v0.1.0` and `v0.2.0` likewise have no GitHub release objects.

Both Pi installations remain pinned to `v0.2.0`. Upgrading either one belongs to the coordinated cutover, not to publication.

### Monitor distribution to the peer, 11:19-11:24 EDT

The peer had no monitor app installed at all, so distribution was a fresh install rather than an upgrade. Built from monitor `main` at `8b06032` and transferred over Tailscale file copy.

| Artifact | SHA-256 |
| --- | --- |
| Transfer archive `ClaudeLaneMonitor-8b06032.zip` | `7c6c2aab3e99a0ba87b2bc24ee0735be11f9fac0a31f427d0cf64e7f8dbe65df` |
| Binary, built on Ruminaider | `2950c852d793dbd3abb451aedd6c149a5f633dd267e18285528b4fbe462816a1` |
| Binary, installed on peer | `2950c852d793dbd3abb451aedd6c149a5f633dd267e18285528b4fbe462816a1` |

Archive and installed binary hashes both matched the source build. The app is adhoc-signed with no Team ID, so `xattr -dr com.apple.quarantine` is required after extraction on every machine that receives it this way. The peer's app is installed but deliberately not launched: starting it before the authority exists would display local-only data.

Ruminaider still runs the older local-only monitor build (`a8aec3f24b2cd7896e20b820476ee6e6b411a76587e695b391a4f4a642f7ff35`). Both machines converge on the shared-authority build during cutover, not before.

The monitor repository still has no remote. Adding one remains optional and is a distribution convenience, not an architectural requirement: the monitor is a read-only menu bar app that runs on both machines, and the client/server split applies only to the authority daemons.

### Clock skew, 11:24 EDT

Requirement: at most 30 seconds between machines.

| Machine | Offset from time.apple.com | Uncertainty |
| --- | --- | --- |
| Ruminaider | +0.006187 s | ±0.003180 s |
| albert-aviary-mac | +0.181199 s | ±0.011844 s |

Implied skew is approximately 175 ms, three orders of magnitude inside the requirement. Hand-pasted `date` samples were discarded as a skew measurement because operator paste latency dominates them; only the NTP offsets are authoritative.

### Tailnet latency, 11:25 EDT

Twenty sequential `tailscale ping` round trips from Ruminaider to the peer, all relayed through DERP(nyc) because no direct connection was established:

```
samples=20 min=19ms p50=30ms p90=41ms p99=79ms max=79ms
```

This bounds transport latency for claim requests but is not the claim p99 itself. A claim adds TLS, bearer verification, scheduler work, and a durable ledger write. Measure claim p99 against live lane daemons before choosing offer TTL, renewal interval, renewal deadline, and terminal retention. A p99 near 79 ms of pure transport means an offer TTL in the low seconds is defensible, but no timing value should be fixed until measured end to end.

### Account fingerprints, Ruminaider side, 11:25-11:35 EDT

SHA-256 over `profile-v1\0<account.uuid>\0<organization.uuid>` from the Anthropic OAuth profile endpoint. Tokens were piped directly into `scripts/account-fingerprint.mjs` and never written to a file, argument, or log.

| Lane | Ruminaider fingerprint |
| --- | --- |
| anthropic-a | `697832eaa258f1ecd7d82e809d38b2d55972af05eef8a92bfb5e1088666ea9e1` |
| anthropic-b | `3aa4697715db0a3d0c1b571177c60998a1db392ebb89c477e4b85b05f9eb7ea5` |
| anthropic-c | `6a3fa6aee7eca4faa1b10728a41109e4e7c53681dc48c807ec4e7c22f195edba` |
| anthropic-d | `cfb10e6647ace1d7eba5c4c8da6b22bee372e9ca4489d336d05a613d7d695345` |

All four digests are distinct, so the four lanes are four different accounts on this machine. Lane C was initially skipped because its token had expired at 2026-08-27T01:39Z; the operator reauthenticated it and the fingerprint was taken from the naturally refreshed token.

The peer runs the same check from a scratch clone of the `v0.3.0` tag, because its installed package is pinned to `v0.2.0` at `7f3ce00`, which predates the script. Account-binding UUIDs may be created only after all four pairs match.

## Still unmeasured

Provider-duration p99, claim p99 against live daemons, fsync cost under production-sized state, and two-Mac fairness. No timing or capacity conclusion should be inherited from the build phase.

## Open gates

Account identity fingerprints for lanes A-D have not been compared across machines and require both a valid access token per lane and explicit approval. Keychain provisioning, the Tailnet grant, lane daemon maintenance windows, LaunchAgent installation, Serve routes, and coordinated cutover all remain gated as recorded in the lane plan.
