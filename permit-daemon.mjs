#!/usr/bin/env node
// Local permit daemon for direct Anthropic requests. It never proxies traffic.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

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
