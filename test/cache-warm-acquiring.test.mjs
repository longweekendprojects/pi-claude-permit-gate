import test from "node:test";
import assert from "node:assert/strict";
import { acquireAuthority } from "../index.ts";

const within = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error("request stayed blocked")), 2000).unref())]);

// The deadlock seen live: the refresh was still acquiring when the real request arrived.
test("a refresh granted while a real request waits gives the permit up at once", async () => {
  let completed = 0; let grant;
  let pending = new Promise((resolve) => { grant = resolve; });
  const client = { acquire: () => pending ?? Promise.resolve({ provider: "anthropic-b", ticket: { lease: {} } }), complete: async () => { completed++; }, renew: async () => {}, cancel: async () => {}, abandon: async () => {} };
  const ctx = { ui: { setStatus: () => {}, notify: () => {} } };
  const refresh = acquireAuthority(ctx, client, "anthropic-b", undefined, true);
  const real = acquireAuthority(ctx, client, "anthropic-b", undefined, false);
  await new Promise((resolve) => setImmediate(resolve));
  pending = undefined; grant({ provider: "anthropic-b", ticket: { lease: {} } });
  assert.equal(await within(refresh), "acquired");
  assert.equal(await within(real), "acquired");
  assert.equal(completed, 1);

  // A request waiting behind a real permit still waits, but Esc now ends that wait.
  const controller = new AbortController();
  const waiting = acquireAuthority({ ...ctx, signal: controller.signal }, client, "anthropic-b", undefined, false);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(completed, 1, "a real permit is never preempted");
  controller.abort();
  assert.equal(await within(waiting), "aborted");
});
