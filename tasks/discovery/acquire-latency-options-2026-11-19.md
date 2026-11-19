# Acquire latency options (2026-11-19)

## Summary
1. First, cache the Keychain token in the client. A no-poll acquire runs `/usr/bin/security` 3 times (once more per poll); a cache with a re-read on 401 saves about 195 ms per acquire and works against any server.
2. Second, one authority release with two changes: mark the committed state as validated, and trim allowance replays to the newest 8 per installation. Measured offline, one mutation drops from 52 ms to 33 ms, and a burst of 16 queued mutations from 451 ms mean latency to 260 ms.
3. Third, poll faster only at the queue head and skip the ledger write on an unchanged poll (client-only). Granting the lease in the create response through an opt-in header is the largest saving (about 0.7 s on the 65% of acquires that find a free slot) but changes lease behaviour, so it goes last.
4. Do not build long-poll, move allowancePublishes to its own file, lower RETRY_MS globally, or make the server grant without client opt-in.
5. Offline numbers come from an Apple M5 Max. The authority host looks about 2.2 times slower on the CPU passes (inferred from the 2026-11-18 figures), and how much of the 598/610 ms POST means is queueing is not measured.

Nothing live was contacted. Benchmarks ran in temp directories with no listeners, called `openAuthorityState` and `createAuthorityClient` directly, and cleaned up. `npm test` was not run.

## 1. The acquire path

### Client (index.ts)
Entry: `pi.on("before_provider_request")` (index.ts:447) calls `acquireAuthority` (index.ts:410), which waits for any earlier lifecycle and then calls `client.acquire` (index.ts:374), `tracedAcquire` (373) and `acquireOne` (359).

Running the real client against a fake authority gave this sequence for a free slot: `token > GET /v1/health > token > POST /v1/tickets > token > POST /v1/tickets/*/claim`, with 4 ledger mutations.

| # | Await | Where | Cost |
|---|---|---|---|
| 1 | `await health(provider, signal)` | 359, 332 | one token read plus one GET round trip; the health span exists in acquire-timing.jsonl but I do not have its value |
| 2 | `await token(config.keychain.permitMutate)` inside `send` | 329, 315, 260 | execs `/usr/bin/security`; about 65 ms each (your figure); runs before every request |
| 3 | `await loadOrCreate(provider)` | 359, 328 | ledger mutation 1 |
| 4 | `await reconcileOperation(...)` | 360 | no I/O when nothing is pending |
| 5 | `await createTicket(...)`: token, then POST /v1/tickets | 362, 353 | 598 ms mean (your figure) |
| 6 | `await save(record)` after create | 353, 324 | ledger mutation 2 |
| 7 | `await operation(provider, record, "claim", ...)`: `await save(record)` | 363, 334 | ledger mutation 3 (persists the operation id) |
| 8 | token, then POST claim | 335, 331, 329 | 610 ms mean (your figure) |
| 9 | `await save(record)` after claim | 335 | ledger mutation 4 |

- Each ledger mutation (`defaultLedgerMutator`, index.ts:270) takes a lock directory, reads, writes a temp file, fsyncs the file, renames, fsyncs the directory, and removes the lock. It cost 8 ms here; the 2026-11-18 note measured 21-39 ms under load.
- When the lane is full the loop runs `else { if (trace) trace.polls++; await wait(RETRY_MS, signal); await get(provider, record, signal); }` (index.ts:363). Each poll is a 500 ms wait, a token read, a GET, and a ledger write, because `get` always ends with `record.ticket = result; await save(record); return result;` (index.ts:333). The real cycle is therefore about 700 ms, not 500.
- With 2 polls the measured sequence had 5 token reads; test/acquire-timing.test.mjs:43 asserts exactly that (`line.spans.token.n, 5`).
- After the permit is held, renewal runs on a timer (index.ts:410, 375): token, POST renew, 2 ledger writes. With a 30 s renew interval that is one renewal about every 15 s.
- Completion (`release`, index.ts:419; `complete`, 380) is awaited in `message_end` (index.ts:450): token, POST complete, 3 ledger writes. It is outside the measured acquire but is paid on every request.

### Authority HTTP layer (permit-daemon.mjs)
Create is handled at lines 244-252; claim, renew, complete and cancel at 254-265.
1. `await authorityPrincipal(...)` (82): reads and validates the verifier store (85), authenticates the bearer (90), observes the generation (93). Measured 0.2 ms with 27 verifier records.
2. `await authorityRequestBody(req)` (246, 256): reads the body before queueing.
3. `await serializeAuthorityMutation(() => authority.createTicket(...))` (248, 191-195): one mutation at a time per lane. The 1 s reconcile timer uses the same queue (297-304).
4. GET ticket (238-243) is not queued. It calls `authority.getTicket`, which runs `_validateCurrent()` (authority-state.mjs:1762).
5. GET health (227-231) authenticates and counts tickets; it does not validate the state.

### Authority state (authority-state.mjs)
`createTicket` (1705) and `mutateTicket` (1766) both go through `_transition` (1677):
- `this._validateCurrent()` (1681): a whole-state validation of the current state.
- `const next = clone(this.state)` (1682): a whole-state `structuredClone`.
- `mutate(next, now)` (1684): under 1 ms. Create runs `scheduleOffers(next, transitionNow, ...)` then `ticket.createResponse = ticketPublic(next, ticket)` (1752-1753), so a free slot is already returned as `offered` by the create. There is no separate offer step.
- `await this._commit(next, verifyGeneration)` (1685, 1653):
  - `_assertStoredHeader()` (1632): one stat on the fast path (1636).
  - `withAuthorityVerifierFence(...)` (1668, 549): a host-wide lock shared by all four lanes. It opens a unix socket (560), creates the lock file with a file fsync and a directory fsync (565), and when another lane holds it, sleeps 25 ms and retries for up to 3 s (572, constants at 34-35).
  - Inside the fence: verifier recheck, `validateState(next, this.configuration)` (1661), then `writeDurableJson` (1663, 1137), which does `JSON.stringify` (1146), file fsync (1148), rename, directory fsync (1156).
  - Fence release (578): another directory fsync.
  - `this.state = next` (1674).
- Claim is the branch at 1781; renew at 1801; complete is the final branch and calls `scheduleOffers`. Each ends with `rememberOperation` (1826).

## 2. Where the per-mutation time goes (measured offline)
Method: the repository's own `openAuthorityState`, `createTicket`, `mutateTicket` and `publishAllowance` built the state. The run used the verifier fence, a verifier recheck, the production flags `--max-semi-space-size=2` and `MallocSpaceEfficient=1`, and Node 25.9.0. The state was 2,120,528 bytes: 250 tickets (226 released, 16 active, 8 queued) and 1,398 replay records from 6 installations (1,167 kB). Timing values were assumed from scripts/cutover-ruminaider.sh:23-26 (15 s offer, 30 s renew interval, 120 s renew deadline). Phase boundaries came from the `runtimeFaultInjector` hooks.

One mutation, median ms (create, claim, renew, complete and publish are all within 2 ms of each other):

| Phase | v0.4.23 | (b) no redundant validate | (a) replays trimmed to 8 | (a)+(b) |
|---|---|---|---|---|
| validate current + clone + mutate | 14.3 | 4.0 | 4.5 | 2.0 |
| fence acquire | 8.7 | 8.7 | 9.3 | 9.6 |
| verifier recheck + validate next | 10.9 | 11.0 | 3.2 | 3.4 |
| stringify + write + file fsync | 9.0 | 8.9 | 6.5 | 7.1 |
| dir fsync + fence release | 9.0 | 9.0 | 9.2 | 10.1 |
| **total (p90)** | **52 (55)** | **42 (44)** | **33.4 (42)** | **33 (36)** |
| GET right after a mutation | 10.4 | 0 | 2.7 | 0 |
| 16 simultaneous renewals, mean / last | 451 / 869 | 358 / 676 | 314 / 607 | 260 / 490 |

A second baseline run at the end gave 53.8 ms, so drift was small.

Single whole-state passes, median ms:

| Pass | 2.47 MB, 1,398 replays | 1.17 MB, 96 replays | 0.93 MB, 0 replays |
|---|---|---|---|
| validateState | 9.8 | 2.6 | 1.8 |
| structuredClone | 3.5 | 1.5 | 1.2 |
| JSON.stringify | 3.1 | 0.7 | 1.0 |
| canonical (slow path only, not per mutation) | 6.4 | 3.4 | 2.8 |
| open + write | 0.7 | 0.4 | 0.4 |
| file fsync | 5.0 | 3.4 | 3.7 |
| directory fsync | 3.8 | 3.9 | 3.6 |

An empty fence acquire and release costs 13.8 ms.

What this shows:
- **Validation runs twice per mutation.** The commit validates `next` (1661) and swaps it in (1674); the next transition or GET validates the same object again, because `_validateCurrent` only skips when `this._validatedState === this.state` (1622-1625).
- **Replays are the dominant cost inside validation.** Each replay is parsed and canonicalised three times per pass (860, 865, 956). 1,398 replays take validation from 2.6 ms to 9.8 ms, and it runs twice.
- **allowancePublishes costs about 19 ms of the 52 ms (36%).**
- **About 23 ms is fixed file work**: five fsyncs and the fence. I would not touch it.

Scaling to the authority host is a hypothesis. The 2026-11-18 note gives 42 ms clone and 34 ms stringify at 12.8 MB, about 2.2 times slower per MB than this machine. That suggests roughly 85 ms per mutation there now and roughly 37 ms after (a)+(b).

## 3. Options, smallest and safest first

### 1. (c) Cache the token in the client: do it
- **Change:** index.ts `createAuthorityClient`, the `token` wrapper (315) and `send` (329). Keep the last token in memory for about 60 s. On a 401, clear it, read the Keychain again and retry that request once.
- **Saving:** 3 x 65 = 195 ms per no-poll acquire, 22% of the 0.89 s median. Caching only within one acquire keeps one read and saves 130 ms. A polled acquire has 3 + polls reads. Renew and complete each save 65 ms too.
- **Scope:** client-only. Old and new clients work with old and new servers.
- **Risk:** a rotated or revoked token. The 401 re-read covers it; a 401 is raised before any state change, and the bodies are idempotent. Without the re-read, a stale token would fail a request with `request rejected`.
- **Detect:** with `acquire-timing.on`, `spans.token.n` drops from 3 or more to 0 or 1. Watch for sessions failing with `request rejected`.
- **Roll back:** repin to v0.4.23 in pi-dotfiles and reload sessions.

### 2. (b) Remove the redundant validation: do it
- **Change:** authority-state.mjs, add `this._validatedState = next;` after `this.state = next;` at 1674 (`_commit`) and at 1598 (`observeVerifierGeneration`). `next` was validated at 1661 or 1584 and is not changed afterwards.
- **Saving:** 52 to 42 ms per mutation here (19%), and 10.4 ms to 0 for the first GET after each mutation. Two mutations sit on the acquire path, so about 20 ms direct here and about 40 ms on the authority host (hypothesis). Burst mean drops 21%.
- **Scope:** server-only. No protocol or state change, so all client versions work.
- **Risk:** in-memory damage to the committed state between commits is no longer caught at the next request. It is still caught when the next commit validates its clone.
- **Detect:** a degraded lane exits and restarts; laneTerm and instanceId change in lane-samples.jsonl.
- **Roll back:** `scripts/install-authority.sh --rollback-lane anthropic-<x>`. The state file is unaffected.

### 3. (a) Trim allowance replays to the newest 8 per installation: do it, in the same release as (b)
- **Why it is safe to trim:** the prober sends a fresh id on every publish (`publishId: crypto.randomUUID()`, scripts/allowance-prober.mjs:258) every 90 s, so it never replays an old one.
- **Why the state stays large today:** trimming only touches the publishing installation (authority-state.mjs:1857-1863), so an installation id that stopped publishing keeps 256 records for good.
- **Change:** in `publishAllowance` (1831), replace the per-principal trim at 1857-1863 with a trim of every installation's records to the newest 8, ordered by the `publisherSequence` inside the stored fingerprint.
- **Do not lower the constant at line 22.** `validateState` throws when `count > MAX_ALLOWANCE_REPLAYS_PER_INSTALLATION` (954). A lower bound would make every lane refuse to start on today's state.
- **Saving:** 52 to 33.4 ms per mutation here (36%); state 2.12 MB to 0.97 MB; burst mean down 30%, or 42% with (b). Direct: about 37 ms per acquire here, about 75 ms on the authority host (hypothesis). If queueing is what lifts the POST means from 130-260 ms idle to about 600 ms, the saving is nearer 290 ms per no-poll acquire (hypothesis).
- **Scope:** server-only. v0.4.23 opened the trimmed state and ran 80 mutations on it in the benchmark, so rollback reads it. New code reads old state because the bound stays at 256.
- **Risk:** the trim must keep, for each installation, the record with the highest sequence (963) and the record matching the current allowance (965). If it does not, the commit degrades the lane on every publish. Ordering by sequence guarantees both.
- **Risk:** a retried publish older than 8 records gets `409 stale_revision` instead of a replay. The in-repo prober cannot send one.
- **Detect:** within 90 s of install the lane file shrinks and the prober log shows `publish HTTP 200`. A lane restart loop shows as laneTerm changes.
- **Roll back:** the same rollback command. Trimmed records are not restored and are not needed.
- **Not recommended:** moving allowancePublishes to its own file. `stateKeys()` is checked exactly, so it needs a schema migration and breaks rollback.

### 4. (d) Poll faster only at the queue head, and skip the ledger write on an unchanged poll: do it after 1-3
- **Change:** index.ts:363, wait about 150 ms when `ticket.queueAhead === 0`, otherwise RETRY_MS. In `get` (333), call `save(record)` only when the revision or state changed.
- **Saving:** the offer is seen after about 130 ms on average instead of about 350 ms, so about 220 ms per polled acquire, or 77 ms across all acquires. The slot also sits idle that much less.
- **Scope:** client-only; works with any server.
- **Risk:** about three times more GETs from one head ticket per lane. That is cheap once (b) is live; before (b), a GET after a mutation runs a 10 ms validation on the lane's only thread. `queueAhead` is first-in-first-out position, not fairness order, so the head is likely but not certain to be next.
- **Detect:** `offerToSeenMs` in acquire-timing.jsonl falls; the GET count per acquire rises.
- **Roll back:** repin the client.
- **Not recommended:** lowering `CLAUDE_PERMIT_GATE_ACQUIRE_RETRY_MS`. RETRY_MS is also the floor for 429/503 backoff (index.ts:274-275) and the local daemon retry.

### 5. Cache the health check for 30-60 s: optional, measure first
This was not on your list.
- **Change:** index.ts:359, skip `health()` when the same provider passed within the window.
- **Saving:** one GET round trip (0.1-0.3 s) on about two of three acquires at one request per 19 s. Read the `GET /v1/health` span from acquire-timing.jsonl before deciding.
- **Scope:** client-only.
- **Risk:** a wrong authority id is noticed up to a minute late. A draining lane changes from an immediate error to waiting on 503, which matches the lesson that every 503 is retried, but it is a behaviour change.
- **Tests that pin the count:** test/acquire-timing.test.mjs:42 (`GET /v1/health` n = 1) and the test at source-policy.test.mjs:516.

### 6. (e) Grant in the create response when a slot is free: largest saving, schedule after 1-3 are measured
- **Change, client:** `defaultAuthorityRequest` (index.ts:271) sends a header such as `x-permit-claim-on-offer: 1` on POST /v1/tickets. No other client change is needed; the unmodified client accepted an `active` create response in the benchmark and held the permit after 2 round trips.
- **Change, server:** permit-daemon.mjs:244-252 passes the flag; `createTicket` (authority-state.mjs:1705) applies the claim assignments (1781-1792) when the ticket is `offered` after `scheduleOffers` (1752).
- **Why a header, not a body field:** an old server rejects unknown body fields with a non-retryable 400 (`assertExactObject` at 1381 and 632) and rejects queries (permit-daemon.mjs:224). It ignores unknown headers.
- **Saving:** the whole claim step: 610 ms mean + 65 ms token + 2 ledger writes, about 0.7 s on 65% of acquires, or about 0.45 s off the 2.40 s mean. It also removes one of about four mutations per request from the lane queue.
- **Scope:** both. An old client on a new server sends no header and behaves as today. A new client on an old server gets `offered` and claims as today.
- **Risk:** a client that dies or aborts while the create is in flight leaves an active lease. It is reclaimed after two renew deadlines (240 s with the assumed timing) instead of the 15 s offer expiry. `cleanupAbortedAcquire` returns early when the record has no ticket (index.ts:345).
- **Risk:** whether Tailscale serve passes the header is not verified; if it is stripped, the client falls back to today's path.
- **Detect:** `POST /v1/tickets/*/claim` disappears from the timing spans; watch `uncertain` in lane health.
- **Roll back:** an env switch on the client to stop sending the header, or the server rollback. The old server reads a state whose create response is `active` (hypothesis from reading `validatePublicTicket`; add a test).
- **Not recommended:** the server granting without opt-in. It works by code reading but changes every running session at once with no client-side off switch.

### 7. (f) Long-poll: do not do it
- It holds connections open through the proxy, and shutdown waits for the listener to close (permit-daemon.mjs:330), so held polls would turn clean restarts into the 10 s timeout and exit 1.
- lessons.md already records a wedge from stalled sockets and a fairness loss from connection-owned waiting.
- The gain is about half a poll cycle on 35% of acquires, and option 4 gets most of it in a few client lines.

## 4. Tests for the top options

**(c) Token cache.** Existing coverage: test/acquire-timing.test.mjs (line 43 asserts 5 token reads for a two-poll acquire) and the authority-client tests in test/source-policy.test.mjs from line 89.
- Change line 43 to expect 1. It fails without the cache.
- New in source-policy.test.mjs: a counting `token` stub, where one acquire plus renew plus complete reads it once.
- New: the fake authority answers 401 `unauthenticated` once after a rotation; the client rereads, retries the same body once and succeeds.
- New: a second 401 surfaces the error instead of looping.

**(a) Replay trim.** Existing coverage: test/permit-daemon.test.mjs:1199 ("authority persists allowance scope, skew, replay, and accepted truth across restart") and :1229 for compaction.
- New: installation A publishes 12 times and B 3 times; expect 8 and 3 records. Today it gives 12.
- New: B holds 256 records and never publishes again; one publish from A trims B to 8.
- New: `gate.restart()` succeeds after the trim.
- New: A's latest publish id still replays; a trimmed id returns `stale_revision`.
- New: a state with 256 records per installation still opens.
- New: two publishes in the same millisecond keep the higher sequence.

**(b) Redundant validation.** Existing coverage: the authority tests in test/permit-daemon.test.mjs (376, 392, 785, 1026).
- New: after `await authority.createTicket(...)`, replace `allowancePublishes` on `authority.state` with a counting getter, call `authority.getTicket(...)`, and assert zero reads. Today `validateState` reads it. A simpler form asserts `authority._validatedState === authority.state` after a commit.
- Keep the stale-term and ownership tests at 1026 green; they prove a foreign writer is still caught.

## Not verified
- Authority-host timings; all per-mutation numbers are from an M5 Max.
- How the 598/610 ms POST means split between network, service time, lane queueing and waits on the shared fence.
- The health GET span and the ledger span in the real traffic.
- Whether the Pi runtime reuses TLS connections. `defaultAuthorityRequest` uses the default agent (index.ts:271); if every request does a new handshake, an explicit keep-alive agent could save a round trip or more per request. Measure before changing.
- The production timing values; taken from scripts/cutover-ruminaider.sh.
- Why lane C holds about 1,400 replays. I assume three live probers plus retired installation ids; the state file was not read.