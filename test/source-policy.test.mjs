import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquirePermitResponse, providerPorts } from "../index.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = await fs.readFile(path.join(root, "index.ts"), "utf8");

test("default provider map gates built-in and four lane providers only", () => {
  assert.deepEqual(providerPorts(), { anthropic: 8790, "anthropic-a": 8791, "anthropic-b": 8792, "anthropic-c": 8793, "anthropic-d": 8794 });
  assert.deepEqual(providerPorts("anthropic-a:19001, custom:19002, invalid:0"), { "anthropic-a": 19001, custom: 19002 });
});

test("failed acquisition remains pending and later recovery returns a permit", async () => {
  let attempts = 0; let warnings = 0; let transportCalls = 0; const never = new Promise(() => {});
  const pending = (async () => { await acquirePermitResponse(19000, { session: "test" }, "/unused", { request: async () => { attempts++; return {}; }, ensure: async () => {}, wait: async () => attempts >= 3 ? never : undefined, warningAfterAttempts: 3, retryMs: 1, onUnavailable: () => { warnings++; } }); transportCalls++; })();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 3); assert.equal(warnings, 1); assert.equal(transportCalls, 0);
  void pending;
  let recoveryAttempts = 0;
  const recovered = await acquirePermitResponse(19000, { session: "test" }, "/unused", { request: async () => ++recoveryAttempts === 4 ? { permitId: "recovered" } : {}, ensure: async () => {}, wait: async () => {}, warningAfterAttempts: 3, onUnavailable: () => { warnings++; } });
  assert.equal(recovered.permitId, "recovered"); assert.equal(recoveryAttempts, 4); assert.equal(warnings, 2);
});

test("extension preserves provider payloads and owns one acquire hook", () => {
  assert.match(source, /await acquire\(ctx, directory, port, provider\); return undefined;/);
  assert.equal((source.match(/pi\.on\(\"before_provider_request\"/g) || []).length, 1);
  assert.equal(source.includes("transformPayload"), false);
  assert.equal(source.includes("/renew"), true);
});
