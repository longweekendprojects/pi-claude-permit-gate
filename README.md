# pi-claude-permit-gate

A shared concurrency gate for native Anthropic Claude requests in [Pi](https://github.com/badlogic/pi-mono).

When several Pi sessions use the same Claude account, this extension queues direct provider requests before they reach Anthropic. Each configured provider has a local permit pool, so account lanes remain independent while requests on the same account stay within its shared concurrency limit.

## Install

Install an immutable release tag:

```bash
pi install git:github.com/longweekendprojects/pi-claude-permit-gate@v0.1.0
```

Start a new Pi session or run `/reload`, then inspect the local pools:

```text
/claude-permit
```

The extension starts each daemon on demand. It gates only configured Anthropic-family providers and leaves all other providers unchanged.

## What it does

- Binds current permit acquisition to the preflighted daemon instance and blocks provenance, provider, or protocol mismatches.
- Acquires one local permit before each mapped Anthropic provider request.
- Shares a fair, round-robin queue among local Pi sessions that use the same provider.
- Releases permits after a response, an agent exit, or session shutdown.
- Renews live permits and reclaims abandoned permits after the configured lease timeout.
- Backs off after Anthropic overloads or rate limits, then gradually restores concurrency.
- Keeps waiting if its daemon is unavailable, rather than sending an ungated request.

It does not proxy provider traffic, read credentials, register providers, select accounts, or modify provider payloads.

## Shared-authority protocol

The future authenticated, cross-machine authority has one normative owner: [Authority Protocol v1](docs/authority-protocol-v1.md) and its [machine-validatable schema](protocol/authority-v1.schema.json). This README intentionally does not duplicate authority DTOs, error codes, or retry rules.

The protocol is build-only until its documented H1, deployment, identity, timing, and approval gates are met. Validate its canonical fixtures without dependencies:

```bash
node scripts/validate-authority-contract.mjs
```

### Authority administration

`authority-admin.mjs` is a local-only operator tool. It creates lane state, enrolls or rotates verifier records, revokes one token or installation, drains or resumes a stopped lane, and reconciles one uncertain lease only after explicit approval. It never exposes these actions as HTTP routes.

Authority mode reads the shared owner-only verifier store at `~/Library/Application Support/Claude Permit Authority/verifiers-v1.json`. Each lane also requires its non-secret `CLAUDE_PERMIT_GATE_ACCOUNT_BINDING_ID`; every request body must match that lane binding.

Bearer secrets are accepted only from standard input. The tool pipes the value directly to macOS Keychain with `security add-generic-password ... -w` as the final prompted option, writes only SHA-256 verifiers to disk, and emits no secret value. Do not pass a bearer value through an argument, environment variable, file, log, or fixture.

```bash
# The generator and admin process exchange the bearer only through a pipe.
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' | \
  node scripts/authority-admin.mjs enroll \
    --installation-id <installation-uuid> \
    --scope permit:mutate \
    --lanes anthropic-a,anthropic-b,anthropic-c,anthropic-d \
    --token-id <opaque-token-id> \
    --keychain-service <keychain-service> \
    --keychain-account <keychain-account> \
    --expires-at-epoch-ms <expiry-epoch-ms>

# Rotation retains one predecessor/successor verifier overlap with the same owner, role, and lanes.
node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' | \
  node scripts/authority-admin.mjs rotate \
    --old-token-id <old-opaque-token-id> \
    --new-token-id <new-opaque-token-id> \
    --keychain-service <keychain-service> \
    --keychain-account <keychain-account> \
    --expires-at-epoch-ms <expiry-epoch-ms>
```

The lane-state commands require the four explicit authority timing variables from the normative protocol. They refuse a running listener or launchd-owned lane and reserve the loopback port while they operate. `bootstrap` only creates a missing state file. `reconcile` requires a state backup, one uncertain ticket ID, and `--approve-uncertain-reconciliation`; it is the only path that can emit `operator_reconciled`.

```bash
node scripts/authority-admin.mjs bootstrap --provider anthropic-a
node scripts/authority-admin.mjs drain --provider anthropic-a
node scripts/authority-admin.mjs resume --provider anthropic-a
node scripts/authority-admin.mjs revoke --installation-id <installation-uuid>
node scripts/authority-admin.mjs reconcile --provider anthropic-a --ticket-id <uncertain-ticket-uuid> --backup-path <new-backup-path> --approve-uncertain-reconciliation
```

These commands are build artifacts, not authorization to access a live Keychain, state store, daemon, or launchd job. Follow the protocol's deployment and maintenance gates before using them outside a temporary test home.

## Provider pools

The default mapping supports Pi's built-in Anthropic provider and four account-lane aliases:

| Provider | Port |
| --- | ---: |
| `anthropic` | 8790 |
| `anthropic-a` | 8791 |
| `anthropic-b` | 8792 |
| `anthropic-c` | 8793 |
| `anthropic-d` | 8794 |

Override the complete provider map when your provider names or ports differ:

```bash
export CLAUDE_PERMIT_GATE_PROVIDER_PORTS='anthropic:8790,anthropic-a:8791,work-claude:8900'
```

Only providers in this map are gated. Every Pi process that should share a pool must use the same mapping.

## Configuration

The daemon reads its settings when it first starts. Each pool defaults to two concurrent requests, starts at two, backs off no lower than one, caps a throttle cooldown at one minute, and reclaims unrenewed permits after five minutes.

| Variable | Default | Purpose |
| --- | ---: | --- |
| `CLAUDE_PERMIT_GATE_DISABLE` | `0` | Set to `1` to bypass the extension for one process. |
| `CLAUDE_PERMIT_GATE_PROVIDER_PORTS` | default map above | Comma-separated `provider:port` entries. |
| `CLAUDE_PERMIT_GATE_MAX` | `2` | Maximum concurrent requests in a pool. |
| `CLAUDE_PERMIT_GATE_START` | `2` | Initial pool concurrency. |
| `CLAUDE_PERMIT_GATE_MIN` | `1` | Minimum concurrency after a throttle. |
| `CLAUDE_PERMIT_GATE_COOLDOWN_MS` | `20000` | Default throttle cooldown. |
| `CLAUDE_PERMIT_GATE_MAX_COOLDOWN_MS` | `60000` | Hard cooldown ceiling. |
| `CLAUDE_PERMIT_GATE_INCREASE_AFTER_MS` | `120000` | Quiet period before concurrency rises. |
| `CLAUDE_PERMIT_GATE_PERMIT_TTL_MS` | `300000` | Time without a renewal before a permit is reclaimed. Set to `0` to disable reclaiming. |
| `CLAUDE_PERMIT_GATE_RATE_LIMIT_COOLDOWN_MS` | `20000` | Cooldown requested after a rate-limit response. |
| `CLAUDE_PERMIT_GATE_OVERLOADED_COOLDOWN_MS` | `60000` | Cooldown requested after an overload response. |
| `CLAUDE_PERMIT_GATE_ACQUIRE_RETRY_MS` | `500` | Delay between failed acquire attempts. |
| `CLAUDE_PERMIT_GATE_ACQUIRE_WARNING_ATTEMPTS` | `600` | Failed attempts before the blocked request reports a diagnostic. |
| `CLAUDE_PERMIT_GATE_SPAWN_BACKOFF_MS` | `1000` | Initial delay before retrying a failed daemon launch. |
| `CLAUDE_PERMIT_GATE_MAX_SPAWN_BACKOFF_MS` | `30000` | Maximum retry delay for a failed daemon launch. |
| `CLAUDE_PERMIT_GATE_VERBOSE` | `0` | Set to `1` for permit-grant notifications. |

Account-lane installations can retain `CLAUDE_LANE_A_*` through `CLAUDE_LANE_D_*` settings for each lane's `MIN`, `MAX`, `START`, `COOLDOWN_MS`, `MAX_COOLDOWN_MS`, `INCREASE_AFTER_MS`, and `PERMIT_TTL_MS` values. The initial release also honors matching legacy `ANTHROPIC_PERMIT_GATE_*` names while migrating to `CLAUDE_PERMIT_GATE_*`.

`CLAUDE_PERMIT_GATE_PROVIDER_PORTS`, `CLAUDE_PERMIT_GATE_DISABLE`, retry settings, and throttle settings are read when Pi loads the extension. Restart Pi after changing them. The daemon reads its own concurrency settings when it starts. Normal request handling and this package's commands never terminate a daemon.

### Approved idle replacement

A legacy daemon may remain usable until a separately approved maintenance window. During that window, an operator handles one daemon at a time: confirm that its health is legacy, observe `active === 0` and `queued === 0` twice at least two seconds apart, restart only that eligible daemon, then verify that its replacement reports the expected provider, protocol `1`, and schema version `3`. If work or queueing returns, defer that daemon. This package intentionally provides no termination command.

## Operations

`/claude-permit` is the doctor surface for every configured pool. It reports health schema, protocol, reported provider, daemon age, and a compatibility status alongside occupancy. Raw health is also available locally:

```bash
curl http://127.0.0.1:8791/health
```

New daemons retain `version: 3` and add `protocolVersion: 1`, the provider supplied through `CLAUDE_PERMIT_GATE_PROVIDER`, and a random UUID `instanceId`. Health and successful `/acquire` responses report the same instance identity. `startedAt` is an ISO-8601 timestamp with fractional seconds, such as `2026-01-02T03:04:05.678Z`; the doctor parses it to report daemon age.

Compatibility is fail closed at the acquire boundary:

- `current` means `ok: true`, the expected provider, protocol `1`, and a valid `instanceId`.
- `legacy` means `ok: true` but a provider, protocol, or instance identity field is absent. It remains usable when it has a stable `startedAt`, and is labeled “restart when idle.”
- `incompatible` means an explicit provider differs or an explicit protocol is unsupported. It never receives `/acquire`.
- `invalidOrUnavailable` means malformed, unavailable, or non-OK health. It never receives `/acquire` and acquisition retries until Esc cancels it.

For current health, the client sends the expected instance identity, provider, and protocol with `/acquire`. The daemon rejects a different expectation, and the client accepts a permit only when the response matches its preflight. For legacy health, the client re-probes after a grant and accepts it only when the stable `startedAt` is unchanged; otherwise it releases the permit and retries.

The daemon writes its log under:

```text
~/.pi/agent/claude-permit-gate/permit-daemon.log
```

## Limitations

The gate coordinates only local Pi processes. It cannot prevent Anthropic-side outages or enforce a limit across machines. A configured daemon port is unauthenticated and reachable by any process on the local machine, so another local user or service can occupy a permit or request a cooldown. Queue fairness is per Pi session in this release; subagent fanout can therefore gain additional scheduling turns.

The gate persists active leases and cooldown state before a graceful daemon restart. A replacement daemon conservatively counts restored leases until clients renew or release them, so it does not grant overlapping permits. An unclean machine crash remains bounded only by the five-minute lease timeout. Legacy compatibility requires a valid, stable `startedAt`; a legacy owner without one remains blocked because a grant cannot be safely tied to its preflight. The gate remains pending while it restores an unavailable daemon, unless the user presses Esc to cancel that waiting request. Failed launches back off per port and report the daemon diagnostic after the configured warning threshold.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm test
```

The tests use isolated ports and temporary home directories. They cover bounded concurrency, session-level round-robin scheduling, throttle ordering and cooldown caps, lease renewal and reclamation, graceful shutdown, provider mapping, payload preservation, and fail-closed acquisition recovery.

## License

MIT
