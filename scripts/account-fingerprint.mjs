#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const MAX_PROFILE_BYTES = 64 * 1024;
const MAX_TOKEN_BYTES = 16 * 1024;
const PROFILE_CHILD_TIMEOUT_MS = 20_000;
const TERMINATION_GRACE_MS = 1_000;
const PROVIDERS = new Set(["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROFILE_KEYS = ["account", "application", "enabled_plugins", "organization"];

function fail(message) {
  process.stderr.write(`account-fingerprint: ${message}\n`);
  process.exitCode = 1;
}

function usage() {
  process.stdout.write("Usage: token-producer | scripts/account-fingerprint.mjs --provider anthropic-a\n");
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return null;
  if (argv.length !== 2 || argv[0] !== "--provider" || !PROVIDERS.has(argv[1])) throw new Error("a single A-D provider is required");
  return argv[1];
}

function clear(buffers) {
  for (const buffer of buffers) buffer?.fill(0);
}

function validTokenBytes(token) {
  let padding = false;
  for (const byte of token) {
    if (byte > 0x7f) return false;
    if (byte === 0x3d) { padding = true; continue; }
    if (padding || !((byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39) || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e || byte === 0x2b || byte === 0x2f)) return false;
  }
  return true;
}

async function readToken() {
  if (process.stdin.isTTY) throw new Error("access token must arrive through standard input");
  const chunks = [];
  let raw;
  let token;
  try {
    let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_TOKEN_BYTES) {
        chunk.fill(0);
        throw new Error("access token is invalid");
      }
      chunks.push(chunk);
    }
    raw = Buffer.concat(chunks);
    let start = 0;
    let end = raw.length;
    while (start < end && (raw[start] === 0x0a || raw[start] === 0x0d)) start++;
    while (end > start && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--;
    token = Buffer.from(raw.subarray(start, end));
    if (token.length === 0 || !validTokenBytes(token)) throw new Error("access token is invalid");
    return token;
  } catch (error) {
    clear([token]);
    throw error;
  } finally {
    clear([raw, ...chunks]);
  }
}

function testTimeout(name, maximum) {
  const value = process.env[name];
  if (value === undefined) return maximum;
  if (process.env.CLAUDE_PERMIT_GATE_TEST_MODE !== "1" || !/^[1-9][0-9]*$/.test(value)) throw new Error("profile request failed");
  const timeout = Number(value);
  if (!Number.isSafeInteger(timeout) || timeout > maximum) throw new Error("profile request failed");
  return timeout;
}

function profileUrl() {
  const value = process.env.CLAUDE_PERMIT_GATE_TEST_PROFILE_URL;
  if (value === undefined) return PROFILE_URL;
  if (process.env.CLAUDE_PERMIT_GATE_TEST_MODE !== "1") throw new Error("profile request failed");
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port === "" || url.username || url.password || url.search || url.hash) throw new Error();
    return url.toString();
  } catch {
    throw new Error("profile request failed");
  }
}

function commandForProfile() {
  const injected = process.env.CLAUDE_PERMIT_GATE_TEST_PROFILE_COMMAND;
  if (injected !== undefined) {
    if (process.env.CLAUDE_PERMIT_GATE_TEST_MODE !== "1" || !injected.startsWith("/")) throw new Error("profile request failed");
    return { command: injected, args: [] };
  }
  return { command: "/usr/bin/curl", args: ["--disable", "--fail", "--silent", "--show-error", "--connect-timeout", "5", "--max-time", "15", "--request", "GET", "--header", "@-", "--url", profileUrl()] };
}

function signalProcessGroup(child, signal) {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, signal); } catch { child.kill(signal); }
}

function readProfile(token) {
  const { command, args } = commandForProfile();
  const timeout = testTimeout("CLAUDE_PERMIT_GATE_TEST_PROFILE_TIMEOUT_MS", PROFILE_CHILD_TIMEOUT_MS);
  const header = Buffer.concat([Buffer.from("Authorization: Bearer ", "ascii"), token, Buffer.from("\r\n", "ascii")]);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      clear([header, token]);
      reject(new Error("profile request failed"));
      return;
    }
    const chunks = [];
    let length = 0;
    let failure = null;
    let closed = false;
    let killDeadline;
    const stop = (message) => {
      if (failure !== null) return;
      failure = message;
      child.stdout.removeAllListeners("data");
      child.stdout.resume();
      child.stdin.destroy();
      signalProcessGroup(child, "SIGTERM");
      killDeadline = setTimeout(() => {
        if (!closed) signalProcessGroup(child, "SIGKILL");
      }, TERMINATION_GRACE_MS);
    };
    const deadline = setTimeout(() => stop("profile request failed"), timeout);
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      clear([header, token, ...chunks]);
      if (failure !== null) reject(new Error(failure));
      else reject(new Error("profile request failed"));
    };
    child.on("error", () => {
      if (child.pid === undefined) finish();
      else stop("profile request failed");
    });
    child.stdout.on("data", (chunk) => {
      if (failure !== null) return;
      length += chunk.length;
      if (length > MAX_PROFILE_BYTES) stop("profile response is invalid");
      else chunks.push(chunk);
    });
    child.stdin.on("error", () => stop("profile request failed"));
    child.on("close", (code, signal) => {
      if (failure !== null) { finish(); return; }
      clearTimeout(deadline);
      clear([header, token]);
      if (code !== 0 || signal !== null) { clear(chunks); reject(new Error("profile request failed")); return; }
      const body = Buffer.concat(chunks).toString("utf8");
      clear(chunks);
      resolve(body);
    });
    child.stdin.end(header);
  });
}

function fingerprint(profileBody) {
  let profile;
  try { profile = JSON.parse(profileBody); } catch { throw new Error("profile response is invalid"); }
  if (profile === null || Array.isArray(profile) || typeof profile !== "object") throw new Error("profile response is invalid");
  const keys = Object.keys(profile).sort();
  if (keys.length !== PROFILE_KEYS.length || keys.some((key, index) => key !== PROFILE_KEYS[index])) throw new Error("profile response is invalid");
  const account = profile.account;
  const organization = profile.organization;
  if (account === null || organization === null || Array.isArray(account) || Array.isArray(organization) || typeof account !== "object" || typeof organization !== "object") throw new Error("profile response is invalid");
  if (typeof account.uuid !== "string" || typeof organization.uuid !== "string" || !UUID.test(account.uuid) || !UUID.test(organization.uuid)) throw new Error("profile response is invalid");
  return crypto.createHash("sha256").update(`profile-v1\0${account.uuid.toLowerCase()}\0${organization.uuid.toLowerCase()}`, "utf8").digest("hex");
}

try {
  const provider = parseArguments(process.argv.slice(2));
  if (provider === null) usage();
  else {
    const token = await readToken();
    const digest = fingerprint(await readProfile(token));
    process.stdout.write(`${provider} ${digest}\n`);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : "profile validation failed");
}
