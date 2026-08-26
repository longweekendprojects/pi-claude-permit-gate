# Claude Permit Authority Protocol v1

**Status:** Normative implementation contract for shared authority protocol 2. The machine-readable companion is [`../protocol/authority-v1.schema.json`](../protocol/authority-v1.schema.json). This document and that schema are the only protocol owners. READMEs, monitor fixtures, and implementation tests must link to or validate them rather than restating DTOs.

This contract defines the future shared authority for lanes A-D. It does not authorize deployment, Tailnet changes, Keychain writes, daemon replacement, or a second-Mac cutover.

## Scope and compatibility

- `daemonMode=local` preserves the frozen H1 protocol-1 held-request service. It keeps the version-3 `/health` contract, current/legacy provenance checks, occupied-port exit code `3`, `/claude-permit` doctor behavior, and no automatic daemon termination.
- `daemonMode=authority` exposes only authenticated protocol 2. Tailscale Serve must never front a local-mode daemon.
- `clientMode=local` is the default. `CLAUDE_PERMIT_GATE_ORIGIN`, `CLAUDE_PERMIT_GATE_AUTHORITY_CONFIG`, and every authority-only setting must be absent. Their presence is a startup error.
- `clientMode=authority-client` requires complete authority configuration before any Pi hook registers. It has no loopback probe, daemon spawn, or local fallback capability.
- `monitorSource=local|authority` selects display truth. An authority source never reads loopback permit state or presents unaccepted local allowance as authority truth.

Shared operation uses `clientMode=authority-client` on both Macs, including the authority host. The authority is one loopback daemon per lane on ports 8791 through 8794. This service schedules direct provider requests; it never proxies Anthropic traffic or centralizes OAuth credentials.

## Conformance

Implementations must conform to this document and the schema together.

- Structural JSON is validated against the named `$defs` in the schema. Objects reject unknown keys unless a field is explicitly nullable.
- All integers are JavaScript-safe integers from `0` through `9007199254740991`. Timestamps are integer epoch milliseconds unless the field name ends in `EpochSeconds`.
- The contract validator validates canonical fixtures, their SHA-256 digests, cross-field timing and retry rules, and a fixed fixture clock. It is dependency-free and deterministic.
- Schema response fixtures use a normalized contract-header object. HTTP runtimes may add transport headers such as `Date`, but must not omit or alter the named contract headers.

## Transport and authentication

All authority requests use HTTPS, UTF-8 JSON, `Content-Type: application/json`, and `Cache-Control: no-store`. Request bodies are at most 16 KiB and responses are at most 64 KiB. The authority rejects malformed JSON and unknown JSON keys.

Every authenticated request has this header:

```text
Authorization: Bearer <tokenId>.<base64url-32-byte-secret>
```

`tokenId` is an opaque ASCII identifier. The secret is exactly 32 bytes encoded as unpadded base64url. The token value enters from Keychain at runtime and never appears in configuration, command arguments, logs, response bodies, state snapshots, or fixtures.

Each installation has distinct Keychain tokens for `permit:mutate`, `snapshot:read`, and `allowance:publish`. The authority stores only a SHA-256 verifier plus token ID, immutable installation ID, scope, lane allowlist, generation, issue and expiry times, predecessor, and revocation metadata. Authentication derives the machine identity from that verifier. A body `installationId` that conflicts with the authenticated installation fails before lookup or mutation.

## Authority-client configuration

`CLAUDE_PERMIT_GATE_MODE` is `local|authority-client` and defaults to `local`. Authority-client mode requires `CLAUDE_PERMIT_GATE_ORIGIN` and `CLAUDE_PERMIT_GATE_AUTHORITY_CONFIG`.

The origin is exactly `https://<dns-host>`: no credentials, port, path, query, or fragment. Existing provider ports are appended to this origin. The non-secret, mode-0600 config conforms to `AuthorityClientConfigV1` and contains:

- schema version, mode, origin, expected authority UUID, and stable random installation UUID;
- Keychain service/account references for the three scopes;
- `monitorSource` and `publisherEnabled`; and
- exact A-D provider entries with fixed authority ports and account-binding UUIDs.

Environment and file origin, mode, and port mapping must agree. Invalid, incomplete, or mismatched configuration blocks hook registration. `authority-client` does not infer a local mode and never creates a local recovery path.

## Common response rules

Successful ticket representations are `TicketV1` and always have every nullable key present. They include `ETag: "revision-<n>"`. A first create returns `201` with `Location: /v1/tickets/<ticketId>`; a replayed successful create or mutation returns `200` with `Idempotency-Replayed: true` and the original representation.

Every error body is `ErrorV1`:

```json
{"schemaVersion":1,"error":{"code":"error_code","message":"redacted","retryable":false,"retryAfterMs":null}}
```

Messages are redacted ASCII text at most 160 characters. Error codes, status mapping, and retry behavior are closed:

| HTTP status | Codes | Retry contract |
| --- | --- | --- |
| 400 | `invalid_json`, `invalid_request`, `unsupported_schema` | Never retryable. |
| 401 | `unauthenticated` | Never retryable. |
| 403 | `forbidden_scope`, `forbidden_lane` | Never retryable. |
| 404 | `not_found` | Never retryable. Another principal's opaque ID also returns this response. |
| 409 | `provider_mismatch`, `authority_mismatch`, `account_binding_mismatch`, `stale_revision`, `invalid_transition`, `operation_conflict` | Never retryable. |
| 429 | `principal_limit`, `lane_limit` | Retryable and includes integer-seconds `Retry-After` and an equal `retryAfterMs` value. |
| 503 | `authority_starting`, `authority_draining`, `authority_degraded`, `persistence_unavailable`, `verifier_unavailable` | Retryable only when both `Retry-After` and matching `retryAfterMs` are supplied. |

A matching millisecond value is an exact multiple of 1,000 equal to `Retry-After * 1000`.

## Health and snapshot DTOs

`GET /v1/health` requires an authenticated token authorized by the verifier and returns `AuthorityHealthV1` when a trusted response is available. A successful health or snapshot response has status `ready`, `draining`, or `degraded`; `starting` uses its required `503 authority_starting` error instead. Health contains only the schema and protocol versions, stable authority ID, lane term, process instance UUID, build ID, state schema version, server time, qualified status, provider, port, capabilities, and aggregate `active`, `offered`, `uncertain`, `queued`, `currentConcurrency`, `maximumConcurrency`, `cooldownUntilEpochMs`, and `oldestWaitEpochMs` fields.

`GET /v1/snapshot` requires `snapshot:read` and returns `LaneSnapshotDTOv1`. It carries the same authority provenance, exact lane/provider/port identity, safe aggregate permit fields, and `allowance`. An allowance is either all null before an authority-accepted observation or has an observation time plus nullable 5-hour and 7-day windows. A window is exactly:

```json
{"utilization":0,"status":null,"resetEpochSeconds":1}
```

`status` is null or one of `allowed`, `allowed_warning`, `rejected`, `active`, `warning`, or `rate_limited`. Empty local status normalizes to null. Freshness, age, severity, and post-reset display truth remain monitor concerns.

Neither endpoint may expose `bySession`, installation/session/request/ticket/lease IDs, account bindings or fingerprints, token/verifier data, OAuth or profile values, paths, request or response headers/bodies, or raw errors.

## Ticket endpoints and DTOs

All ticket endpoints require `permit:mutate`. The canonical endpoint/body contract is:

| Endpoint | Request body | Result |
| --- | --- | --- |
| `POST /v1/tickets` | `TicketCreateRequestV1` | First create returns `201 TicketV1`; a matching retry returns its original `200 TicketV1`. |
| `GET /v1/tickets/:ticketId` | None | Returns the owner/lane ticket or owner-hidden `404`. |
| `POST /v1/tickets/:ticketId/claim` | `TicketClaimOrCancelRequestV1` | One revision compare-and-set changes `offered` to `active`; provider traffic may start only after this response. |
| `POST /v1/tickets/:ticketId/cancel` | `TicketClaimOrCancelRequestV1` | Changes only `queued|offered` to `cancelled`. `active|uncertain` returns `409 invalid_transition` and keeps capacity. |
| `POST /v1/tickets/:ticketId/renew` | `TicketRenewRequestV1` | Acknowledges the matching lease generation and sequence; it may restore `uncertain` to `active` without allocating another slot. |
| `POST /v1/tickets/:ticketId/complete` | `TicketCompleteRequestV1` | Frees capacity once. A throttle outcome changes adaptive concurrency and cooldown once. |

A create body contains exactly schema version, provider, account-binding UUID, installation UUID, opaque session UUID, opaque request UUID, and `createdAtEpochMs`. A new create timestamp must be within 30 seconds of server time. The idempotency key is `(authenticated installation, provider, requestId)`. A known retry remains readable; terminal records remain at least 24 hours and through the create retry horizon, and a compacted old timestamp cannot recreate work.

A claim/cancel body contains exactly schema version, operation UUID, expected revision, installation UUID, provider, and account-binding UUID. Renew adds lease UUID, lease generation, and next renew sequence. Complete adds lease UUID and generation, `outcome` (`released|throttled`), `reason` (null for release or `assistant_rate_limit|assistant_overloaded`), and an optional non-negative safe-integer `cooldownMs` only for throttling.

`TicketV1` always has these keys: `schemaVersion`, `ticketId`, `requestId`, `provider`, `state`, `revision`, `createdAtEpochMs`, `enqueuedAtEpochMs`, `offeredAtEpochMs`, `offerExpiresAtEpochMs`, `terminalAtEpochMs`, `terminalReason`, `queueAhead`, and `lease`. `queueAhead` is only an owner-visible non-negative estimate and never a session list.

The closed ticket states are `queued`, `offered`, `active`, `uncertain`, `cancelled`, `released`, `throttled`, and `offerExpired`. `LeaseV1` is non-null only for `active|uncertain` and contains exactly `leaseId`, `generation`, `claimedAtEpochMs`, `renewSequence`, `renewByEpochMs`, and `serverDeadlineEpochMs`. The server deadline transitions a lease to `uncertain`; it never automatically frees capacity.

Duplicate operation IDs return the original result. Reusing an operation ID for a different operation returns `409 operation_conflict`. Claim, cancel, renew, and complete serialize through revision compare-and-set.

## Retry and ordering rules

Network loss, `429`, and retryable `503` reuse the same request or operation ID with capped jittered backoff. `400`, `401`, `403`, and identity or binding mismatches fail closed. A stale revision triggers one authenticated GET before selecting the next legal transition.

A lost create response retries create with the same request ID. For a lost claim, renew, cancel, or complete response, the client GETs the ticket first and retries the same operation ID only when stored state does not already contain that result. No later provider request starts until the preceding ticket completion is acknowledged.

## Authority operational states

`AuthorityHealthV1.status` is `starting|ready|draining|degraded`.

- **starting:** The listener is bound but migration, term commit, verifier validation, or readiness checks are incomplete. Health and every other route return retryable `503 authority_starting`.
- **ready:** Authenticated routes operate normally.
- **draining:** Only offline administration enters this state. One durable transaction cancels queued/offered tickets with `authority_draining`. New creates, claims, publishes, and offers return `503 authority_draining`; authenticated GET, cancel retries, renew, and complete remain available. It remains draining after counts reach zero until offline `resume` or replacement. Resume requires state, verifier, timing, and persistence checks.
- **degraded:** State, verifier, config, persistence, or term failures enter this state. Trusted authenticated health/snapshot reads may remain available only when both verifier and last committed state are trustworthy; otherwise all routes return generic `503`. It performs no ticket, lease, allowance, drain, or resume mutation. Recovery requires successful revalidation and explicit offline resume or restart, never an empty-state reset.

## Fairness, limits, and retention

The scheduler persists FIFO within a session, a session cursor within each authenticated installation, and a machine cursor within the lane. One eligible machine receives one offer before another turn while another machine remains eligible. Session IDs are random per loaded Pi process and never enter shared output.

The fixed v1 limits are:

- 32 authenticated installation principals per authority and 32 live sessions per principal;
- 16 nonterminal tickets per session, 64 per principal, and 256 per lane;
- 4,096 retained ticket/tombstone records per lane and 32 retained operation results per ticket;
- effective `currentConcurrency` and `maximumConcurrency` from 1 through 64, with `active + offered + uncertain <= currentConcurrency <= maximumConcurrency`;
- UUID/string fields at most 64 ASCII characters and redacted error messages at most 160 ASCII characters;
- finite allowance utilization from 0 through 1,000, reset seconds from 1 through 253402300799, and observed timestamps no more than 30 seconds in the future; and
- publisher queues capped at 64 pending snapshots per provider and 256 per installation. Newer unsent same-provider observations supersede older unsent observations but never remove an in-flight ID.

A principal/session limit returns `429 principal_limit`. A full lane queue returns `429 lane_limit`. A full retained ledger that cannot compact without violating replay retention returns `503 persistence_unavailable` and stops creates instead of deleting safety records.

## Timing and durable authority state

Authority mode has no production timing defaults. LaunchAgent generation requires measured explicit integer milliseconds:

| Setting | Range and invariant |
| --- | --- |
| `CLAUDE_PERMIT_GATE_OFFER_TTL_MS` | 5,000-120,000; greater than measured DERP claim p99 plus margin. |
| `CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS` | 5,000-300,000. |
| `CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS` | 15,000-3,600,000; at least three renew intervals and greater than measured provider-duration p99 plus DERP jitter margin. |
| `CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS` | At least 86,400,000. |

Test-only values stay under temporary HOME and ports and never enter plist templates. State records timing schema and digest. Offer deadlines retain their original value. New renew timing begins only after the next acknowledged renew. Timing changes require drain and restart; startup refuses a timing digest change while any ticket is offered, active, or uncertain.

The exclusive owner is the `127.0.0.1:<lane-port>` listening socket, held for the process lifetime. The authority parses non-secret config and verifier location, binds in `starting`, and exits code `3` on `EADDRINUSE` without changing state. While holding that socket it loads/bootstrap/migrates state, validates verifier/timing schemas, atomically increments and fsyncs `laneTerm`, generates and persists `ownerNonce`, then becomes ready.

Before every durable commit, it rereads the state header and requires matching authority ID, provider/port, lane term, and owner nonce. A mismatch fences the process into `degraded` before the write. Each transition writes a mode-0600 temporary file, fsyncs it, atomically renames it, and fsyncs the directory before acknowledgement. The complete lane state retains queue/cursors, tickets/revisions, operation results, leases, capacity/cooldown, replay ledger, allowance, timing digest, verifier generation, counters, term, and owner nonce.

Offline administration refuses state mutation while `lsof` sees a listener or launchd reports the lane running. Missing state requires explicit bootstrap. Corrupt, unknown, or unreadable state never becomes an empty scheduler. Graceful shutdown stops timers, flushes the final commit, and retains the socket until writers stop and exit; stale metadata is replaced only after a new term commits.

## Verifier store

All four authorities read one owner-only (`0600`) verifier store:

```text
~/Library/Application Support/Claude Permit Authority/verifiers-v1.json
```

The store conforms to `VerifierStoreV1`, has a monotonic generation, and contains verifier records only. Offline administration writes a complete temporary file, fsyncs it, atomically renames it, and fsyncs its directory. Every authenticated request reads and validates the current generation; every mutation rereads it immediately before durable commit. Unreadable, malformed, rolled-back, or generation-mismatched verifier state degrades and fails closed. Rotation permits bounded dual-verifier overlap. Revoking one installation never revokes another.

## Allowance publication and monitor truth

`POST /v1/allowance` requires `allowance:publish` and accepts exactly `AllowancePublishRequestV1`: schema version, installation UUID, provider, account-binding UUID, publish UUID, publisher sequence, observed-at milliseconds, and nullable 5-hour/7-day safe windows. Provider and lane derive from the token scope and must match the body. Duplicate publish IDs return the original result.

The authority rejects observations more than 30 seconds in the future and those more than 30 seconds older than stored. Within the 30-second cross-machine uncertainty window, later authority receipt wins while original observation time still drives freshness. Unknown or raw fields fail validation.

The monitor watches only `~/.pi/agent/usage-windows/<provider>.json`, validates the already-sanitized atomic file, and queues only this DTO. It never reads OAuth credentials, headers, or provider bodies. It retries while running and removes an item only after authority acknowledgement.

When `monitorSource=authority`, authority loss makes permit state unavailable immediately. The monitor may retain only the last authority-accepted allowance cache, label it last observed with authority unreachable, preserve original age, and retain awaiting-post-reset truth. It does not fall back to local permit health or unaccepted local allowance. Menu status polling remains open-menu-only; publisher traffic is file-event-driven and independent of menu visibility.

## Fixture and consumer workflow

Run the canonical validator from this repository:

```bash
node scripts/validate-authority-contract.mjs
```

It validates `test/fixtures/authority-v1/manifest.json`, all listed valid and invalid fixtures, every fixture hash, and the schema digest. A consumer can additionally compare a recorded digest:

```bash
node scripts/validate-authority-contract.mjs --digest-file /path/to/authority-v1.schema.sha256
```

The monitor is a digest-checked consumer. It may copy only fixtures necessary for strict decoding and must not become a second protocol owner.

## Deployment gates and residual safety limits

This contract is buildable without live changes. Shared deployment remains blocked until H1 is published, installed, and verified; legacy replacement has explicit maintenance approval plus two idle samples; L1 lifecycle regression remains green; authority timing is measured; account mappings and peer identity are verified; and Tailnet policy/Serve/private reachability are approved.

An already-started Anthropic request cannot be fenced. A missed renewal therefore becomes `uncertain` and continues consuming capacity until completion or approval-gated reconciliation. User LaunchAgents are unavailable while logged out. Keychain prompts/failures, clock skew, fsync performance, schema rollback, and unmeasured DERP/provider timing remain fail-closed deployment risks.
