import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquirePermitResponse, classifyDaemonHealth, createAuthorityClient, providerPorts, resolveClientMode } from "../index.ts";

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
  const current = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic", instanceId: "22222222-2222-4222-8222-222222222222" }, "anthropic");
  const recovered = await acquirePermitResponse(19000, { session: "test" }, "/unused", { request: async () => ++recoveryAttempts === 4 ? { permitId: "recovered", instanceId: "22222222-2222-4222-8222-222222222222", provider: "anthropic", protocolVersion: 1 } : {}, ensure: async () => { recoveryEnsures++; return { ...current, spawned: false }; }, wait: async () => {}, warningAfterAttempts: 3, onUnavailable: () => { warnings++; } });
  assert.equal(recovered.permitId, "recovered"); assert.equal(recoveryAttempts, 4); assert.equal(recoveryEnsures, 4); assert.equal(warnings, 2);
});

test("extension preserves provider payloads and owns one acquire hook", () => {
  assert.match(source, /await acquire\(ctx, directory, port, provider\); return undefined;/);
  assert.equal((source.match(/pi\.on\("before_provider_request"/g) || []).length, 1);
  assert.equal(source.includes("transformPayload"), false);
  assert.equal(source.includes("/renew"), true);
});

test("acquire preflights current and legacy health and blocks incompatible health", async () => {
  const currentInstanceId = "33333333-3333-4333-8333-333333333333";
  const current = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic-a", instanceId: currentInstanceId }, "anthropic-a");
  const legacyStartedAt = "2026-01-02T03:04:05.678Z";
  const legacy = classifyDaemonHealth({ ok: true, version: 1, startedAt: legacyStartedAt }, "anthropic-a");
  const swappedLegacy = classifyDaemonHealth({ ok: true, version: 1, startedAt: "2026-01-02T03:04:06.678Z" }, "anthropic-a");
  const incompatible = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic-b", instanceId: currentInstanceId }, "anthropic-a");
  const unsupportedProtocol = classifyDaemonHealth({ ok: true, protocolVersion: 2, provider: "anthropic-a", instanceId: currentInstanceId }, "anthropic-a");
  const invalidInstance = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic-a", instanceId: "not-a-uuid" }, "anthropic-a");
  const unavailable = classifyDaemonHealth(undefined, "anthropic-a");
  assert.equal(current.compatibility, "current"); assert.equal(legacy.compatibility, "legacy"); assert.equal(incompatible.compatibility, "incompatible"); assert.equal(unsupportedProtocol.compatibility, "incompatible"); assert.equal(invalidInstance.compatibility, "invalidOrUnavailable"); assert.equal(unavailable.compatibility, "invalidOrUnavailable");

  let currentAttempts = 0; const currentRequests = []; const currentReleases = [];
  const currentResponse = await acquirePermitResponse(19000, { provider: "anthropic-a" }, "/unused", {
    ensure: async () => ({ ...current, spawned: false }),
    request: async (pathname, payload) => {
      assert.equal(pathname, "/acquire"); currentRequests.push(payload); currentAttempts++;
      return currentAttempts === 1 ? { permitId: "wrong-current", instanceId: "44444444-4444-4444-8444-444444444444", provider: "anthropic-a", protocolVersion: 1 } : { permitId: "current", instanceId: currentInstanceId, provider: "anthropic-a", protocolVersion: 1 };
    },
    release: async (payload) => { currentReleases.push(payload); },
    wait: async () => {},
  });
  assert.equal(currentResponse.permitId, "current"); assert.equal(currentAttempts, 2); assert.deepEqual(currentRequests, [
    { provider: "anthropic-a", expectedInstanceId: currentInstanceId, expectedProvider: "anthropic-a", expectedProtocolVersion: 1 },
    { provider: "anthropic-a", expectedInstanceId: currentInstanceId, expectedProvider: "anthropic-a", expectedProtocolVersion: 1 },
  ]); assert.deepEqual(currentReleases, [{ permitId: "wrong-current" }]);

  let legacyEnsures = 0; let legacyRequests = 0; const legacyReleases = [];
  const legacyResponse = await acquirePermitResponse(19000, { provider: "anthropic-a" }, "/unused", {
    ensure: async () => { legacyEnsures++; return { ...(legacyEnsures === 2 ? swappedLegacy : legacy), spawned: false }; },
    request: async (pathname, payload) => { assert.equal(pathname, "/acquire"); assert.deepEqual(payload, { provider: "anthropic-a" }); legacyRequests++; return { permitId: legacyRequests === 1 ? "swapped-legacy" : "legacy" }; },
    release: async (payload) => { legacyReleases.push(payload); },
    wait: async () => {},
  });
  assert.equal(legacyResponse.permitId, "legacy"); assert.equal(legacyEnsures, 4); assert.equal(legacyRequests, 2); assert.deepEqual(legacyReleases, [{ permitId: "swapped-legacy" }]);

  for (const preflight of [incompatible, unavailable]) {
    const controller = new AbortController(); let requests = 0;
    const pending = acquirePermitResponse(19000, { provider: "anthropic-a" }, "/unused", { signal: controller.signal, ensure: async () => ({ ...preflight, spawned: false }), request: async () => { requests++; return { permitId: "must-not-be-returned" }; }, wait: async () => { controller.abort(); } });
    await assert.rejects(pending, { name: "AbortError" }); assert.equal(requests, 0);
  }
});

test("aborting an acquire destroys its queued request and stops retries", async () => {
  const controller = new AbortController(); let attempts = 0;
  const current = classifyDaemonHealth({ ok: true, protocolVersion: 1, provider: "anthropic", instanceId: "55555555-5555-4555-8555-555555555555" }, "anthropic");
  const pending = acquirePermitResponse(19000, { session: "test", provider: "anthropic" }, "/unused", { signal: controller.signal, request: async (_path, _body, signal) => { attempts++; return await new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })); }, ensure: async () => ({ ...current, spawned: false }), wait: async () => {}, retryMs: 1 });
  await new Promise((resolve) => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("authority-client rejects mixed configuration and resumes one acknowledged ticket without local capability", async () => {
  assert.throws(() => resolveClientMode({ CLAUDE_PERMIT_GATE_MODE: "local", CLAUDE_PERMIT_GATE_ORIGIN: "https://authority.example" }), /local mode cannot contain authority settings/);
  const config = {
    mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", statePath: "/unused/authority-client-tickets-v1.json",
    keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false,
    lanes: { "anthropic-a": { port: 8791, accountBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "anthropic-b": { port: 8792, accountBindingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "anthropic-c": { port: 8793, accountBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, "anthropic-d": { port: 8794, accountBindingId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
  };
  const calls = []; let ledger = { schemaVersion: 1, tickets: {} }; let requestId = "11111111-1111-4111-8111-111111111111"; const ticketId = "22222222-2222-4222-8222-222222222222";
  const ticket = (state, revision, lease = null) => ({ schemaVersion: 1, ticketId, requestId, provider: "anthropic-a", state, revision, lease });
  let poll = 0;
  const client = createAuthorityClient(config, {
    token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    readLedger: async () => structuredClone(ledger), writeLedger: async (next) => { ledger = structuredClone(next); }, wait: async () => {},
    request: async (request) => {
      calls.push(request);
      if (request.pathname === "/v1/health") return { status: 200, body: { schemaVersion: 1, protocolVersion: 2, authorityId: config.expectedAuthorityId, instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" } };
      if (request.pathname === "/v1/tickets") { requestId = request.body.requestId; return { status: 201, body: ticket("queued", 1) }; }
      if (request.pathname.endsWith("/claim")) return { status: 200, body: ticket("active", 2, { leaseId: "44444444-4444-4444-8444-444444444444", generation: 1, renewSequence: 0 }) };
      if (request.pathname.endsWith("/complete")) throw new Error("response lost");
      if (request.pathname.includes("/v1/tickets/")) return { status: 200, body: ticket(++poll === 1 ? "offered" : "released", poll === 1 ? 1 : 3) };
      throw new Error("unexpected authority request");
    },
  });
  const record = await client.acquire("anthropic-a");
  assert.equal(record.ticket.state, "active");
  await client.complete(record);
  assert.equal(calls.filter((call) => call.pathname === "/v1/tickets").length, 1);
  assert.equal(calls.filter((call) => call.pathname.endsWith("/complete")).length, 1);
  const create = calls.find((call) => call.pathname === "/v1/tickets");
  assert.equal(create.port, 8791); assert.equal(create.body.cwd, undefined); assert.match(create.authorization, /^token-id\./);
  const authorityClientSource = source.slice(source.indexOf("export function createAuthorityClient"), source.indexOf("async function acquireAuthority"));
  assert.doesNotMatch(authorityClientSource, /127\.0\.0\.1|spawn|fallback|ctx\.cwd/);
});
