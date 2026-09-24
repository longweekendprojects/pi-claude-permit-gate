import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createAllowanceAuth } from "../scripts/allowance-prober-auth.mjs";

// Block any transport that a test did not explicitly mock, including during Pi module loading.
globalThis.fetch = async () => { throw new Error("Network access is forbidden in OAuth tests"); };

// CI installs this reviewed Pi release globally beside its Node binary. A missing runtime fails
// these tests rather than turning the credential-race regression into a skipped check.
const runtime = path.resolve(path.dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
const { AuthStorage } = await import(pathToFileURL(path.join(runtime, "dist/core/auth-storage.js")).href);
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const expired = (id) => ({ type: "oauth", access: `synthetic-${id}-old-access`, refresh: `synthetic-${id}-old-refresh`, expires: 1 });
const fresh = (id) => ({ type: "oauth", access: `synthetic-${id}-new-access`, refresh: `synthetic-${id}-new-refresh`, expires: Date.now() + 3_600_000 });
const temporaryAuth = (initial) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "allowance-auth-test-"));
  const authPath = path.join(directory, "auth.json");
  fs.writeFileSync(authPath, JSON.stringify(initial), { mode: 0o600 });
  return { directory, authPath, read: () => JSON.parse(fs.readFileSync(authPath, "utf8")), cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
};
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

test("a canonical Pi write on another account cannot erase the prober's rotated credential", { timeout: 30_000 }, async () => {
  const temp = temporaryAuth({ "anthropic-a": expired("a"), "anthropic-d": expired("d") });
  const originalFetch = globalThis.fetch;
  const entered = deferred(); const release = deferred();
  let piWrite;
  try {
    const resolveToken = await createAllowanceAuth(temp.authPath);
    const piStore = AuthStorage.create(temp.authPath);
    piWrite = piStore.modify("anthropic-a", async () => { entered.resolve(); await release.promise; return fresh("a"); });
    await entered.promise;
    let refreshes = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, TOKEN_URL);
      assert.equal(JSON.parse(options.body).refresh_token, "synthetic-d-old-refresh");
      refreshes++;
      return { ok: true, text: async () => JSON.stringify({ access_token: "synthetic-d-new-access", refresh_token: "synthetic-d-new-refresh", expires_in: 3600 }) };
    };
    const pending = resolveToken("anthropic-d");
    await new Promise((done) => setImmediate(done));
    assert.equal(refreshes, 0, "the prober must wait for Pi's credential lock before refreshing D");
    release.resolve();
    assert.equal(await pending, "synthetic-d-new-access");
    await piWrite;
    assert.equal(refreshes, 1);
    assert.equal(temp.read()["anthropic-a"].refresh, "synthetic-a-new-refresh");
    assert.equal(temp.read()["anthropic-d"].refresh, "synthetic-d-new-refresh");
  } finally {
    release.resolve();
    await piWrite?.catch(() => {});
    globalThis.fetch = originalFetch;
    temp.cleanup();
  }
});

test("concurrent stale reads of one account refresh once and return the rotated access", { timeout: 30_000 }, async () => {
  const temp = temporaryAuth({ "anthropic-d": expired("d") });
  const originalFetch = globalThis.fetch;
  const entered = deferred(); const release = deferred();
  let first, second;
  try {
    const resolveFirst = await createAllowanceAuth(temp.authPath);
    const resolveSecond = await createAllowanceAuth(temp.authPath);
    let refreshes = 0;
    globalThis.fetch = async (url, options) => {
      assert.equal(url, TOKEN_URL);
      assert.equal(JSON.parse(options.body).refresh_token, "synthetic-d-old-refresh");
      refreshes++;
      entered.resolve();
      await release.promise;
      return { ok: true, text: async () => JSON.stringify({ access_token: "synthetic-d-new-access", refresh_token: "synthetic-d-new-refresh", expires_in: 3600 }) };
    };
    first = resolveFirst("anthropic-d");
    await entered.promise;
    second = resolveSecond("anthropic-d");
    await new Promise((done) => setImmediate(done));
    release.resolve();
    assert.deepEqual(await Promise.all([first, second]), ["synthetic-d-new-access", "synthetic-d-new-access"]);
    assert.equal(refreshes, 1);
    assert.equal(temp.read()["anthropic-d"].refresh, "synthetic-d-new-refresh");
  } finally {
    release.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    globalThis.fetch = originalFetch;
    temp.cleanup();
  }
});

test("missing, invalid, rejected, and incompatible OAuth fail closed without revealing a response body", { timeout: 30_000 }, async () => {
  const temp = temporaryAuth({ "anthropic-b": { type: "api_key", key: "synthetic-wrong-type" }, "anthropic-c": expired("c"), "anthropic-d": { type: "oauth", access: "synthetic-d-access", expires: Date.now() + 3_600_000 } });
  const originalFetch = globalThis.fetch;
  try {
    const resolveToken = await createAllowanceAuth(temp.authPath);
    assert.equal(await resolveToken("anthropic-a"), undefined);
    assert.equal(await resolveToken("anthropic-b"), undefined);
    assert.equal(await resolveToken("anthropic-d"), undefined, "a credential without a refresh token cannot authenticate the lane");
    globalThis.fetch = async (url) => {
      assert.equal(url, TOKEN_URL);
      return { ok: false, status: 400, text: async () => "invalid_grant synthetic-private-response" };
    };
    await assert.rejects(resolveToken("anthropic-c"), (error) => error.message === "Pi OAuth credential resolution failed" && !error.message.includes("synthetic-private-response"));
    assert.equal(temp.read()["anthropic-c"].refresh, "synthetic-c-old-refresh");
    await assert.rejects(createAllowanceAuth(temp.authPath, path.join(temp.directory, "missing-runtime")), { message: "Pi OAuth resolver is unavailable" });
  } finally {
    globalThis.fetch = originalFetch;
    temp.cleanup();
  }
});

test("standalone prober resolves from its Node installation and continues usage after a rejected lane", { timeout: 30_000 }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "allowance-prober-home-"));
  try {
    const agentDir = path.join(home, ".pi/agent");
    const gateDir = path.join(agentDir, "claude-permit-gate");
    fs.mkdirSync(gateDir, { recursive: true });
    const authPath = path.join(agentDir, "auth.json");
    fs.writeFileSync(authPath, JSON.stringify({ "anthropic-a": expired("a"), "anthropic-c": fresh("c"), "anthropic-d": expired("d") }), { mode: 0o600 });
    fs.writeFileSync(path.join(gateDir, "authority-client.json"), JSON.stringify({}), { mode: 0o600 });
    const preload = path.join(home, "mock-transport.mjs");
    fs.writeFileSync(preload, `
      import assert from "node:assert/strict";
      import os from "node:os";
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      assert.equal(os.homedir(), process.env.TEST_FAKE_HOME);
      childProcess.execFileSync = () => { throw new Error("Keychain access forbidden in test"); };
      syncBuiltinESMExports();
      globalThis.fetch = async (url, options = {}) => {
        if (url === ${JSON.stringify(TOKEN_URL)}) {
          const refresh = JSON.parse(options.body).refresh_token;
          if (refresh === "synthetic-a-old-refresh") return { ok: true, text: async () => JSON.stringify({ access_token: "synthetic-a-new-access", refresh_token: "synthetic-a-new-refresh", expires_in: 3600 }) };
          if (refresh === "synthetic-d-old-refresh") return { ok: false, status: 400, text: async () => "invalid_grant synthetic-private-response" };
        }
        if (url === ${JSON.stringify(USAGE_URL)}) {
          assert.ok(["Bearer synthetic-a-new-access", "Bearer synthetic-c-new-access"].includes(options.headers.authorization));
          return { ok: true, status: 200, json: async () => ({ five_hour: { utilization: 24, resets_at: null }, seven_day: { utilization: 50, resets_at: null } }) };
        }
        throw new Error("Unexpected network request in test");
      };
    `);
    const prober = path.resolve("scripts/allowance-prober.mjs");
    const run = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, prober], {
      encoding: "utf8", timeout: 25_000,
      env: { ...process.env, HOME: home, TEST_FAKE_HOME: home, CLAUDE_PERMIT_GATE_BYPASS: "1" },
    });
    assert.equal(run.status, 0, `isolated prober exit: ${run.error?.code ?? run.stderr}`);
    assert.match(run.stdout, /anthropic-a: usage 5h=24\.0% 7d=50\.0% -> local file/);
    assert.match(run.stdout, /anthropic-c: usage 5h=24\.0% 7d=50\.0% -> local file/);
    assert.match(run.stdout, /anthropic-b: OAuth credential unavailable/);
    assert.match(run.stdout, /anthropic-d: OAuth credential resolution failed/);
    assert.doesNotMatch(run.stdout + run.stderr, /synthetic-.*(?:access|refresh|response)|invalid_grant/);
    const failures = JSON.parse(fs.readFileSync(path.join(gateDir, "allowance-prober-credentials-v1.json"), "utf8"));
    assert.deepEqual(failures.lanes, {
      "anthropic-b": { failedAtEpochMs: failures.lanes["anthropic-b"].failedAtEpochMs, reason: "OAuth credential unavailable" },
      "anthropic-d": { failedAtEpochMs: failures.lanes["anthropic-d"].failedAtEpochMs, reason: "OAuth credential resolution failed" },
    });
    assert.equal(fs.existsSync(path.join(agentDir, "usage-windows/anthropic-a.json")), true);
    assert.equal(fs.existsSync(path.join(agentDir, "usage-windows/anthropic-c.json")), true);
    assert.equal(fs.existsSync(path.join(agentDir, "usage-windows/anthropic-d.json")), false);
    const saved = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(saved["anthropic-a"].refresh, "synthetic-a-new-refresh");
    assert.equal(saved["anthropic-d"].refresh, "synthetic-d-old-refresh");
    assert.doesNotMatch(JSON.stringify(failures), /synthetic-private-response|synthetic-.*(?:access|refresh)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
