import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquirePermitResponse, classifyDaemonHealth, providerPorts } from "../index.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = await fs.readFile(path.join(root, "index.ts"), "utf8");

test("default provider map gates built-in and four lane providers only", () => {
  assert.deepEqual(providerPorts(), { anthropic: 8790, "anthropic-a": 8791, "anthropic-b": 8792, "anthropic-c": 8793, "anthropic-d": 8794 });
  assert.deepEqual(providerPorts("anthropic-a:19001, custom:19002, invalid:0"), { "anthropic-a": 19001, custom: 19002 });
});

test("failed acquisition remains pending and later recovery returns a permit", async () => {
  let ensureCalls = 0; let warnings = 0; let transportCalls = 0; const never = new Promise(() => {});
  const unavailable = classifyDaemonHealth(undefined, "anthropic");
  const pending = (async () => { await acquirePermitResponse(19000, { session: "test", provider: "anthropic" }, "/unused", { request: async () => { transportCalls++; return {}; }, ensure: async () => { ensureCalls++; return { ...unavailable, spawned: false }; }, wait: async () => ensureCalls >= 3 ? never : undefined, warningAfterAttempts: 3, retryMs: 1, onUnavailable: (message) => { warnings++; assert.match(message, /provider request remains blocked/i); } }); })();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ensureCalls, 3); assert.equal(warnings, 1); assert.equal(transportCalls, 0);
  void pending;
  let recoveryAttempts = 0; let recoveryEnsures = 0;
  const current = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic" }, "anthropic");
  const recovered = await acquirePermitResponse(19000, { session: "test" }, "/unused", { request: async () => ++recoveryAttempts === 4 ? { permitId: "recovered" } : {}, ensure: async () => { recoveryEnsures++; return { ...current, spawned: false }; }, wait: async () => {}, warningAfterAttempts: 3, onUnavailable: () => { warnings++; } });
  assert.equal(recovered.permitId, "recovered"); assert.equal(recoveryAttempts, 4); assert.equal(recoveryEnsures, 4); assert.equal(warnings, 2);
});

test("extension preserves provider payloads and owns one acquire hook", () => {
  assert.match(source, /await acquire\(ctx, directory, port, provider\); return undefined;/);
  assert.equal((source.match(/pi\.on\("before_provider_request"/g) || []).length, 1);
  assert.equal(source.includes("transformPayload"), false);
  assert.equal(source.includes("/renew"), true);
});

test("acquire preflights current and legacy health and blocks incompatible health", async () => {
  const current = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic-a" }, "anthropic-a");
  const legacy = classifyDaemonHealth({ ok: true, version: 1 }, "anthropic-a");
  const incompatible = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic-b" }, "anthropic-a");
  const unsupportedProtocol = classifyDaemonHealth({ ok: true, protocolVersion: 2, provider: "anthropic-a" }, "anthropic-a");
  const unavailable = classifyDaemonHealth(undefined, "anthropic-a");
  assert.equal(current.compatibility, "current"); assert.equal(legacy.compatibility, "legacy"); assert.equal(incompatible.compatibility, "incompatible"); assert.equal(unsupportedProtocol.compatibility, "incompatible"); assert.equal(unavailable.compatibility, "invalidOrUnavailable");
  for (const preflight of [current, legacy]) {
    let requests = 0;
    const response = await acquirePermitResponse(19000, { provider: "anthropic-a" }, "/unused", { ensure: async () => ({ ...preflight, spawned: false }), request: async () => { requests++; return { permitId: preflight.compatibility }; }, wait: async () => {} });
    assert.equal(response.permitId, preflight.compatibility); assert.equal(requests, 1);
  }
  for (const preflight of [incompatible, unavailable]) {
    const controller = new AbortController(); let requests = 0;
    const pending = acquirePermitResponse(19000, { provider: "anthropic-a" }, "/unused", { signal: controller.signal, ensure: async () => ({ ...preflight, spawned: false }), request: async () => { requests++; return { permitId: "must-not-be-returned" }; }, wait: async () => { controller.abort(); } });
    await assert.rejects(pending, { name: "AbortError" }); assert.equal(requests, 0);
  }
});

test("aborting an acquire destroys its queued request and stops retries", async () => {
  const controller = new AbortController(); let attempts = 0;
  const current = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic" }, "anthropic");
  const pending = acquirePermitResponse(19000, { session: "test", provider: "anthropic" }, "/unused", { signal: controller.signal, request: async (_path, _body, signal) => { attempts++; return await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })); }, ensure: async () => ({ ...current, spawned: false }), wait: async () => {}, retryMs: 1 });
  await new Promise((resolve) => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(attempts, 1);
});
