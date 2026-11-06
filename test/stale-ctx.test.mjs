import test from "node:test";
import assert from "node:assert/strict";
import { acquireAuthority } from "../index.ts";

// Seen live: a session reloaded while its request waited for a shared permit, and the gate read the stale ctx.
test("a request whose session reloads while it waits for a permit ends as aborted", async () => {
  let stale = false; let grant; let cancelled = 0;
  const client = { acquire: () => new Promise((resolve) => { grant = resolve; }), cancel: async () => { cancelled++; }, complete: async () => {}, renew: async () => {}, abandon: async () => {} };
  const ctx = { ui: { setStatus: () => {}, notify: () => {} }, get signal() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return undefined; } };
  const waiting = acquireAuthority(ctx, client, "anthropic-b", undefined, false);
  await new Promise((resolve) => setImmediate(resolve));
  stale = true;
  grant({ provider: "anthropic-b", ticket: { lease: {} } });
  assert.equal(await waiting, "aborted");
  assert.equal(cancelled, 1, "the permit granted to the dead request is handed back");
});
