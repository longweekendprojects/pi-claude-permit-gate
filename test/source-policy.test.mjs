import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquirePermitResponse, classifyDaemonHealth, createAuthorityClient, defaultLedgerWriter, providerPorts, resolveClientMode } from "../index.ts";

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
  const canonicalTicket = (id, ticketRequestId, state, revision, lease = null) => { const active = state === "active" || state === "uncertain"; const offered = state === "offered" || active || state === "offerExpired"; const terminalReason = state === "cancelled" ? "client_cancelled" : state === "released" ? "released" : state === "throttled" ? "assistant_rate_limit" : state === "offerExpired" ? "offer_expired" : null; const terminal = terminalReason ? 2_000 : null; const defaultLease = active ? { leaseId: "44444444-4444-4444-8444-444444444444", generation: 1, claimedAtEpochMs: 1_100, renewSequence: 0, renewByEpochMs: 1_200, serverDeadlineEpochMs: 1_300 } : null; return { schemaVersion: 1, ticketId: id, requestId: ticketRequestId, provider: "anthropic-a", state, revision, createdAtEpochMs: 1_000, enqueuedAtEpochMs: 1_001, offeredAtEpochMs: offered ? 1_050 : null, offerExpiresAtEpochMs: offered ? 1_100 : null, terminalAtEpochMs: terminal, terminalReason, queueAhead: 0, lease: active ? { ...defaultLease, ...lease } : null }; };
  const calls = []; let ledger = { schemaVersion: 1, tickets: {} }; let requestId = "11111111-1111-4111-8111-111111111111"; const ticketId = "22222222-2222-4222-8222-222222222222";
  const ticket = (state, revision, lease = null) => canonicalTicket(ticketId, requestId, state, revision, lease);
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
  assert.equal(create.port, 8791); assert.equal(create.body.cwd, undefined); assert.equal(create.authorization, "Bearer token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

  const ledgerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "permit-ledger-")); const ledgerFile = path.join(ledgerDirectory, "authority-client-tickets-v1.json");
  try { await defaultLedgerWriter(ledgerFile)({ schemaVersion: 1, tickets: {} }); const stat = await fs.stat(ledgerFile); assert.equal(stat.mode & 0o777, 0o600); assert.deepEqual((await fs.readdir(ledgerDirectory)).sort(), ["authority-client-tickets-v1.json"]); } finally { await fs.rm(ledgerDirectory, { recursive: true, force: true }); }

  const lease = { leaseId: "55555555-5555-4555-8555-555555555555", generation: 1, claimedAtEpochMs: 1_100, renewSequence: 0, renewByEpochMs: 1_200, serverDeadlineEpochMs: 1_300 };
  const ticketFor = (id, ticketRequestId, state, revision, ticketLease = lease) => canonicalTicket(id, ticketRequestId, state, revision, ticketLease);
  const healthBody = { schemaVersion: 1, protocolVersion: 2, authorityId: config.expectedAuthorityId, instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" }; const storedRequestId = (currentLedger) => Object.values(currentLedger.tickets)[0].requestId;
  const oldRequestId = "66666666-6666-4666-8666-666666666666"; const oldTicketId = "77777777-7777-4777-8777-777777777777";
  let restartLedger = { schemaVersion: 1, tickets: { "anthropic-a": { provider: "anthropic-a", requestId: oldRequestId, sessionId: "88888888-8888-4888-8888-888888888888", createdAtEpochMs: 1, ticket: ticketFor(oldTicketId, oldRequestId, "active", 4), operation: { action: "complete", operationId: "99999999-9999-4999-8999-999999999999", additions: { leaseId: lease.leaseId, generation: 1, outcome: "released", reason: null } } } } };
  const restartCalls = []; const restarted = createAuthorityClient(config, { sessionId: "88888888-8888-4888-8888-888888888888", token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => structuredClone(restartLedger), writeLedger: async (next) => { restartLedger = structuredClone(next); }, wait: async () => {}, request: async (request) => { restartCalls.push(request); if (request.pathname === "/v1/health") return { status: 200, body: healthBody }; if (request.pathname === `/v1/tickets/${oldTicketId}`) return { status: 200, body: ticketFor(oldTicketId, oldRequestId, "released", 5, null) }; if (request.pathname === "/v1/tickets") return { status: 201, body: ticketFor("aaaaaaaa-0000-4000-8000-000000000000", request.body.requestId, "active", 1) }; throw new Error(`unexpected restart request ${request.pathname}`); } });
  const recovered = await restarted.acquire("anthropic-a"); assert.notEqual(recovered.requestId, oldRequestId); assert.equal(restartCalls.filter((entry) => entry.pathname === `/v1/tickets/${oldTicketId}`).length, 1); assert.equal(restartCalls.filter((entry) => entry.pathname.endsWith("/complete")).length, 0);

  let concurrentLedger = { schemaVersion: 1, tickets: {} }; let createCalls = 0; let completeReply; const completeGate = new Promise((resolve) => { completeReply = resolve; });
  const concurrent = createAuthorityClient(config, { token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => structuredClone(concurrentLedger), writeLedger: async (next) => { concurrentLedger = structuredClone(next); }, wait: async () => {}, request: async (request) => { if (request.pathname === "/v1/health") return { status: 200, body: healthBody }; if (request.pathname === "/v1/tickets") { createCalls++; return { status: 201, body: ticketFor(`aaaaaaaa-0000-4000-8000-00000000000${createCalls}`, request.body.requestId, "active", 1) }; } if (request.pathname.endsWith("/complete")) { await completeGate; return { status: 200, body: ticketFor(request.pathname.split("/")[3], request.body.requestId ?? storedRequestId(concurrentLedger), "released", 2, null) }; } throw new Error(`unexpected concurrent request ${request.pathname}`); } });
  const firstAcquire = concurrent.acquire("anthropic-a"); const secondAcquire = concurrent.acquire("anthropic-a"); const [firstRecord, sameRecord] = await Promise.all([firstAcquire, secondAcquire]); assert.strictEqual(firstRecord, sameRecord); assert.equal(createCalls, 1);
  const completion = concurrent.complete(firstRecord); await new Promise((resolve) => setImmediate(resolve)); const laterAcquire = concurrent.acquire("anthropic-a"); assert.equal(createCalls, 1); completeReply(); await completion; const laterRecord = await laterAcquire; assert.notEqual(laterRecord.requestId, firstRecord.requestId); assert.equal(createCalls, 2);

  for (const state of ["queued", "offered"]) { let abortLedger = { schemaVersion: 1, tickets: {} }; const controller = new AbortController(); const cleanupCalls = []; const aborted = createAuthorityClient(config, { token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => structuredClone(abortLedger), writeLedger: async (next) => { abortLedger = structuredClone(next); }, wait: async () => { controller.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); }, request: async (request) => { cleanupCalls.push(request); if (request.pathname === "/v1/health") return { status: 200, body: healthBody }; if (request.pathname === "/v1/tickets") return { status: 201, body: ticketFor("bbbbbbbb-0000-4000-8000-000000000000", request.body.requestId, state, 1, null) }; if (request.pathname.endsWith("/claim")) { controller.abort(); throw Object.assign(new Error("aborted"), { name: "AbortError" }); } if (request.pathname.includes("/v1/tickets/") && !request.pathname.endsWith("/cancel")) return { status: 200, body: ticketFor("bbbbbbbb-0000-4000-8000-000000000000", storedRequestId(abortLedger), state, 1, null) }; if (request.pathname.endsWith("/cancel")) { assert.equal(request.signal?.aborted, false); return { status: 200, body: ticketFor("bbbbbbbb-0000-4000-8000-000000000000", storedRequestId(abortLedger), "cancelled", 2, null) }; } throw new Error(`unexpected abort request ${request.pathname}`); } });
    if (state === "offered") await assert.rejects(aborted.acquire("anthropic-a", controller.signal), { name: "AbortError" }); else { const pending = aborted.acquire("anthropic-a", controller.signal); const rejected = assert.rejects(pending, { name: "AbortError" }); await new Promise((resolve) => setImmediate(resolve)); controller.abort(); await rejected; } assert.equal(cleanupCalls.filter((entry) => entry.pathname.endsWith("/cancel")).length, 1); assert.deepEqual(abortLedger.tickets, {}); }

  let cancelLedger = { schemaVersion: 1, tickets: { "anthropic-a": { provider: "anthropic-a", requestId: oldRequestId, sessionId: "88888888-8888-4888-8888-888888888888", createdAtEpochMs: 1, ticket: ticketFor(oldTicketId, oldRequestId, "queued", 1, null), operation: { action: "cancel", operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", additions: {} } } } }; const cancelOperations = [];
  const cancelledRecovery = createAuthorityClient(config, { sessionId: "88888888-8888-4888-8888-888888888888", token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => structuredClone(cancelLedger), writeLedger: async (next) => { cancelLedger = structuredClone(next); }, wait: async () => {}, request: async (request) => { if (request.pathname === "/v1/health") return { status: 200, body: healthBody }; if (request.pathname === `/v1/tickets/${oldTicketId}`) return { status: 200, body: ticketFor(oldTicketId, oldRequestId, "queued", 1, null) }; if (request.pathname.endsWith("/cancel")) { cancelOperations.push(request.body.operationId); return { status: 200, body: ticketFor(oldTicketId, oldRequestId, "cancelled", 2, null) }; } if (request.pathname === "/v1/tickets") return { status: 201, body: ticketFor("dddddddd-0000-4000-8000-000000000000", request.body.requestId, "active", 1) }; throw new Error(`unexpected cancel recovery request ${request.pathname}`); } });
  await cancelledRecovery.acquire("anthropic-a"); assert.deepEqual(cancelOperations, ["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);

  let staleLedger = { schemaVersion: 1, tickets: { stale: { provider: "anthropic-a", requestId: oldRequestId, sessionId: "88888888-8888-4888-8888-888888888888", createdAtEpochMs: 1, ticket: ticketFor(oldTicketId, oldRequestId, "active", 4) } } }; const staleCalls = [];
  const staleActive = createAuthorityClient(config, { sessionId: "88888888-8888-4888-8888-888888888888", token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => structuredClone(staleLedger), writeLedger: async (next) => { staleLedger = structuredClone(next); }, wait: async () => {}, request: async (request) => { staleCalls.push(request); if (request.pathname === "/v1/health") return { status: 200, body: healthBody }; if (request.pathname === `/v1/tickets/${oldTicketId}`) return { status: 200, body: ticketFor(oldTicketId, oldRequestId, "released", 5, null) }; if (request.pathname === "/v1/tickets") return { status: 201, body: ticketFor("eeeeeeee-0000-4000-8000-000000000000", request.body.requestId, "active", 1) }; throw new Error(`unexpected stale request ${request.pathname}`); } });
  const staleRecovered = await staleActive.acquire("anthropic-a"); assert.notEqual(staleRecovered.requestId, oldRequestId); assert.equal(staleCalls.filter((request) => request.pathname === `/v1/tickets/${oldTicketId}`).length, 1);

  const incomplete = createAuthorityClient(config, { token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => ({ schemaVersion: 1, tickets: {} }), writeLedger: async () => {}, request: async (request) => request.pathname === "/v1/health" ? { status: 200, body: healthBody } : { status: 201, body: { schemaVersion: 1, ticketId: oldTicketId, requestId: request.body.requestId, provider: "anthropic-a", state: "active", revision: 1, lease } } });
  await assert.rejects(incomplete.acquire("anthropic-a"), /authority create response is invalid/);

  // An authority host whose clock trails the client returns enqueuedAtEpochMs < createdAtEpochMs
  // within its accepted skew window; the client must accept it rather than loop on every acquire.
  const skewed = createAuthorityClient(config, { token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => ({ schemaVersion: 1, tickets: {} }), writeLedger: async () => {}, wait: async () => {}, request: async (request) => request.pathname === "/v1/health" ? { status: 200, body: healthBody } : { status: 201, body: { schemaVersion: 1, ticketId: "cccccccc-0000-4000-8000-000000000000", requestId: request.body.requestId, provider: "anthropic-a", state: "active", revision: 1, createdAtEpochMs: 5_000, enqueuedAtEpochMs: 4_997, offeredAtEpochMs: 5_050, offerExpiresAtEpochMs: 5_100, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease } } });
  const skewedRecord = await skewed.acquire("anthropic-a"); assert.equal(skewedRecord.ticket.state, "active"); assert.ok(skewedRecord.ticket.enqueuedAtEpochMs < skewedRecord.ticket.createdAtEpochMs);

  let activeAbortLedger = { schemaVersion: 1, tickets: {} }; const activeAbortController = new AbortController(); const activeAbortCalls = [];
  const activeAbort = createAuthorityClient(config, { token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => structuredClone(activeAbortLedger), writeLedger: async (next) => { activeAbortLedger = structuredClone(next); }, request: async (request) => { activeAbortCalls.push(request); if (request.pathname === "/v1/health") return { status: 200, body: healthBody }; if (request.pathname === "/v1/tickets") return { status: 201, body: ticketFor("ffffffff-0000-4000-8000-000000000000", request.body.requestId, "offered", 1, null) }; if (request.pathname.endsWith("/claim")) { activeAbortController.abort(); return { status: 200, body: ticketFor("ffffffff-0000-4000-8000-000000000000", storedRequestId(activeAbortLedger), "active", 2) }; } if (request.pathname.includes("/v1/tickets/") && !request.pathname.endsWith("/complete")) return { status: 200, body: ticketFor("ffffffff-0000-4000-8000-000000000000", storedRequestId(activeAbortLedger), "active", 2) }; if (request.pathname.endsWith("/complete")) { assert.equal(request.signal?.aborted, false); return { status: 200, body: ticketFor("ffffffff-0000-4000-8000-000000000000", storedRequestId(activeAbortLedger), "released", 3, null) }; } throw new Error(`unexpected active-abort request ${request.pathname}`); } });
  await assert.rejects(activeAbort.acquire("anthropic-a", activeAbortController.signal), { name: "AbortError" }); assert.equal(activeAbortCalls.filter((request) => request.pathname.endsWith("/complete")).length, 1); assert.equal(activeAbortCalls.filter((request) => request.pathname.endsWith("/cancel")).length, 0); assert.deepEqual(activeAbortLedger.tickets, {});

  const sharedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "permit-shared-ledger-")); const sharedConfig = { ...config, statePath: path.join(sharedDirectory, "authority-client-tickets-v1.json") }; let sharedCreates = 0;
  try { const sharedRequest = async (request) => { if (request.pathname === "/v1/health") return { status: 200, body: healthBody }; if (request.pathname === "/v1/tickets") { sharedCreates++; return { status: 201, body: ticketFor(`11111111-0000-4000-8000-00000000000${sharedCreates}`, request.body.requestId, "active", 1) }; } throw new Error(`unexpected shared request ${request.pathname}`); }; const firstProcess = createAuthorityClient(sharedConfig, { token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", request: sharedRequest }); const secondProcess = createAuthorityClient(sharedConfig, { token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", request: sharedRequest }); await Promise.all([firstProcess.acquire("anthropic-a"), secondProcess.acquire("anthropic-a")]); const persisted = JSON.parse(await fs.readFile(sharedConfig.statePath, "utf8")); assert.equal(sharedCreates, 2); assert.equal(Object.keys(persisted.tickets).length, 2); assert.equal(new Set(Object.keys(persisted.tickets)).size, 2); assert.ok(Object.keys(persisted.tickets).every((key) => key.includes(":"))); } finally { await fs.rm(sharedDirectory, { recursive: true, force: true }); }
  const authorityClientSource = source.slice(source.indexOf("export function createAuthorityClient"), source.indexOf("async function acquireAuthority"));
  assert.doesNotMatch(authorityClientSource, /127\.0\.0\.1|spawn|fallback|ctx\.cwd/);
});

test("authority-client discards retry state naming a ticket the authority no longer knows", async () => {
  const sessionId = "99999999-9999-4999-8999-999999999999";
  const config = {
    mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", statePath: "/unused/authority-client-tickets-v1.json",
    keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false,
    lanes: { "anthropic-a": { port: 8791, accountBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "anthropic-b": { port: 8792, accountBindingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "anthropic-c": { port: 8793, accountBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, "anthropic-d": { port: 8794, accountBindingId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
  };
  // A lane term change or a compacted reclaim leaves the persisted ticket unknown to the authority.
  const staleTicketId = "77777777-7777-4777-8777-777777777777";
  const staleRequestId = "88888888-8888-4888-8888-888888888888";
  let ledger = { schemaVersion: 1, tickets: { [`${sessionId}:${staleRequestId}`]: { provider: "anthropic-a", requestId: staleRequestId, sessionId, createdAtEpochMs: 1_000, ticket: { schemaVersion: 1, ticketId: staleTicketId, requestId: staleRequestId, provider: "anthropic-a", state: "active", revision: 5, createdAtEpochMs: 1_000, enqueuedAtEpochMs: 1_001, offeredAtEpochMs: 1_050, offerExpiresAtEpochMs: 1_100, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease: { leaseId: "44444444-4444-4444-8444-444444444444", generation: 1, claimedAtEpochMs: 1_100, renewSequence: 0, renewByEpochMs: 1_200, serverDeadlineEpochMs: 1_300 } } } } };
  const freshTicketId = "66666666-6666-4666-8666-666666666666";
  let freshRequestId; let staleLookups = 0; let creates = 0;
  const client = createAuthorityClient(config, {
    sessionId,
    token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    readLedger: async () => structuredClone(ledger), writeLedger: async (next) => { ledger = structuredClone(next); }, wait: async () => {},
    request: async (request) => {
      if (request.pathname === "/v1/health") return { status: 200, body: { schemaVersion: 1, protocolVersion: 2, authorityId: config.expectedAuthorityId, instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" } };
      if (request.pathname.includes(staleTicketId)) { staleLookups++; return { status: 404, body: { schemaVersion: 1, error: { code: "not_found", message: "ticket is unknown", retryable: false, retryAfterMs: null } } }; }
      if (request.pathname === "/v1/tickets") { creates++; freshRequestId = request.body.requestId; return { status: 201, body: { schemaVersion: 1, ticketId: freshTicketId, requestId: freshRequestId, provider: "anthropic-a", state: "active", revision: 2, createdAtEpochMs: 2_000, enqueuedAtEpochMs: 2_001, offeredAtEpochMs: 2_050, offerExpiresAtEpochMs: 2_100, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease: { leaseId: "55555555-5555-4555-8555-555555555555", generation: 1, claimedAtEpochMs: 2_100, renewSequence: 0, renewByEpochMs: 2_200, serverDeadlineEpochMs: 2_300 } } }; }
      throw new Error(`unexpected authority request ${request.pathname}`);
    },
  });
  const record = await client.acquire("anthropic-a");
  assert.equal(record.ticket.ticketId, freshTicketId);
  assert.equal(record.ticket.state, "active");
  assert.equal(staleLookups, 1);
  assert.equal(creates, 1);
  assert.equal(Object.keys(ledger.tickets).includes(`${sessionId}:${staleRequestId}`), false);
});

test("authority-client discards a persisted record whose reused request id yields an unusable create response", async () => {
  const sessionId = "aaaa1111-9999-4999-8999-999999999999";
  const config = {
    mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", statePath: "/unused/authority-client-tickets-v1.json",
    keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false,
    lanes: { "anthropic-a": { port: 8791, accountBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "anthropic-b": { port: 8792, accountBindingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "anthropic-c": { port: 8793, accountBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, "anthropic-d": { port: 8794, accountBindingId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
  };
  // The record carries no ticket and no pending operation, so only its persistence marks it stale.
  const staleRequestId = "cccc2222-8888-4888-8888-888888888888";
  let ledger = { schemaVersion: 1, tickets: { [`${sessionId}:${staleRequestId}`]: { provider: "anthropic-a", requestId: staleRequestId, sessionId, createdAtEpochMs: 1_000 } } };
  const freshTicketId = "dddd3333-6666-4666-8666-666666666666";
  let creates = 0; let rejectedOnce = false;
  const client = createAuthorityClient(config, {
    sessionId,
    token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    readLedger: async () => structuredClone(ledger), writeLedger: async (next) => { ledger = structuredClone(next); }, wait: async () => {},
    request: async (request) => {
      if (request.pathname === "/v1/health") return { status: 200, body: { schemaVersion: 1, protocolVersion: 2, authorityId: config.expectedAuthorityId, instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" } };
      if (request.pathname === "/v1/tickets") {
        creates++;
        // The reused request id replays a ticket whose identity no longer matches the record.
        if (request.body.requestId === staleRequestId) { rejectedOnce = true; return { status: 201, body: { schemaVersion: 1, ticketId: "eeee4444-5555-4555-8555-555555555555", requestId: "ffff5555-4444-4444-8444-444444444444", provider: "anthropic-a", state: "queued", revision: 1, createdAtEpochMs: 1_000, enqueuedAtEpochMs: 1_001, offeredAtEpochMs: null, offerExpiresAtEpochMs: null, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease: null } }; }
        return { status: 201, body: { schemaVersion: 1, ticketId: freshTicketId, requestId: request.body.requestId, provider: "anthropic-a", state: "active", revision: 2, createdAtEpochMs: 2_000, enqueuedAtEpochMs: 2_001, offeredAtEpochMs: 2_050, offerExpiresAtEpochMs: 2_100, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease: { leaseId: "55555555-5555-4555-8555-555555555555", generation: 1, claimedAtEpochMs: 2_100, renewSequence: 0, renewByEpochMs: 2_200, serverDeadlineEpochMs: 2_300 } } };
      }
      throw new Error(`unexpected authority request ${request.pathname}`);
    },
  });
  const record = await client.acquire("anthropic-a");
  assert.equal(rejectedOnce, true);
  assert.equal(record.ticket.ticketId, freshTicketId);
  assert.equal(record.ticket.state, "active");
  assert.equal(creates, 2);
  assert.equal(Object.keys(ledger.tickets).includes(`${sessionId}:${staleRequestId}`), false);
});

test("authority-client breaks a ledger lock left behind by a killed session", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "permit-stale-lock-"));
  const statePath = path.join(directory, "authority-client-tickets-v1.json");
  try {
    // A session killed mid-write leaves this directory behind and nothing else removes it.
    await fs.mkdir(`${statePath}.lock`, { mode: 0o700 });
    await fs.utimes(`${statePath}.lock`, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const config = {
      mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", statePath,
      keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false,
      lanes: { "anthropic-a": { port: 8791, accountBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "anthropic-b": { port: 8792, accountBindingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "anthropic-c": { port: 8793, accountBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, "anthropic-d": { port: 8794, accountBindingId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
    };
    const client = createAuthorityClient(config, {
      sessionId: "bbbb2222-7777-4777-8777-777777777777",
      token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      wait: async () => {},
      request: async (request) => {
        if (request.pathname === "/v1/health") return { status: 200, body: { schemaVersion: 1, protocolVersion: 2, authorityId: config.expectedAuthorityId, instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" } };
        if (request.pathname === "/v1/tickets") return { status: 201, body: { schemaVersion: 1, ticketId: "9999aaaa-3333-4333-8333-333333333333", requestId: request.body.requestId, provider: "anthropic-a", state: "active", revision: 2, createdAtEpochMs: 2_000, enqueuedAtEpochMs: 2_001, offeredAtEpochMs: 2_050, offerExpiresAtEpochMs: 2_100, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease: { leaseId: "55555555-5555-4555-8555-555555555555", generation: 1, claimedAtEpochMs: 2_100, renewSequence: 0, renewByEpochMs: 2_200, serverDeadlineEpochMs: 2_300 } } };
        throw new Error(`unexpected authority request ${request.pathname}`);
      },
    });
    const record = await client.acquire("anthropic-a");
    assert.equal(record.ticket.state, "active");
    assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).schemaVersion, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("authority-client completes cleanly when its lease was already reclaimed", async () => {
  const config = {
    mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", statePath: "/unused/authority-client-tickets-v1.json",
    keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false,
    lanes: { "anthropic-a": { port: 8791, accountBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "anthropic-b": { port: 8792, accountBindingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "anthropic-c": { port: 8793, accountBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, "anthropic-d": { port: 8794, accountBindingId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } },
  };
  let ledger = { schemaVersion: 1, tickets: {} };
  const client = createAuthorityClient(config, {
    sessionId: "cccc3333-2222-4222-8222-222222222222",
    token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    readLedger: async () => structuredClone(ledger), writeLedger: async (next) => { ledger = structuredClone(next); }, wait: async () => {},
    request: async (request) => {
      if (request.pathname === "/v1/health") return { status: 200, body: { schemaVersion: 1, protocolVersion: 2, authorityId: config.expectedAuthorityId, instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" } };
      if (request.pathname === "/v1/tickets") return { status: 201, body: { schemaVersion: 1, ticketId: "7777bbbb-1111-4111-8111-111111111111", requestId: request.body.requestId, provider: "anthropic-a", state: "active", revision: 2, createdAtEpochMs: 2_000, enqueuedAtEpochMs: 2_001, offeredAtEpochMs: 2_050, offerExpiresAtEpochMs: 2_100, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease: { leaseId: "55555555-5555-4555-8555-555555555555", generation: 1, claimedAtEpochMs: 2_100, renewSequence: 0, renewByEpochMs: 2_200, serverDeadlineEpochMs: 2_300 } } };
      throw new Error(`unexpected authority request ${request.pathname}`);
    },
  });
  const record = await client.acquire("anthropic-a");
  // The authority reclaimed the lease while the request was still finishing.
  record.ticket = { ...record.ticket, state: "released", terminalReason: "operator_reconciled", terminalAtEpochMs: 3_000, lease: null };
  await client.complete(record);
  assert.equal(Object.keys(ledger.tickets).length, 0);
});
