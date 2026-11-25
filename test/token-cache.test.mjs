import "./clean-permit-environment.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { harness, tokenOf } from "./token-cache-harness.mjs";

const inTemp = async (run) => { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "permit-token-")); try { return await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); } };

test("one acquisition reads the Keychain token once, however many requests it sends", () => inTemp(async (directory) => {
  const { client, seen } = harness(directory, { accepts: tokenOf("now"), reads: [tokenOf("now")] });
  const held = await client.acquire("anthropic-a");
  assert.equal(held.ticket.state, "active");
  // health, create, two polls, claim
  assert.equal(seen.requests.length, 5);
  assert.equal(seen.tokenReads, 1);
}));

test("a token the authority refuses is read again once, and the same request is sent again", () => inTemp(async (directory) => {
  // The kept token was rotated: the Keychain now holds the one the authority accepts.
  const { client, seen } = harness(directory, { accepts: tokenOf("new"), reads: [tokenOf("old"), tokenOf("new")] });
  const held = await client.acquire("anthropic-a");
  assert.equal(held.ticket.state, "active");
  assert.equal(seen.refusals, 1);
  assert.equal(seen.tokenReads, 2);
  assert.deepEqual(seen.requests.slice(0, 2), ["GET /v1/health", "GET /v1/health"]);
  assert.equal(seen.requests.length, 6);
}));

test("a refusal of the token the Keychain still holds fails the request without another try", () => inTemp(async (directory) => {
  const { client, seen } = harness(directory, { accepts: tokenOf("other"), reads: [tokenOf("old")] });
  await assert.rejects(client.acquire("anthropic-a"), /bearer is unavailable/);
  // One request, refused; one more Keychain read to see whether the token changed; no second request.
  assert.equal(seen.requests.length, 1);
  assert.equal(seen.tokenReads, 2);
}));

test("a new token the authority also refuses is not sent a third time", () => inTemp(async (directory) => {
  const { client, seen } = harness(directory, { accepts: tokenOf("other"), reads: [tokenOf("old"), tokenOf("new"), tokenOf("newer")] });
  await assert.rejects(client.acquire("anthropic-a"), /bearer is unavailable/);
  assert.deepEqual(seen.requests, ["GET /v1/health", "GET /v1/health"]);
  assert.equal(seen.tokenReads, 2);
}));

test("a Keychain read that fails after a refusal surfaces the refusal, and the failed read is not kept", () => inTemp(async (directory) => {
  let reads = 0;
  const { client, seen } = harness(directory, { accepts: tokenOf("new"), reads: [tokenOf("old")], token: async () => { reads++; if (reads === 2) throw new Error("authority token is unavailable"); return reads === 1 ? tokenOf("old") : tokenOf("new"); } });
  await assert.rejects(client.acquire("anthropic-a"), /bearer is unavailable/);
  assert.equal(seen.requests.length, 1);
  // The next acquisition reads the Keychain again and succeeds with the token it now holds.
  const held = await client.acquire("anthropic-a");
  assert.equal(held.ticket.state, "active");
  assert.equal(reads, 3);
}));

test("a token rotated in the middle of an acquisition is picked up on the refused POST", () => inTemp(async (directory) => {
  const state = { accepts: tokenOf("old") };
  const { client, seen } = harness(directory, { accepts: () => state.accepts, reads: [tokenOf("old"), tokenOf("new")], onRequest: (line) => { if (line === "GET /v1/health") state.accepts = tokenOf("new"); } });
  const held = await client.acquire("anthropic-a");
  assert.equal(held.ticket.state, "active");
  assert.equal(seen.refusals, 1);
  assert.equal(seen.requests.filter((line) => line === "POST /v1/tickets").length, 2);
  assert.equal(seen.tokenReads, 2);
}));

test("CLAUDE_PERMIT_GATE_TOKEN_CACHE_MS=0 reads the Keychain before every request", async () => {
  const script = `import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path"; import { harness } from ${JSON.stringify(fileURLToPath(new URL("./token-cache-harness.mjs", import.meta.url)))}; const d = await fs.mkdtemp(path.join(os.tmpdir(), "permit-token-")); const t = "now." + "a".repeat(43); const { client, seen } = harness(d, { accepts: t, reads: [t] }); await client.acquire("anthropic-a"); await fs.rm(d, { recursive: true, force: true }); console.log(JSON.stringify(seen));`;
  const out = await new Promise((resolve, reject) => execFile(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, CLAUDE_PERMIT_GATE_TOKEN_CACHE_MS: "0", NODE_TEST_CONTEXT: "" }, encoding: "utf8" }, (error, stdout, stderr) => error ? reject(new Error(stderr || String(error))) : resolve(stdout)));
  const seen = JSON.parse(out.trim().split("\n").pop());
  assert.equal(seen.requests.length, 5);
  assert.equal(seen.tokenReads, 5);
});

test("CLAUDE_PERMIT_GATE_TOKEN_CACHE_MS=0 never sends a refused request again", async () => {
  const script = `import fs from "node:fs/promises"; import os from "node:os"; import path from "node:path"; import { harness, tokenOf } from ${JSON.stringify(fileURLToPath(new URL("./token-cache-harness.mjs", import.meta.url)))}; const d = await fs.mkdtemp(path.join(os.tmpdir(), "permit-token-")); const { client, seen } = harness(d, { accepts: tokenOf("new"), reads: [tokenOf("old"), tokenOf("new")] }); const failed = await client.acquire("anthropic-a").then(() => false, () => true); await fs.rm(d, { recursive: true, force: true }); console.log(JSON.stringify({ ...seen, failed }));`;
  const out = await new Promise((resolve, reject) => execFile(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { env: { ...process.env, CLAUDE_PERMIT_GATE_TOKEN_CACHE_MS: "0", NODE_TEST_CONTEXT: "" }, encoding: "utf8" }, (error, stdout, stderr) => error ? reject(new Error(stderr || String(error))) : resolve(stdout)));
  const seen = JSON.parse(out.trim().split("\n").pop());
  assert.equal(seen.failed, true);
  assert.equal(seen.requests.length, 1);
  assert.equal(seen.tokenReads, 1);
});
