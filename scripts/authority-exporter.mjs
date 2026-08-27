#!/usr/bin/env node
// Prometheus exporter for the shared permit authority.
//
// Written after lane A wedged for 24 minutes without anyone noticing: two `uncertain` tickets held
// both capacity slots while three more queued behind them. An uncertain ticket is a client that
// began provider work and never acknowledged completion, usually because its session was killed
// mid-request. It consumes capacity and never self-releases, because the authority cannot fence an
// Anthropic request that already started. That state is the single most important thing to alarm
// on: `claude_lane_uncertain_tickets > 0` sustained means a lane is losing capacity permanently
// until an operator reconciles it.
//
// Serves Prometheus text format on 127.0.0.1:9713/metrics. Netdata scrapes this directly with its
// prometheus collector; no extra adapter is needed.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const PORT = Number(process.env.CLAUDE_AUTHORITY_EXPORTER_PORT ?? 9713);
const PROVIDERS = ["anthropic-a", "anthropic-b", "anthropic-c", "anthropic-d"];
const CONFIG_FILE = path.join(os.homedir(), ".pi/agent/claude-permit-gate/authority-client.json");

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const bearer = execFileSync("/usr/bin/security", ["find-generic-password", "-s", config.keychain.snapshotRead.service, "-a", config.keychain.snapshotRead.account, "-w"], { encoding: "utf8" }).trim();

const METRICS = [
  ["claude_lane_active_permits", "gauge", "Permits currently held on this lane.", (h) => h.active],
  ["claude_lane_offered_tickets", "gauge", "Tickets offered but not yet claimed.", (h) => h.offered],
  ["claude_lane_uncertain_tickets", "gauge", "Tickets whose provider work was never acknowledged. These consume capacity until an operator reconciles them; alarm when sustained above zero.", (h) => h.uncertain],
  ["claude_lane_queued_tickets", "gauge", "Tickets waiting for capacity.", (h) => h.queued],
  ["claude_lane_current_concurrency", "gauge", "Concurrency the lane is currently willing to grant.", (h) => h.currentConcurrency],
  ["claude_lane_maximum_concurrency", "gauge", "Ceiling on concurrent permits for this lane.", (h) => h.maximumConcurrency],
  ["claude_lane_cooldown_seconds_remaining", "gauge", "Seconds until a throttle cooldown expires.", (h) => h.cooldownUntilEpochMs ? Math.max(0, (h.cooldownUntilEpochMs - Date.now()) / 1000) : 0],
  ["claude_lane_oldest_wait_seconds", "gauge", "Age of the longest-waiting queued ticket.", (h) => h.oldestWaitEpochMs ? Math.max(0, (Date.now() - h.oldestWaitEpochMs) / 1000) : 0],
  ["claude_lane_up", "gauge", "1 when the lane answered its health check and reports ready.", (h) => h.status === "ready" ? 1 : 0],
];

const ALLOWANCE = [
  ["claude_lane_allowance_utilization", "gauge", "Account allowance utilisation as a 0-1 fraction.", (a, w) => a?.[w]?.utilization],
  ["claude_lane_allowance_reset_seconds", "gauge", "Seconds until this allowance window resets.", (a, w) => a?.[w]?.resetEpochSeconds ? Math.max(0, a[w].resetEpochSeconds - Date.now() / 1000) : undefined],
  ["claude_lane_allowance_age_seconds", "gauge", "Age of the newest accepted allowance observation. Rising without bound means the prober has stopped.", (a) => a?.observedAtEpochMs ? Math.max(0, (Date.now() - a.observedAtEpochMs) / 1000) : undefined],
];

async function laneSnapshot(provider) {
  const lane = config.lanes[provider];
  try {
    const response = await fetch(`${config.origin}:${lane.port}/v1/snapshot`, { headers: { authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(4000) });
    if (!response.ok) return { provider, port: lane.port, up: false };
    return { provider, port: lane.port, up: true, snapshot: await response.json() };
  } catch {
    return { provider, port: lane.port, up: false };
  }
}

function render(lanes) {
  const lines = [];
  const emit = (name, type, help, samples) => {
    if (!samples.length) return;
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples);
  };

  for (const [name, type, help, read] of METRICS) {
    emit(name, type, help, lanes.flatMap(({ provider, port, up, snapshot }) => {
      if (name === "claude_lane_up") return [`${name}{provider="${provider}",port="${port}"} ${up && snapshot?.status === "ready" ? 1 : 0}`];
      if (!up || !snapshot) return [];
      const value = read(snapshot);
      return typeof value === "number" ? [`${name}{provider="${provider}",port="${port}"} ${value}`] : [];
    }));
  }

  for (const [name, type, help, read] of ALLOWANCE) {
    emit(name, type, help, lanes.flatMap(({ provider, port, snapshot }) => {
      const allowance = snapshot?.allowance;
      if (!allowance) return [];
      if (name === "claude_lane_allowance_age_seconds") {
        const value = read(allowance);
        return typeof value === "number" ? [`${name}{provider="${provider}",port="${port}"} ${value}`] : [];
      }
      return ["fiveHour", "sevenDay"].flatMap((window) => {
        const value = read(allowance, window);
        return typeof value === "number" ? [`${name}{provider="${provider}",port="${port}",window="${window === "fiveHour" ? "5h" : "7d"}"} ${value}`] : [];
      });
    }));
  }

  return lines.join("\n") + "\n";
}

http.createServer(async (request, response) => {
  if (!request.url?.startsWith("/metrics")) { response.writeHead(404).end("not found\n"); return; }
  try {
    const body = render(await Promise.all(PROVIDERS.map(laneSnapshot)));
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(body);
  } catch (error) {
    response.writeHead(500).end(`# exporter error: ${error.message}\n`);
  }
}).listen(PORT, "127.0.0.1", () => process.stdout.write(`[${new Date().toISOString()}] authority exporter on 127.0.0.1:${PORT}/metrics\n`));
