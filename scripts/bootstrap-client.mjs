#!/usr/bin/env node
// Idempotent installer for everything `pi update --extensions` cannot carry.
//
// The package pin only reconciles extension code. A working install also needs a per-machine client
// configuration, three Keychain credentials, environment variables that survive a reboot for both
// terminal- and GUI-launched processes, background jobs, and the absence of local A-D daemons that
// would double-spend account capacity. Those lived in operator memory, so every machine drifted.
//
// Run this after any `pi update --extensions`. It is safe to run repeatedly: each step reports
// `ok` when already correct and only writes when something is missing or wrong.
//
//   node scripts/bootstrap-client.mjs            apply
//   node scripts/bootstrap-client.mjs --check    report only, exit 1 if anything needs applying
//
// Secret enrolment is deliberately excluded: the authority derives a verifier from the secret, so
// credentials must be minted on the authority host. This reports which are missing and stops short
// of inventing them.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const CHECK_ONLY = process.argv.includes("--check");
const HOME = os.homedir();
const USER = os.userInfo().username;
const NODE = process.execPath;
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const GATE_DIR = path.join(HOME, ".pi/agent/claude-permit-gate");
const CONFIG_FILE = path.join(GATE_DIR, "authority-client.json");
const AGENTS_DIR = path.join(HOME, "Library/LaunchAgents");
const LOG_DIR = path.join(HOME, "Library/Logs/Claude Permit Authority");
const ORIGIN = process.env.CLAUDE_PERMIT_GATE_ORIGIN ?? "https://ruminaider.tail252378.ts.net";
const AUTHORITY_ID = process.env.CLAUDE_PERMIT_AUTHORITY_ID ?? "ce298942-e550-44f2-8566-b45ea813d01c";
const KEYCHAIN_ACCOUNT = process.env.CLAUDE_PERMIT_KEYCHAIN_ACCOUNT ?? os.hostname().split(".")[0].replace(/[^A-Za-z0-9_-]/g, "");
const LANES = {
  "anthropic-a": { port: 8791, accountBindingId: "6da67cea-ef88-4093-94b8-54b39c1b1ea2" },
  "anthropic-b": { port: 8792, accountBindingId: "49c0e5bf-478c-4752-ab23-89f7e8b64626" },
  "anthropic-c": { port: 8793, accountBindingId: "417c2d6d-edce-4811-bcb2-5567e6fbb683" },
  "anthropic-d": { port: 8794, accountBindingId: "5f612820-7146-4757-abd0-3cbab41732ee" },
};
const SCOPES = [["permit:mutate", "claude-permit-authority-permit-mutate"], ["snapshot:read", "claude-permit-authority-snapshot-read"], ["allowance:publish", "claude-permit-authority-allowance-publish"]];

const results = [];
const record = (step, state, detail) => results.push({ step, state, detail });
const wouldChange = () => results.some((r) => r.state === "changed" || r.state === "missing");

function ensureConfig() {
  fs.mkdirSync(GATE_DIR, { recursive: true, mode: 0o700 });
  let config;
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { config = undefined; }
  // The installation id identifies this machine to the authority and must never be shared or reused:
  // enrolment rejects a repeated installation and scope pair, even after revocation.
  const installationId = config?.installationId && /^[0-9a-f-]{36}$/i.test(config.installationId) ? config.installationId : crypto.randomUUID();
  const desired = { schemaVersion: 1, mode: "authority-client", origin: ORIGIN, expectedAuthorityId: AUTHORITY_ID, installationId, keychain: Object.fromEntries(SCOPES.map(([scope, service]) => [scope === "permit:mutate" ? "permitMutate" : scope === "snapshot:read" ? "snapshotRead" : "allowancePublish", { service, account: KEYCHAIN_ACCOUNT }])), monitorSource: "authority", publisherEnabled: true, lanes: LANES };
  const current = config ? JSON.stringify(config) : "";
  if (current === JSON.stringify(desired) && (fs.statSync(CONFIG_FILE).mode & 0o077) === 0) { record("client config", "ok", installationId); return desired; }
  if (CHECK_ONLY) { record("client config", config ? "changed" : "missing", installationId); return desired; }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(desired, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(CONFIG_FILE, 0o600);
  record("client config", "changed", `${config ? "updated" : "created"} ${installationId}`);
  return desired;
}

function ensureShellEnvironment() {
  const file = path.join(HOME, ".zshenv");
  const block = `\n# Claude permit authority client mode (managed by bootstrap-client.mjs)\nexport CLAUDE_PERMIT_GATE_MODE=authority-client\nexport CLAUDE_PERMIT_GATE_ORIGIN=${ORIGIN}\nexport CLAUDE_PERMIT_GATE_AUTHORITY_CONFIG="$HOME/.pi/agent/claude-permit-gate/authority-client.json"\n`;
  let contents = "";
  try { contents = fs.readFileSync(file, "utf8"); } catch {}
  if (contents.includes("CLAUDE_PERMIT_GATE_MODE=authority-client")) { record("shell environment", "ok", "~/.zshenv"); return; }
  if (CHECK_ONLY) { record("shell environment", "missing", "~/.zshenv"); return; }
  fs.appendFileSync(file, block);
  record("shell environment", "changed", "appended to ~/.zshenv");
}

// A plist is rewritten only when its content differs, so re-running does not churn launchd.
function ensureAgent(label, plist, { optional = false } = {}) {
  const file = path.join(AGENTS_DIR, `${label}.plist`);
  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  let existing = "";
  try { existing = fs.readFileSync(file, "utf8"); } catch {}
  const loaded = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "ignore" }).status === 0;
  if (existing === plist && loaded) { record(label, "ok", optional ? "optional" : "required"); return; }
  if (CHECK_ONLY) { record(label, existing ? "changed" : "missing", optional ? "optional" : "required"); return; }
  fs.writeFileSync(file, plist);
  if (spawnSync("/usr/bin/plutil", ["-lint", file], { stdio: "ignore" }).status !== 0) { record(label, "error", "plist failed lint"); return; }
  spawnSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "ignore" });
  // launchd unloads asynchronously; bootstrapping a label still tearing down fails with EIO.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "ignore" }).status !== 0) break;
    spawnSync("/bin/sleep", ["0.1"], { stdio: "ignore" });
  }
  const boot = spawnSync("/bin/launchctl", ["bootstrap", `gui/${process.getuid()}`, file], { stdio: "ignore" });
  record(label, boot.status === 0 ? "changed" : "error", boot.status === 0 ? "installed" : "bootstrap failed");
}

const plist = (label, args, { env = {}, keepAlive = true, interval } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>${args.map((a) => `\n    <string>${a}</string>`).join("")}
  </array>${Object.keys(env).length ? `
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `\n    <key>${k}</key><string>${v}</string>`).join("")}
  </dict>` : ""}
  <key>RunAtLoad</key><true/>${interval ? `
  <key>StartInterval</key><integer>${interval}</integer>` : ""}${keepAlive ? `
  <key>KeepAlive</key><true/>` : ""}
  <key>StandardOutPath</key><string>${LOG_DIR}/${label.split(".").pop()}.log</string>
  <key>StandardErrorPath</key><string>${LOG_DIR}/${label.split(".").pop()}.err.log</string>
</dict>
</plist>
`;

function checkCredentials() {
  const missing = SCOPES.filter(([, service]) => spawnSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", KEYCHAIN_ACCOUNT], { stdio: "ignore" }).status !== 0).map(([scope]) => scope);
  if (!missing.length) record("keychain credentials", "ok", `account ${KEYCHAIN_ACCOUNT}`);
  else record("keychain credentials", "missing", `enrol on the authority host: ${missing.join(", ")}`);
}

// A local daemon on an A-D port means this machine is scheduling permits by itself, which spends the
// shared account's capacity without the authority knowing. Only stop one that is provably idle.
function stopLocalLaneDaemons() {
  const stopped = [];
  for (const [, lane] of Object.entries(LANES)) {
    const pid = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${lane.port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" }).stdout?.trim().split("\n")[0];
    if (!pid) continue;
    const managed = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/com.longweekendprojects.claude-permit-lane.${Object.keys(LANES).find((k) => LANES[k].port === lane.port)}`], { stdio: "ignore" }).status === 0;
    if (managed) continue;   // this machine is the authority host; its lane jobs own these ports
    const health = spawnSync("/usr/bin/curl", ["-sS", "--max-time", "2", `http://127.0.0.1:${lane.port}/health`], { encoding: "utf8" }).stdout ?? "";
    let idle = false;
    try { const parsed = JSON.parse(health); idle = parsed.active === 0 && parsed.queued === 0; } catch {}
    if (!idle) { record("local lane daemons", "error", `port ${lane.port} is busy; rerun when idle`); return; }
    if (CHECK_ONLY) { stopped.push(lane.port); continue; }
    process.kill(Number(pid));
    stopped.push(lane.port);
  }
  if (!stopped.length) record("local lane daemons", "ok", "none listening");
  else record("local lane daemons", CHECK_ONLY ? "changed" : "changed", `${CHECK_ONLY ? "would stop" : "stopped"} ${stopped.join(", ")}`);
}

function verifyAuthority(config) {
  let token;
  try { token = execFileSync("/usr/bin/security", ["find-generic-password", "-s", config.keychain.snapshotRead.service, "-a", config.keychain.snapshotRead.account, "-w"], { encoding: "utf8" }).trim(); }
  catch { record("authority reachability", "missing", "no snapshot:read credential yet"); return; }
  const out = spawnSync("/usr/bin/curl", ["-sS", "--max-time", "5", "-H", `authorization: Bearer ${token}`, `${config.origin}:${LANES["anthropic-a"].port}/v1/health`], { encoding: "utf8" }).stdout ?? "";
  try {
    const health = JSON.parse(out);
    if (health.status === "ready" && health.authorityId === config.expectedAuthorityId) record("authority reachability", "ok", `lane A ready, term ${health.laneTerm}`);
    else record("authority reachability", "error", health.error?.code ?? "unexpected health response");
  } catch { record("authority reachability", "error", "no response"); }
}

const config = ensureConfig();
ensureShellEnvironment();
ensureAgent("com.longweekendprojects.claude-permit-env", plist("com.longweekendprojects.claude-permit-env", ["/bin/sh", "-c", `launchctl setenv CLAUDE_PERMIT_GATE_MODE authority-client; launchctl setenv CLAUDE_PERMIT_GATE_ORIGIN ${ORIGIN}; launchctl setenv CLAUDE_PERMIT_GATE_AUTHORITY_CONFIG ${CONFIG_FILE}`], { keepAlive: false }));
ensureAgent("com.longweekendprojects.claude-lane-sampler", plist("com.longweekendprojects.claude-lane-sampler", [NODE, path.join(REPO, "scripts/lane-sampler.mjs")]), { optional: true });
const monitorApp = path.join(HOME, "Applications/Claude Lane Monitor.app/Contents/MacOS/ClaudeLaneMonitor");
if (fs.existsSync(monitorApp)) ensureAgent("com.longweekendprojects.claude-lane-monitor", plist("com.longweekendprojects.claude-lane-monitor", [monitorApp], { env: { CLAUDE_PERMIT_GATE_MODE: "authority-client", CLAUDE_PERMIT_GATE_ORIGIN: ORIGIN, CLAUDE_PERMIT_GATE_AUTHORITY_CONFIG: CONFIG_FILE } }), { optional: true });
else record("com.longweekendprojects.claude-lane-monitor", "ok", "monitor app not installed, skipped");
checkCredentials();
stopLocalLaneDaemons();
verifyAuthority(config);

const width = Math.max(...results.map((r) => r.step.length));
for (const { step, state, detail } of results) process.stdout.write(`${state.padEnd(8)} ${step.padEnd(width)}  ${detail}\n`);
const failed = results.some((r) => r.state === "error");
if (failed) process.exitCode = 2;
else if (CHECK_ONLY && wouldChange()) process.exitCode = 1;
