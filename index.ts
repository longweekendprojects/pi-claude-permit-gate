// Shared local concurrency gate for direct Anthropic-family providers in Pi.
// It gates requests before provider transport, never proxies traffic or rewrites payloads.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PORTS: Record<string, number> = { anthropic: 8790, "anthropic-a": 8791, "anthropic-b": 8792, "anthropic-c": 8793, "anthropic-d": 8794 };
const DISABLED = process.env.CLAUDE_PERMIT_GATE_DISABLE === "1" || process.env.ANTHROPIC_PERMIT_GATE_DISABLE === "1";
const VERBOSE = process.env.CLAUDE_PERMIT_GATE_VERBOSE === "1" || process.env.ANTHROPIC_PERMIT_GATE_VERBOSE === "1";
const RETRY_MS = positiveEnvInt("CLAUDE_PERMIT_GATE_ACQUIRE_RETRY_MS", "ANTHROPIC_PERMIT_GATE_ACQUIRE_RETRY_MS", 500, 10);
const WARNING_ATTEMPTS = positiveEnvInt("CLAUDE_PERMIT_GATE_ACQUIRE_WARNING_ATTEMPTS", "ANTHROPIC_PERMIT_GATE_ACQUIRE_WARNING_ATTEMPTS", 600, 1);
const SPAWN_BACKOFF_MS = positiveEnvInt("CLAUDE_PERMIT_GATE_SPAWN_BACKOFF_MS", "ANTHROPIC_PERMIT_GATE_SPAWN_BACKOFF_MS", 1000, 100);
const MAX_SPAWN_BACKOFF_MS = positiveEnvInt("CLAUDE_PERMIT_GATE_MAX_SPAWN_BACKOFF_MS", "ANTHROPIC_PERMIT_GATE_MAX_SPAWN_BACKOFF_MS", 30000, SPAWN_BACKOFF_MS);

function positiveEnvInt(name: string, legacy: string, fallback: number, minimum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? process.env[legacy] ?? "", 10);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}
export function providerPorts(value = process.env.CLAUDE_PERMIT_GATE_PROVIDER_PORTS): Record<string, number> {
  if (!value) return { ...DEFAULT_PORTS };
  const parsed: Record<string, number> = {};
  for (const entry of value.split(",")) {
    const [provider, rawPort] = entry.split(":").map((part) => part.trim());
    const port = Number.parseInt(rawPort || "", 10);
    if (provider && Number.isInteger(port) && port > 0 && port < 65536) parsed[provider] = port;
  }
  return parsed;
}
const PROVIDER_PORTS = providerPorts();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type DaemonRecovery = { failures: number; nextSpawnAt: number; lastError?: string };
const daemonRecovery = new Map<number, DaemonRecovery>();
function recoveryFor(port: number): DaemonRecovery { const state = daemonRecovery.get(port) ?? { failures: 0, nextSpawnAt: 0 }; daemonRecovery.set(port, state); return state; }
function recoveryMessage(port: number): string | undefined { return daemonRecovery.get(port)?.lastError; }
function clearRecovery(port: number) { daemonRecovery.delete(port); }

function getJson<T = any>(port: number, pathname = "/health", timeoutMs = 1000): Promise<T | undefined> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}${pathname}`, { timeout: timeoutMs }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; }); res.on("end", () => { try { resolve(text ? JSON.parse(text) : undefined); } catch { resolve(undefined); } });
    });
    req.on("timeout", () => { req.destroy(); resolve(undefined); }); req.on("error", () => resolve(undefined));
  });
}
function postJson<T = any>(port: number, pathname: string, body: any, timeoutMs = 7200000, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const payload = JSON.stringify(body ?? {});
    const req = http.request(`http://127.0.0.1:${port}${pathname}`, { method: "POST", timeout: timeoutMs, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; }); res.on("end", () => { try { resolve(text ? JSON.parse(text) : {}); } catch (error) { reject(error); } });
    });
    const abort = () => req.destroy(abortError());
    signal?.addEventListener("abort", abort, { once: true });
    req.on("timeout", () => req.destroy(new Error("permit acquire timed out"))); req.on("error", reject); req.on("close", () => signal?.removeEventListener("abort", abort)); req.end(payload);
  });
}
function abortError() { return Object.assign(new Error("permit acquisition aborted"), { name: "AbortError" }); }
function isAborted(signal?: AbortSignal) { return signal?.aborted === true; }
function waitForRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (isAborted(signal)) { reject(abortError()); return; }
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); done(abortError()); };
    function done(error?: Error) { signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
function laneForProvider(provider: string): string | undefined { return provider.match(/^anthropic-([a-d])$/)?.[1]; }
function daemonEnv(port: number, provider: string): NodeJS.ProcessEnv {
  const lane = laneForProvider(provider)?.toUpperCase();
  const laneValue = (suffix: string) => lane ? process.env[`CLAUDE_LANE_${lane}_${suffix}`] : undefined;
  return {
    ...process.env,
    CLAUDE_PERMIT_GATE_PORT: String(port),
    CLAUDE_PERMIT_GATE_MAX: laneValue("MAX") ?? process.env.CLAUDE_PERMIT_GATE_MAX ?? process.env.ANTHROPIC_PERMIT_GATE_MAX ?? "2",
    CLAUDE_PERMIT_GATE_START: laneValue("START") ?? process.env.CLAUDE_PERMIT_GATE_START ?? process.env.ANTHROPIC_PERMIT_GATE_START ?? "2",
    CLAUDE_PERMIT_GATE_MIN: laneValue("MIN") ?? process.env.CLAUDE_PERMIT_GATE_MIN ?? process.env.ANTHROPIC_PERMIT_GATE_MIN ?? "1",
    CLAUDE_PERMIT_GATE_COOLDOWN_MS: laneValue("COOLDOWN_MS") ?? process.env.CLAUDE_PERMIT_GATE_COOLDOWN_MS ?? process.env.ANTHROPIC_PERMIT_GATE_COOLDOWN_MS ?? "20000",
    CLAUDE_PERMIT_GATE_MAX_COOLDOWN_MS: laneValue("MAX_COOLDOWN_MS") ?? process.env.CLAUDE_PERMIT_GATE_MAX_COOLDOWN_MS ?? process.env.ANTHROPIC_PERMIT_GATE_MAX_COOLDOWN_MS ?? "60000",
    CLAUDE_PERMIT_GATE_INCREASE_AFTER_MS: laneValue("INCREASE_AFTER_MS") ?? process.env.CLAUDE_PERMIT_GATE_INCREASE_AFTER_MS ?? process.env.ANTHROPIC_PERMIT_GATE_INCREASE_AFTER_MS ?? "120000",
    CLAUDE_PERMIT_GATE_PERMIT_TTL_MS: laneValue("PERMIT_TTL_MS") ?? process.env.CLAUDE_PERMIT_GATE_PERMIT_TTL_MS ?? process.env.ANTHROPIC_PERMIT_GATE_PERMIT_TTL_MS ?? "300000",
  };
}
async function ensureDaemon(directory: string, port: number, provider: string): Promise<void> {
  if ((await getJson(port))?.ok) { clearRecovery(port); return; }
  const state = recoveryFor(port);
  const now = Date.now();
  if (now < state.nextSpawnAt) throw new Error(`Claude permit daemon on port ${port} is retrying after startup failure: ${state.lastError ?? "daemon is unavailable"}`);

  state.failures++;
  const backoff = Math.min(MAX_SPAWN_BACKOFF_MS, SPAWN_BACKOFF_MS * 2 ** Math.min(state.failures - 1, 5));
  state.nextSpawnAt = now + backoff;
  state.lastError = `daemon launch pending; retrying in ${Math.ceil(backoff / 1000)}s`;
  try {
    const child = spawn(process.execPath, [path.join(directory, "permit-daemon.mjs")], { detached: true, stdio: "ignore", env: daemonEnv(port, provider) });
    child.once("error", (error) => { state.lastError = `could not start daemon on port ${port}: ${error.message}`; });
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) return;
      state.lastError = `daemon on port ${port} exited${signal ? ` from ${signal}` : ` with code ${code}`}; retrying in ${Math.ceil(backoff / 1000)}s`;
    });
    child.unref();
  } catch (error) {
    state.lastError = `could not start daemon on port ${port}: ${error instanceof Error ? error.message : String(error)}`;
    throw error;
  }
}

type Permit = { permitId: string; port: number; renewTimer?: ReturnType<typeof setInterval> };
let activePermit: Permit | undefined;
let sessionId = "unknown";
function startRenewal(permit: Permit, ttlMs: number) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const interval = Math.max(10, Math.min(60000, Math.floor(ttlMs / 3)));
  permit.renewTimer = setInterval(async () => { if (activePermit === permit) { try { await postJson(permit.port, "/renew", { permitId: permit.permitId }, 5000); } catch {} } }, interval);
  permit.renewTimer.unref?.();
}
export async function acquirePermitResponse(port: number, body: any, directory: string, options: { request?: (path: string, body: any, signal?: AbortSignal) => Promise<any>; ensure?: () => Promise<void>; wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>; onUnavailable?: (message: string) => void; warningAfterAttempts?: number; retryMs?: number; signal?: AbortSignal } = {}): Promise<any> {
  const signal = options.signal;
  let warned = false;
  for (let attempt = 1; ; attempt++) {
    if (isAborted(signal)) throw abortError();
    let response: any;
    try { response = await (options.request ?? ((pathname, payload, requestSignal) => postJson(port, pathname, payload, 7200000, requestSignal)))("/acquire", body, signal); } catch (error) { if (isAborted(signal) || (error as Error)?.name === "AbortError") throw abortError(); }
    if (response?.permitId) {
      if (isAborted(signal)) { await postJson(port, "/release", { permitId: response.permitId }, 5000).catch(() => {}); throw abortError(); }
      return response;
    }
    try { await (options.ensure ?? (() => ensureDaemon(directory, port, String(body.provider ?? "anthropic"))))(); } catch {}
    if (!warned && attempt >= (options.warningAfterAttempts ?? WARNING_ATTEMPTS)) {
      warned = true;
      const detail = recoveryMessage(port);
      options.onUnavailable?.(`Claude permit gate on port ${port} remains unavailable after ${attempt} attempts${detail ? `: ${detail}` : ""}. Provider request remains blocked.`);
    }
    await (options.wait ?? waitForRetry)(options.retryMs ?? RETRY_MS, signal);
  }
}
async function acquire(ctx: any, directory: string, port: number, provider: string) {
  if (activePermit || isAborted(ctx.signal)) return;
  ctx.ui?.setStatus?.("claude-permit-gate", "Claude: waiting for permit...");
  try {
    const response = await acquirePermitResponse(port, { session: sessionId, cwd: ctx.cwd, provider }, directory, { signal: ctx.signal, onUnavailable: (message) => { ctx.ui?.setStatus?.("claude-permit-gate", "Claude: blocked; permit gate unavailable"); ctx.ui?.notify?.(message, "error"); } });
    if (isAborted(ctx.signal)) { await postJson(port, "/release", { permitId: response.permitId }, 5000).catch(() => {}); return; }
    const permit: Permit = { permitId: String(response.permitId), port }; activePermit = permit; startRenewal(permit, Number(response.permitTtlMs || 0));
    const waited = Number(response.waitedMs || 0); ctx.ui?.setStatus?.("claude-permit-gate", waited > 1000 ? `Claude: permit after ${Math.round(waited / 1000)}s` : "Claude: permit active"); if (VERBOSE) ctx.ui?.notify?.(`Claude permit granted after ${waited}ms`, "info");
  } catch (error) {
    if (!isAborted(ctx.signal) && (error as Error)?.name !== "AbortError") throw error;
  } finally {
    if (isAborted(ctx.signal)) ctx.ui?.setStatus?.("claude-permit-gate", undefined);
  }
}
async function release(throttle: boolean, reason: string, cooldownMs?: number) {
  const permit = activePermit; if (!permit) return; activePermit = undefined; if (permit.renewTimer) clearInterval(permit.renewTimer);
  try { await postJson(permit.port, throttle ? "/throttle" : "/release", { permitId: permit.permitId, reason, cooldownMs }, 5000); } catch {}
}
function providerFailure(message: any): "rate-limit" | "overloaded" | undefined {
  if (message?.stopReason !== "error" || !message?.errorMessage) return undefined;
  const text = String(message.errorMessage); if (/overloaded_error|overloaded/i.test(text)) return "overloaded";
  return /rate.?limit|rate_limit_error|too many requests|429|529/i.test(text) && !/quota|billing|balance|insufficient/i.test(text) ? "rate-limit" : undefined;
}
function cooldown(failure: "rate-limit" | "overloaded") { return failure === "overloaded" ? Number(process.env.CLAUDE_PERMIT_GATE_OVERLOADED_COOLDOWN_MS || 60000) : Number(process.env.CLAUDE_PERMIT_GATE_RATE_LIMIT_COOLDOWN_MS || 20000); }

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  pi.on("session_start", async (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); const port = ctx.model && PROVIDER_PORTS[ctx.model.provider]; if (port) { try { await ensureDaemon(directory, port, ctx.model.provider); } catch {} if (ctx.hasUI) ctx.ui.setStatus("claude-permit-gate", "Claude gate: ready"); } });
  pi.on("model_select", async (event: any, ctx: any) => { if (!ctx.hasUI) return; ctx.ui.setStatus("claude-permit-gate", PROVIDER_PORTS[event.model?.provider] ? "Claude gate: ready" : undefined); });
  pi.on("before_provider_request", async (_event, ctx) => { const provider = ctx.model?.provider; const port = provider && PROVIDER_PORTS[provider]; if (!provider || !port) return undefined; try { await ensureDaemon(directory, port, provider); } catch {} await acquire(ctx, directory, port, provider); return undefined; });
  pi.on("message_end", async (event, ctx) => { if (!activePermit || event.message.role !== "assistant") return undefined; const failure = providerFailure(event.message); await release(!!failure, failure ? `assistant-${failure}` : "assistant-end", failure ? cooldown(failure) : undefined); if (ctx.hasUI && PROVIDER_PORTS[ctx.model?.provider]) ctx.ui.setStatus("claude-permit-gate", "Claude gate: ready"); return undefined; });
  pi.on("agent_end", async () => { await release(false, "agent-end"); });
  pi.on("session_shutdown", async () => { await release(false, "session-shutdown"); });
  pi.registerCommand("claude-permit", { description: "Show Claude permit gate status: /claude-permit", handler: async (_args, ctx) => { const lines = ["Claude permit gate:"]; for (const [provider, port] of Object.entries(PROVIDER_PORTS)) { const health: any = await getJson(port); const unavailable = recoveryMessage(port); lines.push(health?.ok ? `  ${provider} (${port}): active ${health.active}, queued ${health.queued}, concurrency ${health.current}/${health.max}, throttles ${health.throttles}` : `  ${provider} (${port}): ${unavailable ?? "daemon stopped"}`); } ctx.ui.notify(lines.join("\n"), "info"); } });
}
