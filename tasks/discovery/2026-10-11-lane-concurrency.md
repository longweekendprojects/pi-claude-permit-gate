# Can lane A run more than 4 requests at a time? (2026-10-11)

Evidence:
- Lane sampler, 2026-10-09 16:16 to 2026-10-11 17:15 UTC, 35,073 samples at 5 s: lane A held concurrency at its maximum of 4 the whole time with no cooldown. Requests in use: 0 for 76%, 1 for 17%, 2 for 5%, 3 or 4 for 1.7%. A queue existed in 0.6% of samples, up to 28 waiting today.
- Pi session logs, last 14 days: no rate-limit (429) failures on any lane. Lane A had 3 overloaded (529) failures, the last at 2026-10-08 15:39:36.968Z. The lane recorded a throttle at 15:39:36.736Z, so the overload feedback loop works end to end.
- Lanes B to D have a maximum of 2. C and D were idle for the whole window; B peaked at 2.
- Anthropic documents no concurrency limit for subscription accounts. Public Claude Code issues (#53922, #44481, #60562) report an undocumented per-account throttle ("Server is temporarily limiting requests (not your usage limit)") at about 3 to 5 parallel streams, not scaling with plan tier.

Conclusion: 4 has never produced a rate limit, so its headroom is unknown. On a throttle, the scheduler drops one slot, cools down 20 to 60 s, and climbs back one slot per 30 s, so a higher ceiling self-corrects at the cost of one failed turn per throttle.

Decision (2026-10-11): keep lane A at 4. Revisit if rate-limit errors stay absent while queues grow, and spread agents across lanes B to D first.
