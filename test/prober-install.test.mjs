import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// An npm package has a different root. Inspection must not provision the rest of the machine.
test("prober-only inspection detects a missing job without provisioning other services", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "permit-prober-install-"));
  try {
    const scriptDir = path.join(home, ".pi/agent/npm/node_modules/pi-claude-permit-gate/scripts");
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.copyFileSync(new URL("../scripts/bootstrap-client.mjs", import.meta.url), path.join(scriptDir, "bootstrap-client.mjs"));
    const run = spawnSync(process.execPath, [path.join(scriptDir, "bootstrap-client.mjs"), "--prober-only", "--check"], {
      env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 5000,
    });
    assert.equal(run.status, 1, run.stderr);
    assert.match(run.stdout, /^missing\s+com\.longweekendprojects\.claude-allowance-prober\s+required\s*$/);
    assert.equal(fs.existsSync(path.join(home, "Library/LaunchAgents")), false);
    assert.equal(fs.existsSync(path.join(home, ".pi/agent/claude-permit-gate")), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("authority-client session warns about a prober still pointing at another package", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "permit-prober-notice-"));
  try {
    const configPath = path.join(home, "authority-client.json");
    const id = "00000000-0000-4000-8000-000000000001";
    const keychain = { service: "test", account: "test" };
    const lanes = Object.fromEntries(["a", "b", "c", "d"].map((letter, index) => [
      `anthropic-${letter}`, { port: 8791 + index, accountBindingId: id },
    ]));
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, mode: "authority-client", origin: "https://example.test", expectedAuthorityId: id, installationId: id, keychain: { permitMutate: keychain, snapshotRead: keychain, allowancePublish: keychain }, monitorSource: "authority", publisherEnabled: true, lanes }), { mode: 0o600 });
    const runner = path.join(home, "run-session.mjs");
    fs.writeFileSync(runner, `
      import gate from ${JSON.stringify(new URL("../index.ts", import.meta.url).href)};
      let start;
      const notices = [];
      gate({ on: (event, handler) => { if (event === "session_start") start = handler; }, registerCommand: () => {} });
      await start({}, { sessionManager: { getSessionId: () => "synthetic" }, hasUI: true, ui: { setStatus: () => {}, notify: (message) => notices.push(message) } });
      if (!notices.some((message) => message.includes("--prober-only --check"))) throw new Error("missing migration warning");
    `);
    const run = spawnSync(process.execPath, ["--experimental-strip-types", runner], {
      env: { ...process.env, HOME: home, CLAUDE_PERMIT_GATE_MODE: "authority-client", CLAUDE_PERMIT_GATE_ORIGIN: "https://example.test", CLAUDE_PERMIT_GATE_AUTHORITY_CONFIG: configPath },
      encoding: "utf8", timeout: 5000,
    });
    assert.equal(run.status, 0, run.stderr);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Stand in for launchd and plutil; never touch the real machine's jobs or credentials.
for (const scenario of ["running", "invalid-plist", "bootstrap-failure"]) {
  test(`prober-only handles ${scenario} without losing the existing job`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "permit-prober-safety-"));
    try {
      const scriptDir = path.join(home, ".pi/agent/npm/node_modules/pi-claude-permit-gate/scripts");
      const agents = path.join(home, "Library/LaunchAgents");
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.mkdirSync(agents, { recursive: true });
      const script = path.join(scriptDir, "bootstrap-client.mjs");
      fs.copyFileSync(new URL("../scripts/bootstrap-client.mjs", import.meta.url), script);
      const plist = path.join(agents, "com.longweekendprojects.claude-allowance-prober.plist");
      fs.writeFileSync(plist, "old prober plist");
      const preload = path.join(home, "mock-launchd.mjs");
      fs.writeFileSync(preload, `
        import childProcess from "node:child_process";
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        let unloaded = false;
        let bootstrapAttempts = 0;
        childProcess.spawnSync = (command, args) => {
          fs.appendFileSync(process.env.TEST_CALLS, command + " " + args[0] + "\\n");
          if (command === "/bin/launchctl" && args[0] === "print") return { status: unloaded ? 1 : 0, stdout: process.env.TEST_SCENARIO === "running" ? "pid = 123\\n" : "state = waiting\\n" };
          if (command === "/usr/bin/plutil" && args[0] === "-lint") return { status: process.env.TEST_SCENARIO === "invalid-plist" ? 1 : 0 };
          if (command === "/bin/launchctl" && args[0] === "bootout") { unloaded = true; return { status: 0 }; }
          if (command === "/bin/launchctl" && args[0] === "bootstrap") { bootstrapAttempts++; return { status: bootstrapAttempts === 1 ? 1 : 0 }; }
          throw new Error("unexpected command: " + command + " " + args.join(" "));
        };
        syncBuiltinESMExports();
      `);
      const calls = path.join(home, "calls.log");
      const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, "--prober-only"], {
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, HOME: home, TEST_CALLS: calls, TEST_SCENARIO: scenario },
      });
      assert.equal(run.status, 2, run.stderr);
      assert.match(run.stdout, /error\s+com\.longweekendprojects\.claude-allowance-prober/);
      assert.equal(fs.readFileSync(plist, "utf8"), "old prober plist");
      const actions = fs.readFileSync(calls, "utf8");
      if (scenario === "bootstrap-failure") {
        assert.equal((actions.match(/\/bin\/launchctl bootstrap/g) ?? []).length, 2, actions);
      } else assert.doesNotMatch(actions, /bootout|bootstrap/);
      assert.equal(fs.existsSync(path.join(home, ".pi/agent/claude-permit-gate")), false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}
