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

const COMPATIBILITIES = ["current", "legacy", "incompatible", "invalidOrUnavailable"] as const;
const PROTOCOL_VERSION = 1;
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNAVAILABLE_HEALTH = "health is unavailable or invalid";
export type DaemonCompatibility = (typeof COMPATIBILITIES)[number];
type HealthRecord = Record<string, unknown>;
type DaemonProvenance = { instanceId: string; provider: string; protocolVersion: number };
export type DaemonHealthClassification = { compatibility: DaemonCompatibility; health?: HealthRecord; diagnostic: string };
export type EnsureDaemonResult = DaemonHealthClassification & { spawned: boolean };
type HealthProbe = (signal?: AbortSignal) => Promise<unknown>;
type SpawnedDaemon = { once(event: string, listener: (...args: any[]) => void): unknown; unref(): unknown };
type EnsureDaemonOptions = { signal?: AbortSignal; probe?: HealthProbe; spawnDaemon?: (directory: string, port: number, provider: string) => SpawnedDaemon };

function isHealthRecord(value: unknown): value is HealthRecord { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isInstanceId(value: unknown): value is string { return typeof value === "string" && INSTANCE_ID_PATTERN.test(value); }
function isCompatibleHealth(result: DaemonHealthClassification): boolean { return result.compatibility === "current" || result.compatibility === "legacy"; }
export function classifyDaemonHealth(health: unknown, expectedProvider: string): DaemonHealthClassification {
  if (!isHealthRecord(health)) return { compatibility: "invalidOrUnavailable", diagnostic: UNAVAILABLE_HEALTH };
  if (health.ok !== true) return { compatibility: "invalidOrUnavailable", health, diagnostic: UNAVAILABLE_HEALTH };
  const hasProvider = health.provider !== undefined;
  const hasProtocol = health.protocolVersion !== undefined;
  const hasInstanceId = health.instanceId !== undefined;
  if (hasProvider && typeof health.provider !== "string") return { compatibility: "invalidOrUnavailable", health, diagnostic: "health provider is invalid" };
  if (hasProtocol && typeof health.protocolVersion !== "number") return { compatibility: "invalidOrUnavailable", health, diagnostic: "health protocol version is invalid" };
  if (hasInstanceId && !isInstanceId(health.instanceId)) return { compatibility: "invalidOrUnavailable", health, diagnostic: "health instance identity is invalid" };
  if (hasProvider && health.provider !== expectedProvider) return { compatibility: "incompatible", health, diagnostic: `provider ${JSON.stringify(health.provider)} does not match expected ${JSON.stringify(expectedProvider)}` };
  if (hasProtocol && health.protocolVersion !== PROTOCOL_VERSION) return { compatibility: "incompatible", health, diagnostic: `protocol ${health.protocolVersion} is unsupported; expected ${PROTOCOL_VERSION}` };
  if (!hasProvider || !hasProtocol || !hasInstanceId) return { compatibility: "legacy", health, diagnostic: "health omits provider, protocol, or instance identity; restart when idle" };
  return { compatibility: "current", health, diagnostic: "provider, protocol, and instance identity match" };
}

function getJson<T = any>(port: number, pathname = "/health", timeoutMs = 1000, signal?: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false; let req: ReturnType<typeof http.get> | undefined;
    function finish(value: T | undefined) { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); resolve(value); }
    function abort() { req?.destroy(); finish(undefined); }
    if (signal?.aborted) { finish(undefined); return; }
    signal?.addEventListener("abort", abort, { once: true });
    req = http.get(`http://127.0.0.1:${port}${pathname}`, { timeout: timeoutMs }, (res) => {
      let text = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { text += chunk; }); res.on("error", () => finish(undefined)); res.on("end", () => { try { finish(text ? JSON.parse(text) : undefined); } catch { finish(undefined); } });
    });
    req.on("timeout", () => { req?.destroy(); finish(undefined); }); req.on("error", () => finish(undefined));
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
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
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
    CLAUDE_PERMIT_GATE_PROVIDER: provider,
    CLAUDE_PERMIT_GATE_MAX: laneValue("MAX") ?? process.env.CLAUDE_PERMIT_GATE_MAX ?? process.env.ANTHROPIC_PERMIT_GATE_MAX ?? "2",
    CLAUDE_PERMIT_GATE_START: laneValue("START") ?? process.env.CLAUDE_PERMIT_GATE_START ?? process.env.ANTHROPIC_PERMIT_GATE_START ?? "2",
    CLAUDE_PERMIT_GATE_MIN: laneValue("MIN") ?? process.env.CLAUDE_PERMIT_GATE_MIN ?? process.env.ANTHROPIC_PERMIT_GATE_MIN ?? "1",
    CLAUDE_PERMIT_GATE_COOLDOWN_MS: laneValue("COOLDOWN_MS") ?? process.env.CLAUDE_PERMIT_GATE_COOLDOWN_MS ?? process.env.ANTHROPIC_PERMIT_GATE_COOLDOWN_MS ?? "20000",
    CLAUDE_PERMIT_GATE_MAX_COOLDOWN_MS: laneValue("MAX_COOLDOWN_MS") ?? process.env.CLAUDE_PERMIT_GATE_MAX_COOLDOWN_MS ?? process.env.ANTHROPIC_PERMIT_GATE_MAX_COOLDOWN_MS ?? "60000",
    CLAUDE_PERMIT_GATE_INCREASE_AFTER_MS: laneValue("INCREASE_AFTER_MS") ?? process.env.CLAUDE_PERMIT_GATE_INCREASE_AFTER_MS ?? process.env.ANTHROPIC_PERMIT_GATE_INCREASE_AFTER_MS ?? "120000",
    CLAUDE_PERMIT_GATE_PERMIT_TTL_MS: laneValue("PERMIT_TTL_MS") ?? process.env.CLAUDE_PERMIT_GATE_PERMIT_TTL_MS ?? process.env.ANTHROPIC_PERMIT_GATE_PERMIT_TTL_MS ?? "300000",
  };
}
function launchDaemon(directory: string, port: number, provider: string): SpawnedDaemon {
  return spawn(process.execPath, [path.join(directory, "permit-daemon.mjs")], { detached: true, stdio: "ignore", env: daemonEnv(port, provider) });
}
async function probeHealth(probe: HealthProbe, provider: string, signal?: AbortSignal): Promise<DaemonHealthClassification> {
  let health: unknown;
  try { health = await probe(signal); } catch {}
  return classifyDaemonHealth(health, provider);
}
async function occupiedPortRecovery(port: number, provider: string, probe: HealthProbe) {
  const result = await probeHealth(probe, provider);
  if (isCompatibleHealth(result)) { clearRecovery(port); return; }
  recoveryFor(port).lastError = `daemon launch found an occupied port: ${result.diagnostic}`;
}
export async function ensureDaemon(directory: string, port: number, provider: string, options: EnsureDaemonOptions = {}): Promise<EnsureDaemonResult> {
  const signal = options.signal;
  const probe = options.probe ?? ((probeSignal?: AbortSignal) => getJson(port, "/health", 1000, probeSignal));
  if (isAborted(signal)) throw abortError();
  const result = await probeHealth(probe, provider, signal);
  if (isAborted(signal)) throw abortError();
  if (isCompatibleHealth(result)) { clearRecovery(port); return { ...result, spawned: false }; }
  const state = recoveryFor(port);
  if (result.compatibility === "incompatible") { state.lastError = result.diagnostic; return { ...result, spawned: false }; }
  const now = Date.now();
  if (now < state.nextSpawnAt) return { ...result, diagnostic: state.lastError ?? result.diagnostic, spawned: false };

  state.failures++;
  const backoff = Math.min(MAX_SPAWN_BACKOFF_MS, SPAWN_BACKOFF_MS * 2 ** Math.min(state.failures - 1, 5));
  state.nextSpawnAt = now + backoff;
  state.lastError = `daemon launch pending; retrying in ${Math.ceil(backoff / 1000)}s`;
  try {
    const child = (options.spawnDaemon ?? launchDaemon)(directory, port, provider);
    child.once("error", (error: Error) => { recoveryFor(port).lastError = `could not start daemon on port ${port}: ${error.message}`; });
    child.once("exit", (code: number | null, signal: string | null) => {
      if (code === 3 && !signal) { void occupiedPortRecovery(port, provider, probe); return; }
      if (code === 0 && !signal) return;
      recoveryFor(port).lastError = `daemon on port ${port} exited${signal ? ` from ${signal}` : ` with code ${code}`}; retrying in ${Math.ceil(backoff / 1000)}s`;
    });
    child.unref();
    return { ...result, diagnostic: state.lastError, spawned: true };
  } catch (error) {
    state.lastError = `could not start daemon on port ${port}: ${errorText(error)}`;
    return { ...result, diagnostic: state.lastError, spawned: false };
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
type AcquirePermitOptions = { request?: (path: string, body: any, signal?: AbortSignal) => Promise<any>; release?: (body: any, signal?: AbortSignal) => Promise<unknown>; ensure?: (signal?: AbortSignal) => Promise<EnsureDaemonResult>; wait?: (ms: number, signal?: AbortSignal) => Promise<unknown>; onUnavailable?: (message: string) => void; warningAfterAttempts?: number; retryMs?: number; signal?: AbortSignal };
type ProvenanceValidation = { matches: boolean; diagnostic: string };
function unavailableEnsureResult(diagnostic: string): EnsureDaemonResult { return { compatibility: "invalidOrUnavailable", diagnostic, spawned: false }; }
function isEnsureDaemonResult(value: unknown): value is EnsureDaemonResult { return isHealthRecord(value) && typeof value.diagnostic === "string" && typeof value.spawned === "boolean" && (COMPATIBILITIES as readonly string[]).includes(String(value.compatibility)); }
function currentProvenance(result: EnsureDaemonResult): DaemonProvenance | undefined {
  const health = result.health;
  if (result.compatibility !== "current" || !health || !isInstanceId(health.instanceId) || typeof health.provider !== "string" || health.protocolVersion !== PROTOCOL_VERSION) return undefined;
  return { instanceId: health.instanceId, provider: health.provider, protocolVersion: health.protocolVersion };
}
function stableHealthIdentity(health?: HealthRecord): string | undefined {
  const startedAt = health?.startedAt;
  return parseDaemonStartedAt(startedAt) === undefined ? undefined : startedAt;
}
function acquireRequestBody(body: any, provenance: DaemonProvenance | undefined): any {
  if (!provenance) return body;
  return { ...body, expectedInstanceId: provenance.instanceId, expectedProvider: provenance.provider, expectedProtocolVersion: provenance.protocolVersion };
}
async function preflightDaemon(ensure: NonNullable<AcquirePermitOptions["ensure"]>, signal?: AbortSignal): Promise<EnsureDaemonResult> {
  try {
    const ensured = await ensure(signal);
    return isEnsureDaemonResult(ensured) ? ensured : unavailableEnsureResult(UNAVAILABLE_HEALTH);
  } catch (error) {
    if (isAborted(signal) || (error as Error)?.name === "AbortError") throw abortError();
    return unavailableEnsureResult(errorText(error));
  }
}
async function validateAcquiredPermitProvenance(preflight: EnsureDaemonResult, response: unknown, ensure: NonNullable<AcquirePermitOptions["ensure"]>, signal?: AbortSignal): Promise<ProvenanceValidation> {
  const provenance = currentProvenance(preflight);
  if (preflight.compatibility === "current") {
    const matches = provenance !== undefined && isHealthRecord(response) && response.instanceId === provenance.instanceId && response.provider === provenance.provider && response.protocolVersion === provenance.protocolVersion;
    return { matches, diagnostic: matches ? "acquire response matches preflight provenance" : "acquire response does not match preflight daemon provenance" };
  }
  const identity = stableHealthIdentity(preflight.health);
  if (!identity) return { matches: false, diagnostic: "legacy health has no stable startedAt identity" };
  const postflight = await preflightDaemon(ensure, signal);
  const matches = isCompatibleHealth(postflight) && stableHealthIdentity(postflight.health) === identity;
  return { matches, diagnostic: matches ? "legacy health identity matches after acquire" : `legacy daemon identity changed during acquire: ${postflight.diagnostic}` };
}
export async function acquirePermitResponse(port: number, body: any, directory: string, options: AcquirePermitOptions = {}): Promise<any> {
  const signal = options.signal;
  const expectedProvider = String(body.provider ?? "anthropic");
  const ensure = options.ensure ?? ((ensureSignal?: AbortSignal) => ensureDaemon(directory, port, expectedProvider, { signal: ensureSignal }));
  const request = options.request ?? ((pathname: string, payload: any, requestSignal?: AbortSignal) => postJson(port, pathname, payload, 7200000, requestSignal));
  const releasePermit = options.release ?? ((payload: any, releaseSignal?: AbortSignal) => postJson(port, "/release", payload, 5000, releaseSignal));
  const wait = options.wait ?? waitForRetry;
  const warningAfterAttempts = options.warningAfterAttempts ?? WARNING_ATTEMPTS;
  const retryMs = options.retryMs ?? RETRY_MS;
  const releaseAcquiredPermit = async (permitId: unknown) => { try { await releasePermit({ permitId }); } catch {} };
  let warned = false; let reportedIncompatibility = false; let lastDiagnostic = UNAVAILABLE_HEALTH;
  for (let attempt = 1; ; attempt++) {
    if (isAborted(signal)) throw abortError();
    const preflight = await preflightDaemon(ensure, signal);
    lastDiagnostic = preflight.diagnostic;
    if (isAborted(signal)) throw abortError();
    let response: any;
    if (isCompatibleHealth(preflight)) {
      try { response = await request("/acquire", acquireRequestBody(body, currentProvenance(preflight)), signal); } catch (error) { if (isAborted(signal) || (error as Error)?.name === "AbortError") throw abortError(); }
    }
    if (response?.permitId) {
      let validation: ProvenanceValidation;
      try { validation = await validateAcquiredPermitProvenance(preflight, response, ensure, signal); } catch (error) {
        await releaseAcquiredPermit(response.permitId);
        if (isAborted(signal) || (error as Error)?.name === "AbortError") throw abortError();
        validation = { matches: false, diagnostic: errorText(error) };
      }
      if (isAborted(signal)) { await releaseAcquiredPermit(response.permitId); throw abortError(); }
      if (validation.matches) return response;
      lastDiagnostic = validation.diagnostic;
      await releaseAcquiredPermit(response.permitId);
    }
    if (preflight.compatibility === "incompatible" && !reportedIncompatibility) {
      reportedIncompatibility = true;
      options.onUnavailable?.(`Claude permit gate on port ${port} is incompatible: ${preflight.diagnostic}. Provider request remains blocked. Restart it only during approved idle maintenance.`);
    }
    if (!warned && attempt >= warningAfterAttempts) {
      warned = true;
      const detail = recoveryMessage(port) ?? lastDiagnostic;
      options.onUnavailable?.(`Claude permit gate on port ${port} remains unavailable after ${attempt} attempts${detail ? `: ${detail}` : ""}. Provider request remains blocked.`);
    }
    await wait(retryMs, signal);
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
function parseDaemonStartedAt(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : undefined;
}
function formatDaemonAge(startedAt: unknown): string {
  const timestamp = parseDaemonStartedAt(startedAt); if (timestamp === undefined) return "unknown";
  const seconds = Math.floor(Math.max(0, Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function doctorLine(provider: string, port: number, rawHealth: unknown, unavailable?: string): string {
  const result = classifyDaemonHealth(rawHealth, provider); const health = result.health;
  const schema = typeof health?.version === "number" ? `v${health.version}` : "unknown";
  const protocol = typeof health?.protocolVersion === "number" ? String(health.protocolVersion) : "absent";
  const owner = typeof health?.provider === "string" ? health.provider : "absent";
  const compatibility = result.compatibility === "legacy" ? "legacy (restart when idle)" : result.compatibility;
  const count = (field: string) => typeof health?.[field] === "number" ? String(health[field]) : "unknown";
  const state = health?.ok === true ? `; active ${count("active")}, queued ${count("queued")}, concurrency ${count("current")}/${count("max")}, throttles ${count("throttles")}` : `; ${unavailable ?? result.diagnostic}`;
  return `  ${provider} (${port}): compatibility ${compatibility}; schema ${schema}; protocol ${protocol}; provider ${owner}; daemon age ${formatDaemonAge(health?.startedAt)}${state}`;
}

export default function (pi: ExtensionAPI) {
  if (DISABLED) return;
  const directory = path.dirname(fileURLToPath(import.meta.url));
  pi.on("session_start", async (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); const port = ctx.model && PROVIDER_PORTS[ctx.model.provider]; if (port) { try { await ensureDaemon(directory, port, ctx.model.provider); } catch {} if (ctx.hasUI) ctx.ui.setStatus("claude-permit-gate", "Claude gate: ready"); } });
  pi.on("model_select", async (event: any, ctx: any) => { if (!ctx.hasUI) return; ctx.ui.setStatus("claude-permit-gate", PROVIDER_PORTS[event.model?.provider] ? "Claude gate: ready" : undefined); });
  pi.on("before_provider_request", async (_event, ctx) => { const provider = ctx.model?.provider; const port = provider && PROVIDER_PORTS[provider]; if (!provider || !port) return undefined; try { await ensureDaemon(directory, port, provider); } catch {} await acquire(ctx, directory, port, provider); return undefined; });
  pi.on("message_end", async (event, ctx) => { if (!activePermit || event.message.role !== "assistant") return undefined; const failure = providerFailure(event.message); await release(!!failure, failure ? `assistant-${failure}` : "assistant-end", failure ? cooldown(failure) : undefined); if (ctx.hasUI && PROVIDER_PORTS[ctx.model?.provider]) ctx.ui.setStatus("claude-permit-gate", "Claude gate: ready"); return undefined; });
  pi.on("agent_end", async () => { await release(false, "agent-end"); });
  pi.on("session_shutdown", async () => { await release(false, "session-shutdown"); });
  pi.registerCommand("claude-permit", { description: "Show Claude permit gate status: /claude-permit", handler: async (_args, ctx) => { const lines = ["Claude permit gate doctor:"]; for (const [provider, port] of Object.entries(PROVIDER_PORTS)) { const health = await getJson<unknown>(port); lines.push(doctorLine(provider, port, health, recoveryMessage(port))); } ctx.ui.notify(lines.join("\n"), "info"); } });
}
