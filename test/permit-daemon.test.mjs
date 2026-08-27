import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AuthorityError, openAuthorityState } from "../authority-state.mjs";
import { ensureDaemon } from "../index.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const daemonPath = path.join(root, "permit-daemon.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address(); await new Promise((resolve) => server.close(resolve)); return port;
}
function request(port, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { ...extraHeaders, ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) };
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, timeout: 5000, headers }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text || "{}") }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("request timed out"))); req.end(payload);
  });
}
const health = (port) => request(port, "GET", "/health").then((response) => response.body);
const acquire = (port, session) => request(port, "POST", "/acquire", { session });
const release = (port, permitId) => request(port, "POST", "/release", { permitId });
async function eventually(check, message) { const deadline = Date.now() + 3000; while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch {} await delay(20); } throw new Error(message); }
async function startDaemon(port, home, overrides = {}) {
  const child = spawn(process.execPath, [daemonPath], { env: { ...process.env, HOME: home, CLAUDE_PERMIT_GATE_PORT: String(port), ...overrides }, stdio: "ignore" });
  await eventually(async () => (await health(port)).ok, "daemon did not start");
  return child;
}
async function daemon(overrides = {}) {
  const port = await unusedPort(); const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-gate-"));
  const child = await startDaemon(port, home, overrides);
  const gate = { port, home, overrides, child };
  return { ...gate, async stop() { if (this.child.exitCode === null) this.child.kill("SIGTERM"); if (this.child.exitCode === null) await new Promise((resolve) => this.child.once("exit", resolve)); await fs.rm(home, { recursive: true, force: true }); } };
}

const AUTHORITY_TIMING = Object.freeze({ offerTtlMs: 5_000, renewIntervalMs: 5_000, renewDeadlineMs: 15_000, terminalRetentionMs: 86_400_000 });
function authorityUuid(value) {
  const hex = Number(value).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-${hex.padStart(12, "0")}`;
}
function authorityPrincipal(value) {
  return { installationId: authorityUuid(value), accountBindingId: authorityUuid(100 + value), providers: ["anthropic-a"] };
}
function authorityHeaders(principal, scopes = "permit:mutate,snapshot:read,allowance:publish") {
  return { "x-authority-test-installation": principal.installationId, "x-authority-test-account-binding": principal.accountBindingId, "x-authority-test-providers": principal.providers.join(","), "x-authority-test-scopes": scopes };
}
function ticketCreate(principal, { session = authorityUuid(200), request = authorityUuid(300), now = 1_760_000_000_000 } = {}) {
  return { schemaVersion: 1, provider: "anthropic-a", accountBindingId: principal.accountBindingId, installationId: principal.installationId, sessionId: session, requestId: request, createdAtEpochMs: now };
}
function ticketMutation(principal, { operation, revision, lease, outcome, reason = null, cooldownMs } = {}) {
  const request = { schemaVersion: 1, operationId: operation, expectedRevision: revision, installationId: principal.installationId, provider: "anthropic-a", accountBindingId: principal.accountBindingId };
  if (lease) Object.assign(request, { leaseId: lease.leaseId, generation: lease.generation });
  if (lease && outcome === undefined) request.renewSequence = lease.renewSequence + 1;
  if (outcome !== undefined) {
    Object.assign(request, { outcome, reason });
    if (cooldownMs !== undefined) request.cooldownMs = cooldownMs;
  }
  return request;
}
async function durableAuthority(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-"));
  const statePath = path.join(directory, "lane.json");
  const time = { now: 1_760_000_000_000 };
  const base = {
    statePath,
    provider: "anthropic-a",
    port: 8791,
    authorityId: authorityUuid(900),
    clock: () => time.now,
    timing: AUTHORITY_TIMING,
    minimumConcurrency: 1,
    maximumConcurrency: 1,
    currentConcurrency: 1,
    ...overrides,
  };
  let authority = openAuthorityState({ ...base, bootstrap: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    directory,
    statePath,
    time,
    get authority() { return authority; },
    restart(extra = {}) { authority = openAuthorityState({ ...base, ...extra, bootstrap: false }); return authority; },
  };
}
async function authorityDaemon(t, overrides = {}) {
  const port = await unusedPort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-daemon-"));
  const stateDirectory = path.join(home, "state");
  const principal = authorityPrincipal(700);
  const child = spawn(process.execPath, [daemonPath], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PERMIT_GATE_DAEMON_MODE: "authority",
      CLAUDE_PERMIT_GATE_TEST_MODE: "1",
      CLAUDE_PERMIT_GATE_TEST_AUTH: "1",
      CLAUDE_PERMIT_GATE_AUTHORITY_BOOTSTRAP: "1",
      CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR: stateDirectory,
      CLAUDE_PERMIT_GATE_PROVIDER: "anthropic-a",
      CLAUDE_PERMIT_GATE_PORT: String(port),
      CLAUDE_PERMIT_GATE_OFFER_TTL_MS: "5000",
      CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS: "5000",
      CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS: "15000",
      CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS: "86400000",
      CLAUDE_PERMIT_GATE_MIN: "1",
      CLAUDE_PERMIT_GATE_MAX: "1",
      CLAUDE_PERMIT_GATE_START: "1",
      ...overrides,
    },
    stdio: "ignore",
  });
  await eventually(async () => (await request(port, "GET", "/v1/health", undefined, authorityHeaders(principal))).status === 200, "authority daemon did not become ready");
  const statePath = path.join(stateDirectory, `lane-${port}.json`);
  t.after(async () => { if (child.exitCode === null) child.kill("SIGTERM"); if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve)); await fs.rm(home, { recursive: true, force: true }); });
  return { port, home, stateDirectory, statePath, principal, child };
}

test("daemon health reports provenance and EADDRINUSE re-probes a compatible owner", async (t) => {
  const gate = await daemon({ CLAUDE_PERMIT_GATE_PROVIDER: "anthropic-a" }); t.after(() => gate.stop());
  const state = await health(gate.port);
  assert.equal(state.version, 3); assert.equal(state.protocolVersion, 1); assert.equal(state.provider, "anthropic-a"); assert.match(state.instanceId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i); assert.match(state.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  const granted = await request(gate.port, "POST", "/acquire", { session: "provenance", expectedInstanceId: state.instanceId, expectedProvider: state.provider, expectedProtocolVersion: state.protocolVersion });
  assert.equal(granted.status, 200); assert.equal(granted.body.instanceId, state.instanceId); assert.equal(granted.body.provider, state.provider); assert.equal(granted.body.protocolVersion, state.protocolVersion); assert.equal((await release(gate.port, granted.body.permitId)).body.ok, true);
  for (const mismatch of [{ expectedInstanceId: "00000000-0000-4000-8000-000000000000" }, { expectedProvider: "anthropic-b" }, { expectedProtocolVersion: 2 }]) {
    const rejected = await request(gate.port, "POST", "/acquire", { session: "provenance", expectedInstanceId: state.instanceId, expectedProvider: state.provider, expectedProtocolVersion: state.protocolVersion, ...mismatch });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.retry, true); assert.equal(rejected.body.permitId, undefined);
  }
  assert.equal((await health(gate.port)).active, 0);
  const contenderHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-gate-")); t.after(() => fs.rm(contenderHome, { recursive: true, force: true }));
  const contender = spawn(process.execPath, [daemonPath], { env: { ...process.env, HOME: contenderHome, CLAUDE_PERMIT_GATE_PORT: String(gate.port), CLAUDE_PERMIT_GATE_PROVIDER: "anthropic-a" }, stdio: "ignore" });
  const exited = await new Promise((resolve) => contender.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exited, { code: 3, signal: null });

  const port = await unusedPort(); const first = new EventEmitter(); const second = new EventEmitter(); first.unref = () => first; second.unref = () => second;
  let probes = 0; let spawns = 0;
  const options = {
    probe: async () => { probes++; return probes === 1 ? undefined : probes === 2 ? { ok: true, version: 3, protocolVersion: 1, provider: "anthropic-a", instanceId: "11111111-1111-4111-8111-111111111111" } : undefined; },
    spawnDaemon: () => { spawns++; return spawns === 1 ? first : second; },
  };
  const pending = await ensureDaemon("/unused", port, "anthropic-a", options);
  assert.equal(pending.compatibility, "invalidOrUnavailable"); assert.equal(pending.spawned, true);
  first.emit("exit", 3, null);
  await eventually(() => probes === 2, "occupied-port winner was not re-probed");
  const retried = await ensureDaemon("/unused", port, "anthropic-a", options);
  assert.equal(retried.spawned, true); assert.equal(spawns, 2, "a compatible occupied-port winner must clear recovery");
  await ensureDaemon("/unused", port, "anthropic-a", { probe: async () => ({ ok: true, protocolVersion: 1, provider: "anthropic-a", instanceId: "11111111-1111-4111-8111-111111111111" }), spawnDaemon: () => second });
});

test("daemon bounds concurrency and schedules sessions round-robin", async (t) => {
  const gate = await daemon({ CLAUDE_PERMIT_GATE_MIN: "1", CLAUDE_PERMIT_GATE_MAX: "1", CLAUDE_PERMIT_GATE_START: "1" }); t.after(() => gate.stop());
  const holder = await acquire(gate.port, "holder"); assert.equal(holder.status, 200);
  const pending = new Map([
    ["a-1", acquire(gate.port, "a").then((response) => ({ label: "a-1", response }))],
    ["b-1", acquire(gate.port, "b").then((response) => ({ label: "b-1", response }))],
    ["a-2", acquire(gate.port, "a").then((response) => ({ label: "a-2", response }))],
  ]);
  await eventually(async () => (await health(gate.port)).queued === 3, "requests did not queue");
  await release(gate.port, holder.body.permitId);
  const grants = [];
  while (pending.size) {
    const winner = await Promise.race(pending.values());
    pending.delete(winner.label);
    grants.push(winner);
    await release(gate.port, winner.response.body.permitId);
  }
  assert.deepEqual(grants.map(({ label }) => label), ["a-1", "b-1", "a-2"]);
  assert.deepEqual(grants.map(({ response }) => response.status), [200, 200, 200]);
  const final = await health(gate.port); assert.equal(final.active, 0); assert.equal(final.queued, 0); assert.equal(final.peakActive, 1);
});

test("closing a queued acquire removes it without consuming a permit", async (t) => {
  const gate = await daemon({ CLAUDE_PERMIT_GATE_MIN: "1", CLAUDE_PERMIT_GATE_MAX: "1", CLAUDE_PERMIT_GATE_START: "1" }); t.after(() => gate.stop());
  const holder = await acquire(gate.port, "holder"); const controller = new AbortController();
  const pending = new Promise((resolve) => {
    const payload = JSON.stringify({ session: "waiting" });
    const req = http.request({ host: "127.0.0.1", port: gate.port, method: "POST", path: "/acquire", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } });
    controller.signal.addEventListener("abort", () => req.destroy(), { once: true }); req.on("error", resolve); req.end(payload);
  });
  await eventually(async () => (await health(gate.port)).queued === 1, "request did not queue"); controller.abort(); await pending;
  await eventually(async () => (await health(gate.port)).queued === 0, "aborted request remained queued"); await release(gate.port, holder.body.permitId);
  const state = await health(gate.port); assert.equal(state.active, 0); assert.equal(state.cancelled, 1);
});

test("releases a grant when its queued client disconnects before the response flushes", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-gate-"));
  const preload = path.join(home, "delay-grant-response.cjs");
  await fs.writeFile(preload, `const http = require("node:http"); const end = http.ServerResponse.prototype.end; http.ServerResponse.prototype.end = function(chunk, ...args) { if (String(chunk).includes("\\\"permitId\\\"")) { setTimeout(() => end.call(this, chunk, ...args), 100); return this; } return end.call(this, chunk, ...args); };`);
  const port = await unusedPort(); const child = await startDaemon(port, home, { NODE_OPTIONS: `--require=${preload}`, CLAUDE_PERMIT_GATE_MIN: "1", CLAUDE_PERMIT_GATE_MAX: "1", CLAUDE_PERMIT_GATE_START: "1" });
  const gate = { port, home, child, async stop() { if (this.child.exitCode === null) this.child.kill("SIGTERM"); if (this.child.exitCode === null) await new Promise((resolve) => this.child.once("exit", resolve)); await fs.rm(home, { recursive: true, force: true }); } }; t.after(() => gate.stop());
  const holder = await acquire(port, "holder");
  const disconnected = new Promise((resolve) => {
    const payload = JSON.stringify({ session: "waiting" }); const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/acquire", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } });
    req.once("error", resolve); req.end(payload); gate.disconnect = () => req.destroy();
  });
  await eventually(async () => (await health(port)).queued === 1, "request did not queue");
  await release(port, holder.body.permitId); await eventually(async () => (await health(port)).active === 1, "queued request was not granted"); gate.disconnect(); await disconnected;
  await eventually(async () => (await health(port)).active === 0, "disconnected grant remained active");
  assert.equal((await health(port)).released, 2);
});

test("throttles before releasing, caps cooldown, and renews live permits", async (t) => {
  const gate = await daemon({ CLAUDE_PERMIT_GATE_MIN: "1", CLAUDE_PERMIT_GATE_MAX: "1", CLAUDE_PERMIT_GATE_START: "1", CLAUDE_PERMIT_GATE_MAX_COOLDOWN_MS: "1000", CLAUDE_PERMIT_GATE_PERMIT_TTL_MS: "100" }); t.after(() => gate.stop());
  const first = await acquire(gate.port, "first"); const waiting = acquire(gate.port, "next"); await eventually(async () => (await health(gate.port)).queued === 1, "request did not queue");
  const throttle = await request(gate.port, "POST", "/throttle", { permitId: first.body.permitId, reason: "test", cooldownMs: 600000 }); assert.equal(throttle.body.ok, true); assert(throttle.body.cooldownMsRemaining <= 1000);
  const second = await waiting; assert.equal(second.status, 200);
  for (let i = 0; i < 3; i++) { await delay(50); assert.equal((await request(gate.port, "POST", "/renew", { permitId: second.body.permitId })).body.ok, true); }
  assert.equal((await health(gate.port)).expired, 0); await release(gate.port, second.body.permitId);
});

test("graceful restart preserves live permits before granting replacements", async (t) => {
  const gate = await daemon({ CLAUDE_PERMIT_GATE_MIN: "1", CLAUDE_PERMIT_GATE_MAX: "1", CLAUDE_PERMIT_GATE_START: "1", CLAUDE_PERMIT_GATE_PERMIT_TTL_MS: "10000" });
  t.after(() => gate.stop());
  const held = await acquire(gate.port, "held");
  assert.equal(held.status, 200);
  gate.child.kill("SIGTERM");
  await new Promise((resolve) => gate.child.once("exit", resolve));
  gate.child = await startDaemon(gate.port, gate.home, gate.overrides);
  const restored = await health(gate.port);
  assert.equal(restored.active, 1, "replacement must quarantine the pre-restart lease");
  const waiting = acquire(gate.port, "waiting");
  await eventually(async () => (await health(gate.port)).queued === 1, "replacement granted while a restored lease was active");
  assert.equal((await release(gate.port, held.body.permitId)).body.ok, true);
  assert.equal((await waiting).status, 200);
});

test("reclaims abandoned permits and drains waiters on shutdown", async () => {
  const gate = await daemon({ CLAUDE_PERMIT_GATE_MIN: "1", CLAUDE_PERMIT_GATE_MAX: "1", CLAUDE_PERMIT_GATE_START: "1", CLAUDE_PERMIT_GATE_PERMIT_TTL_MS: "100" });
  const leaked = await acquire(gate.port, "leaked"); const waiting = acquire(gate.port, "waiting"); await eventually(async () => (await health(gate.port)).queued === 1, "request did not queue");
  await delay(120); await eventually(async () => (await health(gate.port)).expired === 1, "lease was not reclaimed");
  const recovered = await waiting; assert.equal(recovered.status, 200); const another = acquire(gate.port, "shutdown"); await eventually(async () => (await health(gate.port)).queued === 1, "shutdown request did not queue");
  gate.child.kill("SIGTERM"); const retry = await another; assert.equal(retry.status, 503); assert.equal(retry.body.retry, true); await new Promise((resolve) => gate.child.once("exit", resolve));
});

test("authority replays creates and compacts terminal records without recreating them", async (t) => {
  const gate = await durableAuthority(t);
  const principal = authorityPrincipal(1);
  const create = ticketCreate(principal, { session: authorityUuid(201), request: authorityUuid(301), now: gate.time.now });
  const first = gate.authority.createTicket(principal, create);
  const replay = gate.authority.createTicket(principal, create);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(replay.ticket.ticketId, first.ticket.ticketId);
  const claimed = gate.authority.mutateTicket(principal, first.ticket.ticketId, "claim", ticketMutation(principal, { operation: authorityUuid(401), revision: first.ticket.revision }));
  gate.authority.mutateTicket(principal, first.ticket.ticketId, "complete", ticketMutation(principal, { operation: authorityUuid(402), revision: claimed.ticket.revision, lease: claimed.ticket.lease, outcome: "released" }));
  gate.restart();
  gate.time.now += AUTHORITY_TIMING.terminalRetentionMs + 1;
  gate.authority.createTicket(principal, ticketCreate(principal, { session: authorityUuid(202), request: authorityUuid(302), now: gate.time.now }));
  assert.throws(() => gate.authority.getTicket(principal, first.ticket.ticketId), (error) => error instanceof AuthorityError && error.code === "not_found");
  assert.throws(() => gate.authority.createTicket(principal, create), (error) => error instanceof AuthorityError && error.code === "invalid_request");
});

test("authority keeps reconnect-stable tickets through cancellation and claim dispatch", async (t) => {
  const gate = await authorityDaemon(t);
  const firstPrincipal = gate.principal;
  const secondPrincipal = authorityPrincipal(701);
  const now = Date.now();
  const firstRequest = ticketCreate(firstPrincipal, { session: authorityUuid(2701), request: authorityUuid(3701), now });
  const secondRequest = ticketCreate(secondPrincipal, { session: authorityUuid(2702), request: authorityUuid(3702), now });
  const wrongLane = await request(gate.port, "POST", "/v1/tickets", { ...firstRequest, provider: "anthropic-b", requestId: authorityUuid(3799) }, authorityHeaders({ ...firstPrincipal, providers: ["anthropic-a", "anthropic-b"] }));
  const first = await request(gate.port, "POST", "/v1/tickets", firstRequest, authorityHeaders(firstPrincipal));
  const queued = await request(gate.port, "POST", "/v1/tickets", secondRequest, authorityHeaders(secondPrincipal));
  const reconnect = await request(gate.port, "POST", "/v1/tickets", secondRequest, authorityHeaders(secondPrincipal));
  assert.equal(wrongLane.status, 409); assert.equal(wrongLane.body.error.code, "provider_mismatch");
  assert.equal(first.status, 201); assert.equal(first.body.state, "offered"); assert.equal(first.headers.etag, `"revision-${first.body.revision}"`);
  assert.equal(queued.status, 201); assert.equal(queued.body.state, "queued"); assert.equal(reconnect.status, 200); assert.equal(reconnect.headers["idempotency-replayed"], "true"); assert.equal(reconnect.body.ticketId, queued.body.ticketId);
  const cancelRequest = ticketMutation(firstPrincipal, { operation: authorityUuid(4701), revision: first.body.revision });
  const cancelled = await request(gate.port, "POST", `/v1/tickets/${first.body.ticketId}/cancel`, cancelRequest, authorityHeaders(firstPrincipal));
  const replayedCancel = await request(gate.port, "POST", `/v1/tickets/${first.body.ticketId}/cancel`, cancelRequest, authorityHeaders(firstPrincipal));
  const offered = await request(gate.port, "GET", `/v1/tickets/${queued.body.ticketId}`, undefined, authorityHeaders(secondPrincipal));
  const claimRequest = ticketMutation(secondPrincipal, { operation: authorityUuid(4702), revision: offered.body.revision });
  const claimed = await request(gate.port, "POST", `/v1/tickets/${queued.body.ticketId}/claim`, claimRequest, authorityHeaders(secondPrincipal));
  assert.equal(cancelled.body.state, "cancelled"); assert.equal(replayedCancel.headers["idempotency-replayed"], "true"); assert.equal(offered.body.state, "offered"); assert.equal(claimed.body.state, "active");
});

test("authority quarantines missed renewals and restores only an acknowledged matching lease", async (t) => {
  const gate = await durableAuthority(t);
  const firstPrincipal = authorityPrincipal(2); const secondPrincipal = authorityPrincipal(3);
  const first = gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(202), request: authorityUuid(302), now: gate.time.now }));
  const claimed = gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "claim", ticketMutation(firstPrincipal, { operation: authorityUuid(403), revision: first.ticket.revision }));
  const waiting = gate.authority.createTicket(secondPrincipal, ticketCreate(secondPrincipal, { session: authorityUuid(203), request: authorityUuid(303), now: gate.time.now }));
  assert.equal(waiting.ticket.state, "queued");
  gate.time.now += AUTHORITY_TIMING.renewDeadlineMs + 1;
  gate.authority.reconcile();
  const uncertain = gate.authority.getTicket(firstPrincipal, first.ticket.ticketId);
  assert.equal(uncertain.state, "uncertain"); assert.equal(gate.authority.health({ instanceId: authorityUuid(500), buildId: "test" }).uncertain, 1);
  assert.throws(() => gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "cancel", ticketMutation(firstPrincipal, { operation: authorityUuid(404), revision: uncertain.revision })), (error) => error instanceof AuthorityError && error.code === "invalid_transition");
  const renewed = gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "renew", ticketMutation(firstPrincipal, { operation: authorityUuid(405), revision: uncertain.revision, lease: claimed.ticket.lease }));
  assert.equal(renewed.ticket.state, "active"); assert.equal(renewed.ticket.lease.renewSequence, 1);
  gate.time.now += AUTHORITY_TIMING.renewDeadlineMs + 1;
  gate.authority.reconcile();
  assert.equal(gate.authority.getTicket(firstPrincipal, first.ticket.ticketId).state, "uncertain"); assert.equal(gate.authority.getTicket(secondPrincipal, waiting.ticket.ticketId).state, "queued");
});

test("authority applies throttle completion exactly once before releasing capacity", async (t) => {
  const gate = await durableAuthority(t, { maximumConcurrency: 2, currentConcurrency: 2 });
  const firstPrincipal = authorityPrincipal(4); const secondPrincipal = authorityPrincipal(5);
  const first = gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(204), request: authorityUuid(304), now: gate.time.now }));
  const firstClaim = gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "claim", ticketMutation(firstPrincipal, { operation: authorityUuid(406), revision: first.ticket.revision }));
  const second = gate.authority.createTicket(secondPrincipal, ticketCreate(secondPrincipal, { session: authorityUuid(205), request: authorityUuid(305), now: gate.time.now }));
  const secondClaim = gate.authority.mutateTicket(secondPrincipal, second.ticket.ticketId, "claim", ticketMutation(secondPrincipal, { operation: authorityUuid(407), revision: second.ticket.revision }));
  const completeRequest = ticketMutation(firstPrincipal, { operation: authorityUuid(408), revision: firstClaim.ticket.revision, lease: firstClaim.ticket.lease, outcome: "throttled", reason: "assistant_rate_limit", cooldownMs: 20_000 });
  const completed = gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "complete", completeRequest);
  const replay = gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "complete", completeRequest);
  const healthState = gate.authority.health({ instanceId: authorityUuid(501), buildId: "test" });
  assert.equal(completed.ticket.state, "throttled"); assert.equal(replay.replayed, true); assert.deepEqual(replay.ticket, completed.ticket); assert.equal(healthState.active, 1); assert.equal(healthState.currentConcurrency, 1); assert(healthState.cooldownUntilEpochMs > gate.time.now);
  gate.authority.mutateTicket(secondPrincipal, second.ticket.ticketId, "complete", ticketMutation(secondPrincipal, { operation: authorityUuid(409), revision: secondClaim.ticket.revision, lease: secondClaim.ticket.lease, outcome: "released" }));
  assert.equal(gate.authority.health({ instanceId: authorityUuid(501), buildId: "test" }).active, 0);
});

test("authority persists nested machine and session fairness across restart", async (t) => {
  const gate = await durableAuthority(t);
  const firstPrincipal = authorityPrincipal(6); const secondPrincipal = authorityPrincipal(7);
  const holder = gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(206), request: authorityUuid(306), now: gate.time.now }));
  const holderClaim = gate.authority.mutateTicket(firstPrincipal, holder.ticket.ticketId, "claim", ticketMutation(firstPrincipal, { operation: authorityUuid(410), revision: holder.ticket.revision }));
  const firstSession = gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(207), request: authorityUuid(307), now: gate.time.now }));
  const secondMachine = gate.authority.createTicket(secondPrincipal, ticketCreate(secondPrincipal, { session: authorityUuid(208), request: authorityUuid(308), now: gate.time.now }));
  const secondSession = gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(209), request: authorityUuid(309), now: gate.time.now }));
  const beforeRestartTerm = gate.authority.laneTerm;
  gate.restart();
  assert.equal(gate.authority.laneTerm, beforeRestartTerm + 1);
  gate.authority.mutateTicket(firstPrincipal, holder.ticket.ticketId, "complete", ticketMutation(firstPrincipal, { operation: authorityUuid(411), revision: holderClaim.ticket.revision, lease: holderClaim.ticket.lease, outcome: "released" }));
  const firstOffered = gate.authority.getTicket(firstPrincipal, firstSession.ticket.ticketId);
  assert.equal(firstOffered.state, "offered");
  const firstClaim = gate.authority.mutateTicket(firstPrincipal, firstOffered.ticketId, "claim", ticketMutation(firstPrincipal, { operation: authorityUuid(412), revision: firstOffered.revision }));
  gate.authority.mutateTicket(firstPrincipal, firstOffered.ticketId, "complete", ticketMutation(firstPrincipal, { operation: authorityUuid(413), revision: firstClaim.ticket.revision, lease: firstClaim.ticket.lease, outcome: "released" }));
  const machineTurn = gate.authority.getTicket(secondPrincipal, secondMachine.ticket.ticketId);
  assert.equal(machineTurn.state, "offered");
  const machineClaim = gate.authority.mutateTicket(secondPrincipal, machineTurn.ticketId, "claim", ticketMutation(secondPrincipal, { operation: authorityUuid(414), revision: machineTurn.revision }));
  gate.authority.mutateTicket(secondPrincipal, machineTurn.ticketId, "complete", ticketMutation(secondPrincipal, { operation: authorityUuid(415), revision: machineClaim.ticket.revision, lease: machineClaim.ticket.lease, outcome: "released" }));
  assert.equal(gate.authority.getTicket(firstPrincipal, secondSession.ticket.ticketId).state, "offered");
});

test("authority fails closed for migration, fsync faults, socket ownership, and stale terms", async (t) => {
  const corruptDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-corrupt-"));
  const corruptPath = path.join(corruptDirectory, "lane.json");
  await fs.writeFile(corruptPath, "{not-json\n"); await fs.chmod(corruptPath, 0o600);
  t.after(() => fs.rm(corruptDirectory, { recursive: true, force: true }));
  assert.throws(() => openAuthorityState({ statePath: corruptPath, provider: "anthropic-a", port: 8791, timing: AUTHORITY_TIMING, bootstrap: false }), (error) => error instanceof AuthorityError && error.code === "persistence_unavailable");
  assert.equal(await fs.readFile(corruptPath, "utf8"), "{not-json\n");

  const migrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-migration-"));
  const migrationPath = path.join(migrationDirectory, "lane.json");
  t.after(() => fs.rm(migrationDirectory, { recursive: true, force: true }));
  const migrationConfig = { statePath: migrationPath, provider: "anthropic-a", port: 8791, authorityId: authorityUuid(901), timing: AUTHORITY_TIMING, bootstrap: true };
  openAuthorityState(migrationConfig);
  const v1 = JSON.parse(await fs.readFile(migrationPath, "utf8"));
  v1.stateSchemaVersion = 1; delete v1.ownerNonce; delete v1.createTombstones; delete v1.allowancePublishes; delete v1.publisherSequences;
  await fs.writeFile(migrationPath, `${JSON.stringify(v1)}\n`); await fs.chmod(migrationPath, 0o600);
  const migrated = openAuthorityState({ ...migrationConfig, bootstrap: false });
  assert.equal(migrated.health({ instanceId: authorityUuid(502), buildId: "test" }).stateSchemaVersion, 2);

  for (const code of ["EIO", "ENOSPC"]) {
    let writes = 0;
    const faultGate = await durableAuthority(t, { faultInjector: ({ phase }) => {
      if (phase === "before-write" && ++writes === 2) return Object.assign(new Error(code), { code });
      return undefined;
    } });
    const before = await fs.readFile(faultGate.statePath, "utf8");
    const principal = authorityPrincipal(code === "EIO" ? 8 : 9);
    assert.throws(() => faultGate.authority.createTicket(principal, ticketCreate(principal, { session: authorityUuid(code === "EIO" ? 208 : 209), request: authorityUuid(code === "EIO" ? 308 : 309), now: faultGate.time.now })), (error) => error instanceof AuthorityError && error.code === "persistence_unavailable");
    assert.equal(await fs.readFile(faultGate.statePath, "utf8"), before); assert.equal(faultGate.authority.status, "degraded"); assert.equal(faultGate.authority.health({ instanceId: authorityUuid(503), buildId: "test" }).offered, 0);
  }

  const termGate = await durableAuthority(t); const termPrincipal = authorityPrincipal(10);
  const foreign = JSON.parse(await fs.readFile(termGate.statePath, "utf8")); foreign.ownerNonce = authorityUuid(999); await fs.writeFile(termGate.statePath, `${JSON.stringify(foreign)}\n`); await fs.chmod(termGate.statePath, 0o600);
  const fencedBytes = await fs.readFile(termGate.statePath, "utf8");
  assert.throws(() => termGate.authority.createTicket(termPrincipal, ticketCreate(termPrincipal, { session: authorityUuid(210), request: authorityUuid(310), now: termGate.time.now })), (error) => error instanceof AuthorityError && error.code === "persistence_unavailable");
  assert.equal(await fs.readFile(termGate.statePath, "utf8"), fencedBytes);

  const socketGate = await authorityDaemon(t); const beforeSocketRace = await fs.readFile(socketGate.statePath, "utf8");
  const contender = spawn(process.execPath, [daemonPath], { env: { ...process.env, HOME: socketGate.home, CLAUDE_PERMIT_GATE_DAEMON_MODE: "authority", CLAUDE_PERMIT_GATE_TEST_MODE: "1", CLAUDE_PERMIT_GATE_TEST_AUTH: "1", CLAUDE_PERMIT_GATE_AUTHORITY_BOOTSTRAP: "1", CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR: socketGate.stateDirectory, CLAUDE_PERMIT_GATE_PROVIDER: "anthropic-a", CLAUDE_PERMIT_GATE_PORT: String(socketGate.port), CLAUDE_PERMIT_GATE_OFFER_TTL_MS: "5000", CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS: "5000", CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS: "15000", CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS: "86400000" }, stdio: "ignore" });
  assert.equal((await new Promise((resolve) => contender.once("exit", resolve))), 3);
  assert.equal(await fs.readFile(socketGate.statePath, "utf8"), beforeSocketRace);
});

test("authority persists allowance scope, skew, replay, and accepted truth across restart", async (t) => {
  const gate = await durableAuthority(t);
  const principal = authorityPrincipal(11);
  const first = { schemaVersion: 1, installationId: principal.installationId, provider: "anthropic-a", accountBindingId: principal.accountBindingId, publishId: authorityUuid(611), publisherSequence: 1, observedAtEpochMs: gate.time.now, fiveHour: { utilization: 47.5, status: "allowed", resetEpochSeconds: 1_760_003_600 }, sevenDay: null };
  const accepted = gate.authority.publishAllowance(principal, first);
  const replay = gate.authority.publishAllowance(principal, first);
  assert.equal(accepted.replayed, false); assert.equal(replay.replayed, true); assert.deepEqual(replay.allowance, accepted.allowance);
  assert.throws(() => gate.authority.publishAllowance({ ...principal, providers: ["anthropic-a", "anthropic-b"] }, { ...first, provider: "anthropic-b", publishId: authorityUuid(612), publisherSequence: 2 }), (error) => error instanceof AuthorityError && error.code === "provider_mismatch");
  assert.throws(() => gate.authority.publishAllowance(principal, { ...first, publishId: authorityUuid(613), publisherSequence: 2, accountBindingId: authorityUuid(712) }), (error) => error instanceof AuthorityError && error.code === "account_binding_mismatch");
  assert.throws(() => gate.authority.publishAllowance(principal, { ...first, publishId: authorityUuid(614), publisherSequence: 2, observedAtEpochMs: gate.time.now + 30_001 }), (error) => error instanceof AuthorityError && error.code === "invalid_request");
  gate.time.now += 30_001;
  const newest = { ...first, publishId: authorityUuid(615), publisherSequence: 2, observedAtEpochMs: gate.time.now, fiveHour: { utilization: 48, status: "warning", resetEpochSeconds: 1_760_007_200 } };
  gate.authority.publishAllowance(principal, newest);
  assert.throws(() => gate.authority.publishAllowance(principal, { ...first, publishId: authorityUuid(616), publisherSequence: 3 }), (error) => error instanceof AuthorityError && error.code === "stale_revision");
  gate.restart();
  assert.equal(gate.authority.publishAllowance(principal, first).replayed, true);
  const snapshot = gate.authority.snapshot({ instanceId: authorityUuid(504), buildId: "test" });
  assert.equal(snapshot.allowance.observedAtEpochMs, newest.observedAtEpochMs); assert.equal(snapshot.allowance.fiveHour.status, "warning"); assert.equal("installationId" in snapshot, false);
});
