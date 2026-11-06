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
    fs.copyFileSync(new URL("../scripts/launchd-node.mjs", import.meta.url), path.join(scriptDir, "launchd-node.mjs"));
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
      fs.copyFileSync(new URL("../scripts/launchd-node.mjs", import.meta.url), path.join(scriptDir, "launchd-node.mjs"));
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
          if (args[0] === "-e") return { status: 0 };
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

// The persisted interpreter survives Node upgrades, including an exporter installed outside Pi.
test("jobs-only prefers stable Node, preserves exporter settings, and leaves local lanes and credentials alone", () => {
  for (const node of ["/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath]) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "permit-client-node-"));
    try {
      const agents = path.join(home, "Library/LaunchAgents");
      fs.mkdirSync(agents, { recursive: true });
      const label = "com.longweekendprojects.claude-authority-exporter";
      const exporterFile = path.join(agents, `${label}.plist`);
      const exporter = { Label: label, ProgramArguments: ["/old/node", "/existing/authority-exporter.mjs"], EnvironmentVariables: { CLAUDE_AUTHORITY_EXPORTER_HOST: "100.64.0.1", CLAUDE_AUTHORITY_EXPORTER_PORT: "9714" }, KeepAlive: true, StandardErrorPath: "/existing/exporter.err" };
      fs.writeFileSync(exporterFile, JSON.stringify(exporter));
      const preload = path.join(home, "mock-client-install.mjs");
      fs.writeFileSync(preload, `
        import childProcess from "node:child_process";
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        const loaded = new Set();
        childProcess.spawnSync = (command, args) => {
          if (args[0] === "-e") return { status: command === process.env.TEST_NODE ? 0 : 1 };
          if (command === "/bin/launchctl") {
            const label = args[1]?.split("/").pop();
            if (args[0] === "print") return { status: loaded.has(label) ? 0 : 1, stdout: "state = waiting" };
            if (args[0] === "bootout") loaded.delete(label);
            if (args[0] === "bootstrap") loaded.add(args[2].split("/").pop().replace(/\\.plist$/, ""));
            return { status: 0 };
          }
          if (command === "/usr/bin/plutil") return { status: 0 };
          throw new Error("jobs-only must not inspect or stop local lanes, access credentials, or contact the authority: " + command);
        };
        childProcess.execFileSync = (command, args, options) => {
          // plutil's representation conversion is irrelevant to the launch definition contract.
          if (command === "/usr/bin/plutil") return args[1] === "json" ? fs.readFileSync(args.at(-1), "utf8") : options.input;
          throw new Error("jobs-only must not access credentials: " + command);
        };
        syncBuiltinESMExports();
      `);
      const script = new URL("../scripts/bootstrap-client.mjs", import.meta.url).pathname;
      const run = () => spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, "--jobs-only"], {
        encoding: "utf8", timeout: 5000,
        env: { ...process.env, HOME: home, TEST_NODE: node, CLAUDE_PERMIT_GATE_ORIGIN: "https://example.test", CLAUDE_PERMIT_AUTHORITY_ID: "ce298942-e550-44f2-8566-b45ea813d01c" },
      });
      const installed = run();
      assert.equal(installed.status, 0, installed.stderr + installed.stdout);
      assert.equal(fs.existsSync(path.join(home, ".pi/agent/claude-permit-gate")), false);
      assert.equal(fs.existsSync(path.join(home, ".zshenv")), false);
      for (const job of ["claude-allowance-prober", "claude-allowance-syncer", "claude-lane-sampler"]) {
        const contents = fs.readFileSync(path.join(agents, `com.longweekendprojects.${job}.plist`), "utf8");
        assert.ok(contents.includes(`<array>\n    <string>${node}</string>`), contents);
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(exporterFile, "utf8")), { ...exporter, ProgramArguments: [node, exporter.ProgramArguments[1]] });
      fs.rmSync(exporterFile);
      const absent = run();
      assert.equal(absent.status, 0, absent.stderr);
      assert.equal(fs.existsSync(exporterFile), false, "do not install an exporter on a new client");
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});
