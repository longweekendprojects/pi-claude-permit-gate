import crypto from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_EPOCH_MS = 253_402_300_799_999;
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
const MAX_ALLOWANCE_REPLAY_RECORDS = MAX_INSTALLATIONS * MAX_ALLOWANCE_REPLAYS_PER_INSTALLATION;
const MAX_FINGERPRINT_LENGTH = 16_384;
const MAX_REQUEST_AGE_MS = 30_000;
const STATE_SCHEMA_VERSION = 2;
const VERIFIER_SCOPES = new Set(["permit:mutate", "snapshot:read", "allowance:publish"]);
const MAX_VERIFIER_RECORDS = 192;
const MAX_VERIFIERS_PER_INSTALLATION_SCOPE = 2;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const VERIFIER_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERIFIER_FENCE_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
const VERIFIER_FENCE_LIVENESS_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const VERIFIER_FENCE_TIMEOUT_MS = 3_000;
const VERIFIER_FENCE_RETRY_MS = 25;
const VERIFIER_FENCE_LIVENESS_TIMEOUT_MS = 100;
const VERIFIER_FENCE_LIVENESS_MAX_BYTES = 512;
const DUMMY_VERIFIER_SHA256 = crypto.createHash("sha256").update("claude-permit-authority-dummy-verifier").digest();

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

function verifierFault() {
  return new AuthorityError("verifier_unavailable", { message: "verifier is unavailable" });
}

function verifierUnauthorized() {
  return new AuthorityError("unauthenticated", { message: "bearer is unavailable" });
}

function validateVerifierStore(value) {
  if (!hasExactKeys(value, ["schemaVersion", "generation", "verifiers"]) || value.schemaVersion !== 1 || !isSafeInteger(value.generation, 1) || !Array.isArray(value.verifiers) || value.verifiers.length === 0 || value.verifiers.length > MAX_VERIFIER_RECORDS) throw verifierFault();
  const tokenIds = new Set();
  const verifierDigests = new Set();
  const installationScopes = new Map();
  const recordsByInstallationScope = new Map();
  const records = new Map();
  for (const record of value.verifiers) {
    const keys = ["tokenId", "verifierSha256", "installationId", "scope", "laneAllowlist", "generation", "issuedAtEpochMs", "expiresAtEpochMs", "predecessorTokenId", "revokedAtEpochMs"];
    if (!hasExactKeys(record, keys) || !TOKEN_ID_PATTERN.test(record.tokenId) || !VERIFIER_SHA256_PATTERN.test(record.verifierSha256) || !isUuid(record.installationId) || !VERIFIER_SCOPES.has(record.scope) || !Array.isArray(record.laneAllowlist) || record.laneAllowlist.length === 0 || record.laneAllowlist.length > Object.keys(PROVIDER_PORTS).length || new Set(record.laneAllowlist).size !== record.laneAllowlist.length || !record.laneAllowlist.every((provider) => provider in PROVIDER_PORTS) || !isSafeInteger(record.generation, 1, value.generation) || !isEpochMs(record.issuedAtEpochMs) || !isEpochMs(record.expiresAtEpochMs) || record.expiresAtEpochMs <= record.issuedAtEpochMs || record.predecessorTokenId !== null && !TOKEN_ID_PATTERN.test(record.predecessorTokenId) || record.revokedAtEpochMs !== null && (!isEpochMs(record.revokedAtEpochMs) || record.revokedAtEpochMs < record.issuedAtEpochMs)) throw verifierFault();
    if (tokenIds.has(record.tokenId) || verifierDigests.has(record.verifierSha256)) throw verifierFault();
    tokenIds.add(record.tokenId);
    verifierDigests.add(record.verifierSha256);
    records.set(record.tokenId, record);
    const scopeKey = `${record.installationId}\u0000${record.scope}`;
    const count = (installationScopes.get(scopeKey) ?? 0) + 1;
    if (count > MAX_VERIFIERS_PER_INSTALLATION_SCOPE) throw verifierFault();
    installationScopes.set(scopeKey, count);
    const scopedRecords = recordsByInstallationScope.get(scopeKey) ?? [];
    scopedRecords.push(record);
    recordsByInstallationScope.set(scopeKey, scopedRecords);
  }
  for (const record of value.verifiers) {
    if (record.predecessorTokenId === null) continue;
    const predecessor = records.get(record.predecessorTokenId);
    if (!predecessor || predecessor.tokenId === record.tokenId || predecessor.installationId !== record.installationId || predecessor.scope !== record.scope || canonical(predecessor.laneAllowlist) !== canonical(record.laneAllowlist) || predecessor.generation >= record.generation) throw verifierFault();
  }
  for (const scopedRecords of recordsByInstallationScope.values()) {
    if (scopedRecords.length < 2) continue;
    const [first, second] = scopedRecords;
    if (first.predecessorTokenId === null && second.predecessorTokenId === first.tokenId || second.predecessorTokenId === null && first.predecessorTokenId === second.tokenId) continue;
    throw verifierFault();
  }
  return value;
}

function readVerifierSnapshotSync(file, { allowMissing = false } = {}) {
  let raw;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw verifierFault();
    raw = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    if (allowMissing && error?.code === "ENOENT") return undefined;
    throw verifierFault();
  }
  try {
    return { raw, store: validateVerifierStore(JSON.parse(raw.toString("utf8"))) };
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw verifierFault();
  }
}

async function readVerifierSnapshot(file, { allowMissing = false } = {}) {
  let raw;
  try {
    const stat = await fsPromises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw verifierFault();
    raw = await fsPromises.readFile(file);
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    if (allowMissing && error?.code === "ENOENT") return undefined;
    throw verifierFault();
  }
  try {
    return { raw, store: validateVerifierStore(JSON.parse(raw.toString("utf8"))) };
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw verifierFault();
  }
}

export function authorityVerifierPath({ home, verifierStore } = {}) {
  if (typeof verifierStore === "string" && verifierStore) return path.resolve(verifierStore);
  if (typeof home !== "string" || !home) throw verifierFault();
  return path.join(home, "Library", "Application Support", "Claude Permit Authority", "verifiers-v1.json");
}

export function readAuthorityVerifierStore(file, { minimumGeneration = 1 } = {}) {
  const snapshot = readVerifierSnapshotSync(file);
  if (!isSafeInteger(minimumGeneration, 1) || snapshot.store.generation < minimumGeneration) throw verifierFault();
  return snapshot.store;
}

export async function readAuthorityVerifierStoreAsync(file, { minimumGeneration = 1 } = {}) {
  const snapshot = await readVerifierSnapshot(file);
  if (!isSafeInteger(minimumGeneration, 1) || snapshot.store.generation < minimumGeneration) throw verifierFault();
  return snapshot.store;
}

function sameVerifierRecord(left, right) {
  const immutableKeys = ["tokenId", "verifierSha256", "installationId", "scope", "laneAllowlist", "generation", "issuedAtEpochMs", "expiresAtEpochMs", "predecessorTokenId"];
  return immutableKeys.every((key) => canonical(left[key]) === canonical(right[key]));
}

function validateVerifierEvolution(previous, next) {
  if (next.generation !== previous.generation + 1) throw verifierFault();
  const nextByTokenId = new Map(next.verifiers.map((record) => [record.tokenId, record]));
  for (const record of previous.verifiers) {
    const successor = nextByTokenId.get(record.tokenId);
    if (!successor || !sameVerifierRecord(record, successor) || record.revokedAtEpochMs !== null && successor.revokedAtEpochMs !== record.revokedAtEpochMs || record.revokedAtEpochMs === null && successor.revokedAtEpochMs !== null && successor.revokedAtEpochMs < record.issuedAtEpochMs) throw verifierFault();
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function currentUid() {
  if (typeof process.getuid !== "function") throw verifierFault();
  const uid = process.getuid();
  if (!isSafeInteger(uid, 0)) throw verifierFault();
  return uid;
}

function isSafeFenceArtifact(stat) {
  return stat.isFile() && !stat.isSymbolicLink() && stat.uid === currentUid() && (stat.mode & 0o077) === 0;
}

function fenceOwner(value) {
  if (!hasExactKeys(value, ["schemaVersion", "ownerToken", "pid", "uid", "createdAtEpochMs", "processUptimeMs", "processBirthId", "livenessId"]) || value.schemaVersion !== 2 || !VERIFIER_FENCE_TOKEN_PATTERN.test(value.ownerToken) || !isSafeInteger(value.pid, 1) || !isSafeInteger(value.uid, 0) || value.uid !== currentUid() || !isEpochMs(value.createdAtEpochMs) || !isSafeInteger(value.processUptimeMs, 0) || !VERIFIER_FENCE_TOKEN_PATTERN.test(value.processBirthId) || !VERIFIER_FENCE_LIVENESS_ID_PATTERN.test(value.livenessId)) return undefined;
  return value;
}

function sameFenceOwner(left, right) {
  return left.ownerToken === right.ownerToken && left.pid === right.pid && left.uid === right.uid && left.createdAtEpochMs === right.createdAtEpochMs && left.processUptimeMs === right.processUptimeMs && left.processBirthId === right.processBirthId && left.livenessId === right.livenessId;
}

function newFenceOwner() {
  return {
    schemaVersion: 2,
    ownerToken: crypto.randomBytes(32).toString("hex"),
    pid: process.pid,
    uid: currentUid(),
    createdAtEpochMs: Date.now(),
    processUptimeMs: Math.floor(process.uptime() * 1_000),
    processBirthId: crypto.randomBytes(32).toString("hex"),
    livenessId: crypto.randomBytes(12).toString("base64url"),
  };
}

function verifierFenceTiming() {
  const override = process.env.CLAUDE_PERMIT_GATE_TEST_VERIFIER_FENCE_TIMEOUT_MS;
  if (override === undefined) return { timeoutMs: VERIFIER_FENCE_TIMEOUT_MS, retryMs: VERIFIER_FENCE_RETRY_MS };
  if (process.env.CLAUDE_PERMIT_GATE_TEST_MODE !== "1" || !/^\d+$/.test(override)) throw verifierFault();
  const timeoutMs = Number(override);
  if (!isSafeInteger(timeoutMs, 50, 5_000)) throw verifierFault();
  return { timeoutMs, retryMs: Math.min(VERIFIER_FENCE_RETRY_MS, timeoutMs) };
}

export function authorityVerifierFencePath(file) {
  if (typeof file !== "string" || !file) throw verifierFault();
  return `${path.resolve(file)}.lock`;
}

function verifierFenceLivenessDirectory() {
  return path.join("/tmp", `.cpf-${currentUid()}`);
}

function verifierFenceLivenessPath(file, owner) {
  const storeId = crypto.createHash("sha256").update(path.resolve(file)).digest("base64url").slice(0, 16);
  return path.join(verifierFenceLivenessDirectory(), `${storeId}-${owner.livenessId}`);
}

function recoveryPathForFenceOwner(file, owner) {
  return path.join(path.dirname(file), `.${path.basename(file)}.${owner.ownerToken}.recovery`);
}

function isSafeFenceDirectory(stat) {
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === currentUid() && (stat.mode & 0o077) === 0;
}

async function ensureVerifierFenceDirectory(file) {
  const directory = path.dirname(file);
  try {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    let stat = await fsPromises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== currentUid()) throw verifierFault();
    if ((stat.mode & 0o077) !== 0) await fsPromises.chmod(directory, 0o700);
    stat = await fsPromises.lstat(directory);
    if (!isSafeFenceDirectory(stat)) throw verifierFault();
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw verifierFault();
  }
}

async function ensureVerifierFenceLivenessDirectory() {
  await ensureVerifierFenceDirectory(path.join(verifierFenceLivenessDirectory(), "socket"));
}

async function readVerifierFenceArtifact(file) {
  let stat;
  try {
    stat = await fsPromises.lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw verifierFault();
  }
  if (!isSafeFenceArtifact(stat)) return { kind: "unsafe" };
  let raw;
  try {
    raw = await fsPromises.readFile(file, "utf8");
    const after = await fsPromises.lstat(file);
    if (!sameFile(stat, after) || !isSafeFenceArtifact(after)) return { kind: "unsafe" };
    const owner = fenceOwner(JSON.parse(raw));
    return owner ? { kind: "valid", owner, stat: after } : { kind: "unsafe" };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    return { kind: "unsafe" };
  }
}

function isSafeFenceLivenessArtifact(stat) {
  return stat.isSocket() && !stat.isSymbolicLink() && stat.uid === currentUid() && (stat.mode & 0o077) === 0;
}

function fenceBirthProof(owner) {
  return { schemaVersion: 1, ownerToken: owner.ownerToken, pid: owner.pid, processBirthId: owner.processBirthId, processUptimeMs: owner.processUptimeMs };
}

function matchesFenceBirthProof(value, owner) {
  return hasExactKeys(value, ["schemaVersion", "ownerToken", "pid", "processBirthId", "processUptimeMs"]) && value.schemaVersion === 1 && value.ownerToken === owner.ownerToken && value.pid === owner.pid && value.processBirthId === owner.processBirthId && value.processUptimeMs === owner.processUptimeMs;
}

async function openVerifierFenceLiveness(file, owner) {
  await ensureVerifierFenceLivenessDirectory();
  const endpoint = verifierFenceLivenessPath(file, owner);
  try {
    await fsPromises.lstat(endpoint);
    throw verifierFault();
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    if (error?.code !== "ENOENT") throw verifierFault();
  }
  const server = net.createServer((socket) => { socket.end(`${JSON.stringify(fenceBirthProof(owner))}\n`); });
  server.on("error", () => {});
  let listening = false;
  let endpointStat;
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off("listening", onListening); reject(error); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint);
    });
    listening = true;
    await fsPromises.chmod(endpoint, 0o600);
    endpointStat = await fsPromises.lstat(endpoint);
    if (!isSafeFenceLivenessArtifact(endpointStat)) throw verifierFault();
    return { server, endpoint, stat: endpointStat };
  } catch (error) {
    if (listening) {
      await new Promise((resolve) => server.close(() => resolve()));
      try {
        const stat = await fsPromises.lstat(endpoint);
        if (endpointStat && isSafeFenceLivenessArtifact(stat) && sameFile(stat, endpointStat)) await fsPromises.unlink(endpoint);
      } catch {}
    }
    if (error instanceof AuthorityError) throw error;
    throw verifierFault();
  }
}

async function closeVerifierFenceLiveness(liveness) {
  if (liveness.server.listening) await new Promise((resolve) => liveness.server.close(() => resolve()));
  try {
    const stat = await fsPromises.lstat(liveness.endpoint);
    if (isSafeFenceLivenessArtifact(stat) && sameFile(stat, liveness.stat)) await fsPromises.unlink(liveness.endpoint);
  } catch {}
}

async function verifierFenceLivenessState(file, owner) {
  const endpoint = verifierFenceLivenessPath(file, owner);
  try {
    const directory = await fsPromises.lstat(path.dirname(endpoint));
    if (!isSafeFenceDirectory(directory)) return "uncertain";
  } catch (error) {
    return error?.code === "ENOENT" ? "dead" : "uncertain";
  }
  let stat;
  try {
    stat = await fsPromises.lstat(endpoint);
  } catch (error) {
    if (error?.code === "ENOENT") return "dead";
    return "uncertain";
  }
  if (!isSafeFenceLivenessArtifact(stat)) return "uncertain";
  return new Promise((resolve) => {
    let settled = false;
    let response = "";
    const client = net.createConnection({ path: endpoint });
    const finish = (state) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      resolve(state);
    };
    const timeout = setTimeout(() => finish("uncertain"), VERIFIER_FENCE_LIVENESS_TIMEOUT_MS);
    client.setEncoding("utf8");
    client.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > VERIFIER_FENCE_LIVENESS_MAX_BYTES) finish("uncertain");
    });
    client.on("end", () => {
      try { finish(matchesFenceBirthProof(JSON.parse(response), owner) ? "live" : "uncertain"); } catch { finish("uncertain"); }
    });
    client.on("error", (error) => finish(error?.code === "ENOENT" || error?.code === "ECONNREFUSED" ? "dead" : "uncertain"));
    client.on("close", () => { if (!settled) finish("uncertain"); });
  });
}

function ownerPidState(owner) {
  try {
    process.kill(owner.pid, 0);
    return "present";
  } catch (error) {
    return error?.code === "ESRCH" ? "absent" : "uncertain";
  }
}

async function ownerIsConclusiveDead(file, owner) {
  if (ownerPidState(owner) === "uncertain") return false;
  return await verifierFenceLivenessState(file, owner) === "dead";
}

async function createVerifierFenceArtifact(file, owner) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.fence`);
  let descriptor;
  try {
    descriptor = await fsPromises.open(temporary, "wx", 0o600);
    await descriptor.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await descriptor.chmod(0o600);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await fsPromises.link(temporary, file);
    await fsyncDirectory(directory);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw verifierFault();
  } finally {
    if (descriptor) try { await descriptor.close(); } catch {}
    try { await fsPromises.unlink(temporary); } catch {}
  }
}

async function removeVerifierFenceArtifact(file, expectedOwner, expectedStat) {
  const observed = await readVerifierFenceArtifact(file);
  if (observed.kind !== "valid" || !sameFenceOwner(observed.owner, expectedOwner) || expectedStat && !sameFile(observed.stat, expectedStat)) throw verifierFault();
  let witness;
  const witnessPath = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.release`);
  try {
    await fsPromises.link(file, witnessPath);
    witness = await readVerifierFenceArtifact(witnessPath);
    const current = await readVerifierFenceArtifact(file);
    if (witness.kind !== "valid" || current.kind !== "valid" || !sameFenceOwner(witness.owner, expectedOwner) || !sameFenceOwner(current.owner, expectedOwner) || !sameFile(witness.stat, current.stat) || expectedStat && !sameFile(current.stat, expectedStat)) throw verifierFault();
    await fsPromises.unlink(file);
    await fsyncDirectory(path.dirname(file));
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw verifierFault();
  } finally {
    try { await fsPromises.unlink(witnessPath); } catch {}
  }
}

async function removeOrphanedVerifierFenceRecoveries(file) {
  const directory = path.dirname(file);
  const prefix = `.${path.basename(file)}.`;
  const suffix = ".recovery";
  let entries;
  try {
    entries = await fsPromises.readdir(directory);
  } catch {
    throw verifierFault();
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
    const recoveryPath = path.join(directory, name);
    const recovery = await readVerifierFenceArtifact(recoveryPath);
    if (recovery.kind !== "valid" || recoveryPath !== recoveryPathForFenceOwner(file, recovery.owner) || !await ownerIsConclusiveDead(file, recovery.owner)) throw verifierFault();
    await removeVerifierFenceArtifact(recoveryPath, recovery.owner);
  }
}

async function reclaimDeadVerifierFence(file, observed) {
  if (!await ownerIsConclusiveDead(file, observed.owner)) return false;
  const directory = path.dirname(file);
  const recoveryPath = recoveryPathForFenceOwner(file, observed.owner);
  let createdRecovery = false;
  let completed = false;
  try {
    try {
      await fsPromises.link(file, recoveryPath);
      createdRecovery = true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      if (error?.code !== "EEXIST") throw error;
    }
    const current = await readVerifierFenceArtifact(file);
    const recovery = await readVerifierFenceArtifact(recoveryPath);
    if (current.kind !== "valid" || recovery.kind !== "valid" || !sameFenceOwner(current.owner, observed.owner) || !sameFenceOwner(recovery.owner, observed.owner) || !sameFile(current.stat, recovery.stat) || !sameFile(current.stat, observed.stat) || !await ownerIsConclusiveDead(file, current.owner)) return false;
    await fsPromises.unlink(file);
    await fsyncDirectory(directory);
    completed = true;
    return true;
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw verifierFault();
  } finally {
    if (createdRecovery || completed) {
      const recovery = await readVerifierFenceArtifact(recoveryPath);
      if (recovery.kind === "valid" && sameFenceOwner(recovery.owner, observed.owner)) {
        try { await fsPromises.unlink(recoveryPath); await fsyncDirectory(directory); } catch {}
      }
    }
  }
}

const waitForVerifierFence = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withAuthorityVerifierFence(file, operation) {
  if (typeof operation !== "function") throw verifierFault();
  const fencePath = authorityVerifierFencePath(file);
  const owner = newFenceOwner();
  const { timeoutMs, retryMs } = verifierFenceTiming();
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let released = false;
  let liveness;
  try {
    await ensureVerifierFenceDirectory(fencePath);
    liveness = await openVerifierFenceLiveness(fencePath, owner);
    while (Date.now() < deadline) {
      const beforeCreate = await readVerifierFenceArtifact(fencePath);
      if (beforeCreate.kind === "unsafe") throw verifierFault();
      if (beforeCreate.kind === "missing") await removeOrphanedVerifierFenceRecoveries(fencePath);
      if (await createVerifierFenceArtifact(fencePath, owner)) {
        acquired = true;
        break;
      }
      const observed = await readVerifierFenceArtifact(fencePath);
      if (observed.kind === "unsafe") throw verifierFault();
      if (observed.kind === "valid" && await ownerIsConclusiveDead(fencePath, observed.owner)) await reclaimDeadVerifierFence(fencePath, observed);
      await waitForVerifierFence(retryMs);
    }
    if (!acquired) throw verifierFault();
    return await operation();
  } finally {
    if (acquired) {
      await removeVerifierFenceArtifact(fencePath, owner);
      released = true;
    }
    if (liveness && (!acquired || released)) await closeVerifierFenceLiveness(liveness);
  }
}

export async function updateAuthorityVerifierStore(file, update, { allowCreate = false } = {}) {
  if (typeof update !== "function") throw verifierFault();
  return withAuthorityVerifierFence(file, async () => {
    const current = await readVerifierSnapshot(file, { allowMissing: allowCreate });
    const next = validateVerifierStore(await update(current?.store));
    if (current === undefined) {
      if (!allowCreate) throw verifierFault();
    } else {
      validateVerifierEvolution(current.store, next);
    }
    await writeDurableJson(file, next);
    return next;
  });
}

export async function writeAuthorityVerifierStore(file, store, { allowCreate = false, expectedGeneration } = {}) {
  return updateAuthorityVerifierStore(file, (current) => {
    if (current === undefined) {
      if (!allowCreate || expectedGeneration !== undefined) throw verifierFault();
    } else if (expectedGeneration !== current.generation) {
      throw verifierFault();
    }
    return store;
  }, { allowCreate });
}

export function authenticateAuthorityBearer(authorization, store, { requiredScope, provider, now = Date.now() } = {}) {
  validateVerifierStore(store);
  if (typeof authorization !== "string") throw verifierUnauthorized();
  const match = /^Bearer ([A-Za-z0-9._:-]{1,64})\.([A-Za-z0-9_-]{43})$/.exec(authorization);
  if (!match || !isSafeInteger(now)) throw verifierUnauthorized();
  const secret = Buffer.from(match[2], "base64url");
  if (secret.length !== 32) throw verifierUnauthorized();
  const digest = crypto.createHash("sha256").update(secret).digest();
  let record;
  for (const candidate of store.verifiers) if (candidate.tokenId === match[1]) record = candidate;
  const verifier = record ? Buffer.from(record.verifierSha256, "hex") : DUMMY_VERIFIER_SHA256;
  const digestMatches = crypto.timingSafeEqual(verifier, digest);
  if (!record || !digestMatches || record.revokedAtEpochMs !== null || now < record.issuedAtEpochMs || now >= record.expiresAtEpochMs) throw verifierUnauthorized();
  if (requiredScope !== undefined && record.scope !== requiredScope) throw new AuthorityError("forbidden_scope", { message: "scope is not allowed" });
  if (provider !== undefined && !record.laneAllowlist.includes(provider)) throw new AuthorityError("forbidden_lane", { message: "lane is not allowed" });
  return { installationId: record.installationId, providers: [...record.laneAllowlist], scope: record.scope, tokenId: record.tokenId, verifierGeneration: store.generation };
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
  const providers = principal.providers;
  if (!Array.isArray(providers) || providers.length === 0 || providers.length > Object.keys(PROVIDER_PORTS).length || new Set(providers).size !== providers.length || !providers.every((provider) => provider in PROVIDER_PORTS)) fail("unauthenticated", "principal is unavailable");
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

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isEpochMs(value) {
  return isSafeInteger(value, 0, MAX_EPOCH_MS);
}

function validateWindow(window) {
  if (window === null) return;
  const keys = ["utilization", "status", "resetEpochSeconds"];
  if (!hasExactKeys(window, keys)) throw new StateFault("allowance window is invalid");
  if (typeof window.utilization !== "number" || !Number.isFinite(window.utilization) || window.utilization < 0 || window.utilization > 1_000) throw new StateFault("allowance utilization is invalid");
  if (window.status !== null && !WINDOW_STATUSES.has(window.status)) throw new StateFault("allowance status is invalid");
  if (!isSafeInteger(window.resetEpochSeconds, 1, 253_402_300_799)) throw new StateFault("allowance reset is invalid");
}

function validateLease(lease) {
  const keys = ["leaseId", "generation", "claimedAtEpochMs", "renewSequence", "renewByEpochMs", "serverDeadlineEpochMs"];
  if (!hasExactKeys(lease, keys) || !isUuid(lease.leaseId) || !isSafeInteger(lease.generation, 1) || !isEpochMs(lease.claimedAtEpochMs) || !isSafeInteger(lease.renewSequence) || !isEpochMs(lease.renewByEpochMs) || !isEpochMs(lease.serverDeadlineEpochMs) || lease.renewByEpochMs < lease.claimedAtEpochMs || lease.serverDeadlineEpochMs < lease.renewByEpochMs) throw new StateFault("ticket lease is invalid");
}

function validatePublicTicket(ticket, response) {
  const keys = ["schemaVersion", "ticketId", "requestId", "provider", "state", "revision", "createdAtEpochMs", "enqueuedAtEpochMs", "offeredAtEpochMs", "offerExpiresAtEpochMs", "terminalAtEpochMs", "terminalReason", "queueAhead", "lease"];
  if (!hasExactKeys(response, keys) || response.schemaVersion !== 1 || response.ticketId !== ticket.ticketId || response.requestId !== ticket.requestId || response.provider !== ticket.provider || !TICKET_STATES.has(response.state) || !isSafeInteger(response.revision, 1) || response.revision > ticket.revision || response.createdAtEpochMs !== ticket.createdAtEpochMs || response.enqueuedAtEpochMs !== ticket.enqueuedAtEpochMs || !isSafeInteger(response.queueAhead, 0, MAX_RETAINED_RECORDS)) throw new StateFault("ticket replay response is invalid");
  if (response.offeredAtEpochMs !== null && !isEpochMs(response.offeredAtEpochMs) || response.offerExpiresAtEpochMs !== null && !isEpochMs(response.offerExpiresAtEpochMs) || response.terminalAtEpochMs !== null && !isEpochMs(response.terminalAtEpochMs) || (response.offeredAtEpochMs === null) !== (response.offerExpiresAtEpochMs === null) || response.offeredAtEpochMs !== null && response.offerExpiresAtEpochMs < response.offeredAtEpochMs) throw new StateFault("ticket replay response is invalid");
  if (response.state === "queued") {
    if (response.offeredAtEpochMs !== null || response.offerExpiresAtEpochMs !== null || response.terminalAtEpochMs !== null || response.terminalReason !== null || response.lease !== null) throw new StateFault("ticket replay response is invalid");
  } else if (response.state === "offered") {
    if (response.offeredAtEpochMs === null || response.offerExpiresAtEpochMs === null || response.terminalAtEpochMs !== null || response.terminalReason !== null || response.lease !== null) throw new StateFault("ticket replay response is invalid");
  } else if (response.state === "active" || response.state === "uncertain") {
    if (response.offeredAtEpochMs === null || response.offerExpiresAtEpochMs === null || response.terminalAtEpochMs !== null || response.terminalReason !== null) throw new StateFault("ticket replay response is invalid");
    validateLease(response.lease);
  } else {
    const validReason = response.state === "cancelled" ? ["client_cancelled", "authority_draining"] : response.state === "released" ? ["released", "operator_reconciled"] : response.state === "throttled" ? ["assistant_rate_limit", "assistant_overloaded"] : ["offer_expired"];
    if (response.terminalAtEpochMs === null || response.lease !== null || !validReason.includes(response.terminalReason)) throw new StateFault("ticket replay response is invalid");
  }
}

function parseStoredFingerprint(fingerprint, actions, message) {
  if (typeof fingerprint !== "string" || fingerprint.length === 0 || fingerprint.length > MAX_FINGERPRINT_LENGTH) throw new StateFault(message);
  const separator = fingerprint.indexOf(":");
  const action = separator > 0 ? fingerprint.slice(0, separator) : "";
  const encodedRequest = separator > 0 ? fingerprint.slice(separator + 1) : "";
  if (!actions.has(action)) throw new StateFault(message);
  let request;
  try { request = JSON.parse(encodedRequest); } catch { throw new StateFault(message); }
  if (!isObject(request) || canonical(request) !== encodedRequest) throw new StateFault(message);
  return { action, request };
}

function validateOperationResult(ticket, result) {
  const keys = ["operationId", "fingerprint", "response", "recordedAtEpochMs"];
  if (!hasExactKeys(result, keys) || !isUuid(result.operationId) || !isEpochMs(result.recordedAtEpochMs)) throw new StateFault("ticket operation ledger is invalid");
  const { action, request } = parseStoredFingerprint(result.fingerprint, new Set(["claim", "cancel", "renew", "complete"]), "ticket operation ledger is invalid");
  try { validateMutationRequest(request, action); } catch { throw new StateFault("ticket operation ledger is invalid"); }
  if (request.operationId !== result.operationId || request.installationId !== ticket.installationId || request.provider !== ticket.provider || request.accountBindingId !== ticket.accountBindingId) throw new StateFault("ticket operation ledger is invalid");
  validatePublicTicket(ticket, result.response);
  if (result.response.revision !== request.expectedRevision + 1 || action === "claim" && result.response.state !== "active" || action === "cancel" && result.response.state !== "cancelled" || action === "renew" && (result.response.state !== "active" || result.response.lease?.leaseId !== request.leaseId || result.response.lease?.generation !== request.generation || result.response.lease?.renewSequence !== request.renewSequence) || action === "complete" && (result.response.state !== request.outcome || result.response.lease !== null)) throw new StateFault("ticket operation ledger is invalid");
}

function validateTicketState(ticket) {
  const keys = ["ticketId", "requestId", "provider", "installationId", "accountBindingId", "sessionId", "state", "revision", "createdAtEpochMs", "enqueuedAtEpochMs", "offeredAtEpochMs", "offerExpiresAtEpochMs", "terminalAtEpochMs", "terminalReason", "lease", "operationResults", "createResponse", "queueSequence"];
  if (!hasExactKeys(ticket, keys) || !isUuid(ticket.ticketId) || !isUuid(ticket.requestId) || !(ticket.provider in PROVIDER_PORTS) || !isUuid(ticket.installationId) || !isUuid(ticket.accountBindingId) || !isUuid(ticket.sessionId)) throw new StateFault("ticket identity is invalid");
  if (!TICKET_STATES.has(ticket.state) || !isSafeInteger(ticket.revision, 1) || !isEpochMs(ticket.createdAtEpochMs) || !isEpochMs(ticket.enqueuedAtEpochMs) || !isSafeInteger(ticket.queueSequence, 1)) throw new StateFault("ticket state is invalid");
  if (ticket.offeredAtEpochMs !== null && !isEpochMs(ticket.offeredAtEpochMs) || ticket.offerExpiresAtEpochMs !== null && !isEpochMs(ticket.offerExpiresAtEpochMs) || ticket.terminalAtEpochMs !== null && !isEpochMs(ticket.terminalAtEpochMs) || (ticket.offeredAtEpochMs === null) !== (ticket.offerExpiresAtEpochMs === null) || ticket.offeredAtEpochMs !== null && ticket.offerExpiresAtEpochMs < ticket.offeredAtEpochMs) throw new StateFault("ticket state is invalid");
  if (![null, "client_cancelled", "authority_draining", "offer_expired", "released", "assistant_rate_limit", "assistant_overloaded", "operator_reconciled"].includes(ticket.terminalReason)) throw new StateFault("ticket terminal reason is invalid");
  if (!Array.isArray(ticket.operationResults) || ticket.operationResults.length > MAX_OPERATION_RESULTS || new Set(ticket.operationResults.map((result) => result?.operationId)).size !== ticket.operationResults.length) throw new StateFault("ticket operation ledger is invalid");
  for (const result of ticket.operationResults) validateOperationResult(ticket, result);
  if (ticket.createResponse === null) throw new StateFault("ticket replay state is invalid");
  validatePublicTicket(ticket, ticket.createResponse);
  if (ticket.state === "queued") {
    if (ticket.offeredAtEpochMs !== null || ticket.offerExpiresAtEpochMs !== null || ticket.terminalAtEpochMs !== null || ticket.terminalReason !== null || ticket.lease !== null) throw new StateFault("queued ticket fields are invalid");
  } else if (ticket.state === "offered") {
    if (ticket.offeredAtEpochMs === null || ticket.offerExpiresAtEpochMs === null || ticket.terminalAtEpochMs !== null || ticket.terminalReason !== null || ticket.lease !== null) throw new StateFault("offered ticket fields are invalid");
  } else if (ticket.state === "active" || ticket.state === "uncertain") {
    if (ticket.offeredAtEpochMs === null || ticket.offerExpiresAtEpochMs === null || ticket.terminalAtEpochMs !== null || ticket.terminalReason !== null) throw new StateFault("active ticket fields are invalid");
    validateLease(ticket.lease);
  } else {
    const validReason = ticket.state === "cancelled" ? ["client_cancelled", "authority_draining"] : ticket.state === "released" ? ["released", "operator_reconciled"] : ticket.state === "throttled" ? ["assistant_rate_limit", "assistant_overloaded"] : ["offer_expired"];
    if (ticket.terminalAtEpochMs === null || ticket.lease !== null || !validReason.includes(ticket.terminalReason)) throw new StateFault("terminal ticket fields are invalid");
  }
}

function parseCreateKey(key) {
  const parts = typeof key === "string" ? key.split("\u0000") : [];
  if (parts.length !== 3 || !isUuid(parts[0]) || !(parts[1] in PROVIDER_PORTS) || !isUuid(parts[2])) throw new StateFault("create replay key is invalid");
  return { installationId: parts[0], provider: parts[1], requestId: parts[2] };
}

function parsePublisherKey(key, includesPublishId = false) {
  const parts = typeof key === "string" ? key.split("\u0000") : [];
  const expectedLength = includesPublishId ? 3 : 2;
  if (parts.length !== expectedLength || !isUuid(parts[0]) || !(parts[1] in PROVIDER_PORTS) || includesPublishId && !isUuid(parts[2])) throw new StateFault("allowance replay key is invalid");
  return { installationId: parts[0], provider: parts[1], publishId: parts[2] };
}

function validatePrivateAllowance(allowance) {
  const keys = ["observedAtEpochMs", "fiveHour", "sevenDay"];
  if (!hasExactKeys(allowance, keys) || !isEpochMs(allowance.observedAtEpochMs)) throw new StateFault("allowance replay state is invalid");
  validateWindow(allowance.fiveHour);
  validateWindow(allowance.sevenDay);
}

function validateAllowanceReplay(key, replay) {
  const keys = ["fingerprint", "allowance", "receivedAtEpochMs"];
  if (!hasExactKeys(replay, keys) || !isEpochMs(replay.receivedAtEpochMs)) throw new StateFault("allowance replay state is invalid");
  const keyed = parsePublisherKey(key, true);
  if (typeof replay.fingerprint !== "string" || replay.fingerprint.length === 0 || replay.fingerprint.length > MAX_FINGERPRINT_LENGTH) throw new StateFault("allowance replay state is invalid");
  let request;
  try { request = JSON.parse(replay.fingerprint); } catch { throw new StateFault("allowance replay state is invalid"); }
  if (!isObject(request) || canonical(request) !== replay.fingerprint) throw new StateFault("allowance replay state is invalid");
  try { validateAllowanceRequestShape(request); } catch { throw new StateFault("allowance replay state is invalid"); }
  if (keyed.installationId !== request.installationId || keyed.provider !== request.provider || keyed.publishId !== request.publishId) throw new StateFault("allowance replay state is invalid");
  validatePrivateAllowance(replay.allowance);
  const expectedAllowance = { observedAtEpochMs: request.observedAtEpochMs, fiveHour: request.fiveHour, sevenDay: request.sevenDay };
  if (canonical(replay.allowance) !== canonical(expectedAllowance)) throw new StateFault("allowance replay state is invalid");
  return request;
}

function cursorSuccessorIsValid(order, cursor) {
  return order.length === 0 ? cursor === 0 : isSafeInteger(cursor, 0, order.length - 1);
}

function validateAllowanceState(allowance) {
  const keys = ["observedAtEpochMs", "fiveHour", "sevenDay", "receivedAtEpochMs"];
  if (!hasExactKeys(allowance, keys) || allowance.observedAtEpochMs !== null && !isEpochMs(allowance.observedAtEpochMs) || allowance.receivedAtEpochMs !== null && !isEpochMs(allowance.receivedAtEpochMs) || (allowance.observedAtEpochMs === null) !== (allowance.receivedAtEpochMs === null)) throw new StateFault("authority allowance state is invalid");
  validateWindow(allowance.fiveHour);
  validateWindow(allowance.sevenDay);
  if (allowance.observedAtEpochMs === null && (allowance.fiveHour !== null || allowance.sevenDay !== null)) throw new StateFault("authority allowance state is invalid");
  return allowance;
}

function validateState(state, { provider, port, timing, allowTestPort = false } = {}) {
  if (!hasExactKeys(state, stateKeys()) || state.stateSchemaVersion !== STATE_SCHEMA_VERSION) throw new StateFault("authority state schema is unsupported");
  if (!isUuid(state.authorityId) || !(state.provider in PROVIDER_PORTS) || !isSafeInteger(state.port, 1, 65535) || !isSafeInteger(state.laneTerm, 1) || !isUuid(state.ownerNonce)) throw new StateFault("authority state header is invalid");
  if (!allowTestPort && PROVIDER_PORTS[state.provider] !== state.port) throw new StateFault("authority state provider and port do not match");
  if (provider && state.provider !== provider) throw new StateFault("authority state provider does not match configuration");
  if (port && state.port !== port) throw new StateFault("authority state port does not match configuration");
  if (state.timingSchemaVersion !== 1 || typeof state.timingDigest !== "string" || !/^[0-9a-f]{64}$/.test(state.timingDigest) || !isSafeInteger(state.verifierGeneration, 1)) throw new StateFault("authority state timing header is invalid");
  if (!["ready", "draining", "degraded"].includes(state.lifecycleState)) throw new StateFault("authority lifecycle state is invalid");
  const schedulerKeys = ["minimumConcurrency", "currentConcurrency", "maximumConcurrency", "cooldownUntilEpochMs", "lastThrottleAtEpochMs", "lastIncreaseAtEpochMs"];
  if (!hasExactKeys(state.scheduler, schedulerKeys) || !isSafeInteger(state.scheduler.minimumConcurrency, 1, 64) || !isSafeInteger(state.scheduler.currentConcurrency, 1, 64) || !isSafeInteger(state.scheduler.maximumConcurrency, 1, 64) || state.scheduler.minimumConcurrency > state.scheduler.currentConcurrency || state.scheduler.currentConcurrency > state.scheduler.maximumConcurrency || state.scheduler.cooldownUntilEpochMs !== null && !isEpochMs(state.scheduler.cooldownUntilEpochMs) || state.scheduler.lastThrottleAtEpochMs !== null && !isEpochMs(state.scheduler.lastThrottleAtEpochMs) || !isEpochMs(state.scheduler.lastIncreaseAtEpochMs)) throw new StateFault("authority scheduler is invalid");
  if (!isObject(state.tickets) || !isObject(state.createTombstones) || !isObject(state.fairness) || !isObject(state.allowance) || !isObject(state.allowancePublishes) || !isObject(state.publisherSequences) || !isObject(state.counters)) throw new StateFault("authority state is incomplete");
  const ticketIds = new Set();
  const createKeys = new Set();
  const queueSequences = new Set();
  const ticketPairs = new Map();
  const liveTicketPairs = new Map();
  let highestQueueSequence = 0;
  for (const [ticketId, ticket] of Object.entries(state.tickets)) {
    if (!isUuid(ticketId) || ticketId !== ticket?.ticketId || ticket.provider !== state.provider || ticketIds.has(ticketId)) throw new StateFault("authority ticket key is invalid");
    validateTicketState(ticket);
    const createKey = createKeyForState(ticket.installationId, ticket.provider, ticket.requestId);
    if (createKeys.has(createKey) || queueSequences.has(ticket.queueSequence)) throw new StateFault("authority ticket ordering is invalid");
    ticketIds.add(ticketId);
    createKeys.add(createKey);
    queueSequences.add(ticket.queueSequence);
    highestQueueSequence = Math.max(highestQueueSequence, ticket.queueSequence);
    const sessions = ticketPairs.get(ticket.installationId) ?? new Set();
    sessions.add(ticket.sessionId);
    ticketPairs.set(ticket.installationId, sessions);
    if (!TERMINAL_STATES.has(ticket.state)) {
      const liveSessions = liveTicketPairs.get(ticket.installationId) ?? new Set();
      liveSessions.add(ticket.sessionId);
      liveTicketPairs.set(ticket.installationId, liveSessions);
    }
  }
  if (!hasExactKeys(state.counters, ["nextQueueSequence"]) || !isSafeInteger(state.counters.nextQueueSequence, 1) || state.counters.nextQueueSequence <= highestQueueSequence) throw new StateFault("authority counters are invalid");
  if (capacityInUse(state) > state.scheduler.currentConcurrency) throw new StateFault("authority capacity state is unsafe");
  if (timing && state.timingDigest !== timing.digest) {
    const hasLiveWork = Object.values(state.tickets).some((ticket) => ACTIVE_STATES.has(ticket.state));
    if (hasLiveWork || state.lifecycleState !== "draining") throw new StateFault("authority timing changed without a drained restart");
  }
  if (Object.keys(state.tickets).length + Object.keys(state.createTombstones).length > MAX_RETAINED_RECORDS) throw new StateFault("authority retained state exceeds the protocol bound");
  for (const [key, tombstone] of Object.entries(state.createTombstones)) {
    const parsed = parseCreateKey(key);
    if (parsed.provider !== state.provider || !hasExactKeys(tombstone, ["createdAtEpochMs", "compactedAtEpochMs"]) || !isEpochMs(tombstone.createdAtEpochMs) || !isEpochMs(tombstone.compactedAtEpochMs) || tombstone.compactedAtEpochMs < tombstone.createdAtEpochMs || createKeys.has(createKeyForState(parsed.installationId, parsed.provider, parsed.requestId))) throw new StateFault("create replay state is invalid");
  }
  const fairnessKeys = ["machineOrder", "machineCursor", "sessionOrder", "sessionCursor"];
  if (!hasExactKeys(state.fairness, fairnessKeys) || !Array.isArray(state.fairness.machineOrder) || state.fairness.machineOrder.length > MAX_INSTALLATIONS || new Set(state.fairness.machineOrder).size !== state.fairness.machineOrder.length || !state.fairness.machineOrder.every(isUuid) || !cursorSuccessorIsValid(state.fairness.machineOrder, state.fairness.machineCursor) || !isObject(state.fairness.sessionOrder) || !isObject(state.fairness.sessionCursor) || Object.keys(state.fairness.sessionOrder).length !== Object.keys(state.fairness.sessionCursor).length) throw new StateFault("authority fairness state is invalid");
  for (const installationId of state.fairness.machineOrder) {
    if (!ticketPairs.has(installationId) || !Object.hasOwn(state.fairness.sessionOrder, installationId)) throw new StateFault("authority fairness state is invalid");
  }
  for (const [installationId, sessions] of Object.entries(state.fairness.sessionOrder)) {
    const knownSessions = ticketPairs.get(installationId);
    if (!state.fairness.machineOrder.includes(installationId) || !isUuid(installationId) || !Array.isArray(sessions) || sessions.length === 0 || sessions.length > MAX_SESSIONS_PER_INSTALLATION || new Set(sessions).size !== sessions.length || !sessions.every((sessionId) => isUuid(sessionId) && knownSessions?.has(sessionId)) || !Object.hasOwn(state.fairness.sessionCursor, installationId) || !cursorSuccessorIsValid(sessions, state.fairness.sessionCursor[installationId])) throw new StateFault("authority fairness state is invalid");
  }
  for (const [installationId, sessions] of liveTicketPairs) {
    if (!state.fairness.machineOrder.includes(installationId) || !sessionsIsSubset(sessions, state.fairness.sessionOrder[installationId])) throw new StateFault("authority fairness state is invalid");
  }
  validateAllowanceState(state.allowance);
  const replayEntries = Object.entries(state.allowancePublishes);
  if (replayEntries.length > MAX_ALLOWANCE_REPLAY_RECORDS) throw new StateFault("allowance replay state exceeds the protocol bound");
  const replaySequences = new Map();
  const replayCounts = new Map();
  let currentAllowanceMatched = state.allowance.observedAtEpochMs === null;
  for (const [key, replay] of replayEntries) {
    const request = validateAllowanceReplay(key, replay);
    if (request.provider !== state.provider) throw new StateFault("allowance replay state is invalid");
    const sequenceKey = publisherSequenceKey(request.installationId, request.provider);
    const sequences = replaySequences.get(sequenceKey) ?? [];
    sequences.push(request.publisherSequence);
    replaySequences.set(sequenceKey, sequences);
    const count = (replayCounts.get(request.installationId) ?? 0) + 1;
    if (count > MAX_ALLOWANCE_REPLAYS_PER_INSTALLATION) throw new StateFault("allowance replay state exceeds the protocol bound");
    replayCounts.set(request.installationId, count);
    if (state.allowance.observedAtEpochMs !== null && replay.receivedAtEpochMs === state.allowance.receivedAtEpochMs && canonical(replay.allowance) === canonical({ observedAtEpochMs: state.allowance.observedAtEpochMs, fiveHour: state.allowance.fiveHour, sevenDay: state.allowance.sevenDay })) currentAllowanceMatched = true;
  }
  if (Object.keys(state.publisherSequences).length > MAX_INSTALLATIONS || Object.keys(state.publisherSequences).length !== replaySequences.size) throw new StateFault("publisher sequence state is invalid");
  for (const [key, sequence] of Object.entries(state.publisherSequences)) {
    const publisher = parsePublisherKey(key);
    if (publisher.provider !== state.provider) throw new StateFault("publisher sequence state is invalid");
    const replays = replaySequences.get(key);
    if (!isSafeInteger(sequence, 1) || !replays || new Set(replays).size !== replays.length || Math.max(...replays) !== sequence) throw new StateFault("publisher sequence state is invalid");
  }
  if (!currentAllowanceMatched) throw new StateFault("allowance replay state is invalid");
  return state;
}

function createKeyForState(installationId, provider, requestId) {
  return `${installationId}\u0000${provider}\u0000${requestId}`;
}

function sessionsIsSubset(sessions, order) {
  return Array.isArray(order) && [...sessions].every((sessionId) => order.includes(sessionId));
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
  const legacyKeys = stateKeys().filter((key) => !["ownerNonce", "createTombstones", "allowancePublishes", "publisherSequences"].includes(key));
  if (!hasExactKeys(state, legacyKeys) || state.stateSchemaVersion !== 1 || !hasExactKeys(state.counters, ["nextQueueSequence"]) || !isSafeInteger(state.counters.nextQueueSequence, 1) || !isObject(state.tickets)) throw new StateFault("authority state migration is unsafe");
  const migrated = clone(state);
  migrated.stateSchemaVersion = STATE_SCHEMA_VERSION;
  migrated.ownerNonce = crypto.randomUUID();
  migrated.createTombstones = {};
  migrated.allowancePublishes = {};
  migrated.publisherSequences = {};
  validateAllowanceState(migrated.allowance);
  if (migrated.allowance.observedAtEpochMs !== null) {
    // Schema 1 did not retain publisher identity, so use the fresh owner nonce to avoid colliding with a client principal.
    const installationId = migrated.ownerNonce;
    const publishId = crypto.randomUUID();
    const request = {
      schemaVersion: 1,
      installationId,
      provider: migrated.provider,
      accountBindingId: installationId,
      publishId,
      publisherSequence: 1,
      observedAtEpochMs: migrated.allowance.observedAtEpochMs,
      fiveHour: clone(migrated.allowance.fiveHour),
      sevenDay: clone(migrated.allowance.sevenDay),
    };
    const allowance = privateAllowance(migrated);
    migrated.allowancePublishes[publisherKey(installationId, migrated.provider, publishId)] = { fingerprint: canonical(request), allowance, receivedAtEpochMs: migrated.allowance.receivedAtEpochMs };
    migrated.publisherSequences[publisherSequenceKey(installationId, migrated.provider)] = request.publisherSequence;
  }
  let nextQueueSequence = migrated.counters.nextQueueSequence;
  for (const ticket of Object.values(migrated.tickets)) {
    if (!isObject(ticket)) throw new StateFault("authority state migration is unsafe");
    ticket.operationResults ??= [];
    ticket.queueSequence ??= nextQueueSequence++;
    ticket.lease ??= null;
  }
  const highestQueueSequence = Math.max(0, ...Object.values(migrated.tickets).map((ticket) => ticket.queueSequence));
  migrated.counters.nextQueueSequence = Math.max(nextQueueSequence, highestQueueSequence + 1);
  for (const ticket of Object.values(migrated.tickets)) {
    ticket.createResponse ??= ticketPublic(migrated, ticket);
  }
  validateState(migrated, configuration);
  return migrated;
}

function readJsonSnapshot(file) {
  let raw;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new StateFault("authority state permissions are unsafe");
    raw = fs.readFileSync(file);
  } catch (error) {
    if (error instanceof StateFault) throw error;
    if (error?.code === "ENOENT") return undefined;
    throw new StateFault("authority state cannot be read");
  }
  try {
    return { raw, state: JSON.parse(raw.toString("utf8")) };
  } catch {
    throw new StateFault("authority state is corrupt");
  }
}

async function readJsonFileAsync(file) {
  let raw;
  try {
    const stat = await fsPromises.stat(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new StateFault("authority state permissions are unsafe");
    raw = await fsPromises.readFile(file);
  } catch (error) {
    if (error instanceof StateFault) throw error;
    if (error?.code === "ENOENT") return undefined;
    throw new StateFault("authority state cannot be read");
  }
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new StateFault("authority state is corrupt");
  }
}

function fsyncDirectorySync(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

async function fsyncDirectory(directory) {
  const descriptor = await fsPromises.open(directory, "r");
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}

function invokeFault(faultInjector, phase, file) {
  if (!faultInjector) return;
  const result = faultInjector({ phase, file });
  if (result instanceof Error) throw result;
}

async function invokeFaultAsync(faultInjector, phase, file) {
  if (!faultInjector) return;
  const result = await faultInjector({ phase, file });
  if (result instanceof Error) throw result;
}

function writeDurableJsonSync(file, value, faultInjector) {
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
    fsyncDirectorySync(directory);
  } catch (error) {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch {}
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
}

async function writeDurableJson(file, value, faultInjector) {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let descriptor;
  try {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(directory, 0o700);
    await invokeFaultAsync(faultInjector, "before-write", file);
    descriptor = await fsPromises.open(temporary, "wx", 0o600);
    await descriptor.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await descriptor.chmod(0o600);
    await descriptor.sync();
    await descriptor.close();
    descriptor = undefined;
    await invokeFaultAsync(faultInjector, "after-file-fsync", file);
    await invokeFaultAsync(faultInjector, "before-rename", file);
    await fsPromises.rename(temporary, file);
    await invokeFaultAsync(faultInjector, "after-rename", file);
    await invokeFaultAsync(faultInjector, "before-directory-fsync", file);
    await fsyncDirectory(directory);
  } catch (error) {
    if (descriptor !== undefined) try { await descriptor.close(); } catch {}
    try { await fsPromises.unlink(temporary); } catch {}
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

function successorCursor(priorOrder, priorCursor, survivingOrder) {
  if (survivingOrder.length === 0 || priorOrder.length === 0) return 0;
  const start = priorCursor % priorOrder.length;
  for (let offset = 0; offset < priorOrder.length; offset += 1) {
    const survivor = priorOrder[(start + offset) % priorOrder.length];
    const index = survivingOrder.indexOf(survivor);
    if (index !== -1) return index;
  }
  return 0;
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
  const machines = priorMachines.filter((installationId) => liveMachines.has(installationId));
  state.fairness.machineOrder = machines;
  state.fairness.machineCursor = successorCursor(priorMachines, state.fairness.machineCursor, machines);
  for (const installationId of Object.keys(state.fairness.sessionOrder)) {
    const liveSessions = liveMachines.get(installationId);
    if (!liveSessions) {
      delete state.fairness.sessionOrder[installationId];
      delete state.fairness.sessionCursor[installationId];
      continue;
    }
    const priorSessions = state.fairness.sessionOrder[installationId];
    const sessions = priorSessions.filter((sessionId) => liveSessions.has(sessionId));
    const cursor = successorCursor(priorSessions, state.fairness.sessionCursor[installationId], sessions);
    for (const sessionId of liveSessions) if (!sessions.includes(sessionId)) sessions.push(sessionId);
    state.fairness.sessionOrder[installationId] = sessions;
    state.fairness.sessionCursor[installationId] = cursor;
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

function validateAllowanceRequestShape(request) {
  assertExactObject(request, ["schemaVersion", "installationId", "provider", "accountBindingId", "publishId", "publisherSequence", "observedAtEpochMs", "fiveHour", "sevenDay"]);
  assertSchemaVersion(request.schemaVersion);
  assertUuid(request.installationId);
  assertProvider(request.provider);
  assertUuid(request.accountBindingId);
  assertUuid(request.publishId);
  assertSafeInteger(request.publisherSequence, 1);
  assertSafeInteger(request.observedAtEpochMs);
  validateWindowRequest(request.fiveHour);
  validateWindowRequest(request.sevenDay);
}

function validateAllowanceRequest(request, now) {
  validateAllowanceRequestShape(request);
  if (request.observedAtEpochMs > now + MAX_REQUEST_AGE_MS) fail("invalid_request", "allowance observation is in the future");
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
  if (eligible.length > 0) pruneFairness(state);
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
  if (options.verifierStorePath !== undefined && (typeof options.verifierStorePath !== "string" || !options.verifierStorePath)) throw new StateFault("verifier store path is invalid");
  if (options.verifyGeneration !== undefined && typeof options.verifyGeneration !== "function" || options.verifyGenerationSync !== undefined && typeof options.verifyGenerationSync !== "function") throw new StateFault("verifier generation checker is invalid");
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
    verifierStorePath: options.verifierStorePath,
    verifyGeneration: options.verifyGeneration,
    verifyGenerationSync: options.verifyGenerationSync,
    allowTestPort: options.allowTestPort === true,
    allowMigration: options.allowMigration !== false,
    bootstrap: options.bootstrap === true,
    clock: options.clock ?? Date.now,
    faultInjector: options.faultInjector,
    runtimeFaultInjector: options.runtimeFaultInjector ?? options.faultInjector,
  };
}

export class AuthorityState {
  constructor(state, configuration) {
    this.state = state;
    this.configuration = configuration;
    this.degraded = false;
    this._tail = Promise.resolve();
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

  get verifierGeneration() {
    return this.state.verifierGeneration;
  }

  async awaitIdle() {
    await this._tail;
  }

  markVerifierUnavailable() {
    this.degraded = true;
  }

  _now() {
    const now = this.configuration.clock();
    if (!isSafeInteger(now)) throw new StateFault("authority clock is invalid");
    return now;
  }

  _degrade(error) {
    this.degraded = true;
    if (error instanceof AuthorityError) throw error;
    throw new StateFault("authority persistence failed");
  }

  _enqueue(operation) {
    const run = this._tail.then(operation, operation);
    this._tail = run.catch(() => {});
    return run;
  }

  _validateCurrent() {
    try { validateState(this.state, this.configuration); } catch (error) { this._degrade(error); }
  }

  async _assertStoredHeader() {
    let stored;
    try {
      stored = await readJsonFileAsync(this.configuration.statePath);
      if (stored) validateState(stored, this.configuration);
    } catch (error) {
      this._degrade(error);
    }
    if (!stored || !sameHeader(stored, this.state) || canonical(stored) !== canonical(this.state)) this._degrade(new StateFault("authority ownership fence changed"));
  }

  async _commit(next, verifyGeneration) {
    await this._assertStoredHeader();
    const commit = async () => {
      let generation = this.configuration.verifierGeneration;
      await invokeFaultAsync(this.configuration.runtimeFaultInjector, "before-verifier-recheck", this.configuration.statePath);
      if (verifyGeneration ?? this.configuration.verifyGeneration) generation = await (verifyGeneration ?? this.configuration.verifyGeneration)();
      if (!isSafeInteger(generation, 1) || generation < this.state.verifierGeneration) throw verifierFault();
      next.verifierGeneration = generation;
      validateState(next, this.configuration);
      await writeDurableJson(this.configuration.statePath, next, this.configuration.runtimeFaultInjector);
    };
    try {
      await invokeFaultAsync(this.configuration.runtimeFaultInjector, "before-verifier-fence", this.configuration.statePath);
      if (this.configuration.verifierStorePath) await withAuthorityVerifierFence(this.configuration.verifierStorePath, commit);
      else await commit();
    } catch (error) {
      if (error instanceof AuthorityError && ["unauthenticated", "forbidden_scope", "forbidden_lane"].includes(error.code)) throw error;
      this._degrade(error);
    }
    this.state = next;
  }

  _transition(mutate, { allowDraining = false, verifyGeneration } = {}) {
    return this._enqueue(async () => {
      if (this.degraded || this.state.lifecycleState === "degraded") fail("authority_degraded", "authority is degraded");
      if (!allowDraining && this.state.lifecycleState === "draining") fail("authority_draining", "authority is draining");
      this._validateCurrent();
      const next = clone(this.state);
      const now = this._now();
      const result = mutate(next, now);
      await this._commit(next, verifyGeneration);
      return result;
    });
  }

  reconcile() {
    return this._enqueue(async () => {
      if (this.degraded || this.state.lifecycleState === "degraded") return false;
      this._validateCurrent();
      const next = clone(this.state);
      const now = this._now();
      const changed = expireAndQuarantine(next, now, this.configuration.timing);
      const offered = next.lifecycleState === "ready" ? scheduleOffers(next, now, this.configuration.timing) : [];
      if (!changed && offered.length === 0) return false;
      await this._commit(next);
      return true;
    });
  }

  createTicket(principal, request, { verifyGeneration } = {}) {
    return this._transition((next, transitionNow) => {
      validateCreateRequest(request);
      const checkedPrincipal = assertPrincipalMatches(principal, request);
      if (request.provider !== next.provider) fail("provider_mismatch", "request provider does not match lane");
      expireAndQuarantine(next, transitionNow, this.configuration.timing);
      compactRetainedState(next, transitionNow, this.configuration.timing);
      const key = createKey(checkedPrincipal.installationId, request.provider, request.requestId);
      const existing = Object.values(next.tickets).find((ticket) => createKey(ticket.installationId, ticket.provider, ticket.requestId) === key);
      if (existing) {
        const sameRequest = existing.accountBindingId === request.accountBindingId && existing.sessionId === request.sessionId && existing.createdAtEpochMs === request.createdAtEpochMs;
        if (!sameRequest) fail("operation_conflict", "request identifier was reused");
        return { ticket: clone(existing.createResponse), replayed: true, created: false };
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
    }, { verifyGeneration });
  }

  getTicket(principal, ticketId) {
    const checkedPrincipal = assertPrincipal(principal);
    if (!checkedPrincipal.providers.has(this.state.provider)) fail("forbidden_lane", "lane is not allowed");
    if (!isUuid(ticketId)) fail("not_found", "ticket is unavailable");
    this._validateCurrent();
    return ticketPublic(this.state, ticketForOwner(this.state, checkedPrincipal, ticketId));
  }

  mutateTicket(principal, ticketId, action, request, { verifyGeneration } = {}) {
    return this._transition((next, now) => {
      if (!["claim", "cancel", "renew", "complete"].includes(action)) throw new StateFault("authority operation is invalid");
      validateMutationRequest(request, action);
      const checkedPrincipal = assertPrincipalMatches(principal, request);
      if (!isUuid(ticketId)) fail("not_found", "ticket is unavailable");
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
    }, { allowDraining: action === "renew" || action === "complete" || action === "cancel", verifyGeneration });
  }

  publishAllowance(principal, request, { verifyGeneration } = {}) {
    return this._transition((next, transitionNow) => {
      validateAllowanceRequest(request, transitionNow);
      const checkedPrincipal = assertPrincipalMatches(principal, request);
      if (request.provider !== next.provider) fail("provider_mismatch", "allowance provider does not match lane");
      const key = publisherKey(checkedPrincipal.installationId, request.provider, request.publishId);
      const fingerprint = canonical(request);
      const replay = next.allowancePublishes[key];
      if (replay) {
        if (replay.fingerprint !== fingerprint) fail("operation_conflict", "publish identifier was reused");
        return { accepted: clone(replay.allowance), publishId: parsePublisherKey(key, true).publishId, replayed: true };
      }
      const sequenceKey = publisherSequenceKey(checkedPrincipal.installationId, request.provider);
      if (!Object.hasOwn(next.publisherSequences, sequenceKey) && Object.keys(next.publisherSequences).length >= MAX_INSTALLATIONS) fail("principal_limit", "publisher principal limit reached");
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
      return { accepted: allowance, publishId: request.publishId, replayed: false };
    }, { verifyGeneration });
  }

  allowancePublishResponse(result, { instanceId }) {
    if (!isUuid(instanceId) || !isObject(result) || !isUuid(result.publishId) || typeof result.replayed !== "boolean") throw new StateFault("allowance publish response is invalid");
    validatePrivateAllowance(result.accepted);
    return {
      schemaVersion: 1,
      protocolVersion: 2,
      authorityId: this.state.authorityId,
      laneTerm: this.state.laneTerm,
      instanceId,
      laneId: LANE_IDS[this.state.provider],
      provider: this.state.provider,
      port: this.state.port,
      publishId: result.publishId,
      disposition: result.replayed ? "replayed" : "accepted",
      accepted: clone(result.accepted),
    };
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

  reconcileUncertain(ticketId) {
    return this._transition((next, now) => {
      if (!isUuid(ticketId)) fail("not_found", "ticket is unavailable");
      const ticket = next.tickets[ticketId];
      if (!ticket) fail("not_found", "ticket is unavailable");
      if (ticket.state !== "uncertain") fail("invalid_transition", "ticket is not uncertain");
      ticket.state = "released";
      ticket.revision += 1;
      ticket.terminalAtEpochMs = now;
      ticket.terminalReason = "operator_reconciled";
      ticket.lease = null;
      scheduleOffers(next, now, this.configuration.timing);
      return ticketPublic(next, ticket);
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

function currentVerifierGenerationSync(configuration, minimumGeneration) {
  let generation = configuration.verifierGeneration;
  if (configuration.verifyGenerationSync) generation = configuration.verifyGenerationSync();
  if (!isSafeInteger(generation, 1) || generation < minimumGeneration) throw verifierFault();
  return generation;
}

export function openAuthorityState(options) {
  const configuration = normalizeConfiguration(options);
  if (typeof configuration.statePath !== "string" || !configuration.statePath) throw new StateFault("authority state path is required");
  const source = readJsonSnapshot(configuration.statePath);
  let state;
  if (source === undefined) {
    if (!configuration.bootstrap) throw new StateFault("authority state is missing and bootstrap was not requested");
    configuration.verifierGeneration = currentVerifierGenerationSync(configuration, 1);
    state = initialState(configuration);
    validateState(state, configuration);
    const authority = new AuthorityState(state, configuration);
    try {
      writeDurableJsonSync(configuration.statePath, state, configuration.faultInjector);
    } catch (error) {
      authority._degrade(error);
    }
    return authority;
  }
  if (source.state.stateSchemaVersion === 1) {
    if (!configuration.allowMigration) throw new StateFault("authority state migration was not allowed");
    state = migrateV1(source.state, configuration);
  } else {
    state = source.state;
  }
  validateState(state, configuration);
  configuration.verifierGeneration = currentVerifierGenerationSync(configuration, state.verifierGeneration);
  if (configuration.authorityId && configuration.authorityId !== state.authorityId) throw new StateFault("authority identifier does not match state");
  const authority = new AuthorityState(state, configuration);
  try { invokeFault(configuration.faultInjector, "before-term-commit", configuration.statePath); } catch (error) { throw error instanceof AuthorityError ? error : new StateFault("authority state changed before term commit"); }
  const current = readJsonSnapshot(configuration.statePath);
  if (!current || !current.raw.equals(source.raw)) throw new StateFault("authority ownership changed before term commit");
  const next = clone(state);
  next.laneTerm += 1;
  next.ownerNonce = crypto.randomUUID();
  next.verifierGeneration = currentVerifierGenerationSync(configuration, state.verifierGeneration);
  if (next.timingDigest !== configuration.timing.digest) next.timingDigest = configuration.timing.digest;
  try {
    validateState(next, configuration);
    writeDurableJsonSync(configuration.statePath, next, configuration.faultInjector);
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
