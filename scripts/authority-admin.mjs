#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { AuthorityError, authorityStatePath, authorityTimingFromEnvironment, authorityVerifierPath, openAuthorityState, readAuthorityVerifierStore, readAuthorityVerifierStoreAsync, writeAuthorityVerifierStore } from "../authority-state.mjs";

const PROVIDER_PORTS = Object.freeze({ "anthropic-a": 8791, "anthropic-b": 8792, "anthropic-c": 8793, "anthropic-d": 8794 });
const SCOPES = new Set(["permit:mutate", "snapshot:read", "allowance:publish"]);
const TOKEN_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFERENCE_PATTERN = /^[\x20-\x7e]{1,128}$/;
const COMMANDS = new Set(["bootstrap", "enroll", "rotate", "revoke", "drain", "resume", "reconcile"]);
const VALUE_OPTIONS = new Set(["--provider", "--port", "--state-dir", "--verifier-store", "--authority-id", "--minimum-concurrency", "--maximum-concurrency", "--current-concurrency", "--installation-id", "--scope", "--lanes", "--token-id", "--new-token-id", "--old-token-id", "--keychain-service", "--keychain-account", "--issued-at-epoch-ms", "--expires-at-epoch-ms", "--ticket-id", "--backup-path"]);
const FLAG_OPTIONS = new Set(["--approve-uncertain-reconciliation"]);
const COMMAND_OPTIONS = Object.freeze({
  bootstrap: new Set(["--provider", "--port", "--state-dir", "--verifier-store", "--authority-id", "--minimum-concurrency", "--maximum-concurrency", "--current-concurrency"]),
  enroll: new Set(["--installation-id", "--scope", "--lanes", "--token-id", "--keychain-service", "--keychain-account", "--issued-at-epoch-ms", "--expires-at-epoch-ms", "--verifier-store"]),
  rotate: new Set(["--old-token-id", "--new-token-id", "--keychain-service", "--keychain-account", "--issued-at-epoch-ms", "--expires-at-epoch-ms", "--verifier-store"]),
  revoke: new Set(["--installation-id", "--token-id", "--verifier-store"]),
  drain: new Set(["--provider", "--port", "--state-dir", "--verifier-store", "--authority-id"]),
  resume: new Set(["--provider", "--port", "--state-dir", "--verifier-store", "--authority-id"]),
  reconcile: new Set(["--provider", "--port", "--state-dir", "--verifier-store", "--authority-id", "--ticket-id", "--backup-path"]),
});

function reject() {
  throw new Error("authority administration rejected");
}

function parseArguments(args) {
  const [command, ...rest] = args;
  if (!COMMANDS.has(command)) reject();
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (FLAG_OPTIONS.has(option)) {
      if (flags.has(option)) reject();
      flags.add(option);
      continue;
    }
    if (!VALUE_OPTIONS.has(option) || values.has(option) || index + 1 >= rest.length) reject();
    const value = rest[++index];
    if (value.startsWith("--")) reject();
    values.set(option, value);
  }
  return { command, values, flags };
}

function assertCommandOptions(command, values, flags) {
  const allowed = COMMAND_OPTIONS[command];
  if ([...values.keys()].some((option) => !allowed.has(option))) reject();
  if (command === "reconcile") {
    if (![...flags].every((flag) => flag === "--approve-uncertain-reconciliation")) reject();
  } else if (flags.size !== 0) reject();
}

function required(values, option) {
  const value = values.get(option);
  if (value === undefined) reject();
  return value;
}

function optionalInteger(values, option, fallback, minimum = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const value = values.get(option);
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) reject();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) reject();
  return parsed;
}

function isTestMode() {
  return process.env.CLAUDE_PERMIT_GATE_TEST_MODE === "1";
}

function assertUuid(value) {
  if (!UUID_PATTERN.test(value)) reject();
  return value;
}

function assertTokenId(value) {
  if (!TOKEN_ID_PATTERN.test(value)) reject();
  return value;
}

function assertReference(value) {
  if (!REFERENCE_PATTERN.test(value)) reject();
  return value;
}

function parseLanes(value) {
  const lanes = value.split(",");
  if (lanes.length === 0 || lanes.length > Object.keys(PROVIDER_PORTS).length || new Set(lanes).size !== lanes.length || !lanes.every((lane) => lane in PROVIDER_PORTS)) reject();
  return lanes;
}

function verifierStorePath(values) {
  const verifierStore = values.get("--verifier-store");
  if (verifierStore !== undefined && !isTestMode()) reject();
  return authorityVerifierPath({ home: os.homedir(), verifierStore });
}

function laneConfiguration(values, store) {
  const provider = required(values, "--provider");
  if (!(provider in PROVIDER_PORTS)) reject();
  const port = optionalInteger(values, "--port", PROVIDER_PORTS[provider], 1, 65535);
  if (!isTestMode() && port !== PROVIDER_PORTS[provider]) reject();
  const minimumConcurrency = optionalInteger(values, "--minimum-concurrency", 1, 1, 64);
  const maximumConcurrency = optionalInteger(values, "--maximum-concurrency", 2, minimumConcurrency, 64);
  const currentConcurrency = optionalInteger(values, "--current-concurrency", maximumConcurrency, minimumConcurrency, maximumConcurrency);
  const authorityId = values.has("--authority-id") ? assertUuid(values.get("--authority-id")) : undefined;
  const storePath = verifierStorePath(values);
  const statePath = authorityStatePath({ home: os.homedir(), stateDirectory: values.get("--state-dir"), port });
  return {
    provider,
    port,
    statePath,
    authorityId,
    timing: authorityTimingFromEnvironment(process.env),
    minimumConcurrency,
    maximumConcurrency,
    currentConcurrency,
    verifierGeneration: store.generation,
    allowTestPort: isTestMode(),
    verifyGenerationSync: () => readAuthorityVerifierStore(storePath).generation,
    verifyGeneration: async () => (await readAuthorityVerifierStoreAsync(storePath)).generation,
  };
}

async function readSecret() {
  if (process.stdin.isTTY) reject();
  const chunks = [];
  let inputLength = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputLength += bytes.length;
    if (inputLength > 128) reject();
    chunks.push(bytes);
  }
  const input = Buffer.concat(chunks);
  try {
    const encoded = input.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) reject();
    const secret = Buffer.from(encoded, "base64url");
    if (secret.length !== 32) reject();
    return secret;
  } finally {
    input.fill(0);
  }
}

function writeKeychainSecret(service, account, secret) {
  const testWriter = isTestMode() ? process.env.CLAUDE_PERMIT_GATE_TEST_KEYCHAIN_WRITER : undefined;
  const command = testWriter || "/usr/bin/security";
  const args = testWriter ? [] : ["add-generic-password", "-U", "-a", account, "-s", service, "-w"];
  return new Promise((resolve, rejectPromise) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    } catch {
      rejectPromise(new Error("keychain write failed"));
      return;
    }
    child.once("error", () => rejectPromise(new Error("keychain write failed")));
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else rejectPromise(new Error("keychain write failed"));
    });
    child.stdin.once("error", () => rejectPromise(new Error("keychain write failed")));
    child.stdin.end(Buffer.concat([secret, Buffer.from("\n")]));
  });
}

function verifierRecord({ tokenId, secret, installationId, scope, laneAllowlist, generation, issuedAtEpochMs, expiresAtEpochMs, predecessorTokenId }) {
  return {
    tokenId,
    verifierSha256: crypto.createHash("sha256").update(secret).digest("hex"),
    installationId,
    scope,
    laneAllowlist,
    generation,
    issuedAtEpochMs,
    expiresAtEpochMs,
    predecessorTokenId,
    revokedAtEpochMs: null,
  };
}

async function verifierStoreExists(file) {
  try {
    await fsPromises.lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    reject();
  }
}

function nextStore(previous, records) {
  const generation = previous ? previous.generation + 1 : 1;
  return { schemaVersion: 1, generation, verifiers: records };
}

async function writeUpdatedStore(file, previous, records) {
  const store = nextStore(previous, records);
  return writeAuthorityVerifierStore(file, store, { allowCreate: previous === undefined, expectedGeneration: previous?.generation });
}

async function enroll(values) {
  const installationId = assertUuid(required(values, "--installation-id"));
  const scope = required(values, "--scope");
  if (!SCOPES.has(scope)) reject();
  const laneAllowlist = parseLanes(required(values, "--lanes"));
  const tokenId = assertTokenId(required(values, "--token-id"));
  const service = assertReference(required(values, "--keychain-service"));
  const account = assertReference(required(values, "--keychain-account"));
  const now = Date.now();
  const issuedAtEpochMs = optionalInteger(values, "--issued-at-epoch-ms", now, 0);
  const expiresAtEpochMs = optionalInteger(values, "--expires-at-epoch-ms", undefined, 1);
  if (expiresAtEpochMs === undefined || expiresAtEpochMs <= issuedAtEpochMs) reject();
  const storePath = verifierStorePath(values);
  const previous = await verifierStoreExists(storePath) ? readAuthorityVerifierStore(storePath) : undefined;
  if (previous?.verifiers.some((record) => record.tokenId === tokenId) || previous?.verifiers.some((record) => record.installationId === installationId && record.scope === scope)) reject();
  const secret = await readSecret();
  try {
    await writeKeychainSecret(service, account, secret);
    const generation = (previous?.generation ?? 0) + 1;
    await writeUpdatedStore(storePath, previous, [...(previous?.verifiers ?? []), verifierRecord({ tokenId, secret, installationId, scope, laneAllowlist, generation, issuedAtEpochMs, expiresAtEpochMs, predecessorTokenId: null })]);
  } finally {
    secret.fill(0);
  }
}

async function rotate(values) {
  const oldTokenId = assertTokenId(required(values, "--old-token-id"));
  const tokenId = assertTokenId(required(values, "--new-token-id"));
  const service = assertReference(required(values, "--keychain-service"));
  const account = assertReference(required(values, "--keychain-account"));
  const now = Date.now();
  const issuedAtEpochMs = optionalInteger(values, "--issued-at-epoch-ms", now, 0);
  const expiresAtEpochMs = optionalInteger(values, "--expires-at-epoch-ms", undefined, 1);
  if (expiresAtEpochMs === undefined || expiresAtEpochMs <= issuedAtEpochMs) reject();
  const storePath = verifierStorePath(values);
  const previous = readAuthorityVerifierStore(storePath);
  const oldRecord = previous.verifiers.find((record) => record.tokenId === oldTokenId);
  if (!oldRecord || oldRecord.revokedAtEpochMs !== null || oldRecord.expiresAtEpochMs <= now || previous.verifiers.some((record) => record.tokenId === tokenId) || previous.verifiers.filter((record) => record.installationId === oldRecord.installationId && record.scope === oldRecord.scope).length >= 2) reject();
  const secret = await readSecret();
  try {
    await writeKeychainSecret(service, account, secret);
    const generation = previous.generation + 1;
    await writeUpdatedStore(storePath, previous, [...previous.verifiers, verifierRecord({ tokenId, secret, installationId: oldRecord.installationId, scope: oldRecord.scope, laneAllowlist: [...oldRecord.laneAllowlist], generation, issuedAtEpochMs, expiresAtEpochMs, predecessorTokenId: oldRecord.tokenId })]);
  } finally {
    secret.fill(0);
  }
}

async function revoke(values) {
  const hasToken = values.has("--token-id");
  const hasInstallation = values.has("--installation-id");
  if (hasToken === hasInstallation) reject();
  const tokenId = hasToken ? assertTokenId(values.get("--token-id")) : undefined;
  const installationId = hasInstallation ? assertUuid(values.get("--installation-id")) : undefined;
  const storePath = verifierStorePath(values);
  const previous = readAuthorityVerifierStore(storePath);
  const now = Date.now();
  let changed = false;
  const records = previous.verifiers.map((record) => {
    const matches = tokenId ? record.tokenId === tokenId : record.installationId === installationId;
    if (!matches || record.revokedAtEpochMs !== null) return record;
    changed = true;
    return { ...record, revokedAtEpochMs: now };
  });
  if (!changed) reject();
  await writeUpdatedStore(storePath, previous, records);
}

function runOfflineCheck(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error) reject();
  return { status: result.status, output: result.stdout ?? "" };
}

async function assertLaneOffline(provider, port) {
  if (isTestMode() && process.env.CLAUDE_PERMIT_GATE_TEST_ADMIN_ASSUME_OFFLINE === "1") return;
  if (process.platform !== "darwin") reject();
  const listener = runOfflineCheck("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-F", "p"]);
  if (listener.status !== 1) reject();
  const label = `com.longweekendprojects.claude-permit-lane.${provider}`;
  const launchd = runOfflineCheck("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`]);
  if (launchd.status === 0 && (/\bstate = running;/.test(launchd.output) || /\bpid = [1-9][0-9]*;/.test(launchd.output))) reject();
  if (launchd.status !== 0 && launchd.status !== 3 && launchd.status !== 113) reject();
}

function reserveLoopbackPort(port) {
  const server = net.createServer();
  return new Promise((resolve, rejectPromise) => {
    server.once("error", () => rejectPromise(new Error("lane is not offline")));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve, rejectPromise) => server.close((error) => error ? rejectPromise(error) : resolve()));
}

async function withOfflineLane(provider, port, operation) {
  await assertLaneOffline(provider, port);
  const reservation = await reserveLoopbackPort(port);
  try {
    return await operation();
  } finally {
    await closeServer(reservation);
  }
}

async function durableBackup(source, destination) {
  if (await verifierStoreExists(destination)) reject();
  const bytes = await fsPromises.readFile(source);
  const directory = path.dirname(destination);
  const temporary = path.join(directory, `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(directory, 0o700);
    handle = await fsPromises.open(temporary, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsPromises.rename(temporary, destination);
    const directoryHandle = await fsPromises.open(directory, "r");
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  } catch {
    if (handle) try { await handle.close(); } catch {}
    try { await fsPromises.unlink(temporary); } catch {}
    reject();
  }
}

async function stateAction(command, values, flags) {
  const store = readAuthorityVerifierStore(verifierStorePath(values));
  const configuration = laneConfiguration(values, store);
  await withOfflineLane(configuration.provider, configuration.port, async () => {
    if (command === "bootstrap") {
      if (fs.existsSync(configuration.statePath)) reject();
      openAuthorityState({ ...configuration, bootstrap: true });
      return;
    }
    if (command === "reconcile") {
      if (!flags.has("--approve-uncertain-reconciliation")) reject();
      const backupPath = path.resolve(required(values, "--backup-path"));
      await durableBackup(configuration.statePath, backupPath);
      const authority = openAuthorityState({ ...configuration, bootstrap: false });
      await authority.reconcileUncertain(assertUuid(required(values, "--ticket-id")));
      await authority.awaitIdle();
      return;
    }
    const authority = openAuthorityState({ ...configuration, bootstrap: false });
    if (command === "drain") await authority.drain();
    else if (command === "resume") await authority.resume();
    else reject();
    await authority.awaitIdle();
  });
}

async function main() {
  const { command, values, flags } = parseArguments(process.argv.slice(2));
  assertCommandOptions(command, values, flags);
  if (["enroll", "rotate"].includes(command)) {
    if (command === "enroll") await enroll(values);
    else await rotate(values);
  } else if (command === "revoke") {
    await revoke(values);
  } else {
    await stateAction(command, values, flags);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, command })}\n`);
}

void main().catch(() => {
  process.stderr.write("authority-admin: rejected\n");
  process.exitCode = 1;
});
