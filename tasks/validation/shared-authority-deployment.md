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

### Account fingerprint comparison, 11:41 EDT

| Lane | Ruminaider | albert-aviary-mac | Verdict |
| --- | --- | --- | --- |
| anthropic-a | `697832ea…6ea9e1` | `697832ea…6ea9e1` | Match, cleared for account binding |
| anthropic-b | `3aa46977…eb7ea5` | `3aa46977…eb7ea5` | Match, cleared for account binding |
| anthropic-c | `6a3fa6ae…95edba` | `6a3fa6ae…95edba` | Match, cleared for account binding |
| anthropic-d | `cfb10e66…695345` | `cfb10e66…695345` | Match, cleared for account binding |

All four lanes are cryptographically the same accounts on both machines, compared over both the account and organization UUIDs rather than provider aliases. Lanes C and D initially reported `valid=NO` on the peer and failed at the profile request, which is an expired-token failure rather than evidence of a different account; the operator reauthenticated both and the digests then matched. Lane C on Ruminaider needed the same treatment earlier.

The peer's shallow clone emitted `warning: refs/tags/v0.3.0 1d3dd00460e65a3baa692f3dd6f55261e563882c is not a commit!`. This is cosmetic. `v0.3.0` is an annotated tag object at `1d3dd004` that peels to commit `b2e9dcc0`, `git ls-remote --tags origin v0.3.0` returns the same object on the remote, and the peer checked out `b2e9dcc0`. Git prints this warning when a shallow clone fetches an annotated tag whose object is not itself a commit.

### Lane identifiers, 11:45 EDT

Generated with `crypto.randomUUID()` only after all four fingerprints matched. These are random binding identifiers, not secrets, and they carry no account data.

| Purpose | UUID |
| --- | --- |
| Authority ID | `ce298942-e550-44f2-8566-b45ea813d01c` |
| Account binding, lane A | `6da67cea-ef88-4093-94b8-54b39c1b1ea2` |
| Account binding, lane B | `49c0e5bf-478c-4752-ab23-89f7e8b64626` |
| Account binding, lane C | `417c2d6d-edce-4811-bcb2-5567e6fbb683` |
| Account binding, lane D | `5f612820-7146-4757-abd0-3cbab41732ee` |

### Production timing, chosen 11:47 EDT

| Setting | Value | Basis |
| --- | --- | --- |
| Offer TTL | 15000 ms | Transport p99 of 79 ms leaves roughly 190x headroom, so an offer expires only when a client is genuinely gone rather than merely slow. |
| Renew interval | 30000 ms | Two renewals fit inside the deadline, so one lost renewal over a DERP hiccup does not drop a live lease. |
| Renew deadline | 120000 ms | Reclaims capacity from a dead client within two minutes while tolerating transient relay loss. |
| Terminal retention | 86400000 ms | Meets the protocol's 24-hour minimum for terminal records and the create retry horizon. |

Provider-duration p99 remains unmeasured and the live daemons cannot supply it: `/health` exposes only counters (`granted`, `released`, `expired`, `throttles`, `peakActive`, `peakQueued`, `peakOldestWaitMs`) with no per-permit duration histogram. The values above are therefore bounded by transport latency and the protocol minimum rather than by observed provider durations. Revisit the renew deadline if live operation shows leases being reclaimed from healthy clients.

Lane counters at 11:46 EDT for reference: 8791 granted 530 with no throttles; 8792 granted 957, 113 throttles, peak queue 6, peak wait 886 s; 8793 granted 3671, 100 throttles, peak queue 12, peak wait 1402 s; 8794 granted 493, 1 throttle. Lanes B and C carry the queueing pressure that shared capacity is meant to relieve.

### Installer dry run, 11:48 EDT

```sh
scripts/install-authority.sh --dry-run --home /tmp/authdry/home --output /tmp/authdry/out \
  --authority-id ce298942-… --account-binding-a 6da67cea-… --account-binding-b 49c0e5bf-… \
  --account-binding-c 417c2d6d-… --account-binding-d 5f612820-… \
  --offer-ttl-ms 15000 --renew-interval-ms 30000 --renew-deadline-ms 120000 \
  --terminal-retention-ms 86400000 --h1-release v0.2.0 \
  --h1-installed-build 7f3ce003252d272b6ce1f51033b4255c2bb4379f --h1-verified
```

Result: `authority artifacts are valid: four lintable, credential-free, immutable launchd definitions`. A first attempt failed with `H1 installed build does not match the immutable release` because `--h1-installed-build` requires the full 40-character commit of the `v0.2.0` tag, not the short form.

The four staged plists contain no credential material. Each carries only lane environment values (`CLAUDE_PERMIT_GATE_PORT`, provider, authority ID, account binding, the four timing values, `CLAUDE_PERMIT_GATE_DAEMON_MODE=authority`, state directory, and build ID), `RunAtLoad`, `KeepAlive` on unsuccessful exit, and an absolute node path with the release directory as the working directory. Bearer tokens reach the daemon only through Keychain lookup at runtime.

### Tailnet grant

`deploy/tailscale/permit-authority-grant.hujson.example` no longer carries the unresolved peer placeholder. It now names `albert-aviary-mac` at 100.100.166.117 alongside `ruminaider` at 100.103.181.53, granting only those two sources access to `ruminaider:8791-8794`. Applying it still requires auditing the existing Tailnet policy for broader rules that would already match these ports.

### Credential provisioning, Ruminaider side, 11:55-12:05 EDT

Installation ID for Ruminaider is `4463bb9d-9bb5-4dc7-b4de-23e8f2af6f6e`. Three scoped credentials are live, each valid until 1795621871141 (90 days) and allowlisted for all four lanes:

| Scope | Token ID | Keychain item | Verifier digest |
| --- | --- | --- | --- |
| `permit:mutate` | `ruminaider-permit-mutate-2026-08-27b` | `claude-permit-authority-permit-mutate/ruminaider` | `46b47af2…` |
| `snapshot:read` | `ruminaider-snapshot-read-2026-08-27b` | `claude-permit-authority-snapshot-read/ruminaider` | `88864cde…` |
| `allowance:publish` | `ruminaider-allowance-publish-2026-08-27b` | `claude-permit-authority-allowance-publish/ruminaider` | `570e324c…` |

Verified for all three: the Keychain value matches the client bearer pattern `<tokenId>.<43-char base64url>`, its token ID matches the enrolled record, and the SHA-256 of its decoded 32-byte secret equals the stored verifier. Secrets passed only through standard input and never touched argv, an environment variable, a file, or output.

Two implementation facts cost a first attempt and are worth carrying forward:

1. `scripts/authority-admin.mjs enroll` writes the raw 32-byte secret to Keychain, but `index.ts` requires the composed `<tokenId>.<secret>` bearer. Provisioning must write the composed value itself after enrolling.
2. `security add-generic-password -w` with piped standard input stores an empty value rather than reading the pipe. Use `security -i`, which reads the whole command from standard input, so the secret still avoids argv.

The first attempt therefore enrolled three verifiers whose secrets were never recoverable. Those tokens (`…-2026-08-27`, without the `b` suffix) are revoked and remain in the store as revoked records. Because `enroll` rejects a second record for the same installation and scope even when the earlier record is revoked, and `rotate` refuses a revoked predecessor, recovery required a fresh installation UUID. The original Ruminaider installation ID `0a78d101-2203-4203-a49c-090ec6ef7e9e` is burned and must not be reused. The verifier store is at generation 9 with 6 records, 3 revoked and 3 active.

### Credential provisioning, peer side, 12:05-12:20 EDT

Installation ID for albert-aviary-mac is `dad5f319-6001-4d90-aa8c-76129ea4ca02`. Three scoped credentials are live, same 90-day expiry and four-lane allowlist:

| Scope | Token ID | Keychain item | Verifier digest |
| --- | --- | --- | --- |
| `permit:mutate` | `aviary-permit-mutate-2026-08-27c` | `claude-permit-authority-permit-mutate/aviary` | `53eb933b…` |
| `snapshot:read` | `aviary-snapshot-read-2026-08-27c` | `claude-permit-authority-snapshot-read/aviary` | `3fc4d22e…` |
| `allowance:publish` | `aviary-allowance-publish-2026-08-27c` | `claude-permit-authority-allowance-publish/aviary` | `deaf6be9…` |

Verification ran on the peer and compared digests, never values: each item matches the client bearer pattern, carries the expected token ID, and its decoded secret hashes to the enrolled verifier.

#### Transport mechanism

macOS Keychain writes fail with `-25308 User interaction is not allowed` in any non-interactive SSH session, on both machines. This defeats two obvious designs: pushing the bearer to the peer over SSH, and having the peer invoke `enroll` on Ruminaider over SSH, because `enroll` itself writes a staging Keychain item before recording the verifier. The generic `authority-admin: rejected` message hides this; the real error appears only when the top-level catch is bypassed.

The working design keeps every Keychain write inside a GUI session:

1. Ruminaider creates a mode-600 FIFO at `/tmp/permit-pipe`.
2. The peer's GUI Terminal, driven by `osascript` over SSH, runs `ssh albertgwo@100.103.181.53 cat /tmp/permit-pipe | security -i`.
3. Ruminaider's GUI-derived session generates the secret, enrolls the verifier, deletes the staging item, and writes the composed `add-generic-password` command into the FIFO.

The secret exists only in pipes on both machines. Ruminaider's Remote Login and the peer's authorized key make step 2 possible; the peer's key was already present in Ruminaider's `authorized_keys`.

#### Burned credentials

Three generations of peer tokens are revoked in the store and must never be reused:

- `aviary-*-2026-08-27` (installation `d6c0f1cf`): enrolled before the SSH Keychain limitation was understood, secrets unrecoverable.
- `aviary-*-2026-08-27b` (installation `28d832df`): provisioned successfully, then exposed. A verification command printed each full bearer to a peer log file and to the session transcript. The values were revoked within a minute, `/tmp/verify-safe.log` and the other temporary logs were deleted, and the peer's Terminal windows were closed to clear scrollback.
- The Ruminaider `0a78d101` generation described above.

Verification must compare SHA-256 digests, never Keychain values. Digests are safe to print; bearers are not. The replacement verification script computes the digest on the peer and emits only `format`, `tokenId`, and `digest`.

Because `enroll` rejects a second record for the same installation and scope even after revocation, each recovery consumed a fresh installation UUID. The verifier store is at generation 26 with 6 active records and several revoked ones.

### Live authority cutover, Ruminaider, 12:32-12:35 EDT

The four A-D authority daemons are installed and live. Cutover ran detached (`scripts/cutover-ruminaider.sh`) because lane A carries the driving Pi session, which the swap terminates. Sequence: proved every lane idle twice two seconds apart, stopped the local daemons, bootstrapped four lane states offline, installed four immutable LaunchAgents, and added private Serve listeners on 8791-8794 one at a time. Existing Funnel routes on 8443 and 10000 were preserved byte-for-byte.

Authenticated health from both machines confirms one shared authority:

| Reader | Result |
| --- | --- |
| Ruminaider, all four lanes | HTTP 200, `status: ready`, authority `ce298942…`, protocol 2, state schema 2 |
| albert-aviary-mac, all four lanes over `https://ruminaider.tail252378.ts.net:<port>` | HTTP 200, `status: ready`, `active:0`, capacity 2 |

The peer reaching the authority over the tailnet with a 200 proves the Serve route, the stock allow-all grant, and the peer bearer together. An unauthenticated `/v1/health` correctly returns 401; the earlier all-null `/health` reading was that error body, not a broken daemon.

Three cutover-script defects were fixed live and committed: `setsid` is absent on macOS (use `nohup bash`), `bootstrap` requires the four timing variables exported (only the plists carried them), and re-runs must skip lanes that already have state. The installed release commit is `9067aed`.

### Client mode staging

Both machines are staged for authority-client mode but not yet cut over, because that needs a Pi restart:

- `~/.zshenv` on both machines exports `CLAUDE_PERMIT_GATE_MODE=authority-client`, the origin, and the config path. Backups saved as `~/.zshenv.bak-2026-08-27`.
- `~/.pi/agent/claude-permit-gate/authority-client.json` exists on both machines, mode 600, with the correct installation IDs (Ruminaider `4463bb9d…`, peer `dad5f319…`).

### Definition-of-done efficacy signal

The shared-capacity proof is a permit acquired on one Mac counting against the same account's capacity as seen by the other. Read it from either machine with an authenticated snapshot:

```sh
t=$(security find-generic-password -s claude-permit-authority-snapshot-read -a <ruminaider|aviary> -w)
curl -sS -H "authorization: Bearer $t" https://ruminaider.tail252378.ts.net:8791/v1/health | jq '{active,queued,currentConcurrency}'
```

With both Macs restarted into authority-client mode, driving traffic on both should show a single lane's `active` rising past what one Mac alone could reach, and never exceeding `maximumConcurrency`. This requires the client restart below and is not yet measured.

### Remaining: client restart (external dependency)

Restart every Pi process on both Macs so it loads authority-client mode. Interactive sessions must be restarted by their operator. After restart, `local` mode and the old per-Mac daemons are gone, and any temporary `CLAUDE_PERMIT_GATE_DISABLE` can be removed. Peer local daemons on 8790-8794 stop being respawned once peer Pi runs in authority-client mode; stop any leftovers after the peer restart.

## Still unmeasured

Provider-duration p99, claim p99 against live daemons, fsync cost under production-sized state, and two-Mac fairness. No timing or capacity conclusion should be inherited from the build phase.

## Open gates

Account identity fingerprints for lanes A-D have not been compared across machines and require both a valid access token per lane and explicit approval. Keychain provisioning, the Tailnet grant, lane daemon maintenance windows, LaunchAgent installation, Serve routes, and coordinated cutover all remain gated as recorded in the lane plan.
