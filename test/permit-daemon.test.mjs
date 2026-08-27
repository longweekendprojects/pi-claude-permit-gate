import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AuthorityError, authorityVerifierPath, openAuthorityState, writeAuthorityVerifierStore } from "../authority-state.mjs";
import { ensureDaemon } from "../index.ts";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const daemonPath = path.join(root, "permit-daemon.mjs");
const authorityAdminPath = path.join(root, "scripts", "authority-admin.mjs");
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
function rawAuthorityRequest(port, pathname, payload, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = { ...extraHeaders, "content-type": "application/json", "content-length": Buffer.byteLength(payload) };
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path: pathname, timeout: 5000, headers }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => { try { resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text || "{}") }); } catch (error) { reject(error); } });
    });
    req.on("error", reject); req.on("timeout", () => req.destroy(new Error("raw request timed out"))); req.end(payload);
  });
}
const health = (port) => request(port, "GET", "/health").then((response) => response.body);
const acquire = (port, session) => request(port, "POST", "/acquire", { session });
const release = (port, permitId) => request(port, "POST", "/release", { permitId });
async function eventually(check, message, timeoutMs = 3000) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch {} await delay(20); } throw new Error(message); }
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
function authorityPrincipal(value, { accountBindingId = authorityUuid(100 + value), providers = ["anthropic-a"] } = {}) {
  return { installationId: authorityUuid(value), accountBindingId, providers };
}
function authorityToken(principal, scope = "permit:mutate") {
  const tokenId = `test-${scope.replace(":", "-")}-${principal.installationId.slice(0, 8)}`;
  const secret = crypto.createHash("sha256").update(`test-authority-token:${principal.installationId}:${scope}`).digest();
  return { tokenId, secret };
}
function authorityHeaders(principal, scope = "permit:mutate") {
  const { tokenId, secret } = authorityToken(principal, scope);
  return { authorization: `Bearer ${tokenId}.${secret.toString("base64url")}` };
}
function authorityVerifierRecord(principal, scope, generation = 1) {
  const { tokenId, secret } = authorityToken(principal, scope);
  return {
    tokenId,
    verifierSha256: crypto.createHash("sha256").update(secret).digest("hex"),
    installationId: principal.installationId,
    scope,
    laneAllowlist: [...principal.providers],
    generation,
    issuedAtEpochMs: Date.now() - 1_000,
    expiresAtEpochMs: Date.now() + 3_600_000,
    predecessorTokenId: null,
    revokedAtEpochMs: null,
  };
}
async function seedAuthorityVerifiers(home, principals) {
  const verifierStore = authorityVerifierPath({ home });
  const verifiers = principals.flatMap((principal) => ["permit:mutate", "snapshot:read", "allowance:publish"].map((scope) => authorityVerifierRecord(principal, scope)));
  await writeAuthorityVerifierStore(verifierStore, { schemaVersion: 1, generation: 1, verifiers }, { allowCreate: true });
  return verifierStore;
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
function authorityAdminEnvironment(home) {
  return {
    ...process.env,
    HOME: home,
    CLAUDE_PERMIT_GATE_TEST_MODE: "1",
    CLAUDE_PERMIT_GATE_TEST_KEYCHAIN_WRITER: "/bin/cat",
    CLAUDE_PERMIT_GATE_TEST_ADMIN_ASSUME_OFFLINE: "1",
    CLAUDE_PERMIT_GATE_OFFER_TTL_MS: "5000",
    CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS: "5000",
    CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS: "15000",
    CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS: "86400000",
  };
}

async function runAuthorityAdmin(home, args, secret) {
  const input = secret ? Buffer.from(`${secret.toString("base64url")}\n`) : undefined;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [authorityAdminPath, ...args], { env: authorityAdminEnvironment(home), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      input?.fill(0);
      resolve({ code, signal, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function startSharedAuthority(home, stateDirectory, provider, port, accountBindingId, authorization, overrides = {}) {
  const child = spawn(process.execPath, [daemonPath], {
    env: {
      ...authorityAdminEnvironment(home),
      CLAUDE_PERMIT_GATE_DAEMON_MODE: "authority",
      CLAUDE_PERMIT_GATE_AUTHORITY_BOOTSTRAP: "0",
      CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR: stateDirectory,
      CLAUDE_PERMIT_GATE_ACCOUNT_BINDING_ID: accountBindingId,
      CLAUDE_PERMIT_GATE_PROVIDER: provider,
      CLAUDE_PERMIT_GATE_PORT: String(port),
      CLAUDE_PERMIT_GATE_MIN: "1",
      CLAUDE_PERMIT_GATE_MAX: "1",
      CLAUDE_PERMIT_GATE_START: "1",
      ...overrides,
    },
    stdio: "ignore",
  });
  await eventually(async () => (await request(port, "GET", "/v1/health", undefined, { authorization })).status === 200, "shared authority daemon did not become ready");
  return child;
}

async function stopChild(child) {
  if (child.exitCode === null) child.kill("SIGTERM");
  if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
}

async function authorityDaemon(t, overrides = {}) {
  const port = await unusedPort();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-daemon-"));
  const stateDirectory = path.join(home, "state");
  const principal = authorityPrincipal(700);
  const secondPrincipal = authorityPrincipal(701, { accountBindingId: principal.accountBindingId });
  const wrongLanePrincipal = authorityPrincipal(702, { accountBindingId: principal.accountBindingId, providers: ["anthropic-b"] });
  const verifierStore = await seedAuthorityVerifiers(home, [principal, secondPrincipal, wrongLanePrincipal]);
  const child = spawn(process.execPath, [daemonPath], {
    env: {
      ...process.env,
      HOME: home,
      CLAUDE_PERMIT_GATE_DAEMON_MODE: "authority",
      CLAUDE_PERMIT_GATE_TEST_MODE: "1",
      CLAUDE_PERMIT_GATE_AUTHORITY_BOOTSTRAP: "1",
      CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR: stateDirectory,
      CLAUDE_PERMIT_GATE_ACCOUNT_BINDING_ID: principal.accountBindingId,
      CLAUDE_PERMIT_GATE_VERIFIER_STORE: verifierStore,
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
  return { port, home, stateDirectory, statePath, verifierStore, principal, secondPrincipal, wrongLanePrincipal, child };
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
  const first = await gate.authority.createTicket(principal, create);
  const replay = await gate.authority.createTicket(principal, create);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(replay.ticket.ticketId, first.ticket.ticketId);
  const claimed = await gate.authority.mutateTicket(principal, first.ticket.ticketId, "claim", ticketMutation(principal, { operation: authorityUuid(401), revision: first.ticket.revision }));
  await gate.authority.mutateTicket(principal, first.ticket.ticketId, "complete", ticketMutation(principal, { operation: authorityUuid(402), revision: claimed.ticket.revision, lease: claimed.ticket.lease, outcome: "released" }));
  gate.restart();
  gate.time.now += AUTHORITY_TIMING.terminalRetentionMs + 1;
  await gate.authority.createTicket(principal, ticketCreate(principal, { session: authorityUuid(202), request: authorityUuid(302), now: gate.time.now }));
  assert.throws(() => gate.authority.getTicket(principal, first.ticket.ticketId), (error) => error instanceof AuthorityError && error.code === "not_found");
  await assert.rejects(() => gate.authority.createTicket(principal, create), (error) => error instanceof AuthorityError && error.code === "invalid_request");
});

test("authority authenticates reconnect-stable tickets and manages verifier generations offline", async (t) => {
  const gate = await authorityDaemon(t);
  const firstPrincipal = gate.principal;
  const secondPrincipal = gate.secondPrincipal;
  const now = Date.now();
  const firstRequest = ticketCreate(firstPrincipal, { session: authorityUuid(2701), request: authorityUuid(3701), now });
  const secondRequest = ticketCreate(secondPrincipal, { session: authorityUuid(2702), request: authorityUuid(3702), now });
  for (const headers of [{}, { authorization: "Bearer malformed" }, { authorization: "Bearer unknown.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]) {
    const rejected = await request(gate.port, "POST", "/v1/tickets", firstRequest, headers);
    assert.equal(rejected.status, 401); assert.equal(rejected.body.error.code, "unauthenticated");
  }
  const wrongLane = await request(gate.port, "POST", "/v1/tickets", { ...firstRequest, provider: "anthropic-b", requestId: authorityUuid(3799) }, authorityHeaders(firstPrincipal));
  const first = await request(gate.port, "POST", "/v1/tickets", firstRequest, authorityHeaders(firstPrincipal));
  const queued = await request(gate.port, "POST", "/v1/tickets", secondRequest, authorityHeaders(secondPrincipal));
  const reconnect = await request(gate.port, "POST", "/v1/tickets", secondRequest, authorityHeaders(secondPrincipal));
  assert.equal(wrongLane.status, 403); assert.equal(wrongLane.body.error.code, "forbidden_lane");
  assert.equal(first.status, 201); assert.equal(first.body.state, "offered"); assert.equal(first.headers.etag, `"revision-${first.body.revision}"`);
  assert.equal(queued.status, 201); assert.equal(queued.body.state, "queued"); assert.equal(reconnect.status, 200); assert.equal(reconnect.headers["idempotency-replayed"], "true"); assert.equal(reconnect.body.ticketId, queued.body.ticketId);
  const forbiddenExisting = await request(gate.port, "GET", `/v1/tickets/${queued.body.ticketId}`, undefined, authorityHeaders(gate.wrongLanePrincipal));
  const forbiddenMissing = await request(gate.port, "GET", `/v1/tickets/${authorityUuid(4799)}`, undefined, authorityHeaders(gate.wrongLanePrincipal));
  assert.equal(forbiddenExisting.status, 403); assert.equal(forbiddenExisting.body.error.code, "forbidden_lane");
  assert.equal(forbiddenMissing.status, forbiddenExisting.status); assert.equal(forbiddenMissing.body.error.code, forbiddenExisting.body.error.code);
  const cancelRequest = ticketMutation(firstPrincipal, { operation: authorityUuid(4701), revision: first.body.revision });
  const cancelled = await request(gate.port, "POST", `/v1/tickets/${first.body.ticketId}/cancel`, cancelRequest, authorityHeaders(firstPrincipal));
  const replayedCancel = await request(gate.port, "POST", `/v1/tickets/${first.body.ticketId}/cancel`, cancelRequest, authorityHeaders(firstPrincipal));
  const offered = await request(gate.port, "GET", `/v1/tickets/${queued.body.ticketId}`, undefined, authorityHeaders(secondPrincipal));
  const claimRequest = ticketMutation(secondPrincipal, { operation: authorityUuid(4702), revision: offered.body.revision });
  const claimed = await request(gate.port, "POST", `/v1/tickets/${queued.body.ticketId}/claim`, claimRequest, authorityHeaders(secondPrincipal));
  assert.equal(cancelled.body.state, "cancelled"); assert.equal(replayedCancel.headers["idempotency-replayed"], "true"); assert.equal(offered.body.state, "offered"); assert.equal(claimed.body.state, "active");

  const sharedHome = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authentication-"));
  const sharedStateDirectory = path.join(sharedHome, "state");
  const providers = ["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"];
  const sharedPorts = await Promise.all(providers.map(() => unusedPort()));
  const laneBindings = new Map(providers.map((provider, index) => [provider, authorityUuid(8_000 + index)]));
  const installationOne = authorityUuid(810);
  const installationTwo = authorityUuid(811);
  const installationThree = authorityUuid(812);
  const tokenOne = crypto.randomBytes(32);
  const tokenRead = crypto.randomBytes(32);
  const tokenPublish = crypto.randomBytes(32);
  const tokenTwo = crypto.randomBytes(32);
  const tokenNarrow = crypto.randomBytes(32);
  const tokenRotated = crypto.randomBytes(32);
  const bearer = (tokenId, secret) => `Bearer ${tokenId}.${secret.toString("base64url")}`;
  const expiry = String(Date.now() + 3_600_000);
  const enroll = async ({ tokenId, secret, installationId, scope, lanes }) => {
    const result = await runAuthorityAdmin(sharedHome, ["enroll", "--installation-id", installationId, "--scope", scope, "--lanes", lanes.join(","), "--token-id", tokenId, "--keychain-service", "test.authority", "--keychain-account", `${tokenId}.account`, "--expires-at-epoch-ms", expiry], secret);
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
    assert.equal(result.stdout.includes(secret.toString("base64url")), false); assert.equal(result.stderr.includes(secret.toString("base64url")), false);
  };
  await enroll({ tokenId: "permit-one", secret: tokenOne, installationId: installationOne, scope: "permit:mutate", lanes: providers });
  await enroll({ tokenId: "read-one", secret: tokenRead, installationId: installationOne, scope: "snapshot:read", lanes: providers });
  await enroll({ tokenId: "publish-one", secret: tokenPublish, installationId: installationOne, scope: "allowance:publish", lanes: providers });
  await enroll({ tokenId: "permit-two", secret: tokenTwo, installationId: installationTwo, scope: "permit:mutate", lanes: providers });
  await enroll({ tokenId: "permit-narrow", secret: tokenNarrow, installationId: installationThree, scope: "permit:mutate", lanes: ["anthropic-a"] });
  const verifierStore = authorityVerifierPath({ home: sharedHome });
  for (const [index, provider] of providers.entries()) {
    const result = await runAuthorityAdmin(sharedHome, ["bootstrap", "--provider", provider, "--port", String(sharedPorts[index]), "--state-dir", sharedStateDirectory]);
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null });
  }
  const verifierRecheckMarker = path.join(sharedHome, "verifier-recheck");
  const sharedDaemons = [];
  t.after(async () => { await Promise.all(sharedDaemons.map(stopChild)); await fs.rm(sharedHome, { recursive: true, force: true }); });
  for (const [index, provider] of providers.entries()) {
    sharedDaemons.push(await startSharedAuthority(sharedHome, sharedStateDirectory, provider, sharedPorts[index], laneBindings.get(provider), bearer("permit-one", tokenOne), provider === "anthropic-a" ? { CLAUDE_PERMIT_GATE_TEST_VERIFIER_RECHECK_MARKER: verifierRecheckMarker, CLAUDE_PERMIT_GATE_TEST_VERIFIER_RECHECK_DELAY_MS: "1000" } : {}));
  }
  const sharedCreate = (installationId, provider, accountBindingId, requestId) => ({ schemaVersion: 1, provider, accountBindingId, installationId, sessionId: crypto.randomUUID(), requestId, createdAtEpochMs: Date.now() });
  const laneAStatePath = path.join(sharedStateDirectory, `lane-${sharedPorts[0]}.json`);
  const laneBStatePath = path.join(sharedStateDirectory, `lane-${sharedPorts[1]}.json`);
  const laneABeforeDenials = await fs.readFile(laneAStatePath, "utf8");
  const laneBBeforeDenials = await fs.readFile(laneBStatePath, "utf8");
  const wrongRole = await request(sharedPorts[0], "POST", "/v1/tickets", sharedCreate(installationOne, "anthropic-a", laneBindings.get("anthropic-a"), crypto.randomUUID()), { authorization: bearer("read-one", tokenRead) });
  const wrongOwner = await request(sharedPorts[0], "POST", "/v1/tickets", sharedCreate(installationOne, "anthropic-a", laneBindings.get("anthropic-a"), crypto.randomUUID()), { authorization: bearer("permit-two", tokenTwo) });
  const sharedWrongLane = await request(sharedPorts[1], "POST", "/v1/tickets", sharedCreate(installationThree, "anthropic-b", laneBindings.get("anthropic-b"), crypto.randomUUID()), { authorization: bearer("permit-narrow", tokenNarrow) });
  const wrongBinding = await request(sharedPorts[0], "POST", "/v1/tickets", sharedCreate(installationOne, "anthropic-a", authorityUuid(8_100), crypto.randomUUID()), { authorization: bearer("permit-one", tokenOne) });
  const snapshotAllowed = await request(sharedPorts[0], "GET", "/v1/snapshot", undefined, { authorization: bearer("read-one", tokenRead) });
  const snapshotWrongRole = await request(sharedPorts[0], "GET", "/v1/snapshot", undefined, { authorization: bearer("permit-one", tokenOne) });
  const publishWrongRole = await request(sharedPorts[0], "POST", "/v1/allowance", { schemaVersion: 1, installationId: installationOne, provider: "anthropic-a", accountBindingId: laneBindings.get("anthropic-a"), publishId: crypto.randomUUID(), publisherSequence: 1, observedAtEpochMs: Date.now(), fiveHour: null, sevenDay: null }, { authorization: bearer("read-one", tokenRead) });
  assert.deepEqual([wrongRole.body.error.code, wrongOwner.body.error.code, sharedWrongLane.body.error.code, wrongBinding.body.error.code], ["forbidden_scope", "unauthenticated", "forbidden_lane", "account_binding_mismatch"]);
  assert.deepEqual([wrongRole.status, wrongOwner.status, sharedWrongLane.status, wrongBinding.status], [403, 401, 403, 409]);
  assert.equal(snapshotAllowed.status, 200); assert.equal(snapshotWrongRole.status, 403); assert.equal(publishWrongRole.status, 403);
  assert.equal(await fs.readFile(laneAStatePath, "utf8"), laneABeforeDenials); assert.equal(await fs.readFile(laneBStatePath, "utf8"), laneBBeforeDenials);

  const precommitState = await fs.readFile(laneAStatePath, "utf8");
  const revokedCreate = request(sharedPorts[0], "POST", "/v1/tickets", sharedCreate(installationOne, "anthropic-a", laneBindings.get("anthropic-a"), crypto.randomUUID()), { authorization: bearer("permit-one", tokenOne) });
  await eventually(async () => (await fs.readFile(verifierRecheckMarker, "utf8")) === "ready", "mutation did not reach the verifier recheck");
  const storeBeforeRevocation = await fs.readFile(verifierStore);
  const revokeResult = await runAuthorityAdmin(sharedHome, ["revoke", "--installation-id", installationOne]);
  assert.deepEqual({ code: revokeResult.code, signal: revokeResult.signal }, { code: 0, signal: null });
  const revokedCreateResult = await revokedCreate;
  assert.equal(revokedCreateResult.status, 401); assert.equal(revokedCreateResult.body.error.code, "unauthenticated"); assert.equal(await fs.readFile(laneAStatePath, "utf8"), precommitState);
  const storeAfterRevocation = await fs.readFile(verifierStore);
  assert.equal(JSON.parse(storeAfterRevocation).generation, JSON.parse(storeBeforeRevocation).generation + 1);
  for (const [index, provider] of providers.entries()) {
    const revoked = await request(sharedPorts[index], "GET", "/v1/health", undefined, { authorization: bearer("permit-one", tokenOne) });
    const unaffected = await request(sharedPorts[index], "GET", "/v1/health", undefined, { authorization: bearer("permit-two", tokenTwo) });
    const committed = await request(sharedPorts[index], "POST", "/v1/tickets", sharedCreate(installationTwo, provider, laneBindings.get(provider), crypto.randomUUID()), { authorization: bearer("permit-two", tokenTwo) });
    assert.equal(revoked.status, 401); assert.equal(unaffected.status, 200); assert.equal(committed.status, 201);
    assert.equal(JSON.parse(await fs.readFile(path.join(sharedStateDirectory, `lane-${sharedPorts[index]}.json`), "utf8")).verifierGeneration, JSON.parse(storeAfterRevocation).generation);
  }
  const rotation = await runAuthorityAdmin(sharedHome, ["rotate", "--old-token-id", "permit-two", "--new-token-id", "permit-two-next", "--keychain-service", "test.authority", "--keychain-account", "permit-two-next.account", "--expires-at-epoch-ms", String(Date.now() + 3_600_000)], tokenRotated);
  assert.equal(rotation.code, 0);
  const storeAfterRotation = await fs.readFile(verifierStore);
  for (const [index, provider] of providers.entries()) {
    const overlap = await request(sharedPorts[index], "GET", "/v1/health", undefined, { authorization: bearer("permit-two", tokenTwo) });
    const successor = await request(sharedPorts[index], "GET", "/v1/health", undefined, { authorization: bearer("permit-two-next", tokenRotated) });
    const committed = await request(sharedPorts[index], "POST", "/v1/tickets", sharedCreate(installationTwo, provider, laneBindings.get(provider), crypto.randomUUID()), { authorization: bearer("permit-two-next", tokenRotated) });
    assert.equal(overlap.status, 200); assert.equal(successor.status, 200); assert.equal(committed.status, 201);
    assert.equal(JSON.parse(await fs.readFile(path.join(sharedStateDirectory, `lane-${sharedPorts[index]}.json`), "utf8")).verifierGeneration, JSON.parse(storeAfterRotation).generation);
  }

  await fs.writeFile(verifierStore, storeAfterRevocation, { mode: 0o600 }); await fs.chmod(verifierStore, 0o600);
  const rolledBack = await request(sharedPorts[2], "GET", "/v1/health", undefined, { authorization: bearer("permit-two", tokenTwo) });
  assert.equal(rolledBack.status, 503); assert.equal(rolledBack.body.error.code, "verifier_unavailable");
  await fs.writeFile(verifierStore, storeAfterRotation, { mode: 0o600 }); await fs.chmod(verifierStore, 0o600);
  await fs.chmod(verifierStore, 0o644);
  const unreadable = await request(sharedPorts[3], "GET", "/v1/health", undefined, { authorization: bearer("permit-two", tokenTwo) });
  assert.equal(unreadable.status, 503); assert.equal(unreadable.body.error.code, "verifier_unavailable");
  await fs.chmod(verifierStore, 0o600);
  await fs.writeFile(verifierStore, "{broken", { mode: 0o600 }); await fs.chmod(verifierStore, 0o600);
  const malformed = await request(sharedPorts[0], "GET", "/v1/health", undefined, { authorization: bearer("permit-two", tokenTwo) });
  assert.equal(malformed.status, 503); assert.equal(malformed.body.error.code, "verifier_unavailable");
  await fs.writeFile(verifierStore, storeAfterRotation, { mode: 0o600 }); await fs.chmod(verifierStore, 0o600);
  const expiredToken = crypto.randomBytes(32);
  const expiredEnrollment = await runAuthorityAdmin(sharedHome, ["enroll", "--installation-id", authorityUuid(813), "--scope", "snapshot:read", "--lanes", providers.join(","), "--token-id", "expired-read", "--keychain-service", "test.authority", "--keychain-account", "expired-read.account", "--expires-at-epoch-ms", String(Date.now() + 100)], expiredToken);
  assert.equal(expiredEnrollment.code, 0); await delay(150);
  const expired = await request(sharedPorts[1], "GET", "/v1/snapshot", undefined, { authorization: bearer("expired-read", expiredToken) });
  assert.equal(expired.status, 401); assert.equal(expired.body.error.code, "unauthenticated");

  const adminPort = await unusedPort();
  const adminStateDirectory = path.join(sharedHome, "admin-state");
  const adminBootstrap = await runAuthorityAdmin(sharedHome, ["bootstrap", "--provider", "anthropic-a", "--port", String(adminPort), "--state-dir", adminStateDirectory]);
  assert.equal(adminBootstrap.code, 0);
  const adminStatePath = path.join(adminStateDirectory, `lane-${adminPort}.json`);
  const adminGeneration = JSON.parse(await fs.readFile(verifierStore, "utf8")).generation;
  const adminClock = { now: Date.now() };
  const adminConfiguration = { statePath: adminStatePath, provider: "anthropic-a", port: adminPort, timing: AUTHORITY_TIMING, minimumConcurrency: 1, maximumConcurrency: 1, currentConcurrency: 1, verifierGeneration: adminGeneration, allowTestPort: true, clock: () => adminClock.now, bootstrap: false };
  const offlineAuthority = openAuthorityState(adminConfiguration);
  const offlinePrincipal = { installationId: installationTwo, accountBindingId: laneBindings.get("anthropic-a"), providers: ["anthropic-a"] };
  const offlineTicket = await offlineAuthority.createTicket(offlinePrincipal, ticketCreate(offlinePrincipal, { session: crypto.randomUUID(), request: crypto.randomUUID(), now: adminClock.now }));
  const occupiedListener = net.createServer();
  await new Promise((resolve, reject) => { occupiedListener.once("error", reject); occupiedListener.listen(adminPort, "127.0.0.1", resolve); });
  const blockedDrain = await runAuthorityAdmin(sharedHome, ["drain", "--provider", "anthropic-a", "--port", String(adminPort), "--state-dir", adminStateDirectory]);
  assert.notEqual(blockedDrain.code, 0); await new Promise((resolve) => occupiedListener.close(resolve));
  const drained = await runAuthorityAdmin(sharedHome, ["drain", "--provider", "anthropic-a", "--port", String(adminPort), "--state-dir", adminStateDirectory]);
  assert.equal(drained.code, 0);
  const drainedState = JSON.parse(await fs.readFile(adminStatePath, "utf8"));
  assert.equal(drainedState.lifecycleState, "draining"); assert.equal(drainedState.tickets[offlineTicket.ticket.ticketId].terminalReason, "authority_draining");
  const resumed = await runAuthorityAdmin(sharedHome, ["resume", "--provider", "anthropic-a", "--port", String(adminPort), "--state-dir", adminStateDirectory]);
  assert.equal(resumed.code, 0); assert.equal(JSON.parse(await fs.readFile(adminStatePath, "utf8")).lifecycleState, "ready");
  const uncertainAuthority = openAuthorityState(adminConfiguration);
  const uncertainTicket = await uncertainAuthority.createTicket(offlinePrincipal, ticketCreate(offlinePrincipal, { session: crypto.randomUUID(), request: crypto.randomUUID(), now: adminClock.now }));
  const uncertainClaim = await uncertainAuthority.mutateTicket(offlinePrincipal, uncertainTicket.ticket.ticketId, "claim", ticketMutation(offlinePrincipal, { operation: crypto.randomUUID(), revision: uncertainTicket.ticket.revision }));
  adminClock.now = uncertainClaim.ticket.lease.serverDeadlineEpochMs + 1;
  await uncertainAuthority.reconcile();
  assert.equal(uncertainAuthority.getTicket(offlinePrincipal, uncertainTicket.ticket.ticketId).state, "uncertain");
  const backupPath = path.join(sharedHome, "admin-state-backup.json");
  const missingApproval = await runAuthorityAdmin(sharedHome, ["reconcile", "--provider", "anthropic-a", "--port", String(adminPort), "--state-dir", adminStateDirectory, "--ticket-id", uncertainTicket.ticket.ticketId, "--backup-path", backupPath]);
  assert.notEqual(missingApproval.code, 0);
  const reconciled = await runAuthorityAdmin(sharedHome, ["reconcile", "--provider", "anthropic-a", "--port", String(adminPort), "--state-dir", adminStateDirectory, "--ticket-id", uncertainTicket.ticket.ticketId, "--backup-path", backupPath, "--approve-uncertain-reconciliation"]);
  assert.equal(reconciled.code, 0);
  const reconciledState = JSON.parse(await fs.readFile(adminStatePath, "utf8"));
  assert.equal(reconciledState.tickets[uncertainTicket.ticket.ticketId].state, "released"); assert.equal(reconciledState.tickets[uncertainTicket.ticket.ticketId].terminalReason, "operator_reconciled"); assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600);
  const persistedText = `${await fs.readFile(verifierStore, "utf8")}\n${await fs.readFile(adminStatePath, "utf8")}\n${await fs.readFile(backupPath, "utf8")}`;
  for (const secret of [tokenOne, tokenRead, tokenPublish, tokenTwo, tokenNarrow, tokenRotated, expiredToken]) assert.equal(persistedText.includes(secret.toString("base64url")), false);
  for (const secret of [tokenOne, tokenRead, tokenPublish, tokenTwo, tokenNarrow, tokenRotated, expiredToken]) secret.fill(0);
});

test("authority quarantines missed renewals and restores only an acknowledged matching lease", async (t) => {
  const gate = await durableAuthority(t);
  const firstPrincipal = authorityPrincipal(2); const secondPrincipal = authorityPrincipal(3);
  const first = await gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(202), request: authorityUuid(302), now: gate.time.now }));
  const claimed = await gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "claim", ticketMutation(firstPrincipal, { operation: authorityUuid(403), revision: first.ticket.revision }));
  const waiting = await gate.authority.createTicket(secondPrincipal, ticketCreate(secondPrincipal, { session: authorityUuid(203), request: authorityUuid(303), now: gate.time.now }));
  assert.equal(waiting.ticket.state, "queued");
  gate.time.now += AUTHORITY_TIMING.renewDeadlineMs + 1;
  await gate.authority.reconcile();
  const uncertain = gate.authority.getTicket(firstPrincipal, first.ticket.ticketId);
  assert.equal(uncertain.state, "uncertain"); assert.equal(gate.authority.health({ instanceId: authorityUuid(500), buildId: "test" }).uncertain, 1);
  await assert.rejects(() => gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "cancel", ticketMutation(firstPrincipal, { operation: authorityUuid(404), revision: uncertain.revision })), (error) => error instanceof AuthorityError && error.code === "invalid_transition");
  const renewed = await gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "renew", ticketMutation(firstPrincipal, { operation: authorityUuid(405), revision: uncertain.revision, lease: claimed.ticket.lease }));
  assert.equal(renewed.ticket.state, "active"); assert.equal(renewed.ticket.lease.renewSequence, 1);
  gate.time.now += AUTHORITY_TIMING.renewDeadlineMs + 1;
  await gate.authority.reconcile();
  assert.equal(gate.authority.getTicket(firstPrincipal, first.ticket.ticketId).state, "uncertain"); assert.equal(gate.authority.getTicket(secondPrincipal, waiting.ticket.ticketId).state, "queued");
});

test("authority applies throttle completion exactly once before releasing capacity", async (t) => {
  const gate = await durableAuthority(t, { maximumConcurrency: 2, currentConcurrency: 2 });
  const firstPrincipal = authorityPrincipal(4); const secondPrincipal = authorityPrincipal(5);
  const first = await gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(204), request: authorityUuid(304), now: gate.time.now }));
  const firstClaim = await gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "claim", ticketMutation(firstPrincipal, { operation: authorityUuid(406), revision: first.ticket.revision }));
  const second = await gate.authority.createTicket(secondPrincipal, ticketCreate(secondPrincipal, { session: authorityUuid(205), request: authorityUuid(305), now: gate.time.now }));
  const secondClaim = await gate.authority.mutateTicket(secondPrincipal, second.ticket.ticketId, "claim", ticketMutation(secondPrincipal, { operation: authorityUuid(407), revision: second.ticket.revision }));
  const completeRequest = ticketMutation(firstPrincipal, { operation: authorityUuid(408), revision: firstClaim.ticket.revision, lease: firstClaim.ticket.lease, outcome: "throttled", reason: "assistant_rate_limit", cooldownMs: 20_000 });
  const completed = await gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "complete", completeRequest);
  const replay = await gate.authority.mutateTicket(firstPrincipal, first.ticket.ticketId, "complete", completeRequest);
  const healthState = gate.authority.health({ instanceId: authorityUuid(501), buildId: "test" });
  assert.equal(completed.ticket.state, "throttled"); assert.equal(replay.replayed, true); assert.deepEqual(replay.ticket, completed.ticket); assert.equal(healthState.active, 1); assert.equal(healthState.currentConcurrency, 1); assert(healthState.cooldownUntilEpochMs > gate.time.now);
  await gate.authority.mutateTicket(secondPrincipal, second.ticket.ticketId, "complete", ticketMutation(secondPrincipal, { operation: authorityUuid(409), revision: secondClaim.ticket.revision, lease: secondClaim.ticket.lease, outcome: "released" }));
  assert.equal(gate.authority.health({ instanceId: authorityUuid(501), buildId: "test" }).active, 0);
});

test("authority persists nested machine and session fairness across restart", async (t) => {
  const gate = await durableAuthority(t);
  const firstPrincipal = authorityPrincipal(6); const secondPrincipal = authorityPrincipal(7);
  const holder = await gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(206), request: authorityUuid(306), now: gate.time.now }));
  const holderClaim = await gate.authority.mutateTicket(firstPrincipal, holder.ticket.ticketId, "claim", ticketMutation(firstPrincipal, { operation: authorityUuid(410), revision: holder.ticket.revision }));
  const firstSession = await gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(207), request: authorityUuid(307), now: gate.time.now }));
  const secondMachine = await gate.authority.createTicket(secondPrincipal, ticketCreate(secondPrincipal, { session: authorityUuid(208), request: authorityUuid(308), now: gate.time.now }));
  const secondSession = await gate.authority.createTicket(firstPrincipal, ticketCreate(firstPrincipal, { session: authorityUuid(209), request: authorityUuid(309), now: gate.time.now }));
  const beforeRestartTerm = gate.authority.laneTerm;
  gate.restart();
  assert.equal(gate.authority.laneTerm, beforeRestartTerm + 1);
  await gate.authority.mutateTicket(firstPrincipal, holder.ticket.ticketId, "complete", ticketMutation(firstPrincipal, { operation: authorityUuid(411), revision: holderClaim.ticket.revision, lease: holderClaim.ticket.lease, outcome: "released" }));
  const firstOffered = gate.authority.getTicket(firstPrincipal, firstSession.ticket.ticketId);
  assert.equal(firstOffered.state, "offered");
  const firstClaim = await gate.authority.mutateTicket(firstPrincipal, firstOffered.ticketId, "claim", ticketMutation(firstPrincipal, { operation: authorityUuid(412), revision: firstOffered.revision }));
  await gate.authority.mutateTicket(firstPrincipal, firstOffered.ticketId, "complete", ticketMutation(firstPrincipal, { operation: authorityUuid(413), revision: firstClaim.ticket.revision, lease: firstClaim.ticket.lease, outcome: "released" }));
  const machineTurn = gate.authority.getTicket(secondPrincipal, secondMachine.ticket.ticketId);
  assert.equal(machineTurn.state, "offered");
  const machineClaim = await gate.authority.mutateTicket(secondPrincipal, machineTurn.ticketId, "claim", ticketMutation(secondPrincipal, { operation: authorityUuid(414), revision: machineTurn.revision }));
  await gate.authority.mutateTicket(secondPrincipal, machineTurn.ticketId, "complete", ticketMutation(secondPrincipal, { operation: authorityUuid(415), revision: machineClaim.ticket.revision, lease: machineClaim.ticket.lease, outcome: "released" }));
  assert.equal(gate.authority.getTicket(firstPrincipal, secondSession.ticket.ticketId).state, "offered");

  const machineGate = await durableAuthority(t);
  const machineB = authorityPrincipal(20); const machineC = authorityPrincipal(21); const machineD = authorityPrincipal(22); const machineE = authorityPrincipal(23);
  const machineHolder = await machineGate.authority.createTicket(machineB, ticketCreate(machineB, { session: authorityUuid(220), request: authorityUuid(320), now: machineGate.time.now }));
  const machineHolderClaim = await machineGate.authority.mutateTicket(machineB, machineHolder.ticket.ticketId, "claim", ticketMutation(machineB, { operation: authorityUuid(420), revision: machineHolder.ticket.revision }));
  const machineFirst = await machineGate.authority.createTicket(machineB, ticketCreate(machineB, { session: authorityUuid(221), request: authorityUuid(321), now: machineGate.time.now }));
  const machineRemoved = await machineGate.authority.createTicket(machineC, ticketCreate(machineC, { session: authorityUuid(222), request: authorityUuid(322), now: machineGate.time.now }));
  const machineSuccessor = await machineGate.authority.createTicket(machineD, ticketCreate(machineD, { session: authorityUuid(223), request: authorityUuid(323), now: machineGate.time.now }));
  await machineGate.authority.mutateTicket(machineB, machineHolder.ticket.ticketId, "complete", ticketMutation(machineB, { operation: authorityUuid(421), revision: machineHolderClaim.ticket.revision, lease: machineHolderClaim.ticket.lease, outcome: "released" }));
  const machineFirstOffered = machineGate.authority.getTicket(machineB, machineFirst.ticket.ticketId);
  const machineFirstClaim = await machineGate.authority.mutateTicket(machineB, machineFirst.ticket.ticketId, "claim", ticketMutation(machineB, { operation: authorityUuid(422), revision: machineFirstOffered.revision }));
  const machineEarlier = await machineGate.authority.createTicket(machineB, ticketCreate(machineB, { session: authorityUuid(224), request: authorityUuid(324), now: machineGate.time.now }));
  await machineGate.authority.mutateTicket(machineC, machineRemoved.ticket.ticketId, "cancel", ticketMutation(machineC, { operation: authorityUuid(423), revision: machineRemoved.ticket.revision }));
  await machineGate.authority.createTicket(machineE, ticketCreate(machineE, { session: authorityUuid(225), request: authorityUuid(325), now: machineGate.time.now }));
  machineGate.restart();
  await machineGate.authority.mutateTicket(machineB, machineFirst.ticket.ticketId, "complete", ticketMutation(machineB, { operation: authorityUuid(424), revision: machineFirstClaim.ticket.revision, lease: machineFirstClaim.ticket.lease, outcome: "released" }));
  assert.equal(machineGate.authority.getTicket(machineD, machineSuccessor.ticket.ticketId).state, "offered");
  assert.equal(machineGate.authority.getTicket(machineB, machineEarlier.ticket.ticketId).state, "queued");

  const sessionGate = await durableAuthority(t);
  const sessionPrincipal = authorityPrincipal(24);
  const firstSessionId = authorityUuid(226); const removedSessionId = authorityUuid(227); const successorSessionId = authorityUuid(228);
  const sessionHolder = await sessionGate.authority.createTicket(sessionPrincipal, ticketCreate(sessionPrincipal, { session: firstSessionId, request: authorityUuid(326), now: sessionGate.time.now }));
  const sessionHolderClaim = await sessionGate.authority.mutateTicket(sessionPrincipal, sessionHolder.ticket.ticketId, "claim", ticketMutation(sessionPrincipal, { operation: authorityUuid(425), revision: sessionHolder.ticket.revision }));
  const sessionFirst = await sessionGate.authority.createTicket(sessionPrincipal, ticketCreate(sessionPrincipal, { session: firstSessionId, request: authorityUuid(327), now: sessionGate.time.now }));
  const sessionRemoved = await sessionGate.authority.createTicket(sessionPrincipal, ticketCreate(sessionPrincipal, { session: removedSessionId, request: authorityUuid(328), now: sessionGate.time.now }));
  const sessionSuccessor = await sessionGate.authority.createTicket(sessionPrincipal, ticketCreate(sessionPrincipal, { session: successorSessionId, request: authorityUuid(329), now: sessionGate.time.now }));
  await sessionGate.authority.mutateTicket(sessionPrincipal, sessionHolder.ticket.ticketId, "complete", ticketMutation(sessionPrincipal, { operation: authorityUuid(426), revision: sessionHolderClaim.ticket.revision, lease: sessionHolderClaim.ticket.lease, outcome: "released" }));
  const sessionFirstOffered = sessionGate.authority.getTicket(sessionPrincipal, sessionFirst.ticket.ticketId);
  const sessionFirstClaim = await sessionGate.authority.mutateTicket(sessionPrincipal, sessionFirst.ticket.ticketId, "claim", ticketMutation(sessionPrincipal, { operation: authorityUuid(427), revision: sessionFirstOffered.revision }));
  const sessionEarlier = await sessionGate.authority.createTicket(sessionPrincipal, ticketCreate(sessionPrincipal, { session: firstSessionId, request: authorityUuid(330), now: sessionGate.time.now }));
  await sessionGate.authority.mutateTicket(sessionPrincipal, sessionRemoved.ticket.ticketId, "cancel", ticketMutation(sessionPrincipal, { operation: authorityUuid(428), revision: sessionRemoved.ticket.revision }));
  await sessionGate.authority.createTicket(sessionPrincipal, ticketCreate(sessionPrincipal, { session: authorityUuid(229), request: authorityUuid(331), now: sessionGate.time.now }));
  sessionGate.restart();
  await sessionGate.authority.mutateTicket(sessionPrincipal, sessionFirst.ticket.ticketId, "complete", ticketMutation(sessionPrincipal, { operation: authorityUuid(429), revision: sessionFirstClaim.ticket.revision, lease: sessionFirstClaim.ticket.lease, outcome: "released" }));
  assert.equal(sessionGate.authority.getTicket(sessionPrincipal, sessionSuccessor.ticket.ticketId).state, "offered");
  assert.equal(sessionGate.authority.getTicket(sessionPrincipal, sessionEarlier.ticket.ticketId).state, "queued");

  const compactionGate = await durableAuthority(t);
  const compactionA = authorityPrincipal(30); const compactionB = authorityPrincipal(31); const compactionC = authorityPrincipal(32); const compactionD = authorityPrincipal(33);
  const compactionHolder = await compactionGate.authority.createTicket(compactionA, ticketCreate(compactionA, { session: authorityUuid(240), request: authorityUuid(340), now: compactionGate.time.now }));
  const compactionHolderClaim = await compactionGate.authority.mutateTicket(compactionA, compactionHolder.ticket.ticketId, "claim", ticketMutation(compactionA, { operation: authorityUuid(440), revision: compactionHolder.ticket.revision }));
  const compactionFirst = await compactionGate.authority.createTicket(compactionA, ticketCreate(compactionA, { session: authorityUuid(241), request: authorityUuid(341), now: compactionGate.time.now }));
  const compactedMachine = await compactionGate.authority.createTicket(compactionB, ticketCreate(compactionB, { session: authorityUuid(242), request: authorityUuid(342), now: compactionGate.time.now }));
  const compactionSuccessor = await compactionGate.authority.createTicket(compactionC, ticketCreate(compactionC, { session: authorityUuid(243), request: authorityUuid(343), now: compactionGate.time.now }));
  await compactionGate.authority.mutateTicket(compactionA, compactionHolder.ticket.ticketId, "complete", ticketMutation(compactionA, { operation: authorityUuid(441), revision: compactionHolderClaim.ticket.revision, lease: compactionHolderClaim.ticket.lease, outcome: "released" }));
  const compactionFirstOffered = compactionGate.authority.getTicket(compactionA, compactionFirst.ticket.ticketId);
  const compactionFirstClaim = await compactionGate.authority.mutateTicket(compactionA, compactionFirst.ticket.ticketId, "claim", ticketMutation(compactionA, { operation: authorityUuid(442), revision: compactionFirstOffered.revision }));
  const compactionEarlier = await compactionGate.authority.createTicket(compactionA, ticketCreate(compactionA, { session: authorityUuid(244), request: authorityUuid(344), now: compactionGate.time.now }));
  await compactionGate.authority.mutateTicket(compactionB, compactedMachine.ticket.ticketId, "cancel", ticketMutation(compactionB, { operation: authorityUuid(443), revision: compactedMachine.ticket.revision }));
  compactionGate.time.now += AUTHORITY_TIMING.terminalRetentionMs + 1;
  await compactionGate.authority.createTicket(compactionD, ticketCreate(compactionD, { session: authorityUuid(245), request: authorityUuid(345), now: compactionGate.time.now }));
  const compactedState = JSON.parse(await fs.readFile(compactionGate.statePath, "utf8"));
  assert.equal(compactedState.fairness.machineOrder.includes(compactionB.installationId), false); assert.equal(compactedState.fairness.machineCursor, compactedState.fairness.machineOrder.indexOf(compactionC.installationId));
  compactionGate.restart();
  const uncertainCompactionFirst = compactionGate.authority.getTicket(compactionA, compactionFirst.ticket.ticketId);
  await compactionGate.authority.mutateTicket(compactionA, compactionFirst.ticket.ticketId, "complete", ticketMutation(compactionA, { operation: authorityUuid(444), revision: uncertainCompactionFirst.revision, lease: compactionFirstClaim.ticket.lease, outcome: "released" }));
  assert.equal(compactionGate.authority.getTicket(compactionC, compactionSuccessor.ticket.ticketId).state, "offered");
  assert.equal(compactionGate.authority.getTicket(compactionA, compactionEarlier.ticket.ticketId).state, "queued");
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

  const allowanceMigrationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-allowance-migration-"));
  const allowanceMigrationPath = path.join(allowanceMigrationDirectory, "lane.json");
  t.after(() => fs.rm(allowanceMigrationDirectory, { recursive: true, force: true }));
  const allowanceMigrationConfig = { statePath: allowanceMigrationPath, provider: "anthropic-a", port: 8791, authorityId: authorityUuid(903), timing: AUTHORITY_TIMING, bootstrap: true };
  const legacyAllowanceAuthority = openAuthorityState(allowanceMigrationConfig);
  const legacyAllowancePrincipal = authorityPrincipal(27);
  const legacyAllowanceRequest = { schemaVersion: 1, installationId: legacyAllowancePrincipal.installationId, provider: "anthropic-a", accountBindingId: legacyAllowancePrincipal.accountBindingId, publishId: authorityUuid(635), publisherSequence: 1, observedAtEpochMs: 1_760_000_000_000, fiveHour: { utilization: 47.5, status: "allowed", resetEpochSeconds: 1_760_003_600 }, sevenDay: null };
  await legacyAllowanceAuthority.publishAllowance(legacyAllowancePrincipal, legacyAllowanceRequest);
  const legacyAllowanceState = JSON.parse(await fs.readFile(allowanceMigrationPath, "utf8"));
  legacyAllowanceState.stateSchemaVersion = 1; delete legacyAllowanceState.ownerNonce; delete legacyAllowanceState.createTombstones; delete legacyAllowanceState.allowancePublishes; delete legacyAllowanceState.publisherSequences;
  await fs.writeFile(allowanceMigrationPath, `${JSON.stringify(legacyAllowanceState)}\n`); await fs.chmod(allowanceMigrationPath, 0o600);
  const allowanceMigrated = openAuthorityState({ ...allowanceMigrationConfig, bootstrap: false });
  const migratedAllowanceSnapshot = allowanceMigrated.snapshot({ instanceId: authorityUuid(506), buildId: "test" }).allowance;
  assert.deepEqual(migratedAllowanceSnapshot, { observedAtEpochMs: legacyAllowanceRequest.observedAtEpochMs, fiveHour: legacyAllowanceRequest.fiveHour, sevenDay: null });
  const allowanceMigrationPersisted = JSON.parse(await fs.readFile(allowanceMigrationPath, "utf8"));
  assert.equal(Object.keys(allowanceMigrationPersisted.allowancePublishes).length, 1); assert.deepEqual(Object.values(allowanceMigrationPersisted.allowancePublishes)[0].allowance, migratedAllowanceSnapshot); assert.deepEqual(Object.values(allowanceMigrationPersisted.publisherSequences), [1]);
  assert.deepEqual(openAuthorityState({ ...allowanceMigrationConfig, bootstrap: false }).snapshot({ instanceId: authorityUuid(506), buildId: "test" }).allowance, migratedAllowanceSnapshot);

  const migrationRaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-migration-race-"));
  const migrationRacePath = path.join(migrationRaceDirectory, "lane.json");
  t.after(() => fs.rm(migrationRaceDirectory, { recursive: true, force: true }));
  const migrationRaceConfig = { statePath: migrationRacePath, provider: "anthropic-a", port: 8791, authorityId: authorityUuid(902), timing: AUTHORITY_TIMING, bootstrap: true };
  openAuthorityState(migrationRaceConfig);
  const legacyRace = JSON.parse(await fs.readFile(migrationRacePath, "utf8"));
  legacyRace.stateSchemaVersion = 1; delete legacyRace.ownerNonce; delete legacyRace.createTombstones; delete legacyRace.allowancePublishes; delete legacyRace.publisherSequences;
  await fs.writeFile(migrationRacePath, `${JSON.stringify(legacyRace)}\n`); await fs.chmod(migrationRacePath, 0o600);
  const changedLegacy = { ...legacyRace, laneTerm: 11 };
  const changedLegacyBytes = `${JSON.stringify(changedLegacy)}\n`;
  assert.throws(() => openAuthorityState({ ...migrationRaceConfig, bootstrap: false, faultInjector: ({ phase }) => {
    if (phase === "before-term-commit") fsSync.writeFileSync(migrationRacePath, changedLegacyBytes, { mode: 0o600 });
  } }), (error) => error instanceof AuthorityError && error.code === "persistence_unavailable");
  assert.equal(await fs.readFile(migrationRacePath, "utf8"), changedLegacyBytes);

  const semanticGate = await durableAuthority(t);
  const semanticPrincipal = authorityPrincipal(25);
  const semanticTicket = await semanticGate.authority.createTicket(semanticPrincipal, ticketCreate(semanticPrincipal, { session: authorityUuid(230), request: authorityUuid(332), now: semanticGate.time.now }));
  const semanticPublish = { schemaVersion: 1, installationId: semanticPrincipal.installationId, provider: "anthropic-a", accountBindingId: semanticPrincipal.accountBindingId, publishId: authorityUuid(632), publisherSequence: 1, observedAtEpochMs: semanticGate.time.now, fiveHour: { utilization: 47.5, status: "allowed", resetEpochSeconds: 1_760_003_600 }, sevenDay: null };
  await semanticGate.authority.publishAllowance(semanticPrincipal, semanticPublish);
  const semanticBytes = await fs.readFile(semanticGate.statePath, "utf8");
  const semanticTombstoneKey = `${semanticPrincipal.installationId}\u0000anthropic-a\u0000${authorityUuid(633)}`;
  const semanticPublishKey = `${semanticPrincipal.installationId}\u0000anthropic-a\u0000${authorityUuid(634)}`;
  const semanticSequenceKey = `${semanticPrincipal.installationId}\u0000anthropic-a`;
  for (const corrupt of [
    (state) => { state.createTombstones[semanticTombstoneKey] = "CORRUPT"; },
    (state) => { state.allowancePublishes[semanticPublishKey] = "CORRUPT"; },
    (state) => { state.publisherSequences[semanticSequenceKey] = "corrupt"; },
    (state) => { state.tickets[semanticTicket.ticket.ticketId].operationResults = ["CORRUPT"]; },
    (state) => { state.tickets[semanticTicket.ticket.ticketId].createResponse = "CORRUPT"; },
    (state) => { state.counters.nextQueueSequence = 1; },
    (state) => { state.fairness.machineOrder.push(semanticPrincipal.installationId); },
  ]) {
    const corruptState = JSON.parse(semanticBytes); corrupt(corruptState);
    const corruptBytes = `${JSON.stringify(corruptState)}\n`;
    await fs.writeFile(semanticGate.statePath, corruptBytes); await fs.chmod(semanticGate.statePath, 0o600);
    assert.throws(() => semanticGate.restart(), (error) => error instanceof AuthorityError && error.code === "persistence_unavailable");
    assert.equal(await fs.readFile(semanticGate.statePath, "utf8"), corruptBytes);
    await fs.writeFile(semanticGate.statePath, semanticBytes); await fs.chmod(semanticGate.statePath, 0o600);
  }

  for (const code of ["EIO", "ENOSPC"]) {
    let writes = 0;
    const faultGate = await durableAuthority(t, { faultInjector: ({ phase }) => {
      if (phase === "before-write" && ++writes === 2) return Object.assign(new Error(code), { code });
      return undefined;
    } });
    const before = await fs.readFile(faultGate.statePath, "utf8");
    const principal = authorityPrincipal(code === "EIO" ? 8 : 9);
    await assert.rejects(() => faultGate.authority.createTicket(principal, ticketCreate(principal, { session: authorityUuid(code === "EIO" ? 208 : 209), request: authorityUuid(code === "EIO" ? 308 : 309), now: faultGate.time.now })), (error) => error instanceof AuthorityError && error.code === "persistence_unavailable");
    assert.equal(await fs.readFile(faultGate.statePath, "utf8"), before); assert.equal(faultGate.authority.status, "degraded"); assert.equal(faultGate.authority.health({ instanceId: authorityUuid(503), buildId: "test" }).offered, 0);
  }

  const termGate = await durableAuthority(t); const termPrincipal = authorityPrincipal(10);
  const foreign = JSON.parse(await fs.readFile(termGate.statePath, "utf8")); foreign.ownerNonce = authorityUuid(999); await fs.writeFile(termGate.statePath, `${JSON.stringify(foreign)}\n`); await fs.chmod(termGate.statePath, 0o600);
  const fencedBytes = await fs.readFile(termGate.statePath, "utf8");
  await assert.rejects(() => termGate.authority.createTicket(termPrincipal, ticketCreate(termPrincipal, { session: authorityUuid(210), request: authorityUuid(310), now: termGate.time.now })), (error) => error instanceof AuthorityError && error.code === "persistence_unavailable");
  assert.equal(await fs.readFile(termGate.statePath, "utf8"), fencedBytes);

  let slowWriteStarted;
  let releaseSlowWrite;
  const slowWriteStartedPromise = new Promise((resolve) => { slowWriteStarted = resolve; });
  const slowWriteReleasePromise = new Promise((resolve) => { releaseSlowWrite = resolve; });
  let holdRuntimeWrite = false;
  const orderedGate = await durableAuthority(t, { runtimeFaultInjector: async ({ phase }) => {
    if (holdRuntimeWrite && phase === "before-write") { slowWriteStarted(); await slowWriteReleasePromise; }
  } });
  const orderedPrincipal = authorityPrincipal(26);
  const orderedTicket = await orderedGate.authority.createTicket(orderedPrincipal, ticketCreate(orderedPrincipal, { session: authorityUuid(231), request: authorityUuid(333), now: orderedGate.time.now }));
  const orderedClaim = await orderedGate.authority.mutateTicket(orderedPrincipal, orderedTicket.ticket.ticketId, "claim", ticketMutation(orderedPrincipal, { operation: authorityUuid(430), revision: orderedTicket.ticket.revision }));
  orderedGate.time.now = orderedClaim.ticket.lease.serverDeadlineEpochMs - 1;
  holdRuntimeWrite = true;
  const orderedRenew = orderedGate.authority.mutateTicket(orderedPrincipal, orderedTicket.ticket.ticketId, "renew", ticketMutation(orderedPrincipal, { operation: authorityUuid(431), revision: orderedClaim.ticket.revision, lease: orderedClaim.ticket.lease }));
  await slowWriteStartedPromise;
  orderedGate.time.now += 2;
  const laterReconcile = orderedGate.authority.reconcile();
  releaseSlowWrite();
  const renewed = await orderedRenew; await laterReconcile;
  assert.equal(renewed.ticket.state, "active"); assert.equal(orderedGate.authority.getTicket(orderedPrincipal, orderedTicket.ticket.ticketId).state, "active");

  const slowGate = await authorityDaemon(t, { CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_DELAY_MS: "300" });
  const slowRequest = ticketCreate(slowGate.principal, { session: authorityUuid(232), request: authorityUuid(334), now: Date.now() });
  let mutationReplied = false;
  const pendingMutation = request(slowGate.port, "POST", "/v1/tickets", slowRequest, authorityHeaders(slowGate.principal)).then((response) => { mutationReplied = true; return response; });
  await delay(40);
  assert.equal(mutationReplied, false);
  const responsiveHealth = await Promise.race([
    request(slowGate.port, "GET", "/v1/health", undefined, authorityHeaders(slowGate.principal)),
    delay(150).then(() => { throw new Error("health blocked behind durable write"); }),
  ]);
  assert.equal(responsiveHealth.status, 200);
  const durableReply = await pendingMutation;
  const durableState = JSON.parse(await fs.readFile(slowGate.statePath, "utf8"));
  assert.equal(durableReply.status, 201); assert.equal(durableState.tickets[durableReply.body.ticketId].ticketId, durableReply.body.ticketId);
  const blockingRequest = ticketCreate(slowGate.principal, { session: authorityUuid(233), request: authorityUuid(335), now: Date.now() });
  const blockingMutation = request(slowGate.port, "POST", "/v1/tickets", blockingRequest, authorityHeaders(slowGate.principal));
  await delay(40);
  const [malformedBody, oversizedBody] = await Promise.all([
    rawAuthorityRequest(slowGate.port, "/v1/tickets", "{not-json", authorityHeaders(slowGate.principal)),
    rawAuthorityRequest(slowGate.port, "/v1/tickets", `"${"x".repeat(16_385)}"`, authorityHeaders(slowGate.principal)),
  ]);
  assert.equal((await blockingMutation).status, 201); assert.equal(malformedBody.status, 400); assert.equal(malformedBody.body.error.code, "invalid_json"); assert.equal(oversizedBody.status, 400); assert.equal(oversizedBody.body.error.code, "invalid_request");
  assert.equal((await request(slowGate.port, "GET", "/v1/health", undefined, authorityHeaders(slowGate.principal))).status, 200); assert.equal(slowGate.child.exitCode, null);

  const shutdownMarkerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-shutdown-marker-"));
  const shutdownMarkerPath = path.join(shutdownMarkerDirectory, "write-count");
  t.after(() => fs.rm(shutdownMarkerDirectory, { recursive: true, force: true }));
  const shutdownGate = await authorityDaemon(t, { CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_DELAY_MS: "1000", CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_MARKER: shutdownMarkerPath });
  const shutdownTicket = await request(shutdownGate.port, "POST", "/v1/tickets", ticketCreate(shutdownGate.principal, { session: authorityUuid(234), request: authorityUuid(336), now: Date.now() }), authorityHeaders(shutdownGate.principal));
  assert.equal(shutdownTicket.status, 201); assert.equal(shutdownTicket.body.state, "offered");
  await eventually(async () => (await fs.readFile(shutdownMarkerPath, "utf8")) === "2", "reconciliation did not enter its delayed durable write", 8_000);
  const shutdownStartedAt = Date.now();
  shutdownGate.child.kill("SIGTERM");
  const shutdownExit = await Promise.race([
    new Promise((resolve) => shutdownGate.child.once("exit", (code, signal) => resolve({ code, signal }))),
    delay(5_000).then(() => { throw new Error("authority shutdown did not settle durable reconciliation"); }),
  ]);
  const shutdownState = JSON.parse(await fs.readFile(shutdownGate.statePath, "utf8"));
  assert.deepEqual(shutdownExit, { code: 0, signal: null }); assert(Date.now() - shutdownStartedAt >= 500); assert.equal(shutdownState.tickets[shutdownTicket.body.ticketId].state, "offerExpired");

  const timeoutMarkerDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-authority-timeout-marker-"));
  const timeoutMarkerPath = path.join(timeoutMarkerDirectory, "write-count");
  t.after(() => fs.rm(timeoutMarkerDirectory, { recursive: true, force: true }));
  const timeoutGate = await authorityDaemon(t, { CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_DELAY_MS: "1000", CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_MARKER: timeoutMarkerPath, CLAUDE_PERMIT_GATE_TEST_SHUTDOWN_TIMEOUT_MS: "150" });
  const timingOutMutation = request(timeoutGate.port, "POST", "/v1/tickets", ticketCreate(timeoutGate.principal, { session: authorityUuid(235), request: authorityUuid(337), now: Date.now() }), authorityHeaders(timeoutGate.principal)).catch(() => undefined);
  await eventually(async () => (await fs.readFile(timeoutMarkerPath, "utf8")) === "1", "mutation did not enter its delayed durable write");
  const timeoutExitPromise = new Promise((resolve) => timeoutGate.child.once("exit", (code, signal) => resolve({ code, signal })));
  timeoutGate.child.kill("SIGTERM");
  assert.deepEqual(await timeoutExitPromise, { code: 1, signal: null }); await timingOutMutation;

  const socketGate = await authorityDaemon(t); const beforeSocketRace = await fs.readFile(socketGate.statePath, "utf8");
  const contender = spawn(process.execPath, [daemonPath], { env: { ...process.env, HOME: socketGate.home, CLAUDE_PERMIT_GATE_DAEMON_MODE: "authority", CLAUDE_PERMIT_GATE_TEST_MODE: "1", CLAUDE_PERMIT_GATE_AUTHORITY_BOOTSTRAP: "1", CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR: socketGate.stateDirectory, CLAUDE_PERMIT_GATE_ACCOUNT_BINDING_ID: socketGate.principal.accountBindingId, CLAUDE_PERMIT_GATE_VERIFIER_STORE: socketGate.verifierStore, CLAUDE_PERMIT_GATE_PROVIDER: "anthropic-a", CLAUDE_PERMIT_GATE_PORT: String(socketGate.port), CLAUDE_PERMIT_GATE_OFFER_TTL_MS: "5000", CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS: "5000", CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS: "15000", CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS: "86400000" }, stdio: "ignore" });
  assert.equal((await new Promise((resolve) => contender.once("exit", resolve))), 3);
  assert.equal(await fs.readFile(socketGate.statePath, "utf8"), beforeSocketRace);
});

test("authority persists allowance scope, skew, replay, and accepted truth across restart", async (t) => {
  const gate = await durableAuthority(t);
  const principal = authorityPrincipal(11);
  const first = { schemaVersion: 1, installationId: principal.installationId, provider: "anthropic-a", accountBindingId: principal.accountBindingId, publishId: authorityUuid(611), publisherSequence: 1, observedAtEpochMs: gate.time.now, fiveHour: { utilization: 47.5, status: "allowed", resetEpochSeconds: 1_760_003_600 }, sevenDay: null };
  const accepted = await gate.authority.publishAllowance(principal, first);
  const replay = await gate.authority.publishAllowance(principal, first);
  assert.equal(accepted.replayed, false); assert.equal(replay.replayed, true); assert.deepEqual(replay.allowance, accepted.allowance);
  await assert.rejects(() => gate.authority.publishAllowance({ ...principal, providers: ["anthropic-a", "anthropic-b"] }, { ...first, provider: "anthropic-b", publishId: authorityUuid(612), publisherSequence: 2 }), (error) => error instanceof AuthorityError && error.code === "provider_mismatch");
  await assert.rejects(() => gate.authority.publishAllowance(principal, { ...first, publishId: authorityUuid(613), publisherSequence: 2, accountBindingId: authorityUuid(712) }), (error) => error instanceof AuthorityError && error.code === "account_binding_mismatch");
  await assert.rejects(() => gate.authority.publishAllowance(principal, { ...first, publishId: authorityUuid(614), publisherSequence: 2, observedAtEpochMs: gate.time.now + 30_001 }), (error) => error instanceof AuthorityError && error.code === "invalid_request");
  gate.time.now += 30_001;
  const newest = { ...first, publishId: authorityUuid(615), publisherSequence: 2, observedAtEpochMs: gate.time.now, fiveHour: { utilization: 48, status: "warning", resetEpochSeconds: 1_760_007_200 } };
  await gate.authority.publishAllowance(principal, newest);
  await assert.rejects(() => gate.authority.publishAllowance(principal, { ...first, publishId: authorityUuid(616), publisherSequence: 3 }), (error) => error instanceof AuthorityError && error.code === "stale_revision");
  gate.restart();
  assert.equal((await gate.authority.publishAllowance(principal, first)).replayed, true);
  const snapshot = gate.authority.snapshot({ instanceId: authorityUuid(504), buildId: "test" });
  assert.equal(snapshot.allowance.observedAtEpochMs, newest.observedAtEpochMs); assert.equal(snapshot.allowance.fiveHour.status, "warning"); assert.equal("installationId" in snapshot, false);
});
