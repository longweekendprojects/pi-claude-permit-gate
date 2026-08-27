import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const PROVIDER_PORTS = Object.freeze({ "anthropic-a": 8791, "anthropic-b": 8792, "anthropic-c": 8793, "anthropic-d": 8794 });
const LANE_IDS = Object.freeze({ "anthropic-a": "A", "anthropic-b": "B", "anthropic-c": "C", "anthropic-d": "D" });
const TICKET_STATES = new Set(["queued", "offered", "active", "uncertain", "cancelled", "released", "throttled", "offerExpired"]);
const TERMINAL_STATES = new Set(["cancelled", "released", "throttled", "offerExpired"]);
const ACTIVE_STATES = new Set(["offered", "active", "uncertain"]);
const WINDOW_STATUSES = new Set(["allowed", "allowed_warning", "rejected", "active", "warning", "rate_limited"]);
const MAX_INSTALLATIONS = 32;
const MAX_SESSIONS_PER_INSTALLATION = 32;
const MAX_NONTERMINAL_PER_SESSION = 16;
const MAX_NONTERMINAL_PER_INSTALLATION = 64;
const MAX_NONTERMINAL_PER_LANE = 256;
const MAX_RETAINED_RECORDS = 4096;
const MAX_OPERATION_RESULTS = 32;
const MAX_ALLOWANCE_REPLAYS_PER_INSTALLATION = 256;
const MAX_REQUEST_AGE_MS = 30_000;
const STATE_SCHEMA_VERSION = 2;

const ERROR_STATUS = Object.freeze({
  invalid_json: 400,
  invalid_request: 400,
  unsupported_schema: 400,
  unauthenticated: 401,
  forbidden_scope: 403,
  forbidden_lane: 403,
  not_found: 404,
  provider_mismatch: 409,
  authority_mismatch: 409,
  account_binding_mismatch: 409,
  stale_revision: 409,
  invalid_transition: 409,
  operation_conflict: 409,
  principal_limit: 429,
  lane_limit: 429,
  authority_starting: 503,
  authority_draining: 503,
  authority_degraded: 503,
  persistence_unavailable: 503,
  verifier_unavailable: 503,
});

export class AuthorityError extends Error {
  constructor(code, options = {}) {
    const retryable = options.retryable ?? (code === "principal_limit" || code === "lane_limit");
    const retryAfterMs = options.retryAfterMs ?? (retryable ? 1_000 : null);
    super(options.message ?? "request rejected");
    this.name = "AuthorityError";
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 503;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

export class StateFault extends AuthorityError {
  constructor(message = "authority state is unavailable") {
    super("persistence_unavailable", { message });
    this.name = "StateFault";
  }
}

function fail(code, message) {
  throw new AuthorityError(code, { message });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return structuredClone(value);
}

function isSafeInteger(value, minimum = 0, maximum = MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function assertExactObject(value, required, optional = []) {
  if (!isObject(value)) fail("invalid_request", "request must be an object");
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("invalid_request", "request has an unknown field");
  for (const key of required) if (!(key in value)) fail("invalid_request", "request is missing a required field");
}

function assertUuid(value) {
  if (!isUuid(value)) fail("invalid_request", "request has an invalid identifier");
}

function assertSchemaVersion(value) {
  if (value !== 1) fail("unsupported_schema", "request schema is unsupported");
}

function assertProvider(value) {
  if (!(value in PROVIDER_PORTS)) fail("invalid_request", "request provider is invalid");
}

function assertSafeInteger(value, minimum = 0) {
  if (!isSafeInteger(value, minimum)) fail("invalid_request", "request number is invalid");
}

function assertPrincipal(principal) {
  if (!isObject(principal) || !isUuid(principal.installationId)) fail("unauthenticated", "principal is unavailable");
  const providers = principal.providers ?? Object.keys(PROVIDER_PORTS);
  if (!Array.isArray(providers) || !providers.every((provider) => provider in PROVIDER_PORTS)) fail("unauthenticated", "principal is unavailable");
  if (principal.accountBindingId !== undefined && !isUuid(principal.accountBindingId)) fail("unauthenticated", "principal is unavailable");
  return { installationId: principal.installationId, providers: new Set(providers), accountBindingId: principal.accountBindingId };
}

function assertPrincipalMatches(principal, request) {
  const checked = assertPrincipal(principal);
  if (checked.installationId !== request.installationId) fail("unauthenticated", "installation does not match principal");
  if (!checked.providers.has(request.provider)) fail("forbidden_lane", "lane is not allowed");
  if (checked.accountBindingId && checked.accountBindingId !== request.accountBindingId) fail("account_binding_mismatch", "account binding does not match principal");
  return checked;
}

function timingDigest(timing) {
  return crypto.createHash("sha256").update(JSON.stringify({
    schemaVersion: 1,
    offerTtlMs: timing.offerTtlMs,
    renewIntervalMs: timing.renewIntervalMs,
    renewDeadlineMs: timing.renewDeadlineMs,
    terminalRetentionMs: timing.terminalRetentionMs,
  })).digest("hex");
}

export function validateAuthorityTiming(value) {
  if (!isObject(value)) throw new StateFault("authority timing is invalid");
  const timing = {
    offerTtlMs: value.offerTtlMs,
    renewIntervalMs: value.renewIntervalMs,
    renewDeadlineMs: value.renewDeadlineMs,
    terminalRetentionMs: value.terminalRetentionMs,
  };
  if (!isSafeInteger(timing.offerTtlMs, 5_000, 120_000)
    || !isSafeInteger(timing.renewIntervalMs, 5_000, 300_000)
    || !isSafeInteger(timing.renewDeadlineMs, 15_000, 3_600_000)
    || !isSafeInteger(timing.terminalRetentionMs, 86_400_000)) {
    throw new StateFault("authority timing is outside the protocol bounds");
  }
  if (timing.renewDeadlineMs < timing.renewIntervalMs * 3) throw new StateFault("authority renew deadline is unsafe");
  return { ...timing, digest: timingDigest(timing) };
}

export function authorityTimingFromEnvironment(env = process.env) {
  const names = {
    offerTtlMs: "CLAUDE_PERMIT_GATE_OFFER_TTL_MS",
    renewIntervalMs: "CLAUDE_PERMIT_GATE_RENEW_INTERVAL_MS",
    renewDeadlineMs: "CLAUDE_PERMIT_GATE_RENEW_DEADLINE_MS",
    terminalRetentionMs: "CLAUDE_PERMIT_GATE_TERMINAL_RETENTION_MS",
  };
  const timing = {};
  for (const [field, name] of Object.entries(names)) {
    const source = env[name];
    if (!/^\d+$/.test(source ?? "")) throw new StateFault(`${name} is required in authority mode`);
    timing[field] = Number(source);
  }
  return validateAuthorityTiming(timing);
}

function defaultStateDirectory(home) {
  return path.join(home, "Library", "Application Support", "Claude Permit Authority", "lanes");
}

export function authorityStatePath({ home, stateDirectory, port }) {
  return path.join(stateDirectory || defaultStateDirectory(home), `lane-${port}.json`);
}

function stateHeader(state) {
  return {
    stateSchemaVersion: state.stateSchemaVersion,
    authorityId: state.authorityId,
    provider: state.provider,
    port: state.port,
    laneTerm: state.laneTerm,
    ownerNonce: state.ownerNonce,
    timingSchemaVersion: state.timingSchemaVersion,
    timingDigest: state.timingDigest,
    verifierGeneration: state.verifierGeneration,
  };
}

function sameHeader(left, right) {
  return Object.keys(stateHeader(left)).every((key) => left[key] === right[key]);
}

function stateKeys() {
  return [
    "stateSchemaVersion", "authorityId", "provider", "port", "laneTerm", "ownerNonce", "timingSchemaVersion", "timingDigest", "verifierGeneration",
    "lifecycleState", "scheduler", "tickets", "createTombstones", "fairness", "allowance", "allowancePublishes", "publisherSequences", "counters",
  ];
}

function validateWindow(window) {
  if (window === null) return;
  if (!isObject(window) || Object.keys(window).length !== 3 || !("utilization" in window) || !("status" in window) || !("resetEpochSeconds" in window)) throw new StateFault("allowance window is invalid");
  if (typeof window.utilization !== "number" || !Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization > 1_000) throw new StateFault("allowance utilization is invalid");
  if (window.status !== null && !WINDOW_STATUSES.has(window.status)) throw new StateFault("allowance status is invalid");
  if (!isSafeInteger(window.resetEpochSeconds, 1, 253_402_300_799)) throw new StateFault("allowance reset is invalid");
}

function validateLease(lease) {
  const keys = ["leaseId", "generation", "claimedAtEpochMs", "renewSequence", "renewByEpochMs", "serverDeadlineEpochMs"];
  if (!isObject(lease) || Object.keys(lease).length !== keys.length || keys.some((key) => !(key in lease)) || !isUuid(lease.leaseId) || !isSafeInteger(lease.generation, 1) || !isSafeInteger(lease.claimedAtEpochMs) || !isSafeInteger(lease.renewSequence) || !isSafeInteger(lease.renewByEpochMs) || !isSafeInteger(lease.serverDeadlineEpochMs) || lease.serverDeadlineEpochMs < lease.renewByEpochMs) throw new StateFault("ticket lease is invalid");
}

function validateTicketState(ticket) {
  const keys = ["ticketId", "requestId", "provider", "installationId", "accountBindingId", "sessionId", "state", "revision", "createdAtEpochMs", "enqueuedAtEpochMs", "offeredAtEpochMs", "offerExpiresAtEpochMs", "terminalAtEpochMs", "terminalReason", "lease", "operationResults", "createResponse", "queueSequence"];
  if (!isObject(ticket) || Object.keys(ticket).length !== keys.length || keys.some((key) => !(key in ticket)) || !isUuid(ticket.ticketId) || !isUuid(ticket.requestId) || !(ticket.provider in PROVIDER_PORTS) || !isUuid(ticket.installationId) || !isUuid(ticket.accountBindingId) || !isUuid(ticket.sessionId)) throw new StateFault("ticket identity is invalid");
  if (!TICKET_STATES.has(ticket.state) || !isSafeInteger(ticket.revision, 1) || !isSafeInteger(ticket.createdAtEpochMs) || !isSafeInteger(ticket.enqueuedAtEpochMs) || !isSafeInteger(ticket.queueSequence, 1)) throw new StateFault("ticket state is invalid");
  if (ticket.offeredAtEpochMs !== null && !isSafeInteger(ticket.offeredAtEpochMs)) throw new StateFault("ticket offer is invalid");
  if (ticket.offerExpiresAtEpochMs !== null && !isSafeInteger(ticket.offerExpiresAtEpochMs)) throw new StateFault("ticket offer deadline is invalid");
  if (ticket.terminalAtEpochMs !== null && !isSafeInteger(ticket.terminalAtEpochMs)) throw new StateFault("ticket terminal state is invalid");
  if (![null, "client_cancelled", "authority_draining", "offer_expired", "released", "assistant_rate_limit", "assistant_overloaded", "operator_reconciled"].includes(ticket.terminalReason)) throw new StateFault("ticket terminal reason is invalid");
  if (!Array.isArray(ticket.operationResults) || ticket.operationResults.length > MAX_OPERATION_RESULTS || ticket.operationResults.some((result) => !isObject(result) || !isUuid(result.operationId) || typeof result.fingerprint !== "string" || !isObject(result.response) || !isSafeInteger(result.recordedAtEpochMs))) throw new StateFault("ticket operation ledger is invalid");
  if (ticket.createResponse !== null && !isObject(ticket.createResponse)) throw new StateFault("ticket replay state is invalid");
  if (ticket.state === "queued") {
    if (ticket.offeredAtEpochMs !== null || ticket.offerExpiresAtEpochMs !== null || ticket.terminalAtEpochMs !== null || ticket.terminalReason !== null || ticket.lease !== null) throw new StateFault("queued ticket fields are invalid");
  } else if (ticket.state === "offered") {
    if (!isSafeInteger(ticket.offeredAtEpochMs) || !isSafeInteger(ticket.offerExpiresAtEpochMs) || ticket.terminalAtEpochMs !== null || ticket.terminalReason !== null || ticket.lease !== null) throw new StateFault("offered ticket fields are invalid");
  } else if (ticket.state === "active" || ticket.state === "uncertain") {
    if (!isSafeInteger(ticket.offeredAtEpochMs) || !isSafeInteger(ticket.offerExpiresAtEpochMs) || ticket.terminalAtEpochMs !== null || ticket.terminalReason !== null) throw new StateFault("active ticket fields are invalid");
    validateLease(ticket.lease);
  } else {
    if (!isSafeInteger(ticket.terminalAtEpochMs) || ticket.lease !== null) throw new StateFault("terminal ticket fields are invalid");
    const validReason = ticket.state === "cancelled" ? ["client_cancelled", "authority_draining"] : ticket.state === "released" ? ["released", "operator_reconciled"] : ticket.state === "throttled" ? ["assistant_rate_limit", "assistant_overloaded"] : ["offer_expired"];
    if (!validReason.includes(ticket.terminalReason)) throw new StateFault("terminal ticket reason is invalid");
  }
}

function validateState(state, { provider, port, timing, allowTestPort = false } = {}) {
  if (!isObject(state)) throw new StateFault("authority state is invalid");
  const allowed = new Set(stateKeys());
  if (Object.keys(state).some((key) => !allowed.has(key)) || state.stateSchemaVersion !== STATE_SCHEMA_VERSION) throw new StateFault("authority state schema is unsupported");
  if (!isUuid(state.authorityId) || !(state.provider in PROVIDER_PORTS) || !isSafeInteger(state.port, 1, 65535) || !isSafeInteger(state.laneTerm, 1) || !isUuid(state.ownerNonce)) throw new StateFault("authority state header is invalid");
  if (!allowTestPort && PROVIDER_PORTS[state.provider] !== state.port) throw new StateFault("authority state provider and port do not match");
  if (provider && state.provider !== provider) throw new StateFault("authority state provider does not match configuration");
  if (port && state.port !== port) throw new StateFault("authority state port does not match configuration");
  if (state.timingSchemaVersion !== 1 || typeof state.timingDigest !== "string" || !/^[0-9a-f]{64}$/.test(state.timingDigest) || !isSafeInteger(state.verifierGeneration, 1)) throw new StateFault("authority state timing header is invalid");
  if (timing && state.timingDigest !== timing.digest) {
    const hasLiveWork = Object.values(state.tickets ?? {}).some((ticket) => ACTIVE_STATES.has(ticket.state));
    if (hasLiveWork || state.lifecycleState !== "draining") throw new StateFault("authority timing changed without a drained restart");
  }
  if (!["ready", "draining", "degraded"].includes(state.lifecycleState)) throw new StateFault("authority lifecycle state is invalid");
  if (!isObject(state.scheduler) || !isSafeInteger(state.scheduler.minimumConcurrency, 1, 64) || !isSafeInteger(state.scheduler.currentConcurrency, 1, 64) || !isSafeInteger(state.scheduler.maximumConcurrency, 1, 64) || state.scheduler.minimumConcurrency > state.scheduler.currentConcurrency || state.scheduler.currentConcurrency > state.scheduler.maximumConcurrency) throw new StateFault("authority scheduler is invalid");
  if (state.scheduler.cooldownUntilEpochMs !== null && !isSafeInteger(state.scheduler.cooldownUntilEpochMs) || state.scheduler.lastThrottleAtEpochMs !== null && !isSafeInteger(state.scheduler.lastThrottleAtEpochMs) || !isSafeInteger(state.scheduler.lastIncreaseAtEpochMs)) throw new StateFault("authority cooldown is invalid");
  if (!isObject(state.tickets) || !isObject(state.createTombstones) || !isObject(state.fairness) || !isObject(state.allowance) || !isObject(state.allowancePublishes) || !isObject(state.publisherSequences) || !isObject(state.counters)) throw new StateFault("authority state is incomplete");
  if (!Array.isArray(state.fairness.machineOrder) || state.fairness.machineOrder.length > MAX_INSTALLATIONS || new Set(state.fairness.machineOrder).size !== state.fairness.machineOrder.length || !state.fairness.machineOrder.every(isUuid) || !isSafeInteger(state.fairness.machineCursor) || state.fairness.machineOrder.length === 0 && state.fairness.machineCursor !== 0 || state.fairness.machineOrder.length > 0 && state.fairness.machineCursor >= state.fairness.machineOrder.length || !isObject(state.fairness.sessionOrder) || !isObject(state.fairness.sessionCursor) || Object.keys(state.fairness.sessionCursor).some((installationId) => !(installationId in state.fairness.sessionOrder))) throw new StateFault("authority fairness state is invalid");
  for (const [installationId, sessions] of Object.entries(state.fairness.sessionOrder)) {
    if (!isUuid(installationId) || !Array.isArray(sessions) || sessions.length > MAX_SESSIONS_PER_INSTALLATION || new Set(sessions).size !== sessions.length || !sessions.every(isUuid) || !isSafeInteger(state.fairness.sessionCursor[installationId]) || sessions.length === 0 && state.fairness.sessionCursor[installationId] !== 0 || sessions.length > 0 && state.fairness.sessionCursor[installationId] >= sessions.length) throw new StateFault("authority fairness state is invalid");
  }
  if (!isSafeInteger(state.counters.nextQueueSequence, 1)) throw new StateFault("authority counters are invalid");
  for (const [ticketId, ticket] of Object.entries(state.tickets)) {
    if (ticketId !== ticket.ticketId || ticket.provider !== state.provider) throw new StateFault("authority ticket key is invalid");
    validateTicketState(ticket);
  }
  if (capacityInUse(state) > state.scheduler.currentConcurrency) throw new StateFault("authority capacity state is unsafe");
  if (Object.keys(state.tickets).length + Object.keys(state.createTombstones).length > MAX_RETAINED_RECORDS) throw new StateFault("authority retained state exceeds the protocol bound");
  if (!Object.hasOwn(state.allowance, "observedAtEpochMs") || !Object.hasOwn(state.allowance, "fiveHour") || !Object.hasOwn(state.allowance, "sevenDay") || !Object.hasOwn(state.allowance, "receivedAtEpochMs")) throw new StateFault("authority allowance state is incomplete");
  if (state.allowance.observedAtEpochMs !== null && !isSafeInteger(state.allowance.observedAtEpochMs)) throw new StateFault("authority allowance observation is invalid");
  if (state.allowance.receivedAtEpochMs !== null && !isSafeInteger(state.allowance.receivedAtEpochMs)) throw new StateFault("authority allowance receipt is invalid");
  validateWindow(state.allowance.fiveHour);
  validateWindow(state.allowance.sevenDay);
  return state;
}

function initialState({ authorityId, provider, port, timing, minimumConcurrency, currentConcurrency, maximumConcurrency, verifierGeneration }) {
  return {
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    authorityId: authorityId || crypto.randomUUID(),
    provider,
    port,
    laneTerm: 1,
    ownerNonce: crypto.randomUUID(),
    timingSchemaVersion: 1,
    timingDigest: timing.digest,
    verifierGeneration,
    lifecycleState: "ready",
    scheduler: {
      minimumConcurrency,
      currentConcurrency,
      maximumConcurrency,
      cooldownUntilEpochMs: null,
      lastThrottleAtEpochMs: null,
      lastIncreaseAtEpochMs: 0,
    },
    tickets: {},
    createTombstones: {},
    fairness: { machineOrder: [], machineCursor: 0, sessionOrder: {}, sessionCursor: {} },
    allowance: { observedAtEpochMs: null, fiveHour: null, sevenDay: null, receivedAtEpochMs: null },
    allowancePublishes: {},
    publisherSequences: {},
    counters: { nextQueueSequence: 1 },
  };
}

function migrateV1(state, configuration) {
  const required = ["stateSchemaVersion", "authorityId", "provider", "port", "laneTerm", "timingSchemaVersion", "timingDigest", "verifierGeneration", "lifecycleState", "scheduler", "tickets", "fairness", "allowance", "counters"];
  if (!isObject(state) || state.stateSchemaVersion !== 1 || required.some((key) => !(key in state))) throw new StateFault("authority state migration is unsafe");
  const migrated = {
    ...state,
    stateSchemaVersion: STATE_SCHEMA_VERSION,
    ownerNonce: crypto.randomUUID(),
    createTombstones: state.createTombstones ?? {},
    allowancePublishes: state.allowancePublishes ?? {},
    publisherSequences: state.publisherSequences ?? {},
  };
  for (const ticket of Object.values(migrated.tickets)) {
    if (!isObject(ticket)) throw new StateFault("authority state migration is unsafe");
    ticket.operationResults ??= [];
    ticket.createResponse ??= null;
    ticket.queueSequence ??= migrated.counters.nextQueueSequence++;
    ticket.lease ??= null;
  }
  validateState(migrated, configuration);
  return migrated;
}

function readJsonFile(file) {
  let raw;
  try {
    const stat = fs.statSync(file);
    if ((stat.mode & 0o077) !== 0) throw new StateFault("authority state permissions are unsafe");
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof StateFault) throw error;
    if (error?.code === "ENOENT") return undefined;
    throw new StateFault("authority state cannot be read");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new StateFault("authority state is corrupt");
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function invokeFault(faultInjector, phase, file) {
  if (!faultInjector) return;
  const result = faultInjector({ phase, file });
  if (result instanceof Error) throw result;
}

function writeDurableJson(file, value, faultInjector) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    invokeFault(faultInjector, "before-write", file);
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    invokeFault(faultInjector, "after-file-fsync", file);
    invokeFault(faultInjector, "before-rename", file);
    fs.renameSync(temporary, file);
    invokeFault(faultInjector, "after-rename", file);
    invokeFault(faultInjector, "before-directory-fsync", file);
    fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

function ticketPublic(state, ticket) {
  return {
    schemaVersion: 1,
    ticketId: ticket.ticketId,
    requestId: ticket.requestId,
    provider: ticket.provider,
    state: ticket.state,
    revision: ticket.revision,
    createdAtEpochMs: ticket.createdAtEpochMs,
    enqueuedAtEpochMs: ticket.enqueuedAtEpochMs,
    offeredAtEpochMs: ticket.offeredAtEpochMs,
    offerExpiresAtEpochMs: ticket.offerExpiresAtEpochMs,
    terminalAtEpochMs: ticket.terminalAtEpochMs,
    terminalReason: ticket.terminalReason,
    queueAhead: ticket.state === "queued" ? queuedAhead(state, ticket) : 0,
    lease: ticket.lease === null ? null : {
      leaseId: ticket.lease.leaseId,
      generation: ticket.lease.generation,
      claimedAtEpochMs: ticket.lease.claimedAtEpochMs,
      renewSequence: ticket.lease.renewSequence,
      renewByEpochMs: ticket.lease.renewByEpochMs,
      serverDeadlineEpochMs: ticket.lease.serverDeadlineEpochMs,
    },
  };
}

function queuedAhead(state, ticket) {
  return Object.values(state.tickets).filter((candidate) => candidate.state === "queued" && candidate.queueSequence < ticket.queueSequence).length;
}

function nonterminalTickets(state) {
  return Object.values(state.tickets).filter((ticket) => !TERMINAL_STATES.has(ticket.state));
}

function capacityInUse(state) {
  return Object.values(state.tickets).filter((ticket) => ACTIVE_STATES.has(ticket.state)).length;
}

function pruneFairness(state) {
  const live = nonterminalTickets(state);
  const liveMachines = new Map();
  for (const ticket of live) {
    const sessions = liveMachines.get(ticket.installationId) ?? new Set();
    sessions.add(ticket.sessionId);
    liveMachines.set(ticket.installationId, sessions);
  }
  const priorMachines = state.fairness.machineOrder;
  const priorNextMachine = priorMachines[priorMachines.length ? state.fairness.machineCursor % priorMachines.length : 0];
  state.fairness.machineOrder = priorMachines.filter((installationId) => liveMachines.has(installationId));
  state.fairness.machineCursor = Math.max(0, state.fairness.machineOrder.indexOf(priorNextMachine));
  for (const installationId of Object.keys(state.fairness.sessionOrder)) {
    const liveSessions = liveMachines.get(installationId);
    if (!liveSessions) {
      delete state.fairness.sessionOrder[installationId];
      delete state.fairness.sessionCursor[installationId];
      continue;
    }
    const priorSessions = state.fairness.sessionOrder[installationId];
    const priorNextSession = priorSessions[priorSessions.length ? state.fairness.sessionCursor[installationId] % priorSessions.length : 0];
    const sessions = priorSessions.filter((sessionId) => liveSessions.has(sessionId));
    for (const sessionId of liveSessions) if (!sessions.includes(sessionId)) sessions.push(sessionId);
    state.fairness.sessionOrder[installationId] = sessions;
    state.fairness.sessionCursor[installationId] = Math.max(0, sessions.indexOf(priorNextSession));
  }
}

function addFairnessIdentity(state, installationId, sessionId) {
  pruneFairness(state);
  if (!state.fairness.machineOrder.includes(installationId)) state.fairness.machineOrder.push(installationId);
  const sessions = state.fairness.sessionOrder[installationId] ?? (state.fairness.sessionOrder[installationId] = []);
  if (!sessions.includes(sessionId)) sessions.push(sessionId);
  state.fairness.sessionCursor[installationId] ??= 0;
}

function eligibleTicketForInstallation(state, installationId) {
  const sessions = state.fairness.sessionOrder[installationId] ?? [];
  if (!sessions.length) return undefined;
  const start = state.fairness.sessionCursor[installationId] % sessions.length;
  for (let offset = 0; offset < sessions.length; offset += 1) {
    const index = (start + offset) % sessions.length;
    const sessionId = sessions[index];
    const ticket = Object.values(state.tickets)
      .filter((candidate) => candidate.state === "queued" && candidate.installationId === installationId && candidate.sessionId === sessionId)
      .sort((left, right) => left.queueSequence - right.queueSequence)[0];
    if (ticket) {
      state.fairness.sessionCursor[installationId] = (index + 1) % sessions.length;
      return ticket;
    }
  }
  return undefined;
}

function scheduleOffers(state, now, timing) {
  if (state.lifecycleState !== "ready" || state.scheduler.cooldownUntilEpochMs !== null && state.scheduler.cooldownUntilEpochMs > now) return [];
  const offered = [];
  const machines = state.fairness.machineOrder;
  if (!machines.length) return offered;
  while (capacityInUse(state) < state.scheduler.currentConcurrency) {
    const start = state.fairness.machineCursor % machines.length;
    let chosen;
    for (let offset = 0; offset < machines.length; offset += 1) {
      const index = (start + offset) % machines.length;
      const candidate = eligibleTicketForInstallation(state, machines[index]);
      if (candidate) {
        chosen = candidate;
        state.fairness.machineCursor = (index + 1) % machines.length;
        break;
      }
    }
    if (!chosen) break;
    chosen.state = "offered";
    chosen.revision += 1;
    chosen.offeredAtEpochMs = now;
    chosen.offerExpiresAtEpochMs = now + timing.offerTtlMs;
    offered.push(chosen.ticketId);
  }
  return offered;
}

function expireAndQuarantine(state, now, timing) {
  let changed = false;
  for (const ticket of Object.values(state.tickets)) {
    if (ticket.state === "offered" && ticket.offerExpiresAtEpochMs <= now) {
      ticket.state = "offerExpired";
      ticket.revision += 1;
      ticket.terminalAtEpochMs = now;
      ticket.terminalReason = "offer_expired";
      changed = true;
    } else if (ticket.state === "active" && ticket.lease.serverDeadlineEpochMs <= now) {
      ticket.state = "uncertain";
      ticket.revision += 1;
      changed = true;
    }
  }
  const scheduler = state.scheduler;
  if (scheduler.cooldownUntilEpochMs !== null && scheduler.cooldownUntilEpochMs <= now) {
    scheduler.cooldownUntilEpochMs = null;
    if (scheduler.currentConcurrency < scheduler.maximumConcurrency && now - scheduler.lastThrottleAtEpochMs >= timing.renewIntervalMs && now - scheduler.lastIncreaseAtEpochMs >= timing.renewIntervalMs) {
      scheduler.currentConcurrency += 1;
      scheduler.lastIncreaseAtEpochMs = now;
    }
    changed = true;
  }
  return changed;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isObject(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function operationFingerprint(action, request) {
  return `${action}:${canonical(request)}`;
}

function findOperation(ticket, operationId, fingerprint) {
  const found = ticket.operationResults.find((result) => result.operationId === operationId);
  if (!found) return undefined;
  if (found.fingerprint !== fingerprint) fail("operation_conflict", "operation identifier was reused");
  return clone(found.response);
}

function rememberOperation(ticket, operationId, fingerprint, response, now) {
  ticket.operationResults.push({ operationId, fingerprint, response: clone(response), recordedAtEpochMs: now });
  if (ticket.operationResults.length > MAX_OPERATION_RESULTS) ticket.operationResults.splice(0, ticket.operationResults.length - MAX_OPERATION_RESULTS);
}

function ticketForOwner(state, principal, ticketId) {
  const ticket = state.tickets[ticketId];
  if (!ticket || ticket.installationId !== principal.installationId) fail("not_found", "ticket is unavailable");
  return ticket;
}

function validateCreateRequest(request) {
  assertExactObject(request, ["schemaVersion", "provider", "accountBindingId", "installationId", "sessionId", "requestId", "createdAtEpochMs"]);
  assertSchemaVersion(request.schemaVersion);
  assertProvider(request.provider);
  assertUuid(request.accountBindingId);
  assertUuid(request.installationId);
  assertUuid(request.sessionId);
  assertUuid(request.requestId);
  assertSafeInteger(request.createdAtEpochMs);
}

function validateMutationRequest(request, action) {
  const base = ["schemaVersion", "operationId", "expectedRevision", "installationId", "provider", "accountBindingId"];
  const extra = action === "renew" ? ["leaseId", "generation", "renewSequence"] : action === "complete" ? ["leaseId", "generation", "outcome", "reason"] : [];
  const optional = action === "complete" ? ["cooldownMs"] : [];
  assertExactObject(request, [...base, ...extra], optional);
  assertSchemaVersion(request.schemaVersion);
  assertUuid(request.operationId);
  assertSafeInteger(request.expectedRevision, 1);
  assertUuid(request.installationId);
  assertProvider(request.provider);
  assertUuid(request.accountBindingId);
  if (action === "renew") {
    assertUuid(request.leaseId);
    assertSafeInteger(request.generation, 1);
    assertSafeInteger(request.renewSequence, 1);
  }
  if (action === "complete") {
    assertUuid(request.leaseId);
    assertSafeInteger(request.generation, 1);
    if (!["released", "throttled"].includes(request.outcome)) fail("invalid_request", "completion outcome is invalid");
    if (request.outcome === "released" && (request.reason !== null || "cooldownMs" in request)) fail("invalid_request", "release completion is invalid");
    if (request.outcome === "throttled" && !["assistant_rate_limit", "assistant_overloaded"].includes(request.reason)) fail("invalid_request", "throttle completion is invalid");
    if ("cooldownMs" in request) assertSafeInteger(request.cooldownMs);
  }
}

function validateAllowanceRequest(request, now) {
  assertExactObject(request, ["schemaVersion", "installationId", "provider", "accountBindingId", "publishId", "publisherSequence", "observedAtEpochMs", "fiveHour", "sevenDay"]);
  assertSchemaVersion(request.schemaVersion);
  assertUuid(request.installationId);
  assertProvider(request.provider);
  assertUuid(request.accountBindingId);
  assertUuid(request.publishId);
  assertSafeInteger(request.publisherSequence, 1);
  assertSafeInteger(request.observedAtEpochMs);
  if (request.observedAtEpochMs > now + MAX_REQUEST_AGE_MS) fail("invalid_request", "allowance observation is in the future");
  validateWindowRequest(request.fiveHour);
  validateWindowRequest(request.sevenDay);
}

function validateWindowRequest(window) {
  if (window === null) return;
  if (!isObject(window)) fail("invalid_request", "allowance window is invalid");
  assertExactObject(window, ["utilization", "status", "resetEpochSeconds"]);
  if (typeof window.utilization !== "number" || !Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization > 1_000) fail("invalid_request", "allowance utilization is invalid");
  if (window.status !== null && !WINDOW_STATUSES.has(window.status)) fail("invalid_request", "allowance status is invalid");
  assertSafeInteger(window.resetEpochSeconds, 1);
  if (window.resetEpochSeconds > 253_402_300_799) fail("invalid_request", "allowance reset is invalid");
}

function createKey(installationId, provider, requestId) {
  return `${installationId}\u0000${provider}\u0000${requestId}`;
}

function publisherKey(installationId, provider, publishId) {
  return `${installationId}\u0000${provider}\u0000${publishId}`;
}

function publisherSequenceKey(installationId, provider) {
  return `${installationId}\u0000${provider}`;
}

function compactRetainedState(state, now, timing) {
  for (const [key, tombstone] of Object.entries(state.createTombstones)) {
    if (!isObject(tombstone) || !isSafeInteger(tombstone.compactedAtEpochMs) || now - tombstone.compactedAtEpochMs > MAX_REQUEST_AGE_MS) delete state.createTombstones[key];
  }
  const eligible = Object.values(state.tickets)
    .filter((ticket) => TERMINAL_STATES.has(ticket.state) && ticket.terminalAtEpochMs !== null && now - ticket.terminalAtEpochMs >= timing.terminalRetentionMs)
    .sort((left, right) => left.terminalAtEpochMs - right.terminalAtEpochMs);
  for (const ticket of eligible) {
    const key = createKey(ticket.installationId, ticket.provider, ticket.requestId);
    if (now - ticket.createdAtEpochMs <= MAX_REQUEST_AGE_MS) state.createTombstones[key] = { createdAtEpochMs: ticket.createdAtEpochMs, compactedAtEpochMs: now };
    delete state.tickets[ticket.ticketId];
  }
}

function retainedRecordCount(state) {
  return Object.keys(state.tickets).length + Object.keys(state.createTombstones).length;
}

function privateAllowance(state) {
  return {
    observedAtEpochMs: state.allowance.observedAtEpochMs,
    fiveHour: clone(state.allowance.fiveHour),
    sevenDay: clone(state.allowance.sevenDay),
  };
}

function normalizeConfiguration(options) {
  const timing = validateAuthorityTiming(options.timing);
  const provider = options.provider;
  const port = options.port;
  if (!(provider in PROVIDER_PORTS) || !isSafeInteger(port, 1, 65535)) throw new StateFault("authority provider or port is invalid");
  if (!options.allowTestPort && PROVIDER_PORTS[provider] !== port) throw new StateFault("authority provider and port do not match");
  const minimumConcurrency = options.minimumConcurrency ?? 1;
  const maximumConcurrency = options.maximumConcurrency ?? 2;
  const currentConcurrency = options.currentConcurrency ?? maximumConcurrency;
  if (!isSafeInteger(minimumConcurrency, 1, 64) || !isSafeInteger(maximumConcurrency, minimumConcurrency, 64) || !isSafeInteger(currentConcurrency, minimumConcurrency, maximumConcurrency)) throw new StateFault("authority concurrency is invalid");
  if (options.authorityId !== undefined && !isUuid(options.authorityId)) throw new StateFault("authority identifier is invalid");
  const verifierGeneration = options.verifierGeneration ?? 1;
  if (!isSafeInteger(verifierGeneration, 1)) throw new StateFault("verifier generation is invalid");
  return {
    statePath: options.statePath,
    provider,
    port,
    timing,
    minimumConcurrency,
    maximumConcurrency,
    currentConcurrency,
    authorityId: options.authorityId,
    verifierGeneration,
    allowTestPort: options.allowTestPort === true,
    allowMigration: options.allowMigration !== false,
    bootstrap: options.bootstrap === true,
    clock: options.clock ?? Date.now,
    faultInjector: options.faultInjector,
  };
}

export class AuthorityState {
  constructor(state, configuration) {
    this.state = state;
    this.configuration = configuration;
    this.degraded = false;
  }

  get status() {
    return this.degraded ? "degraded" : this.state.lifecycleState;
  }

  get authorityId() {
    return this.state.authorityId;
  }

  get laneTerm() {
    return this.state.laneTerm;
  }

  _now() {
    const now = this.configuration.clock();
    if (!isSafeInteger(now)) throw new StateFault("authority clock is invalid");
    return now;
  }

  _degrade(error) {
    this.degraded = true;
    this.state.lifecycleState = "degraded";
    if (error instanceof AuthorityError) throw error;
    throw new StateFault("authority persistence failed");
  }

  _assertStoredHeader() {
    let stored;
    try { stored = readJsonFile(this.configuration.statePath); } catch (error) { this._degrade(error); }
    if (!stored || !sameHeader(stored, this.state)) this._degrade(new StateFault("authority ownership fence changed"));
  }

  _commit(next) {
    this._assertStoredHeader();
    try {
      validateState(next, this.configuration);
      writeDurableJson(this.configuration.statePath, next, this.configuration.faultInjector);
    } catch (error) {
      this._degrade(error);
    }
    this.state = next;
  }

  _transition(mutate, { allowDraining = false } = {}) {
    if (this.degraded || this.state.lifecycleState === "degraded") fail("authority_degraded", "authority is degraded");
    if (!allowDraining && this.state.lifecycleState === "draining") fail("authority_draining", "authority is draining");
    const next = clone(this.state);
    const now = this._now();
    const result = mutate(next, now);
    this._commit(next);
    return result;
  }

  reconcile() {
    if (this.degraded || this.state.lifecycleState === "degraded") return false;
    const next = clone(this.state);
    const now = this._now();
    const changed = expireAndQuarantine(next, now, this.configuration.timing);
    const offered = next.lifecycleState === "ready" ? scheduleOffers(next, now, this.configuration.timing) : [];
    if (!changed && offered.length === 0) return false;
    this._commit(next);
    return true;
  }

  createTicket(principal, request) {
    validateCreateRequest(request);
    const checkedPrincipal = assertPrincipalMatches(principal, request);
    return this._transition((next, transitionNow) => {
      if (request.provider !== next.provider) fail("provider_mismatch", "request provider does not match lane");
      expireAndQuarantine(next, transitionNow, this.configuration.timing);
      compactRetainedState(next, transitionNow, this.configuration.timing);
      const key = createKey(checkedPrincipal.installationId, request.provider, request.requestId);
      const existing = Object.values(next.tickets).find((ticket) => createKey(ticket.installationId, ticket.provider, ticket.requestId) === key);
      if (existing) {
        const sameRequest = existing.accountBindingId === request.accountBindingId && existing.sessionId === request.sessionId && existing.createdAtEpochMs === request.createdAtEpochMs;
        if (!sameRequest) fail("operation_conflict", "request identifier was reused");
        return { ticket: clone(existing.createResponse ?? ticketPublic(next, existing)), replayed: true, created: false };
      }
      if (Math.abs(transitionNow - request.createdAtEpochMs) > MAX_REQUEST_AGE_MS) fail("invalid_request", "request timestamp is outside the accepted window");
      if (next.createTombstones[key]) fail("invalid_request", "request timestamp cannot recreate compacted work");
      if (retainedRecordCount(next) >= MAX_RETAINED_RECORDS) fail("persistence_unavailable", "retained replay state is full");
      const live = nonterminalTickets(next);
      const sameInstallation = live.filter((ticket) => ticket.installationId === checkedPrincipal.installationId);
      const sessions = new Set(sameInstallation.map((ticket) => ticket.sessionId));
      if (!sessions.has(request.sessionId) && sessions.size >= MAX_SESSIONS_PER_INSTALLATION) fail("principal_limit", "principal session limit reached");
      if (sameInstallation.filter((ticket) => ticket.sessionId === request.sessionId).length >= MAX_NONTERMINAL_PER_SESSION || sameInstallation.length >= MAX_NONTERMINAL_PER_INSTALLATION) fail("principal_limit", "principal ticket limit reached");
      const installations = new Set(live.map((ticket) => ticket.installationId));
      if (!installations.has(checkedPrincipal.installationId) && installations.size >= MAX_INSTALLATIONS) fail("principal_limit", "principal installation limit reached");
      if (live.length >= MAX_NONTERMINAL_PER_LANE) fail("lane_limit", "lane ticket limit reached");
      const ticket = {
        ticketId: crypto.randomUUID(),
        requestId: request.requestId,
        provider: request.provider,
        installationId: checkedPrincipal.installationId,
        accountBindingId: request.accountBindingId,
        sessionId: request.sessionId,
        state: "queued",
        revision: 1,
        createdAtEpochMs: request.createdAtEpochMs,
        enqueuedAtEpochMs: transitionNow,
        offeredAtEpochMs: null,
        offerExpiresAtEpochMs: null,
        terminalAtEpochMs: null,
        terminalReason: null,
        lease: null,
        operationResults: [],
        createResponse: null,
        queueSequence: next.counters.nextQueueSequence++,
      };
      next.tickets[ticket.ticketId] = ticket;
      addFairnessIdentity(next, checkedPrincipal.installationId, request.sessionId);
      scheduleOffers(next, transitionNow, this.configuration.timing);
      ticket.createResponse = ticketPublic(next, ticket);
      return { ticket: clone(ticket.createResponse), replayed: false, created: true };
    });
  }

  getTicket(principal, ticketId) {
    const checkedPrincipal = assertPrincipal(principal);
    if (!isUuid(ticketId)) fail("not_found", "ticket is unavailable");
    this.reconcile();
    return ticketPublic(this.state, ticketForOwner(this.state, checkedPrincipal, ticketId));
  }

  mutateTicket(principal, ticketId, action, request) {
    if (!["claim", "cancel", "renew", "complete"].includes(action)) throw new StateFault("authority operation is invalid");
    validateMutationRequest(request, action);
    const checkedPrincipal = assertPrincipalMatches(principal, request);
    if (!isUuid(ticketId)) fail("not_found", "ticket is unavailable");
    return this._transition((next, now) => {
      const expiryChanged = expireAndQuarantine(next, now, this.configuration.timing);
      if (expiryChanged) scheduleOffers(next, now, this.configuration.timing);
      const ticket = ticketForOwner(next, checkedPrincipal, ticketId);
      if (ticket.provider !== request.provider) fail("provider_mismatch", "ticket provider does not match");
      if (ticket.accountBindingId !== request.accountBindingId) fail("account_binding_mismatch", "ticket account binding does not match");
      const fingerprint = operationFingerprint(action, request);
      const replay = findOperation(ticket, request.operationId, fingerprint);
      if (replay) return { ticket: replay, replayed: true };
      if (ticket.revision !== request.expectedRevision) fail("stale_revision", "ticket revision is stale");
      if (action === "claim") {
        if (ticket.state !== "offered") fail("invalid_transition", "ticket cannot be claimed");
        ticket.state = "active";
        ticket.revision += 1;
        ticket.lease = {
          leaseId: crypto.randomUUID(),
          generation: 1,
          claimedAtEpochMs: now,
          renewSequence: 0,
          renewByEpochMs: now + this.configuration.timing.renewIntervalMs,
          serverDeadlineEpochMs: now + this.configuration.timing.renewDeadlineMs,
        };
      } else if (action === "cancel") {
        if (!["queued", "offered"].includes(ticket.state)) fail("invalid_transition", "ticket cannot be cancelled");
        ticket.state = "cancelled";
        ticket.revision += 1;
        ticket.terminalAtEpochMs = now;
        ticket.terminalReason = "client_cancelled";
        ticket.lease = null;
        scheduleOffers(next, now, this.configuration.timing);
      } else if (action === "renew") {
        if (!["active", "uncertain"].includes(ticket.state) || !ticket.lease || ticket.lease.leaseId !== request.leaseId || ticket.lease.generation !== request.generation || request.renewSequence !== ticket.lease.renewSequence + 1) fail("invalid_transition", "lease renewal is invalid");
        ticket.state = "active";
        ticket.revision += 1;
        ticket.lease.renewSequence = request.renewSequence;
        ticket.lease.renewByEpochMs = now + this.configuration.timing.renewIntervalMs;
        ticket.lease.serverDeadlineEpochMs = now + this.configuration.timing.renewDeadlineMs;
      } else {
        if (!["active", "uncertain"].includes(ticket.state) || !ticket.lease || ticket.lease.leaseId !== request.leaseId || ticket.lease.generation !== request.generation) fail("invalid_transition", "lease completion is invalid");
        ticket.state = request.outcome;
        ticket.revision += 1;
        ticket.terminalAtEpochMs = now;
        ticket.terminalReason = request.outcome === "released" ? "released" : request.reason;
        ticket.lease = null;
        if (request.outcome === "throttled") {
          const requestedCooldown = request.cooldownMs ?? 20_000;
          const cooldown = Math.min(Math.max(1_000, requestedCooldown), 60_000);
          const inUseAfterCompletion = capacityInUse(next);
          next.scheduler.currentConcurrency = Math.max(next.scheduler.minimumConcurrency, inUseAfterCompletion, next.scheduler.currentConcurrency - 1);
          next.scheduler.cooldownUntilEpochMs = Math.max(next.scheduler.cooldownUntilEpochMs ?? 0, now + cooldown);
          next.scheduler.lastThrottleAtEpochMs = now;
        }
        scheduleOffers(next, now, this.configuration.timing);
      }
      const response = ticketPublic(next, ticket);
      rememberOperation(ticket, request.operationId, fingerprint, response, now);
      return { ticket: response, replayed: false };
    }, { allowDraining: action === "renew" || action === "complete" || action === "cancel" });
  }

  publishAllowance(principal, request) {
    const now = this._now();
    validateAllowanceRequest(request, now);
    const checkedPrincipal = assertPrincipalMatches(principal, request);
    return this._transition((next, transitionNow) => {
      if (request.provider !== next.provider) fail("provider_mismatch", "allowance provider does not match lane");
      const key = publisherKey(checkedPrincipal.installationId, request.provider, request.publishId);
      const fingerprint = canonical(request);
      const replay = next.allowancePublishes[key];
      if (replay) {
        if (replay.fingerprint !== fingerprint) fail("operation_conflict", "publish identifier was reused");
        return { allowance: clone(replay.allowance), replayed: true };
      }
      const sequenceKey = publisherSequenceKey(checkedPrincipal.installationId, request.provider);
      const priorSequence = next.publisherSequences[sequenceKey] ?? 0;
      if (request.publisherSequence <= priorSequence) fail("stale_revision", "publisher sequence is stale");
      const priorObservation = next.allowance.observedAtEpochMs;
      if (priorObservation !== null && request.observedAtEpochMs < priorObservation - MAX_REQUEST_AGE_MS) fail("stale_revision", "allowance observation is stale");
      const allowance = {
        observedAtEpochMs: request.observedAtEpochMs,
        fiveHour: clone(request.fiveHour),
        sevenDay: clone(request.sevenDay),
      };
      next.allowance = { ...allowance, receivedAtEpochMs: transitionNow };
      next.publisherSequences[sequenceKey] = request.publisherSequence;
      next.allowancePublishes[key] = { fingerprint, allowance: clone(allowance), receivedAtEpochMs: transitionNow };
      const principalKeys = Object.entries(next.allowancePublishes)
        .filter(([entry]) => entry.startsWith(`${checkedPrincipal.installationId}\u0000`))
        .sort(([, left], [, right]) => left.receivedAtEpochMs - right.receivedAtEpochMs);
      while (principalKeys.length > MAX_ALLOWANCE_REPLAYS_PER_INSTALLATION) {
        const [oldest] = principalKeys.shift();
        delete next.allowancePublishes[oldest];
      }
      return { allowance, replayed: false };
    });
  }

  drain() {
    return this._transition((next, now) => {
      if (next.lifecycleState === "draining") return false;
      for (const ticket of Object.values(next.tickets)) {
        if (ticket.state === "queued" || ticket.state === "offered") {
          ticket.state = "cancelled";
          ticket.revision += 1;
          ticket.terminalAtEpochMs = now;
          ticket.terminalReason = "authority_draining";
          ticket.lease = null;
        }
      }
      next.lifecycleState = "draining";
      return true;
    }, { allowDraining: true });
  }

  resume() {
    return this._transition((next, now) => {
      if (next.lifecycleState !== "draining") fail("invalid_transition", "authority is not draining");
      next.lifecycleState = "ready";
      scheduleOffers(next, now, this.configuration.timing);
      return true;
    }, { allowDraining: true });
  }

  health({ instanceId, buildId, now = this._now() }) {
    const counts = { active: 0, offered: 0, uncertain: 0, queued: 0 };
    let oldestWaitEpochMs = null;
    for (const ticket of Object.values(this.state.tickets)) {
      if (ticket.state in counts) counts[ticket.state] += 1;
      if (ticket.state === "queued" && (oldestWaitEpochMs === null || ticket.enqueuedAtEpochMs < oldestWaitEpochMs)) oldestWaitEpochMs = ticket.enqueuedAtEpochMs;
    }
    return {
      schemaVersion: 1,
      protocolVersion: 2,
      authorityId: this.state.authorityId,
      laneTerm: this.state.laneTerm,
      instanceId,
      buildId,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
      serverTimeEpochMs: now,
      status: this.status,
      provider: this.state.provider,
      port: this.state.port,
      capabilities: ["tickets", "snapshot", "allowance"],
      active: counts.active,
      offered: counts.offered,
      uncertain: counts.uncertain,
      queued: counts.queued,
      currentConcurrency: this.state.scheduler.currentConcurrency,
      maximumConcurrency: this.state.scheduler.maximumConcurrency,
      cooldownUntilEpochMs: this.state.scheduler.cooldownUntilEpochMs,
      oldestWaitEpochMs,
    };
  }

  snapshot({ instanceId, buildId, now = this._now() }) {
    const health = this.health({ instanceId, buildId, now });
    const { capabilities, ...common } = health;
    return { ...common, laneId: LANE_IDS[this.state.provider], allowance: privateAllowance(this.state) };
  }
}

export function openAuthorityState(options) {
  const configuration = normalizeConfiguration(options);
  if (typeof configuration.statePath !== "string" || !configuration.statePath) throw new StateFault("authority state path is required");
  let stored = readJsonFile(configuration.statePath);
  let state;
  let migrated = false;
  if (stored === undefined) {
    if (!configuration.bootstrap) throw new StateFault("authority state is missing and bootstrap was not requested");
    state = initialState(configuration);
    const authority = new AuthorityState(state, configuration);
    try {
      writeDurableJson(configuration.statePath, state, configuration.faultInjector);
    } catch (error) {
      authority._degrade(error);
    }
    return authority;
  }
  if (stored.stateSchemaVersion === 1) {
    if (!configuration.allowMigration) throw new StateFault("authority state migration was not allowed");
    state = migrateV1(stored, configuration);
    migrated = true;
  } else {
    state = stored;
  }
  validateState(state, configuration);
  if (configuration.authorityId && configuration.authorityId !== state.authorityId) throw new StateFault("authority identifier does not match state");
  const authority = new AuthorityState(state, configuration);
  const current = readJsonFile(configuration.statePath);
  if (!current || (!migrated && !sameHeader(current, state))) throw new StateFault("authority ownership changed before term commit");
  const next = clone(state);
  next.laneTerm += 1;
  next.ownerNonce = crypto.randomUUID();
  if (next.timingDigest !== configuration.timing.digest) next.timingDigest = configuration.timing.digest;
  try {
    validateState(next, configuration);
    writeDurableJson(configuration.statePath, next, configuration.faultInjector);
  } catch (error) {
    authority._degrade(error);
  }
  authority.state = next;
  return authority;
}

export function authorityErrorBody(error) {
  const authorityError = error instanceof AuthorityError ? error : new AuthorityError("authority_degraded", { message: "authority is unavailable" });
  return {
    status: authorityError.status,
    retryable: authorityError.retryable,
    retryAfterMs: authorityError.retryAfterMs,
    body: {
      schemaVersion: 1,
      error: {
        code: authorityError.code,
        message: "request rejected",
        retryable: authorityError.retryable,
        retryAfterMs: authorityError.retryAfterMs,
      },
    },
  };
}
