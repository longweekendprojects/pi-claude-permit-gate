import test from "node:test";
import assert from "node:assert/strict";
import { acquireAuthority } from "../index.ts";

// Pi cancels a pending cache refresh when the next real request starts. A cancelled refresh gets
// no response, so a permit it already holds must not make the real request wait forever.
test("a real request preempts a cache refresh that holds the permit", async () => {
  let completed = 0;
  const client = { acquire: async () => ({ provider: "anthropic-b", ticket: { lease: {} } }), complete: async () => { completed++; }, renew: async () => {}, cancel: async () => {}, abandon: async () => {} };
  const ctx = { ui: { setStatus: () => {}, notify: () => {} } };
  assert.equal(await acquireAuthority(ctx, client, "anthropic-b", undefined, true), "acquired");
  const real = acquireAuthority(ctx, client, "anthropic-b", undefined, false);
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("real request stayed blocked")), 2000).unref());
  assert.equal(await Promise.race([real, timeout]), "acquired");
  assert.equal(completed, 1, "the refresh permit is released, not left to renew");
});
