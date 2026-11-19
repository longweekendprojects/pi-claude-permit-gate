import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuthorityError, authorityErrorBody, openAuthorityState } from "../authority-state.mjs";
import { createAuthorityClient } from "../index.ts";

const TIMING = Object.freeze({ offerTtlMs: 5_000, renewIntervalMs: 5_000, renewDeadlineMs: 15_000, terminalRetentionMs: 86_400_000 });
const AUTHORITY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const INSTALLATION = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BINDING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const principal = { installationId: INSTALLATION, accountBindingId: BINDING, providers: ["anthropic-a"] };
const uuid = (value) => { const hex = Number(value).toString(16).padStart(8, "0"); return `${hex}-0000-4000-8000-${hex.padStart(12, "0")}`; };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function lane(t, { concurrency = 1 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "permit-await-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = { statePath: path.join(directory, "lane.json"), provider: "anthropic-a", port: 8791, authorityId: AUTHORITY_ID, clock: () => Date.now(), timing: TIMING, minimumConcurrency: 1, maximumConcurrency: concurrency, currentConcurrency: concurrency };
  const gate = { directory, authority: openAuthorityState({ ...base, bootstrap: true }) };
  gate.restart = () => { gate.authority = openAuthorityState({ ...base, bootstrap: false }); return gate.authority; };
  return gate;
}
const create = (session, request) => ({ schemaVersion: 1, provider: "anthropic-a", accountBindingId: BINDING, installationId: INSTALLATION, sessionId: uuid(session), requestId: uuid(request), createdAtEpochMs: Date.now() });
const mutation = (operation, revision, extra = {}) => ({ schemaVersion: 1, operationId: uuid(operation), expectedRevision: revision, installationId: INSTALLATION, provider: "anthropic-a", accountBindingId: BINDING, ...extra });
const awaitBody = (afterRevision, { waitMs = 2_000, claim = true } = {}) => ({ schemaVersion: 1, installationId: INSTALLATION, provider: "anthropic-a", accountBindingId: BINDING, afterRevision, waitMs, claim });
const release = (authority, ticket, operation) => authority.mutateTicket(principal, ticket.ticketId, "complete", mutation(operation, ticket.revision, { leaseId: ticket.lease.leaseId, generation: ticket.lease.generation, outcome: "released", reason: null }));

test("a create sent with claim-on-offer comes back holding the lease when a slot is free, and plain creates are unchanged", async (t) => {
  const gate = await lane(t, { concurrency: 2 });
  const body = create(1, 1);
  const claimed = await gate.authority.createTicket(principal, body, { claimOnOffer: true });
  assert.equal(claimed.ticket.state, "active"); assert.equal(claimed.ticket.revision, 3); assert.ok(claimed.ticket.lease);
  const replay = await gate.authority.createTicket(principal, body, { claimOnOffer: true });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.ticket, claimed.ticket);
  const plain = await gate.authority.createTicket(principal, create(2, 2));
  assert.equal(plain.ticket.state, "offered");
  // A full lane queues the claiming create like any other.
  const queued = await gate.authority.createTicket(principal, create(3, 3), { claimOnOffer: true });
  assert.equal(queued.ticket.state, "queued");
  // The stored state, including a create reply that holds a lease, reopens.
  gate.restart();
  assert.equal(gate.authority.getTicket(principal, claimed.ticket.ticketId).state, "active");
});

test("an await call with claim gets its ticket back already holding the lease in the commit that frees the slot", async (t) => {
  const gate = await lane(t);
  const holder = (await gate.authority.createTicket(principal, create(1, 1), { claimOnOffer: true })).ticket;
  const waiter = (await gate.authority.createTicket(principal, create(2, 2))).ticket;
  assert.equal(waiter.state, "queued");
  const pending = gate.authority.awaitTicket(principal, waiter.ticketId, awaitBody(waiter.revision));
  await delay(20);
  assert.equal(gate.authority.awaiterCount, 1);
  await release(gate.authority, holder, 10);
  const result = await pending;
  assert.equal(result.state, "active"); assert.equal(result.revision, waiter.revision + 2); assert.ok(result.lease);
  assert.equal(gate.authority.awaiterCount, 0);
  // The committed state never held the slot as an unclaimed offer.
  assert.equal(gate.authority.health({ instanceId: uuid(9), buildId: "test" }).offered, 0);
});

test("an await call without claim returns the offer for the client to claim", async (t) => {
  const gate = await lane(t);
  const holder = (await gate.authority.createTicket(principal, create(1, 1), { claimOnOffer: true })).ticket;
  const waiter = (await gate.authority.createTicket(principal, create(2, 2))).ticket;
  const pending = gate.authority.awaitTicket(principal, waiter.ticketId, awaitBody(waiter.revision, { claim: false }));
  await release(gate.authority, holder, 10);
  assert.equal((await pending).state, "offered");
});

test("an await call that times out or is dropped leaves no claim behind", async (t) => {
  const gate = await lane(t);
  const holder = (await gate.authority.createTicket(principal, create(1, 1), { claimOnOffer: true })).ticket;
  const waiter = (await gate.authority.createTicket(principal, create(2, 2))).ticket;
  const timedOut = await gate.authority.awaitTicket(principal, waiter.ticketId, awaitBody(waiter.revision, { waitMs: 30 }));
  assert.equal(timedOut.state, "queued"); assert.equal(timedOut.revision, waiter.revision);
  const dropped = new AbortController();
  const pending = gate.authority.awaitTicket(principal, waiter.ticketId, awaitBody(waiter.revision), { signal: dropped.signal });
  dropped.abort();
  assert.equal((await pending).state, "queued");
  assert.equal(gate.authority.awaiterCount, 0);
  await release(gate.authority, holder, 10);
  // Nobody is attached, so the slot is only offered and expires on its own if the client never returns.
  assert.equal(gate.authority.getTicket(principal, waiter.ticketId).state, "offered");
});

test("an await call with claim takes an offer that is already waiting, and returns a changed ticket at once", async (t) => {
  const gate = await lane(t);
  const offered = (await gate.authority.createTicket(principal, create(1, 1))).ticket;
  assert.equal(offered.state, "offered");
  const claimed = await gate.authority.awaitTicket(principal, offered.ticketId, awaitBody(1));
  assert.equal(claimed.state, "active");
  const stale = await gate.authority.awaitTicket(principal, offered.ticketId, awaitBody(1, { waitMs: 25_000 }));
  assert.equal(stale.revision, claimed.revision);
});

test("open await calls are answered when the lane releases them, and malformed or foreign calls are refused", async (t) => {
  const gate = await lane(t);
  await gate.authority.createTicket(principal, create(1, 1), { claimOnOffer: true });
  const waiter = (await gate.authority.createTicket(principal, create(2, 2))).ticket;
  const pending = gate.authority.awaitTicket(principal, waiter.ticketId, awaitBody(waiter.revision, { waitMs: 25_000 }));
  gate.authority.releaseAwaiters();
  assert.equal((await pending).state, "queued");
  assert.throws(() => gate.authority.awaitTicket(principal, waiter.ticketId, awaitBody(waiter.revision, { waitMs: 25_001 })), (error) => error instanceof AuthorityError && error.code === "invalid_request");
  const stranger = { installationId: uuid(77), accountBindingId: BINDING, providers: ["anthropic-a"] };
  assert.throws(() => gate.authority.awaitTicket(stranger, waiter.ticketId, { ...awaitBody(waiter.revision), installationId: uuid(77) }), (error) => error instanceof AuthorityError && error.code === "not_found");
});

// The real client against the real lane state, joined by an in-process transport that mimics the daemon routes.
function transport(gate, { advertiseAwait = true, honourClaimHeader = true, awaitRoute = true } = {}) {
  const calls = [];
  const request = async ({ method, pathname, body, headers, signal }) => {
    calls.push(`${method} ${pathname.replace(/[0-9a-f-]{36}/, "*")}`);
    try {
      if (method === "GET" && pathname === "/v1/health") {
        const health = gate.authority.health({ instanceId: uuid(9), buildId: "test" });
        return { status: 200, body: advertiseAwait ? health : { ...health, capabilities: ["tickets", "snapshot", "allowance"] } };
      }
      if (method === "POST" && pathname === "/v1/tickets") {
        const result = await gate.authority.createTicket(principal, body, { claimOnOffer: honourClaimHeader && headers?.["x-permit-claim-on-offer"] === "1" });
        return { status: result.created ? 201 : 200, body: result.ticket };
      }
      const awaited = pathname.match(/^\/v1\/tickets\/([0-9a-f-]{36})\/await$/);
      if (method === "POST" && awaited) {
        if (!awaitRoute) throw new AuthorityError("not_found", { message: "authority route is unavailable" });
        const held = gate.authority.awaitTicket(principal, awaited[1], body, { signal });
        const aborted = new Promise((_, reject) => signal?.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }, { once: true }));
        return { status: 200, body: await Promise.race([held, aborted]) };
      }
      const ticket = pathname.match(/^\/v1\/tickets\/([0-9a-f-]{36})(?:\/(claim|cancel|renew|complete))?$/);
      if (method === "GET" && ticket) return { status: 200, body: gate.authority.getTicket(principal, ticket[1]) };
      if (method === "POST" && ticket) return { status: 200, body: (await gate.authority.mutateTicket(principal, ticket[1], ticket[2], body)).ticket };
      throw new Error(`unexpected ${method} ${pathname}`);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const reply = authorityErrorBody(error);
      return { status: reply.status, body: reply.body };
    }
  };
  return { calls, request };
}
const config = (directory) => ({ mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: AUTHORITY_ID, installationId: INSTALLATION, statePath: path.join(directory, "tickets.json"), keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false, lanes: { "anthropic-a": { port: 8791, accountBindingId: BINDING }, "anthropic-b": { port: 8792, accountBindingId: uuid(12) }, "anthropic-c": { port: 8793, accountBindingId: uuid(13) }, "anthropic-d": { port: 8794, accountBindingId: uuid(14) } } });
// A failed assertion must not leave an acquisition waiting forever and hold the test process open.
const stopper = (t) => { const controller = new AbortController(); t.after(() => controller.abort()); return controller.signal; };
function client(gate, link, session, options = {}) {
  let ledger = { schemaVersion: 1, tickets: {} };
  const writes = { count: 0 };
  const instance = createAuthorityClient(config(gate.directory), { sessionId: uuid(session), token: async () => "token-id.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", mutateLedger: async (mutation) => { const next = structuredClone(ledger); await mutation(next); ledger = next; writes.count++; }, wait: (ms) => delay(Math.min(ms, 20)), request: link.request, ...options });
  return Object.assign(instance, { writes, ledger: () => ledger });
}

test("a client takes a free slot in one create and waits for a busy one on a single held call, with no claim or poll", async (t) => {
  const gate = await lane(t);
  const link = transport(gate);
  const first = client(gate, link, 1); const second = client(gate, link, 2);
  const stop = stopper(t); const held = await first.acquire("anthropic-a");
  assert.equal(held.ticket.state, "active");
  assert.deepEqual(link.calls, ["GET /v1/health", "POST /v1/tickets"]);
  link.calls.length = 0;
  const waiting = second.acquire("anthropic-a", stop);
  await delay(50);
  assert.deepEqual(link.calls, ["GET /v1/health", "POST /v1/tickets", "POST /v1/tickets/*/await"]);
  await first.complete(held);
  const acquired = await waiting;
  assert.equal(acquired.ticket.state, "active");
  assert.equal(link.calls.filter((call) => call.endsWith("/claim") || call === "GET /v1/tickets/*").length, 0);
  await second.complete(acquired);
  assert.equal(gate.authority.health({ instanceId: uuid(9), buildId: "test" }).active, 0);
});

test("a client facing a lane without ticket-await, or with the await route gone, polls and claims as before", async (t) => {
  for (const variant of [{ advertiseAwait: false, honourClaimHeader: false }, { awaitRoute: false }]) {
    const gate = await lane(t);
    const link = transport(gate, variant);
    const first = client(gate, link, 1); const second = client(gate, link, 2);
    const stop = stopper(t); const held = await first.acquire("anthropic-a");
    const waiting = second.acquire("anthropic-a", stop);
    await delay(50);
    await first.complete(held);
    const acquired = await waiting;
    assert.equal(acquired.ticket.state, "active");
    assert.ok(link.calls.includes("GET /v1/tickets/*"), JSON.stringify(variant));
    if (variant.honourClaimHeader === false) assert.ok(link.calls.includes("POST /v1/tickets/*/claim"));
    await second.complete(acquired);
  }
});

test("polling saves the ticket only when it changes", async (t) => {
  const gate = await lane(t);
  const link = transport(gate, { advertiseAwait: false });
  const first = client(gate, link, 1); const second = client(gate, link, 2);
  const stop = stopper(t); const held = await first.acquire("anthropic-a");
  const waiting = second.acquire("anthropic-a", stop);
  await delay(300);
  const polls = link.calls.filter((call) => call === "GET /v1/tickets/*").length;
  assert.ok(polls >= 5, `expected several polls, saw ${polls}`);
  // One write to create the record and one to store the queued ticket; unchanged polls add none.
  assert.equal(second.writes.count, 2);
  await first.complete(held);
  await second.complete(await waiting);
});

test("an acquisition aborted while its create is in flight releases the lease the create may have taken", async (t) => {
  const gate = await lane(t);
  const link = transport(gate);
  const controller = new AbortController();
  let cut = false;
  // The first create reaches the lane and takes the slot, but its reply is lost to the abort.
  const slowRequest = async (input) => { if (!cut && input.method === "POST" && input.pathname === "/v1/tickets") { cut = true; const reply = await link.request({ ...input, signal: undefined }); controller.abort(); const error = new Error("aborted"); error.name = "AbortError"; throw Object.assign(error, { reply }); } return link.request(input); };
  const lost = client(gate, { request: slowRequest }, 1);
  await assert.rejects(lost.acquire("anthropic-a", controller.signal), { name: "AbortError" });
  assert.equal(link.calls.filter((call) => call === "POST /v1/tickets").length, 2);
  const health = gate.authority.health({ instanceId: uuid(9), buildId: "test" });
  assert.equal(health.active + health.offered, 0);
});
