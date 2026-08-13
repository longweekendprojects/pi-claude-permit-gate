import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const daemonPath = path.join(root, "permit-daemon.mjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { port } = server.address(); await new Promise((resolve) => server.close(resolve)); return port;
}
function request(port, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: "127.0.0.1", port, method, path: pathname, timeout: 5000, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : undefined }, (res) => {
      let text = ""; res.on("data", (chunk) => { text += chunk; }); res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(text || "{}") }); } catch (error) { reject(error); } });
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
