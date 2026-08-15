// Telemetry exists to answer whether the fixed cooldown is the right one, a
// question the cumulative counters cannot settle. These tests protect the two
// properties that decide whether the collected data means anything: a recovery
// must be attributed to a completed turn rather than to the failed request that
// reported the throttle, and it must exclude time the lane sat idle.
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
async function eventually(check, message) { const deadline = Date.now() + 3000; while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch {} await delay(20); } throw new Error(message); }
async function daemon(overrides = {}) {
  const port = await unusedPort(); const home = await fs.mkdtemp(path.join(os.tmpdir(), "pi-claude-permit-gate-telemetry-"));
  const child = spawn(process.execPath, [daemonPath], { env: { ...process.env, HOME: home, CLAUDE_PERMIT_GATE_PORT: String(port), CLAUDE_PERMIT_GATE_MIN: "1", CLAUDE_PERMIT_GATE_MAX: "1", CLAUDE_PERMIT_GATE_START: "1", CLAUDE_PERMIT_GATE_MAX_COOLDOWN_MS: "1000", ...overrides }, stdio: "ignore" });
  await eventually(async () => (await health(port)).ok, "daemon did not start");
  const file = path.join(home, ".pi", "agent", "claude-permit-gate", `telemetry-${port}.jsonl`);
  return {
    port, child, file,
    async records(type) {
      const raw = await fs.readFile(file, "utf8").catch(() => "");
      return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => !type || entry.type === type);
    },
    async stop() { if (child.exitCode === null) child.kill("SIGTERM"); if (child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve)); await fs.rm(home, { recursive: true, force: true }); },
  };
}

test("a throttle records the provider delay without applying it, and its own release is not a recovery", async (t) => {
  const gate = await daemon(); t.after(() => gate.stop());
  const held = await acquire(gate.port, "session-a");
  // The failing request reports the throttle and surrenders its permit in one
  // call. Counting that release as a recovery would report every provider
  // failure as an instant recovery.
  await request(gate.port, "POST", "/throttle", { permitId: held.body.permitId, reason: "assistant-rate-limit", cooldownMs: 20000, providerRetryMs: 2436000 });

  const throttles = await eventually(async () => { const rows = await gate.records("throttle"); return rows.length ? rows : undefined; }, "no throttle record");
  assert.equal(throttles[0].providerRetryMs, 2436000, "provider delay must be recorded for later analysis");
  assert.equal(throttles[0].appliedCooldownMs, 1000, "provider delay must not widen the applied cooldown");
  assert.equal(await gate.records("recovery").then((rows) => rows.length), 0, "the throttle's own release must not close the recovery window");

  // A completed assistant turn is the only evidence the lane is serving again.
  await delay(1100);
  const next = await acquire(gate.port, "session-a");
  await request(gate.port, "POST", "/release", { permitId: next.body.permitId, reason: "assistant-end" });
  const recoveries = await eventually(async () => { const rows = await gate.records("recovery"); return rows.length ? rows : undefined; }, "completed turn did not close the recovery window");
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].providerRetryMs, 2436000);
});

test("recovery time excludes the stretch where the lane had no work", async (t) => {
  const gate = await daemon(); t.after(() => gate.stop());
  const held = await acquire(gate.port, "session-a");
  await request(gate.port, "POST", "/throttle", { permitId: held.body.permitId, reason: "assistant-rate-limit", cooldownMs: 1000 });

  // Leave the lane completely empty. An idle lane is indistinguishable from a
  // blocked one unless this gap is subtracted, which is the flaw that made the
  // original session-log analysis unusable.
  await eventually(async () => (await health(gate.port)).active === 0, "lane did not drain");
  await delay(600);

  const next = await acquire(gate.port, "session-a");
  await request(gate.port, "POST", "/release", { permitId: next.body.permitId, reason: "assistant-end" });
  const [recovery] = await eventually(async () => { const rows = await gate.records("recovery"); return rows.length ? rows : undefined; }, "no recovery record");

  assert(recovery.idleMs >= 500, `idle stretch must be measured, got ${recovery.idleMs}ms`);
  assert(recovery.demandRecoveryMs < recovery.sinceThrottleMs, "recovery under demand must exclude idle time");
  assert(recovery.demandRecoveryMs <= recovery.sinceThrottleMs - recovery.idleMs + 50, "recovery under demand must be wall time minus idle time");
});

test("a release that is not a completed turn leaves the recovery window open", async (t) => {
  const gate = await daemon(); t.after(() => gate.stop());
  const held = await acquire(gate.port, "session-a");
  await request(gate.port, "POST", "/throttle", { permitId: held.body.permitId, reason: "assistant-rate-limit", cooldownMs: 1000 });
  await delay(1100);

  // An agent that exits, or a cancelled turn, proves nothing about the provider.
  const abandoned = await acquire(gate.port, "session-a");
  await request(gate.port, "POST", "/release", { permitId: abandoned.body.permitId, reason: "agent-end" });
  await delay(100);
  assert.equal(await gate.records("recovery").then((rows) => rows.length), 0, "a non-completing release must not count as recovery");
});
