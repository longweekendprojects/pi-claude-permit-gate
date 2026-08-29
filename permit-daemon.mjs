#!/usr/bin/env node
// Local permit daemon for direct Anthropic requests. It never proxies traffic.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { AuthorityError, authenticateAuthorityBearer, authorityErrorBody, authorityStatePath, authorityTimingFromEnvironment, authorityVerifierPath, openAuthorityState, readAuthorityVerifierStore, readAuthorityVerifierStoreAsync } from "./authority-state.mjs";

const DAEMON_MODE = process.env.CLAUDE_PERMIT_GATE_DAEMON_MODE ?? "local";

if (DAEMON_MODE === "authority") void startAuthorityDaemon();
else if (DAEMON_MODE === "local") startLocalDaemon();
else {
  process.stderr.write("CLAUDE_PERMIT_GATE_DAEMON_MODE must be local or authority\n");
  process.exitCode = 1;
}

function authorityInteger(name, fallback) {
  const value = process.env[name];
  if (value === undefined && fallback !== undefined) return fallback;
  if (!/^\d+$/.test(value ?? "")) throw new Error(`${name} must be an integer`);
  return Number(value);
}

function authorityError(res, error) {
  const response = authorityErrorBody(error);
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  if (response.retryable && response.retryAfterMs !== null) headers["retry-after"] = String(response.retryAfterMs / 1000);
  res.writeHead(response.status, headers);
  res.end(JSON.stringify(response.body));
}

function authorityReply(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > 65_536) throw new AuthorityError("persistence_unavailable", { message: "response exceeds authority limit" });
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(payload);
}

function authorityRequestBody(req) {
  const body = new Promise((resolve, reject) => {
    let bytes = 0;
    let text = "";
    let settled = false;
    const rejectOnce = (error) => { if (!settled) { settled = true; reject(error); } };
    const resolveOnce = (value) => { if (!settled) { settled = true; resolve(value); } };
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 16_384) {
        rejectOnce(new AuthorityError("invalid_request", { message: "request exceeds authority limit" }));
        return;
      }
      text += chunk;
    });
    req.on("error", () => rejectOnce(new AuthorityError("invalid_json", { message: "request body is invalid" })));
    req.on("end", () => {
      try { resolveOnce(text ? JSON.parse(text) : {}); } catch { rejectOnce(new AuthorityError("invalid_json", { message: "request body is invalid" })); }
    });
    // A request whose connection closes before the body completes never emits "end" or "error":
    // Node destroys a stalled request socket silently on its request timeout. Without this,
    // the body promise stays unsettled forever, so a mutation chained behind it wedges the lane.
    req.on("close", () => rejectOnce(new AuthorityError("invalid_request", { message: "request body is incomplete" })));
  });
  return body;
}

function isAuthorityUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function authorityAuthorization(req) {
  const values = [];
  for (let index = 0; index < req.rawHeaders.length; index += 2) if (req.rawHeaders[index].toLowerCase() === "authorization") values.push(req.rawHeaders[index + 1]);
  if (values.length !== 1) throw new AuthorityError("unauthenticated", { message: "bearer is unavailable" });
  return values[0];
}

async function authorityPrincipal(req, requiredScope, configuration, authority, { observeGeneration = true } = {}) {
  let store;
  try {
    store = await readAuthorityVerifierStoreAsync(configuration.verifierStorePath, { minimumGeneration: authority.verifierGeneration });
  } catch (error) {
    if (error instanceof AuthorityError && error.code === "verifier_unavailable") authority.markVerifierUnavailable();
    throw error;
  }
  const verified = authenticateAuthorityBearer(authorityAuthorization(req), store, { requiredScope, provider: configuration.provider });
  if (observeGeneration) {
    try {
      await authority.observeVerifierGeneration(verified.verifierGeneration);
    } catch (error) {
      if (error instanceof AuthorityError && error.code === "verifier_unavailable") authority.markVerifierUnavailable();
      throw error;
    }
  }
  return {
    ...verified,
    principal: {
      installationId: verified.installationId,
      accountBindingId: configuration.accountBindingId,
      providers: verified.providers,
    },
  };
}

function authorityPrecommitVerifier(req, requiredScope, configuration, authority, authenticated) {
  return async () => {
    const rechecked = await authorityPrincipal(req, requiredScope, configuration, authority, { observeGeneration: false });
    if (rechecked.tokenId !== authenticated.tokenId || rechecked.installationId !== authenticated.installationId || rechecked.scope !== authenticated.scope) throw new AuthorityError("unauthenticated", { message: "bearer changed before commit" });
    return rechecked.verifierGeneration;
  };
}

function startAuthorityDaemon() {
  let configuration;
  let buildId;
  try {
    const provider = process.env.CLAUDE_PERMIT_GATE_PROVIDER;
    const port = authorityInteger("CLAUDE_PERMIT_GATE_PORT");
    const testMode = process.env.CLAUDE_PERMIT_GATE_TEST_MODE === "1";
    const providerPorts = { "anthropic-a": 8791, "anthropic-b": 8792, "anthropic-c": 8793, "anthropic-d": 8794 };
    const authorityId = process.env.CLAUDE_PERMIT_GATE_AUTHORITY_ID || undefined;
    const accountBindingId = process.env.CLAUDE_PERMIT_GATE_ACCOUNT_BINDING_ID;
    const verifierStoreOverride = process.env.CLAUDE_PERMIT_GATE_VERIFIER_STORE;
    buildId = process.env.CLAUDE_PERMIT_GATE_BUILD_ID || "development";
    if ((authorityId !== undefined && !isAuthorityUuid(authorityId)) || !isAuthorityUuid(accountBindingId) || !testMode && verifierStoreOverride !== undefined || !/^[\x20-\x7e]{1,64}$/.test(buildId)) throw new Error("authority identity is invalid");
    const minimumConcurrency = authorityInteger("CLAUDE_PERMIT_GATE_MIN", 1);
    const maximumConcurrency = authorityInteger("CLAUDE_PERMIT_GATE_MAX", 2);
    const currentConcurrency = authorityInteger("CLAUDE_PERMIT_GATE_START", 2);
    const testControls = ["CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_DELAY_MS", "CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_MARKER", "CLAUDE_PERMIT_GATE_TEST_VERIFIER_RECHECK_DELAY_MS", "CLAUDE_PERMIT_GATE_TEST_VERIFIER_RECHECK_MARKER", "CLAUDE_PERMIT_GATE_TEST_VERIFIER_FENCE_DELAY_MS", "CLAUDE_PERMIT_GATE_TEST_VERIFIER_FENCE_MARKER", "CLAUDE_PERMIT_GATE_TEST_SHUTDOWN_TIMEOUT_MS"];
    if (!testMode && testControls.some((name) => process.env[name] !== undefined)) throw new Error("authority configuration is invalid");
    const durableWriteDelayMs = authorityInteger("CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_DELAY_MS", 0);
    const verifierRecheckDelayMs = authorityInteger("CLAUDE_PERMIT_GATE_TEST_VERIFIER_RECHECK_DELAY_MS", 0);
    const verifierFenceDelayMs = authorityInteger("CLAUDE_PERMIT_GATE_TEST_VERIFIER_FENCE_DELAY_MS", 0);
    const durableWriteMarker = testMode ? process.env.CLAUDE_PERMIT_GATE_TEST_DURABLE_WRITE_MARKER : undefined;
    const verifierRecheckMarker = testMode ? process.env.CLAUDE_PERMIT_GATE_TEST_VERIFIER_RECHECK_MARKER : undefined;
    const verifierFenceMarker = testMode ? process.env.CLAUDE_PERMIT_GATE_TEST_VERIFIER_FENCE_MARKER : undefined;
    const shutdownTimeoutMs = testMode ? authorityInteger("CLAUDE_PERMIT_GATE_TEST_SHUTDOWN_TIMEOUT_MS", 10_000) : 10_000;
    if (!(provider in providerPorts) || (!testMode && providerPorts[provider] !== port) || minimumConcurrency < 1 || maximumConcurrency > 64 || currentConcurrency < minimumConcurrency || currentConcurrency > maximumConcurrency || durableWriteDelayMs > 5_000 || verifierRecheckDelayMs > 5_000 || verifierFenceDelayMs > 5_000 || durableWriteMarker !== undefined && !durableWriteMarker || verifierRecheckMarker !== undefined && !verifierRecheckMarker || verifierFenceMarker !== undefined && !verifierFenceMarker || shutdownTimeoutMs < 1 || shutdownTimeoutMs > 30_000) throw new Error("authority configuration is invalid");
    let durableWriteCount = 0;
    configuration = {
      provider,
      port,
      accountBindingId,
      verifierStorePath: authorityVerifierPath({ home: os.homedir(), verifierStore: testMode ? verifierStoreOverride : undefined }),
      statePath: authorityStatePath({ home: os.homedir(), stateDirectory: process.env.CLAUDE_PERMIT_GATE_AUTHORITY_STATE_DIR, port }),
      bootstrap: false,
      authorityId,
      timing: authorityTimingFromEnvironment(process.env),
      minimumConcurrency,
      maximumConcurrency,
      currentConcurrency,
      allowTestPort: testMode,
      shutdownTimeoutMs,
      verifyGenerationSync: () => readAuthorityVerifierStore(configuration.verifierStorePath).generation,
      verifyGeneration: async () => (await readAuthorityVerifierStoreAsync(configuration.verifierStorePath)).generation,
      runtimeFaultInjector: durableWriteDelayMs === 0 && durableWriteMarker === undefined && verifierRecheckDelayMs === 0 && verifierRecheckMarker === undefined && verifierFenceDelayMs === 0 && verifierFenceMarker === undefined ? undefined : async ({ phase }) => {
        if (phase === "before-verifier-fence") {
          if (verifierFenceMarker !== undefined) await fs.promises.writeFile(verifierFenceMarker, "ready", { mode: 0o600 });
          if (verifierFenceDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verifierFenceDelayMs));
          return;
        }
        if (phase === "before-verifier-recheck") {
          if (verifierRecheckMarker !== undefined) await fs.promises.writeFile(verifierRecheckMarker, "ready", { mode: 0o600 });
          if (verifierRecheckDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, verifierRecheckDelayMs));
          return;
        }
        if (phase !== "before-write") return;
        durableWriteCount += 1;
        if (durableWriteMarker !== undefined) await fs.promises.writeFile(durableWriteMarker, String(durableWriteCount), { mode: 0o600 });
        if (durableWriteDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, durableWriteDelayMs));
      },
    };
  } catch {
    process.stderr.write("authority daemon configuration is invalid\n");
    process.exitCode = 1;
    return;
  }

  const instanceId = crypto.randomUUID();
  let authority;
  let startupFault;
  let reconcileTimer;
  let shuttingDown = false;
  let mutationTail = Promise.resolve();
  const server = http.createServer((req, res) => { void handleAuthorityRequest(req, res); });

  function serializeAuthorityMutation(operation) {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.catch(() => {});
    return result;
  }

  async function handleAuthorityRequest(req, res) {
    try {
      if (!authority) {
        authorityError(res, startupFault
          ? new AuthorityError(startupFault === "verifier_unavailable" ? "verifier_unavailable" : "authority_degraded", { message: "authority state is unavailable" })
          : new AuthorityError("authority_starting", { message: "authority is starting", retryable: true, retryAfterMs: 1_000 }));
        return;
      }
      if (authority.status === "degraded") {
        authorityError(res, new AuthorityError("authority_degraded", { message: "authority is degraded" }));
        return;
      }
      if (shuttingDown) throw new AuthorityError("authority_draining", { message: "authority is shutting down" });
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.search) throw new AuthorityError("invalid_request", { message: "authority route cannot include a query" });
      const pathname = url.pathname;
      if (req.method === "POST" && req.headers["content-type"] !== "application/json") throw new AuthorityError("invalid_request", { message: "authority requests require JSON" });
      if (req.method === "GET" && pathname === "/v1/health") {
        await authorityPrincipal(req, undefined, configuration, authority);
        authorityReply(res, 200, authority.health({ instanceId, buildId }));
        return;
      }
      if (req.method === "GET" && pathname === "/v1/snapshot") {
        await authorityPrincipal(req, "snapshot:read", configuration, authority);
        authorityReply(res, 200, authority.snapshot({ instanceId, buildId }));
        return;
      }
      const ticket = pathname.match(/^\/v1\/tickets\/([0-9a-f-]{36})(?:\/(claim|cancel|renew|complete))?$/i);
      if (req.method === "GET" && ticket && !ticket[2]) {
        const authenticated = await authorityPrincipal(req, "permit:mutate", configuration, authority);
        const result = authority.getTicket(authenticated.principal, ticket[1]);
        authorityReply(res, 200, result, { etag: `"revision-${result.revision}"` });
        return;
      }
      if (req.method === "POST" && pathname === "/v1/tickets") {
        const authenticated = await authorityPrincipal(req, "permit:mutate", configuration, authority);
        const requestBody = await authorityRequestBody(req);
        const verifyGeneration = authorityPrecommitVerifier(req, "permit:mutate", configuration, authority, authenticated);
        const result = await serializeAuthorityMutation(() => authority.createTicket(authenticated.principal, requestBody, { verifyGeneration }));
        const headers = { etag: `"revision-${result.ticket.revision}"`, location: `/v1/tickets/${result.ticket.ticketId}` };
        if (result.replayed) headers["idempotency-replayed"] = "true";
        authorityReply(res, result.created ? 201 : 200, result.ticket, headers);
        return;
      }
      if (req.method === "POST" && ticket && ticket[2]) {
        const authenticated = await authorityPrincipal(req, "permit:mutate", configuration, authority);
        const requestBody = await authorityRequestBody(req);
        const verifyGeneration = authorityPrecommitVerifier(req, "permit:mutate", configuration, authority, authenticated);
        // The body is read before the mutation is queued, so a stalled or abandoned request can
        // never sit at the head of the serialized queue and block every later write on the lane.
        const result = await serializeAuthorityMutation(() => authority.mutateTicket(authenticated.principal, ticket[1], ticket[2], requestBody, { verifyGeneration }));
        const headers = { etag: `"revision-${result.ticket.revision}"` };
        if (result.replayed) headers["idempotency-replayed"] = "true";
        authorityReply(res, 200, result.ticket, headers);
        return;
      }
      if (req.method === "POST" && pathname === "/v1/allowance") {
        const authenticated = await authorityPrincipal(req, "allowance:publish", configuration, authority);
        const requestBody = await authorityRequestBody(req);
        const verifyGeneration = authorityPrecommitVerifier(req, "allowance:publish", configuration, authority, authenticated);
        const result = await serializeAuthorityMutation(() => authority.publishAllowance(authenticated.principal, requestBody, { verifyGeneration }));
        const headers = result.replayed ? { "idempotency-replayed": "true" } : {};
        authorityReply(res, 200, authority.allowancePublishResponse(result, { instanceId }), headers);
        return;
      }
      throw new AuthorityError("not_found", { message: "authority route is unavailable" });
    } catch (error) {
      if (!res.headersSent) authorityError(res, error);
      else res.destroy();
    }
  }

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") process.exit(3);
    else {
      process.stderr.write("authority daemon listener failed\n");
      process.exit(1);
    }
  });
  server.listen(configuration.port, "127.0.0.1", () => {
    setImmediate(() => {
      if (shuttingDown) return;
      try {
        authority = openAuthorityState(configuration);
        reconcileTimer = setInterval(() => { void serializeAuthorityMutation(() => authority.reconcile()).catch(() => {}); }, 1_000);
        reconcileTimer.unref?.();
      } catch (error) {
        startupFault = error instanceof AuthorityError && error.code === "verifier_unavailable" ? "verifier_unavailable" : "authority_degraded";
      }
    });
  });
  function closeAuthorityServer() {
    return new Promise((resolve, reject) => {
      try {
        server.close((error) => {
          if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve();
          else if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        if (error?.code === "ERR_SERVER_NOT_RUNNING") resolve();
        else reject(error);
      }
    });
  }

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    if (reconcileTimer) clearInterval(reconcileTimer);
    const listenerClosed = closeAuthorityServer();
    let deadline;
    try {
      const writesSettled = Promise.all([mutationTail, authority?.awaitIdle() ?? Promise.resolve(), listenerClosed]);
      await Promise.race([
        writesSettled,
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error("authority shutdown timed out")), configuration.shutdownTimeoutMs); }),
      ]);
      if (authority?.status === "degraded") throw new Error("authority shutdown found a degraded state");
      process.exit(0);
    } catch {
      server.closeAllConnections?.();
      process.stderr.write("authority shutdown did not settle\n");
      process.exit(1);
    } finally {
      if (deadline) clearTimeout(deadline);
    }
  }
  process.on("SIGINT", () => { void shutdown(); });
  process.on("SIGTERM", () => { void shutdown(); });
}

function startLocalDaemon() {

function envInt(name, legacy, fallback, minimum = 1) {
  const value = process.env[name] ?? process.env[legacy];
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

const PORT = envInt("CLAUDE_PERMIT_GATE_PORT", "ANTHROPIC_PERMIT_GATE_PORT", 8790);
const PROVIDER = process.env.CLAUDE_PERMIT_GATE_PROVIDER || undefined;
const PROTOCOL_VERSION = 1;
const INSTANCE_ID = crypto.randomUUID();
const MIN = envInt("CLAUDE_PERMIT_GATE_MIN", "ANTHROPIC_PERMIT_GATE_MIN", 1);
const MAX = Math.max(MIN, envInt("CLAUDE_PERMIT_GATE_MAX", "ANTHROPIC_PERMIT_GATE_MAX", 2));
let current = Math.min(MAX, Math.max(MIN, envInt("CLAUDE_PERMIT_GATE_START", "ANTHROPIC_PERMIT_GATE_START", 2)));
const COOLDOWN_MS = envInt("CLAUDE_PERMIT_GATE_COOLDOWN_MS", "ANTHROPIC_PERMIT_GATE_COOLDOWN_MS", 20000, 1000);
const MAX_COOLDOWN_MS = envInt("CLAUDE_PERMIT_GATE_MAX_COOLDOWN_MS", "ANTHROPIC_PERMIT_GATE_MAX_COOLDOWN_MS", 60000, 1000);
const INCREASE_AFTER_MS = envInt("CLAUDE_PERMIT_GATE_INCREASE_AFTER_MS", "ANTHROPIC_PERMIT_GATE_INCREASE_AFTER_MS", 120000, 10000);
const PERMIT_TTL_MS = envInt("CLAUDE_PERMIT_GATE_PERMIT_TTL_MS", "ANTHROPIC_PERMIT_GATE_PERMIT_TTL_MS", 300000, 0);
const DIR = path.join(os.homedir(), ".pi", "agent", "claude-permit-gate");
const LOG = path.join(DIR, "permit-daemon.log");
const STATE = path.join(DIR, `permit-state-${PORT}.json`);
fs.mkdirSync(DIR, { recursive: true });

const stats = { startedAt: new Date().toISOString(), granted: 0, released: 0, cancelled: 0, expired: 0, throttles: 0, peakActive: 0, peakQueued: 0, peakOldestWaitMs: 0 };
const active = new Map();
const queues = new Map();
const roundRobin = [];
let cooldownUntil = 0;
let lastThrottleAt = 0;
let lastIncreaseAt = Date.now();
let pumpTimer;

function log(...parts) { fs.appendFile(LOG, `[${new Date().toISOString()}] [:${PORT}] ${parts.join(" ")}\n`, () => {}); }
function reply(res, status, body) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); }
function readBody(req) { return new Promise((resolve) => { let body = ""; req.on("data", (chunk) => { body += chunk; }); req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); } }); }); }
function daemonProvenance() { return { instanceId: INSTANCE_ID, provider: PROVIDER, protocolVersion: PROTOCOL_VERSION }; }
function expectedProvenanceMatches(body) {
  const hasExpectation = body?.expectedInstanceId !== undefined || body?.expectedProvider !== undefined || body?.expectedProtocolVersion !== undefined;
  return !hasExpectation || (body.expectedInstanceId === INSTANCE_ID && body.expectedProvider === PROVIDER && body.expectedProtocolVersion === PROTOCOL_VERSION);
}
function schedulePump(delay) { if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = undefined; pump(); }, Math.max(0, delay)); }

function saveState() {
  const state = {
    version: 1,
    current,
    cooldownUntil,
    lastThrottleAt,
    active: [...active.entries()].map(([permitId, permit]) => ({ permitId, session: permit.session, renewedAt: permit.renewedAt })),
  };
  const temporary = `${STATE}.${process.pid}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(state)); fs.renameSync(temporary, STATE); } catch { try { fs.unlinkSync(temporary); } catch {} }
}
function restoreState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    current = Math.min(MAX, Math.max(MIN, Number(state.current) || current));
    cooldownUntil = Math.max(0, Number(state.cooldownUntil) || 0);
    lastThrottleAt = Math.max(0, Number(state.lastThrottleAt) || 0);
    const now = Date.now();
    for (const permit of state.active || []) {
      if (!permit?.permitId || !permit?.renewedAt) continue;
      if (PERMIT_TTL_MS && now - permit.renewedAt > PERMIT_TTL_MS) continue;
      active.set(permit.permitId, { session: String(permit.session || "unknown"), grantedAt: permit.renewedAt, renewedAt: permit.renewedAt });
    }
    if (active.size || cooldownUntil > now) log(`restored ${active.size} active permit(s), concurrency ${current}, and ${Math.max(0, cooldownUntil - now)}ms cooldown`);
    saveState();
  } catch {}
}
function snapshot() {
  const now = Date.now(); let queued = 0; let oldestWaitMs = 0; const bySession = {};
  for (const [session, queue] of queues) {
    if (!queue.length) continue;
    queued += queue.length; bySession[session] = queue.length; oldestWaitMs = Math.max(oldestWaitMs, now - queue[0].enqueuedAt);
  }
  stats.peakQueued = Math.max(stats.peakQueued, queued); stats.peakOldestWaitMs = Math.max(stats.peakOldestWaitMs, oldestWaitMs);
  return { queued, oldestWaitMs, bySession };
}
function enqueue(session, res) {
  const request = { session, res, enqueuedAt: Date.now(), done: false };
  const queue = queues.get(session) ?? []; queues.set(session, queue); queue.push(request);
  if (!roundRobin.includes(session)) roundRobin.push(session);
  request.cancel = () => {
    if (request.permitId) {
      if (!request.responseFinished) releasePermit(request.permitId);
      return;
    }
    if (request.done) return;
    request.done = true; const items = queues.get(session); if (!items) return;
    const index = items.indexOf(request); if (index >= 0) items.splice(index, 1);
    if (!items.length) { queues.delete(session); const lane = roundRobin.indexOf(session); if (lane >= 0) roundRobin.splice(lane, 1); }
    stats.cancelled++;
  };
  res.on("close", request.cancel); pump();
}
function pump() {
  const pause = cooldownUntil - Date.now(); if (pause > 0) return schedulePump(pause);
  while (active.size < current && roundRobin.length) {
    const session = roundRobin.shift(); const queue = queues.get(session); if (!queue?.length) continue;
    const request = queue.shift(); if (queue.length) roundRobin.push(session); else queues.delete(session);
    if (request.done) continue;
    request.done = true;
    const permitId = crypto.randomUUID(); const now = Date.now(); request.permitId = permitId; active.set(permitId, { session, grantedAt: now, renewedAt: now }); saveState();
    stats.granted++; stats.peakActive = Math.max(stats.peakActive, active.size);
    request.res.once("finish", () => { request.responseFinished = true; request.res.removeListener("close", request.cancel); });
    reply(request.res, 200, { ok: true, permitId, waitedMs: now - request.enqueuedAt, current, max: MAX, permitTtlMs: PERMIT_TTL_MS, ...daemonProvenance() });
  }
}
function maybeIncrease() { const now = Date.now(); if (current >= MAX || now < cooldownUntil || now - lastThrottleAt < INCREASE_AFTER_MS || now - lastIncreaseAt < INCREASE_AFTER_MS) return; const before = current; current++; lastIncreaseAt = now; log(`clean window: concurrency ${before} -> ${current}`); pump(); }
function releasePermit(permitId) { if (!permitId || !active.delete(permitId)) return false; saveState(); stats.released++; maybeIncrease(); pump(); return true; }
function renewPermit(permitId) { const permit = active.get(permitId); if (!permit) return false; permit.renewedAt = Date.now(); saveState(); return true; }
function throttle(reason, requestedCooldown) { const effective = Math.min(Math.max(1000, Number(requestedCooldown) || COOLDOWN_MS), MAX_COOLDOWN_MS); stats.throttles++; lastThrottleAt = Date.now(); cooldownUntil = Math.min(Date.now() + MAX_COOLDOWN_MS, Math.max(cooldownUntil, Date.now() + effective)); const before = current; current = Math.max(MIN, current - 1); saveState(); log(`throttle(${reason}): concurrency ${before} -> ${current}; cooldown ${effective}ms`); schedulePump(effective); }
function sweepStalePermits() { if (!PERMIT_TTL_MS) return; const now = Date.now(); let expired = 0; for (const [id, permit] of active) { if (now - permit.renewedAt > PERMIT_TTL_MS) { active.delete(id); expired++; } } if (expired) { saveState(); stats.expired += expired; log(`reclaimed ${expired} unrenewed permit(s) older than ${PERMIT_TTL_MS}ms`); maybeIncrease(); pump(); } }

restoreState();
const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") { sweepStalePermits(); return reply(res, 200, { ok: true, version: 3, ...daemonProvenance(), active: active.size, min: MIN, current, max: MAX, cooldownMsRemaining: Math.max(0, cooldownUntil - Date.now()), ...snapshot(), ...stats }); }
  const body = await readBody(req);
  if (req.method === "POST" && req.url === "/acquire") {
    if (!expectedProvenanceMatches(body)) return reply(res, 409, { ok: false, retry: true, error: "daemon provenance does not match expected values", ...daemonProvenance() });
    return enqueue(String(body.session || "unknown"), res);
  }
  if (req.method === "POST" && req.url === "/renew") return reply(res, 200, { ok: renewPermit(body.permitId) });
  if (req.method === "POST" && req.url === "/release") return reply(res, 200, { ok: releasePermit(body.permitId) });
  if (req.method === "POST" && req.url === "/throttle") { throttle(String(body.reason || "unknown"), body.cooldownMs); if (body.permitId) releasePermit(body.permitId); return reply(res, 200, { ok: true, current, cooldownMsRemaining: Math.max(0, cooldownUntil - Date.now()) }); }
  reply(res, 404, { ok: false, error: "not found" });
});
server.on("error", (error) => { if (error.code === "EADDRINUSE") process.exit(3); log("server error", error.message); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => log(`permit daemon listening on 127.0.0.1:${PORT}; concurrency ${current}/${MAX}; cooldown<=${MAX_COOLDOWN_MS}ms; permitTtl ${PERMIT_TTL_MS}ms`));
const sweepTimer = setInterval(sweepStalePermits, 30000); sweepTimer.unref?.();
function shutdown() { saveState(); for (const queue of queues.values()) for (const request of queue) { if (!request.done) { request.done = true; request.res.removeListener("close", request.cancel); reply(request.res, 503, { ok: false, retry: true }); } } server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref?.(); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
}
