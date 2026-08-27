#!/usr/bin/env node
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const MAX_PROFILE_BYTES = 64 * 1024;
const PROVIDERS = new Set(["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

async function readToken() {
  if (process.stdin.isTTY) throw new Error("access token must arrive through standard input");
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 16 * 1024) throw new Error("access token is invalid");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  let start = 0;
  let end = raw.length;
  while (start < end && (raw[start] === 0x0a || raw[start] === 0x0d)) start++;
  while (end > start && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--;
  const token = Buffer.from(raw.subarray(start, end));
  raw.fill(0);
  if (token.length === 0 || !/^[A-Za-z0-9._~+/-]+=*$/.test(token.toString("ascii"))) {
    token.fill(0);
    throw new Error("access token is invalid");
  }
  return token;
}

function commandForProfile() {
  const injected = process.env.CLAUDE_PERMIT_GATE_TEST_PROFILE_COMMAND;
  if (injected !== undefined) {
    if (process.env.CLAUDE_PERMIT_GATE_TEST_MODE !== "1" || !injected.startsWith("/")) throw new Error("profile command override is unavailable");
    return { command: injected, args: [] };
  }
  return { command: "/usr/bin/curl", args: ["--fail", "--silent", "--show-error", "--request", "GET", "--header", "@-", "--url", PROFILE_URL] };
}

function readProfile(token) {
  const { command, args } = commandForProfile();
  const header = Buffer.concat([Buffer.from("Authorization: Bearer ", "ascii"), token, Buffer.from("\r\n", "ascii")]);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"] });
    const chunks = [];
    let length = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      header.fill(0);
      token.fill(0);
      if (error) reject(error); else resolve(value);
    };
    child.on("error", () => finish(new Error("profile request failed")));
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_PROFILE_BYTES) {
        child.kill();
        finish(new Error("profile response is invalid"));
      } else chunks.push(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) finish(new Error("profile request failed"));
      else finish(null, Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => finish(new Error("profile request failed")));
    child.stdin.end(header);
  });
}

function fingerprint(profileBody) {
  let profile;
  try { profile = JSON.parse(profileBody); } catch { throw new Error("profile response is invalid"); }
  if (profile === null || Array.isArray(profile) || typeof profile !== "object") throw new Error("profile response is invalid");
  const account = profile.account_uuid;
  const organization = profile.organization_uuid;
  if (typeof account !== "string" || typeof organization !== "string" || !UUID.test(account) || !UUID.test(organization)) throw new Error("profile response is invalid");
  return crypto.createHash("sha256").update(`profile-v1\0${account.toLowerCase()}\0${organization.toLowerCase()}`, "utf8").digest("hex");
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
