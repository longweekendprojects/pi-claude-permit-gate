import "./clean-permit-environment.mjs";
// Retry state v2: one file per session, a synchronous critical section, and a token that never makes a request wait.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAuthorityClient, pruneSessionLedgers, sessionLedgerDirectory, sessionLedgerMutator, sessionLedgerPath } from "../index.ts";

const config = (statePath) => ({ mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", statePath, keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false, lanes: { "anthropic-a": { port: 8791, accountBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "anthropic-b": { port: 8792, accountBindingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "anthropic-c": { port: 8793, accountBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, "anthropic-d": { port: 8794, accountBindingId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } } });
const health = { schemaVersion: 1, protocolVersion: 2, authorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" };
const ticket = (id, requestId, state, revision, created) => ({ schemaVersion: 1, ticketId: id, requestId, provider: "anthropic-a", state, revision, createdAtEpochMs: created, enqueuedAtEpochMs: created, offeredAtEpochMs: created, offerExpiresAtEpochMs: created + 5_000, terminalAtEpochMs: state === "released" ? created + 10 : null, terminalReason: state === "released" ? "released" : null, queueAhead: 0, lease: state === "active" ? { leaseId: "55555555-5555-4555-8555-555555555555", generation: 1, claimedAtEpochMs: created, renewSequence: 0, renewByEpochMs: created + 30_000, serverDeadlineEpochMs: created + 60_000 } : null });
// A fake authority that grants at once and acknowledges completion.
function authority(seen = { authorizations: [] }) {
  const tickets = new Map();
  return { seen, request: async (request) => {
    seen.authorizations.push(request.authorization);
    if (request.pathname === "/v1/health") return { status: 200, body: health };
    if (request.pathname === "/v1/tickets") { const id = crypto.randomUUID(); const created = ticket(id, request.body.requestId, "active", 1, request.body.createdAtEpochMs); tickets.set(id, created); return { status: 201, body: created }; }
    const completion = request.pathname.match(/^\/v1\/tickets\/([^/]+)\/complete$/);
    if (completion) { const held = tickets.get(completion[1]); return { status: 200, body: ticket(completion[1], held.requestId, "released", held.revision + 1, held.createdAtEpochMs) }; }
    throw new Error(`unexpected authority request ${request.pathname}`);
  } };
}
const tokenValue = (name) => `${name}.${"a".repeat(43)}`;
async function scratch(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), "permit-session-ledger-")); t.after(() => fs.rm(directory, { recursive: true, force: true })); return path.join(directory, "authority-client-tickets-v1.json"); }
const uuid = () => crypto.randomUUID();

test("each session keeps its retry state in its own file, removed once nothing is outstanding", async (t) => {
  const statePath = await scratch(t); const first = uuid(); const second = uuid(); const { request } = authority();
  const clientA = createAuthorityClient(config(statePath), { sessionId: first, token: async () => tokenValue("t"), request });
  const clientB = createAuthorityClient(config(statePath), { sessionId: second, token: async () => tokenValue("t"), request });
  const [recordA, recordB] = await Promise.all([clientA.acquire("anthropic-a"), clientB.acquire("anthropic-a")]);
  const fileA = JSON.parse(await fs.readFile(sessionLedgerPath(statePath, first), "utf8")); const fileB = JSON.parse(await fs.readFile(sessionLedgerPath(statePath, second), "utf8"));
  assert.deepEqual(Object.keys(fileA.tickets), [`${first}:${recordA.requestId}`]); assert.deepEqual(Object.keys(fileB.tickets), [`${second}:${recordB.requestId}`]);
  assert.equal((await fs.stat(sessionLedgerPath(statePath, first))).mode & 0o777, 0o600);
  await clientA.complete(recordA);
  await assert.rejects(fs.stat(sessionLedgerPath(statePath, first)), { code: "ENOENT" });
  assert.ok(fsSync.existsSync(sessionLedgerPath(statePath, second)));
  // The shared v1 file is never written.
  await assert.rejects(fs.stat(statePath), { code: "ENOENT" });
});

test("a lock held by a stalled process on one session never delays another session", async (t) => {
  const statePath = await scratch(t); const stalled = uuid(); const healthy = uuid(); const { request } = authority();
  const lock = `${sessionLedgerPath(statePath, stalled)}.lock`; await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 }); await fs.mkdir(lock, { mode: 0o700 });
  const stalledClient = createAuthorityClient(config(statePath), { sessionId: stalled, token: async () => tokenValue("t"), request });
  const healthyClient = createAuthorityClient(config(statePath), { sessionId: healthy, token: async () => tokenValue("t"), request });
  let stalledDone = false; const stalledAcquire = stalledClient.acquire("anthropic-a").then((record) => { stalledDone = true; return record; });
  const started = performance.now(); await healthyClient.acquire("anthropic-a"); const healthyMs = performance.now() - started;
  assert.ok(healthyMs < 250, `healthy session waited ${healthyMs} ms`); assert.equal(stalledDone, false);
  await fs.rmdir(lock); const record = await stalledAcquire; assert.equal(record.ticket.state, "active");
});

test("the lock is never held across an event-loop turn", async (t) => {
  const statePath = await scratch(t); const key = uuid(); const mutate = sessionLedgerMutator(statePath, { flush: () => {} }); const lock = `${sessionLedgerPath(statePath, key)}.lock`;
  let seenHeld = false; let polling = true; const poll = () => { if (fsSync.existsSync(lock)) seenHeld = true; if (polling) setImmediate(poll); }; setImmediate(poll);
  for (let index = 0; index < 20; index++) await mutate(key, (ledger) => { ledger.tickets[`${key}:x`] = { provider: "anthropic-a", requestId: "x", sessionId: key, createdAtEpochMs: index }; });
  polling = false;
  assert.equal(seenHeld, false);
  assert.equal(JSON.parse(await fs.readFile(sessionLedgerPath(statePath, key), "utf8")).tickets[`${key}:x`].createdAtEpochMs, 19);
});

test("mutations of one session run in call order while the lock is contended", async (t) => {
  const statePath = await scratch(t); const key = uuid(); const mutate = sessionLedgerMutator(statePath, { flush: () => {} }); const lock = `${sessionLedgerPath(statePath, key)}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 }); await fs.mkdir(lock, { mode: 0o700 });
  // The first call has been waiting long enough to back off; later calls start polling fast just before the lock frees.
  const order = []; const call = (index) => mutate(key, (ledger) => { order.push(index); if (index % 2 === 0) ledger.tickets[`${key}:r`] = { provider: "anthropic-a", requestId: "r", sessionId: key, createdAtEpochMs: index }; else delete ledger.tickets[`${key}:r`]; });
  const pending = [call(0)]; await new Promise((resolve) => setTimeout(resolve, 150)); pending.push(call(1), call(2), call(3), call(4));
  await new Promise((resolve) => setTimeout(resolve, 3)); await fs.rmdir(lock); await Promise.all(pending);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
  assert.equal(JSON.parse(await fs.readFile(sessionLedgerPath(statePath, key), "utf8")).tickets[`${key}:r`].createdAtEpochMs, 4);
});

test("a lock still fresh past the wait budget fails the request as locked", async (t) => {
  const statePath = await scratch(t); const key = uuid(); const lock = `${sessionLedgerPath(statePath, key)}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 }); await fs.mkdir(lock, { mode: 0o700 });
  await assert.rejects(sessionLedgerMutator(statePath, { flush: () => {}, lockWaitMs: 100 })(key, () => {}), { message: "authority retry state is locked" });
});

test("a torn session file is discarded, and a file other users can read is refused", async (t) => {
  const statePath = await scratch(t); const torn = uuid(); const exposed = uuid(); const { request } = authority();
  await fs.mkdir(sessionLedgerDirectory(statePath), { recursive: true, mode: 0o700 });
  await fs.writeFile(sessionLedgerPath(statePath, torn), "{\"schemaVersion\":1,\"tick", { mode: 0o600 });
  const record = await createAuthorityClient(config(statePath), { sessionId: torn, token: async () => tokenValue("t"), request }).acquire("anthropic-a");
  assert.equal(record.ticket.state, "active");
  await fs.writeFile(sessionLedgerPath(statePath, exposed), "{\"schemaVersion\":1,\"tickets\":{}}", { mode: 0o644 }); await fs.chmod(sessionLedgerPath(statePath, exposed), 0o644);
  await assert.rejects(createAuthorityClient(config(statePath), { sessionId: exposed, token: async () => tokenValue("t"), request }).acquire("anthropic-a"), { message: "authority retry state is unavailable" });
});

test("an asynchronous mutation is refused without writing", async (t) => {
  const statePath = await scratch(t); const key = uuid(); const mutate = sessionLedgerMutator(statePath, { flush: () => {} });
  await assert.rejects(mutate(key, async (ledger) => { ledger.tickets.x = {}; }), { message: "authority retry state mutation must be synchronous" });
  await assert.rejects(fs.stat(sessionLedgerPath(statePath, key)), { code: "ENOENT" });
  assert.equal(fsSync.existsSync(`${sessionLedgerPath(statePath, key)}.lock`), false);
});

test("every write is handed to the background flush and the request does not wait for it", async (t) => {
  const statePath = await scratch(t); const key = uuid(); const flushed = []; const { request } = authority();
  const client = createAuthorityClient(config(statePath), { sessionId: key, token: async () => tokenValue("t"), request, flushLedger: (file) => flushed.push(file) });
  const record = await client.acquire("anthropic-a"); await client.complete(record);
  assert.ok(flushed.length >= 2); assert.ok(flushed.every((file) => file === sessionLedgerPath(statePath, key)));
});

test("pruning removes session files untouched for a day and keeps fresh ones", async (t) => {
  const statePath = await scratch(t); const directory = sessionLedgerDirectory(statePath); await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const old = sessionLedgerPath(statePath, uuid()); const fresh = sessionLedgerPath(statePath, uuid()); const unrelated = path.join(directory, "notes.txt");
  for (const file of [old, fresh, unrelated]) await fs.writeFile(file, "{}", { mode: 0o600 });
  const dayAgo = new Date(Date.now() - 25 * 60 * 60_000); await fs.utimes(old, dayAgo, dayAgo); await fs.utimes(unrelated, dayAgo, dayAgo);
  assert.equal(await pruneSessionLedgers(statePath), 1);
  assert.equal(fsSync.existsSync(old), false); assert.ok(fsSync.existsSync(fresh)); assert.ok(fsSync.existsSync(unrelated));
});

test("the token is read once for concurrent requests, and an aging token is refreshed without making a request wait", async (t) => {
  const statePath = await scratch(t); const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset; t.after(() => { Date.now = realNow; });
  let reads = 0; let release; const gate = new Promise((resolve) => { release = resolve; }); let blockReads = false;
  const token = async () => { reads++; const value = tokenValue(`t${reads}`); if (blockReads) await gate; return value; };
  const seen = { authorizations: [] }; const { request } = authority(seen);
  const client = createAuthorityClient(config(statePath), { sessionId: uuid(), token, request });
  client.prefetch(); const first = await client.acquire("anthropic-a"); await client.complete(first);
  assert.equal(reads, 1);
  // Eight minutes on, the kept token is past half its life: the request uses it at once while a fresh read runs behind it.
  offset = 8 * 60_000; blockReads = true;
  const second = await client.acquire("anthropic-a"); await client.complete(second);
  assert.equal(reads, 2); assert.ok(seen.authorizations.every((value) => value === `Bearer ${tokenValue("t1")}`));
  release(); await new Promise((resolve) => setTimeout(resolve, 10));
  const third = await client.acquire("anthropic-a"); await client.complete(third);
  assert.equal(seen.authorizations.at(-1), `Bearer ${tokenValue("t2")}`); assert.equal(reads, 2);
});

test("CLAUDE_PERMIT_GATE_SESSION_LEDGER=0 keeps the shared v1 file", async (t) => {
  const statePath = await scratch(t); const key = uuid(); const { request } = authority();
  const record = await createAuthorityClient(config(statePath), { sessionId: key, sessionLedger: false, token: async () => tokenValue("t"), request }).acquire("anthropic-a");
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(statePath, "utf8")).tickets), [`${key}:${record.requestId}`]);
  await assert.rejects(fs.stat(sessionLedgerPath(statePath, key)), { code: "ENOENT" });
});

test("a lock path that cannot be removed waits out the budget instead of spinning", async (t) => {
  const statePath = await scratch(t); const key = uuid(); const lock = `${sessionLedgerPath(statePath, key)}.lock`;
  await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 }); await fs.writeFile(lock, "not a directory"); const old = new Date(Date.now() - 120_000); await fs.utimes(lock, old, old);
  let ticks = 0; const ticker = setInterval(() => { ticks++; }, 10);
  await assert.rejects(sessionLedgerMutator(statePath, { flush: () => {}, lockWaitMs: 200 })(key, () => {}), { message: "authority retry state is locked" });
  clearInterval(ticker); assert.ok(ticks >= 5, `event loop ran ${ticks} timer ticks`);
});

test("a refused token is read afresh even while an older background read is still running", async (t) => {
  const statePath = await scratch(t); const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset; t.after(() => { Date.now = realNow; });
  let reads = 0; let releaseStale; const stale = new Promise((resolve) => { releaseStale = resolve; }); let accepted = tokenValue("t1");
  const token = async () => { reads++; if (reads === 1) return tokenValue("t1"); if (reads === 2) { await stale; return tokenValue("t1"); } return tokenValue("t2"); };
  const seen = { authorizations: [] }; const base = authority(seen);
  const request = async (input) => input.authorization === `Bearer ${accepted}` ? base.request(input) : { status: 401, body: { error: { code: "unauthenticated", message: "bearer is unavailable" } } };
  const client = createAuthorityClient(config(statePath), { sessionId: uuid(), token, request });
  await client.complete(await client.acquire("anthropic-a"));
  offset = 8 * 60_000; await client.complete(await client.acquire("anthropic-a")); assert.equal(reads, 2);
  // The token rotates while the background read that began before the rotation is still running.
  accepted = tokenValue("t2");
  await client.complete(await client.acquire("anthropic-a")); assert.equal(reads, 3);
  releaseStale(); await new Promise((resolve) => setTimeout(resolve, 10));
  const before = seen.authorizations.length; await client.complete(await client.acquire("anthropic-a"));
  assert.ok(seen.authorizations.slice(before).every((value) => value === `Bearer ${tokenValue("t2")}`));
});

test("pruning leaves a day-old session file alone while its session holds the lock", async (t) => {
  const statePath = await scratch(t); await fs.mkdir(sessionLedgerDirectory(statePath), { recursive: true, mode: 0o700 });
  const file = sessionLedgerPath(statePath, uuid()); await fs.writeFile(file, "{}", { mode: 0o600 }); const dayAgo = new Date(Date.now() - 25 * 60 * 60_000); await fs.utimes(file, dayAgo, dayAgo); await fs.mkdir(`${file}.lock`);
  assert.equal(await pruneSessionLedgers(statePath), 0); assert.ok(fsSync.existsSync(file));
});

test("an acquisition trace names the ledger it used", async (t) => {
  const statePath = await scratch(t); const { request } = authority(); await fs.writeFile(path.join(path.dirname(statePath), "acquire-timing.on"), "");
  await createAuthorityClient(config(statePath), { sessionId: uuid(), token: async () => tokenValue("t"), request }).acquire("anthropic-a");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(JSON.parse((await fs.readFile(path.join(path.dirname(statePath), "acquire-timing.jsonl"), "utf8")).trim()).ledger, "v2");
});
