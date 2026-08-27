#!/usr/bin/env node
// Feeds authority-held allowance back into Pi's per-account usage files so every session's footer
// stays current, including on machines that have not made a request in a long time.
//
// Pi's usage-windows extension only learns allowance from `anthropic-ratelimit-unified-*` headers
// on that machine's own responses, and publishes what it sees to
// ~/.pi/agent/usage-windows/<provider>.json. A machine that is idle, or a lane nobody is using,
// therefore shows an ageing observation even though the shared authority knows the current value.
//
// This reads each lane's authority snapshot and writes it into that same file, which the extension
// already watches, so running sessions pick it up without a restart and without extra API calls.
// A file is only overwritten when the authority observation is strictly newer than what is there,
// so a live local response always wins over an older shared value.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PROVIDERS = ["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"];
const CONFIG_FILE = path.join(os.homedir(), ".pi/agent/claude-permit-gate/authority-client.json");
const STORE_DIR = path.join(os.homedir(), ".pi/agent/usage-windows");

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const bearer = execFileSync("/usr/bin/security", ["find-generic-password", "-s", config.keychain.snapshotRead.service, "-a", config.keychain.snapshotRead.account, "-w"], { encoding: "utf8" }).trim();

// The extension's on-disk shape: utilization is a 0-1 fraction and reset is epoch seconds.
const windowFrom = (raw) => raw && typeof raw.utilization === "number"
  ? { utilization: raw.utilization, status: raw.status ?? "allowed", reset: raw.resetEpochSeconds ?? null }
  : undefined;

const readExisting = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; } };

const results = [];

for (const provider of PROVIDERS) {
  const lane = config.lanes[provider];
  try {
    const response = await fetch(`${config.origin}:${lane.port}/v1/snapshot`, { headers: { authorization: `Bearer ${bearer}` } });
    if (!response.ok) { results.push(`${provider}: snapshot HTTP ${response.status}`); continue; }
    const allowance = (await response.json()).allowance;
    if (!allowance || typeof allowance.observedAtEpochMs !== "number") { results.push(`${provider}: no accepted allowance`); continue; }

    const fiveHour = windowFrom(allowance.fiveHour);
    const sevenDay = windowFrom(allowance.sevenDay);
    if (!fiveHour && !sevenDay) { results.push(`${provider}: no windows`); continue; }

    const file = path.join(STORE_DIR, `${provider.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
    const existing = readExisting(file);
    if (existing && typeof existing.at === "number" && existing.at >= allowance.observedAtEpochMs) {
      results.push(`${provider}: local observation is newer, kept`);
      continue;
    }

    // Preserve the binding window the extension marks when the authority does not carry one.
    const representative = existing?.representative ?? (fiveHour && sevenDay ? (fiveHour.utilization >= sevenDay.utilization ? "five_hour" : "seven_day") : fiveHour ? "five_hour" : "seven_day");
    const snapshot = { provider, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), representative, at: allowance.observedAtEpochMs };

    fs.mkdirSync(STORE_DIR, { recursive: true });
    const temporary = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(snapshot));
    fs.renameSync(temporary, file);   // atomic, matching how the extension publishes
    results.push(`${provider}: synced ${Math.round((Date.now() - allowance.observedAtEpochMs) / 1000)}s-old observation`);
  } catch (error) {
    results.push(`${provider}: ${error.message}`);
  }
}

process.stdout.write(`[${new Date().toISOString()}] ${results.join(" | ")}\n`);
