# Token expiry outage, 2026-11-25

## Symptom
From 15:51 UTC every Pi session on ruminaider and aviary failed with `Extension ".../pi-claude-permit-gate/index.ts" error: request rejected`. The stack pointed at the health check that starts every acquisition. The allowance syncer, prober, and lane sampler logged HTTP 401 from the same moment. Albot kept working.

## Cause
`verifiers-v1.json` showed that every token issued on 2026-08-27, for ruminaider (`b4cc4ae9`, prober `e478e53b`) and aviary (`dad5f319`), had `expiresAtEpochMs` 2026-11-25T15:51:11Z, 90 days after issue. Albot's and the later "Mac" install's tokens were issued for a year. The authority refuses an expired token with 401, and its body always says "request rejected".

## Why recovery needed a code change
- `authority-admin.mjs rotate` refused an expired predecessor, and `enroll` refuses an installation that already holds a record for the scope. No command could restore an expired installation.
- The tool wrote the raw 32-byte secret to Keychain through a piped `security -w`, which stores an empty value. Clients need `<tokenId>.<secret>`.

## Fix (v0.4.37)
- `rotate` accepts an expired, unrevoked predecessor. A revoked one is still refused.
- The tool stores `<tokenId>.<secret>` through `security -i` and reads it back to confirm.
- A 401 now fails with "authority refused this machine's token ...", not "request rejected".

## Recovery performed
- Backup: `verifiers-v1.backup-20261125-expiry.json` beside the store.
- Rotated ruminaider's four tokens to `*-2026-11-25`, expiring 2027-11-25. All four lanes answered 200.
- Rotated aviary's three tokens. Keychain writes fail over SSH, so aviary's GUI Terminal, started with `osascript` over SSH, read the commands from a FIFO on ruminaider into `security -i`. Staging Keychain items on ruminaider were deleted. Aviary's check printed HTTP status codes only: all lanes and the snapshot returned 200.
- Restarted the lane sampler, exporter, and monitor on both Macs, because they read the token once at start. Pi sessions reread the token after a 401 and needed no restart.
- Lane tickets after 18:06Z show released permits from both installations.
