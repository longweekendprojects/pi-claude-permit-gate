import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireTimingPaths, createAuthorityClient } from "../index.ts";

const sessionId = "88888888-8888-4888-8888-888888888888"; const ticketId = "77777777-7777-4777-8777-777777777777";
const configFor = (statePath) => ({ mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", statePath, keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false, lanes: { "anthropic-a": { port: 8791, accountBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "anthropic-b": { port: 8792, accountBindingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "anthropic-c": { port: 8793, accountBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, "anthropic-d": { port: 8794, accountBindingId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } } });
const lease = { leaseId: "55555555-5555-4555-8555-555555555555", generation: 1, claimedAtEpochMs: 4_000, renewSequence: 0, renewByEpochMs: 5_000, serverDeadlineEpochMs: 6_000 };
const ticket = (requestId, state, revision) => ({ schemaVersion: 1, ticketId, requestId, provider: "anthropic-a", state, revision, createdAtEpochMs: 1_000, enqueuedAtEpochMs: 1_001, offeredAtEpochMs: state === "queued" ? null : 1_500, offerExpiresAtEpochMs: state === "queued" ? null : 9_000, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease: state === "active" ? lease : null });
// Queued on create, offered on the second poll, active on claim.
function clientIn(directory) {
  let ledger = { schemaVersion: 1, tickets: {} }; let requestId; let polls = 0;
  return createAuthorityClient(configFor(path.join(directory, "authority-client-tickets-v1.json")), { sessionId, token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", readLedger: async () => structuredClone(ledger), writeLedger: async (next) => { ledger = structuredClone(next); }, wait: async () => {}, request: async (request) => {
    if (request.pathname === "/v1/health") return { status: 200, body: { schemaVersion: 1, protocolVersion: 2, authorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" } };
    if (request.pathname === "/v1/tickets") { requestId = request.body.requestId; return { status: 201, body: ticket(requestId, "queued", 1) }; }
    if (request.pathname === `/v1/tickets/${ticketId}`) return { status: 200, body: ++polls < 2 ? ticket(requestId, "queued", 1) : ticket(requestId, "offered", 2) };
    if (request.pathname === `/v1/tickets/${ticketId}/claim`) return { status: 200, body: ticket(requestId, "active", 3) };
    throw new Error(`unexpected request ${request.pathname}`);
  } });
}
const readLines = async (file) => { for (let attempt = 0; attempt < 100; attempt++) { const text = await fs.readFile(file, "utf8").catch(() => ""); if (text.endsWith("\n")) return text.trim().split("\n").map((line) => JSON.parse(line)); await new Promise((resolve) => setTimeout(resolve, 10)); } return []; };

test("acquire timing writes one line per acquisition only while the flag file exists", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "permit-timing-"));
  try {
    const paths = acquireTimingPaths(path.join(directory, "authority-client-tickets-v1.json"));
    // Flag off: the acquisition succeeds and leaves no log.
    const off = await clientIn(directory).acquire("anthropic-a");
    assert.equal(off.ticket.state, "active");
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(fs.stat(paths.log), { code: "ENOENT" });
    // Flag on: one line names each phase and the authority's offer-to-claim time.
    await fs.writeFile(paths.flag, "");
    const on = await clientIn(directory).acquire("anthropic-a");
    assert.equal(on.ticket.state, "active");
    const lines = await readLines(paths.log);
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.equal(line.provider, "anthropic-a"); assert.equal(line.outcome, "acquired"); assert.equal(line.polls, 2); assert.equal(line.offerToClaimMs, 2_500);
    assert.equal(line.spans["GET /v1/tickets/*"].n, 2); assert.equal(line.spans["POST /v1/tickets/*/claim"].n, 1); assert.equal(line.spans["POST /v1/tickets"].n, 1); assert.equal(line.spans["GET /v1/health"].n, 1);
    assert.equal(line.spans.wait.n, 2); assert.equal(line.spans.token.n, 5); assert.ok(line.spans.ledger.n >= 5);
    assert.equal(typeof line.seenToDoneMs, "number"); assert.equal(typeof line.timerLateMaxMs, "number");
    // No token or ticket identifier reaches the log.
    const raw = await fs.readFile(paths.log, "utf8"); assert.equal(raw.includes(ticketId), false); assert.equal(raw.includes("token-id"), false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
