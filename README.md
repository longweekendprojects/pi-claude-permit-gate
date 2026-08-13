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

- Acquires one local permit before each mapped Anthropic provider request.
- Shares a fair, round-robin queue among local Pi sessions that use the same provider.
- Releases permits after a response, an agent exit, or session shutdown.
- Renews live permits and reclaims abandoned permits after the configured lease timeout.
- Backs off after Anthropic overloads or rate limits, then gradually restores concurrency.
- Keeps waiting if its daemon is unavailable, rather than sending an ungated request.

It does not proxy provider traffic, read credentials, register providers, select accounts, or modify provider payloads.

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
| `CLAUDE_PERMIT_GATE_VERBOSE` | `0` | Set to `1` for permit-grant notifications. |

Account-lane installations can retain `CLAUDE_LANE_A_*` through `CLAUDE_LANE_D_*` settings for each lane's `MIN`, `MAX`, `START`, `COOLDOWN_MS`, `MAX_COOLDOWN_MS`, `INCREASE_AFTER_MS`, and `PERMIT_TTL_MS` values. The initial release also honors the matching legacy `ANTHROPIC_PERMIT_GATE_*` names while migrating to `CLAUDE_PERMIT_GATE_*`.

After changing daemon settings, stop the affected local daemon. The next mapped request starts it with the new configuration:

```bash
pkill -TERM -f 'pi-claude-permit-gate/permit-daemon.mjs'
```

## Operations

Use `/claude-permit` for a compact view of every configured pool. Raw health is also available locally:

```bash
curl http://127.0.0.1:8791/health
```

The daemon writes its log under:

```text
~/.pi/agent/claude-permit-gate/permit-daemon.log
```

## Limitations

The gate coordinates only local Pi processes. It cannot prevent Anthropic-side outages or enforce a limit across machines. A configured daemon port is unauthenticated, so any process under the same local user can occupy a permit or request a cooldown. Queue fairness is per Pi session in this release; subagent fanout can therefore gain additional scheduling turns.

The gate remains pending while it restores an unavailable daemon. This protects the concurrency limit but means a blocked request needs a healthy local port to resume.

## Development

Requires Node.js 22 or newer.

```bash
npm ci
npm test
```

The tests use isolated ports and temporary home directories. They cover bounded concurrency, session-level round-robin scheduling, throttle ordering and cooldown caps, lease renewal and reclamation, graceful shutdown, provider mapping, payload preservation, and fail-closed acquisition recovery.

## License

MIT
