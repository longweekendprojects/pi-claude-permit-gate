# Shared authority build validation

Validated on 2026-08-27 at 03:50 EDT. This artifact covers buildable plan Tasks 1-9 only. It records no authority deployment or second-Mac cutover.

## Locked architecture

- Ruminaider owns one authority-mode process for each lane A-D on loopback ports 8791-8794.
- Both Macs use explicit `authority-client` mode. That mode constructs no loopback probe, daemon spawn, or local fallback path.
- Private Tailscale Serve terminates HTTPS on the lane ports. The service never uses Funnel or proxies Anthropic traffic.
- Each installation has separate Keychain-backed `permit:mutate`, `snapshot:read`, and `allowance:publish` credentials. The authority stores only verifiers and derives machine identity from the authenticated credential.
- Queue ownership is a durable ticket rather than an HTTP connection. Tickets move through queued, offered, active or uncertain, and terminal states with idempotent operations.
- Scheduling is round-robin by authenticated installation and then by opaque Pi session.
- Active work never auto-releases after a missed renewal because Pi cannot fence an already-started Anthropic request. It becomes uncertain and continues consuming capacity until acknowledged completion or approval-gated reconciliation.
- The menu publishes only the already-sanitized local allowance-file shape. The authority returns an identity-bound acknowledgement before the publisher deletes durable work.
- The shared menu reads the same strict `LaneSnapshotDTOv1` on both Macs. It labels local, shared-authority, unreachable, and last-authority-accepted states without falling back to local truth.

## Implemented repositories

### `pi-claude-permit-gate`

Validated implementation baseline: `cf7070c`.

Implemented:

- Canonical protocol document, JSON schema, digest-checked fixtures, and dependency-free validator.
- Durable schema-2 authority scheduler with reconnect-stable tickets, nested fairness, offer/claim, active and uncertain leases, exact-once completion/throttle, allowance persistence, atomic file and directory fsync, socket ownership, term fencing, corruption refusal, and restart recovery.
- Authority-wide bearer authentication, fixed-work verifier lookup, role/lane/owner binding, monotonic verifier generation, cross-process update fencing, rotation/revocation, and offline bootstrap/drain/resume/reconcile administration.
- Explicit local and authority-client Pi modes with HTTPS, Keychain reads, durable cross-process retry ledgers, strict TicketV1 decoding, cancellation cleanup, completion ordering, and no local fallback.
- Four-job LaunchAgent packaging, immutable build identity, template-backed plist generation, explicit production timing, dry-run isolation, transactional install/uninstall recovery, state-preserving rollback, and artifact validation.
- Redacted account-fingerprint and peer-readiness helpers with stdin-only token handling, curl configuration isolation, strict profile validation, bounded output/time, and forced child termination.
- A fail-closed private Tailnet policy template and artifact-only matrix for Ruminaider plus one unresolved operator-supplied peer.

### `pi-claude-lane-monitor`

Validated implementation baseline: `34d02ff`.

Implemented:

- Digest-pinned canonical authority fixtures with strict cross-repository validation in the normal test pipeline.
- Authenticated shared snapshot transport, strict DTO decoding, expected-authority checks, no-fallback source composition, authority-accepted allowance caching, and local H1 instance UUID parity.
- Event-driven sanitized allowance publication with explicit null encoding, durable publish IDs and sequences, bounded queueing, strict identity-bound acknowledgement validation, startup ingestion, watcher recovery, retry/restart behavior, and stop/in-flight cancellation.
- User-facing local/shared/offline/last-observed provenance in the menu title, tooltip, cards, refresh controls, and accessibility descriptions.
- Exactly three implemented Swift `@Test` methods remain.

## Automated validation

- `npm test`: 21/21 Node cases passed. All original 12 remain; nine shared-authority cases stay below the ten-case ceiling.
- `node scripts/validate-authority-contract.mjs`: 28 valid and 21 invalid fixtures passed; schema SHA-256 `d2bbd240177a87fd76bb1f3c89b69d0165cb32d6b39e3f3079fdb668bd2b6816`.
- Node and shell syntax checks passed for authority runtime, administration, installer, validator, fingerprint, peer, and artifact harness files.
- `test/authority-install-artifacts.sh`: passed its isolated dry-run, special-path, tamper, missing-state, bootstrap-failure, retry, rollback, uninstall, and cleanup matrix.
- Tailnet policy artifact validation passed the self/peer allow and same-user/other-member/public deny matrix without running Tailscale.
- `scripts/test.sh` in the monitor passed three consecutive runs; 3/3 Swift tests passed each time.
- `scripts/build-app.sh` passed release build, plist validation, ad-hoc signing, and strict signature verification.
- Both repositories pass `git diff --check` and have clean worktrees.
- `pi-dotfiles` usage producer files are unchanged.

## Live-state noninterference

- No authority LaunchAgent is installed.
- Tailscale Serve/Funnel JSON is byte-equivalent to the pre-build snapshot; existing 8443 and 10000 routes are unchanged.
- No Keychain item, Tailnet grant, remote, or second-Mac state changed.
- No live permit daemon was stopped or replaced.
- Live ports 8792-8794 remain schema-1 legacy daemons; 8790-8791 remain provenance-less schema-3 daemons. This is expected until approved maintenance.

## Deployment gates

Deployment Tasks 10-12 remain blocked on human authority and peer access:

1. Confirm `albert-aviary-mac.tail252378.ts.net` is the intended second Pi Mac.
2. Publish and install the immutable `v0.3.0` permit package so both Macs load the same build.
3. Obtain interactive access to the second Mac because Tailnet ping works but TCP 22 is refused.
4. Run the account fingerprint helper after each lane token is naturally valid or deliberately reauthenticated. A-D fingerprints must match across Macs before account-binding IDs are issued.
5. Create scoped Keychain credentials and the verifier store.
6. Measure DERP claim p99 and provider-duration p99, then set explicit offer and renewal timing.
7. Audit and approve the complete Tailnet policy. Replace the unresolved peer placeholder and prove authority-host self access before applying it.
8. Obtain maintenance approval. For each current daemon, observe `active=0` and `queued=0` twice at least two seconds apart before any stop.
9. Bootstrap each authority lane offline, install the four LaunchAgents, verify authenticated readiness, then add private Serve listeners one at a time.
10. Install/configure both clients, restart every Pi process that loaded old code, and prove the second Mac has no A-D listeners.
11. Run the two-Mac efficacy wave: central capacity never exceeds `currentConcurrency`; the same ticket survives DERP reconnect; machine/session fairness holds; both menus converge on one accepted allowance; unauthorized peers and invalid credentials fail before mutation.

## Rollback boundary

Rollback is fail-closed. Disable new acquisitions, drain central tickets, and obtain fresh explicit approval before restoring independent local scheduling. Never automatically fall back or start a second authority while shared tickets may be active or uncertain.
