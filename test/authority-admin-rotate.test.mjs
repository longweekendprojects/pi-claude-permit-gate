import "./clean-permit-environment.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { authenticateAuthorityBearer, readAuthorityVerifierStore } from "../authority-state.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const admin = path.join(root, "scripts", "authority-admin.mjs");
const installationId = "00000321-0000-4000-8000-000000000321";
const lanes = "anthropic-a,anthropic-b,anthropic-c,anthropic-d";

function run(home, writer, args, secret) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: home, CLAUDE_PERMIT_GATE_TEST_MODE: "1", CLAUDE_PERMIT_GATE_TEST_KEYCHAIN_WRITER: writer };
    const child = spawn(process.execPath, [admin, ...args], { env, stdio: ["pipe", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
    child.stdin.end(`${secret.toString("base64url")}\n`);
  });
}

// Tokens were issued for 90 days. When they lapsed, rotate refused the expired predecessor and enroll
// refused the installation that still held it, so no command could restore the machine's access.
test("an expired token rotates to a successor, and Keychain receives the bearer clients read", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "permit-rotate-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const written = path.join(home, "keychain-written");
  const writer = path.join(home, "keychain-writer.sh");
  await fs.writeFile(writer, `#!/bin/sh\ncat > '${written}'\n`, { mode: 0o700 });
  const now = Date.now();
  const expired = crypto.randomBytes(32);
  assert.equal(await run(home, writer, ["enroll", "--installation-id", installationId, "--scope", "permit:mutate", "--lanes", lanes, "--token-id", "machine-permit-1", "--keychain-service", "test.authority", "--keychain-account", "machine", "--issued-at-epoch-ms", String(now - 10_000), "--expires-at-epoch-ms", String(now - 1_000)], expired), 0);
  const store = authorityPathIn(home);
  assert.throws(() => authenticateAuthorityBearer(`Bearer machine-permit-1.${expired.toString("base64url")}`, readAuthorityVerifierStore(store), { requiredScope: "permit:mutate", provider: "anthropic-a" }));

  const successor = crypto.randomBytes(32);
  assert.equal(await run(home, writer, ["rotate", "--old-token-id", "machine-permit-1", "--new-token-id", "machine-permit-2", "--keychain-service", "test.authority", "--keychain-account", "machine", "--expires-at-epoch-ms", String(now + 3_600_000)], successor), 0);
  const bearer = `machine-permit-2.${successor.toString("base64url")}`;
  assert.equal(await fs.readFile(written, "utf8"), bearer);
  const verified = authenticateAuthorityBearer(`Bearer ${bearer}`, readAuthorityVerifierStore(store), { requiredScope: "permit:mutate", provider: "anthropic-a" });
  assert.equal(verified.installationId, installationId);
  assert.equal(readAuthorityVerifierStore(store).verifiers.find((record) => record.tokenId === "machine-permit-2").predecessorTokenId, "machine-permit-1");
});

test("a revoked token still cannot be rotated", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "permit-rotate-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const writer = "/usr/bin/true";
  const now = Date.now();
  assert.equal(await run(home, writer, ["enroll", "--installation-id", installationId, "--scope", "permit:mutate", "--lanes", lanes, "--token-id", "machine-permit-1", "--keychain-service", "test.authority", "--keychain-account", "machine", "--expires-at-epoch-ms", String(now + 3_600_000)], crypto.randomBytes(32)), 0);
  const revoke = await new Promise((resolve) => { const child = spawn(process.execPath, [admin, "revoke", "--token-id", "machine-permit-1"], { env: { ...process.env, HOME: home, CLAUDE_PERMIT_GATE_TEST_MODE: "1" }, stdio: "ignore" }); child.once("exit", resolve); });
  assert.equal(revoke, 0);
  assert.equal(await run(home, writer, ["rotate", "--old-token-id", "machine-permit-1", "--new-token-id", "machine-permit-2", "--keychain-service", "test.authority", "--keychain-account", "machine", "--expires-at-epoch-ms", String(now + 3_600_000)], crypto.randomBytes(32)), 1);
});

function authorityPathIn(home) {
  return path.join(home, "Library", "Application Support", "Claude Permit Authority", "verifiers-v1.json");
}
