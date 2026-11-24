# Changelog

## 0.4.33 - 2026-11-24

- Reject unexpected Host and Origin headers on local requests and require JSON on control POSTs.
- Let operators require a local token after upgrading daemons and reloading clients.
- Block Claude requests when a local provider-port map is invalid and report the bad entry.
