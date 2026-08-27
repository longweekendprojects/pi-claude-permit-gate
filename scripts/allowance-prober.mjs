#!/usr/bin/env node
// Keeps every lane's allowance observation fresh without spending any inference.
//
// `anthropic-ratelimit-unified-5h/7d` headers only arrive on real completions, so a lane that
// nobody is actively using goes stale and its menu shows nothing. Anthropic exposes the same
// numbers through GET /api/oauth/usage, the endpoint Claude Code itself calls. That request runs
// no inference and costs no tokens, so polling it keeps all four lanes current whether or not
// anyone is working on them.
//
// The endpoint rate limits aggressively without a claude-code User-Agent, so one is always sent.
//
// Measured budget per account: five requests, then HTTP 429 with `retry-after: 300`. That is a
// sustained rate of one per 60 seconds, so a flat 60-second poll sits exactly at the refill rate
// and trips intermittently. Each trip costs five minutes of staleness, which is worse than simply
// polling a little slower, so the job runs every 90 seconds and honours `retry-after` per lane.
//
// Each lane's OAuth access token comes from Pi's auth store. Pi refreshes a token when it makes a
// request, but an account at 100% utilisation is never used, so its token expires and stays expired
// exactly when its numbers matter most. The prober therefore refreshes an expired token itself,
// using the same endpoint and client id Pi uses, and writes the result back atomically.
//
// The prober publishes under its own installation identity. The authority orders publications by
// (installation, lane), and the menu bar app publishes on the same lanes with a plain incrementing
// counter, so sharing an identity would make the two publishers invalidate each other's sequence.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROVIDERS = ["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"];
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USER_AGENT = "claude-code/2.1.80";
const AUTH_FILE = path.join(os.homedir(), ".pi/agent/auth.json");
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CONFIG_FILE = path.join(os.homedir(), ".pi/agent/claude-permit-gate/authority-client.json");
const SEQUENCE_FILE = path.join(os.homedir(), ".pi/agent/claude-permit-gate/allowance-publisher-sequence.json");
const BACKOFF_FILE = path.join(os.homedir(), ".pi/agent/claude-permit-gate/allowance-prober-backoff.json");
const PROBER_INSTALLATION_ID = "e478e53b-3ed3-48a0-9932-cda84c889e8f";
const PROBER_KEYCHAIN_ACCOUNT = "prober";

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
let auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));

// Pi owns this file, so the window between reading and writing is kept as small as possible: the
// store is re-read immediately before the write and only the one provider entry is replaced.
async function refreshProvider(provider) {
  const entry = auth[provider];
  if (!entry?.refresh) return null;
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: entry.refresh }),
  });
  if (!response.ok) return { error: `refresh HTTP ${response.status}` };
  const body = await response.json();
  if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") return { error: "refresh response is invalid" };
  const updated = { ...entry, access: body.access_token, expires: Date.now() + body.expires_in * 1000, ...(typeof body.refresh_token === "string" ? { refresh: body.refresh_token } : {}) };
  const current = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  current[provider] = updated;
  const temporary = `${AUTH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(temporary, AUTH_FILE);
  auth = current;
  return { refreshed: true };
}
const bearer = execFileSync("/usr/bin/security", ["find-generic-password", "-s", config.keychain.allowancePublish.service, "-a", PROBER_KEYCHAIN_ACCOUNT, "-w"], { encoding: "utf8" }).trim();

// Sequences are tracked per lane because the authority orders publications by (installation, lane).
const readSequences = () => { try { return JSON.parse(fs.readFileSync(SEQUENCE_FILE, "utf8")); } catch { return {}; } };
const sequences = readSequences();
const writeSequences = () => fs.writeFileSync(SEQUENCE_FILE, JSON.stringify(sequences) + "\n", { mode: 0o600 });

// A rate-limited lane stays skipped until its retry-after elapses, so a trip costs one lane rather
// than pushing the whole account deeper into the limit.
const readBackoff = () => { try { return JSON.parse(fs.readFileSync(BACKOFF_FILE, "utf8")); } catch { return {}; } };
const backoff = readBackoff();
const writeBackoff = () => fs.writeFileSync(BACKOFF_FILE, JSON.stringify(backoff) + "\n", { mode: 0o600 });

// Anthropic reports utilization as a percentage (24 means 24%). The wire format and the menu use
// a 0-1 fraction, matching what the `anthropic-ratelimit-unified-*` headers produce, so publishing
// the raw percentage renders as 2400%.
function windowFrom(raw) {
  if (!raw || typeof raw.utilization !== "number") return null;
  const utilization = raw.utilization / 100;
  const status = utilization >= 1 ? "rejected" : utilization >= 0.8 ? "allowed_warning" : "allowed";
  const resetEpochSeconds = raw.resets_at ? Math.floor(new Date(raw.resets_at).getTime() / 1000) : null;
  if (resetEpochSeconds === null || !Number.isSafeInteger(resetEpochSeconds)) return null;
  return { utilization, status, resetEpochSeconds };
}

const results = [];

for (const provider of PROVIDERS) {
  const token = auth[provider]?.access;
  const expires = auth[provider]?.expires;
  if (!token || (typeof expires === "number" && expires <= Date.now())) {
    const outcome = await refreshProvider(provider).catch((error) => ({ error: error.message }));
    if (!outcome) { results.push(`${provider}: no refresh token, skipped`); continue; }
    if (outcome.error) { results.push(`${provider}: ${outcome.error}`); continue; }
    results.push(`${provider}: token refreshed`);
  }
  if (typeof backoff[provider] === "number" && backoff[provider] > Date.now()) { results.push(`${provider}: backing off ${Math.ceil((backoff[provider] - Date.now()) / 1000)}s`); continue; }
  try {
    const response = await fetch(USAGE_URL, { headers: { authorization: `Bearer ${auth[provider].access}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": USER_AGENT } });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after"));
      backoff[provider] = Date.now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 300) * 1000;
      writeBackoff();
      results.push(`${provider}: rate limited, backing off ${Math.ceil((backoff[provider] - Date.now()) / 1000)}s`);
      continue;
    }
    if (!response.ok) { results.push(`${provider}: usage HTTP ${response.status}`); continue; }
    if (backoff[provider]) { delete backoff[provider]; writeBackoff(); }
    const usage = await response.json();
    const fiveHour = windowFrom(usage.five_hour);
    const sevenDay = windowFrom(usage.seven_day);
    if (!fiveHour && !sevenDay) { results.push(`${provider}: no windows reported`); continue; }

    const sequence = (sequences[provider] ?? 0) + 1;
    sequences[provider] = sequence;
    writeSequences();
    const lane = config.lanes[provider];
    const publish = await fetch(`${config.origin}:${lane.port}/v1/allowance`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, installationId: PROBER_INSTALLATION_ID, provider, accountBindingId: lane.accountBindingId, publishId: crypto.randomUUID(), publisherSequence: sequence, observedAtEpochMs: Date.now(), fiveHour, sevenDay }),
    });
    const body = await publish.json().catch(() => ({}));
    const asPercent = (window) => window ? `${(window.utilization * 100).toFixed(1)}%` : "-";
    results.push(`${provider}: usage 5h=${asPercent(fiveHour)} 7d=${asPercent(sevenDay)} -> publish HTTP ${publish.status}${body?.error?.code ? ` (${body.error.code})` : ""}`);
  } catch (error) {
    results.push(`${provider}: ${error.message}`);
  }
}

process.stdout.write(`[${new Date().toISOString()}] ${results.join(" | ")}\n`);
