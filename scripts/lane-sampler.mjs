#!/usr/bin/env node
// High-resolution durable history for the permit authority.
//
// Netdata stores 5-second collection but serves long windows as coarse buckets, so a two-minute
// wedge reads as an average near zero once it ages out. That is how a real outage became invisible
// in review. This appends one JSON line per lane every few seconds to a rotating file, so the exact
// moment a lane wedged, restarted, or lost concurrency can always be reconstructed after the fact.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROVIDERS = ["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"];
const CONFIG_FILE = path.join(os.homedir(), ".pi/agent/claude-permit-gate/authority-client.json");
const CLIENT_LEDGER = path.join(os.homedir(), ".pi/agent/claude-permit-gate/authority-client-tickets-v1.json");
const LOG_DIR = path.join(os.homedir(), "Library/Logs/Claude Permit Authority");
const LOG_FILE = path.join(LOG_DIR, "lane-samples.jsonl");
const MAX_BYTES = 32 * 1024 * 1024;
const INTERVAL_MS = 5_000;

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const bearer = execFileSync("/usr/bin/security", ["find-generic-password", "-s", config.keychain.snapshotRead.service, "-a", config.keychain.snapshotRead.account, "-w"], { encoding: "utf8" }).trim();

fs.mkdirSync(LOG_DIR, { recursive: true });

function rotate() {
  try { if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
}

function clientState() {
  let records = 0; let oldestAgeS = 0; let lockAgeS = 0;
  try {
    const ledger = JSON.parse(fs.readFileSync(CLIENT_LEDGER, "utf8"));
    const entries = Object.values(ledger.tickets ?? {});
    records = entries.length;
    for (const entry of entries) { const age = (Date.now() - (entry.createdAtEpochMs ?? Date.now())) / 1000; if (age > oldestAgeS) oldestAgeS = age; }
  } catch {}
  try { lockAgeS = (Date.now() - fs.statSync(`${CLIENT_LEDGER}.lock`).mtimeMs) / 1000; } catch {}
  return { records, oldestAgeS: Math.round(oldestAgeS), lockAgeS: Math.round(lockAgeS) };
}

async function sample() {
  const at = new Date().toISOString();
  const client = clientState();
  for (const provider of PROVIDERS) {
    const lane = config.lanes[provider];
    let row;
    try {
      const response = await fetch(`${config.origin}:${lane.port}/v1/health`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(3000) });
      if (!response.ok) { row = { at, provider, up: false, status: response.status, client }; }
      else {
        const h = await response.json();
        row = { at, provider, up: true, state: h.status, active: h.active, offered: h.offered, uncertain: h.uncertain, queued: h.queued, current: h.currentConcurrency, max: h.maximumConcurrency, laneTerm: h.laneTerm, instanceId: h.instanceId, cooldownUntil: h.cooldownUntilEpochMs, oldestWaitEpochMs: h.oldestWaitEpochMs, client };
      }
    } catch (error) { row = { at, provider, up: false, error: error.message, client }; }
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
  }
  rotate();
}

await sample();
setInterval(sample, INTERVAL_MS);
