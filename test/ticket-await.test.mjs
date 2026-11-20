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
  // Once released for shutdown, a late call is answered at once instead of holding the shutdown up.
  const started = Date.now();
  assert.equal((await gate.authority.awaitTicket(principal, waiter.ticketId, awaitBody(waiter.revision, { waitMs: 25_000 }))).state, "queued");
  assert.ok(Date.now() - started < 1_000);
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

test("an await call answered at once with nothing new does not make the client spin", async (t) => {
  const gate = await lane(t);
  const link = transport(gate);
  const first = client(gate, link, 1); const second = client(gate, link, 2, { awaitMs: 0 });
  const stop = stopper(t); const held = await first.acquire("anthropic-a");
  const waiting = second.acquire("anthropic-a", stop);
  await delay(300);
  const awaits = link.calls.filter((call) => call === "POST /v1/tickets/*/await").length;
  assert.ok(awaits > 2 && awaits < 40, `saw ${awaits} await calls in 300 ms`);
  await first.complete(held);
  await second.complete(await waiting);
});

test("an acquisition aborted after its slot was claimed releases the lease, even when the cancel finds it claimed", async (t) => {
  const gate = await lane(t);
  const link = transport(gate);
  const first = client(gate, link, 1);
  const held = await first.acquire("anthropic-a");
  const controller = new AbortController();
  let queuedSnapshot; let staleGets = 0;
  // The await reply that carries the claimed lease is lost to the abort, and the first read in the
  // cleanup still sees the queued ticket, so the cleanup tries to cancel a ticket that now holds a lease.
  const lossy = async (input) => {
    if (input.pathname.endsWith("/await")) { const reply = await link.request({ ...input, signal: undefined }); controller.abort(); const error = new Error("aborted"); error.name = "AbortError"; void reply; throw error; }
    if (input.method === "GET" && /\/v1\/tickets\/[0-9a-f-]{36}$/.test(input.pathname) && controller.signal.aborted && staleGets++ === 0) return { status: 200, body: queuedSnapshot };
    const reply = await link.request(input);
    if (input.method === "POST" && input.pathname === "/v1/tickets" && reply.body.state === "queued") queuedSnapshot = reply.body;
    return reply;
  };
  const second = client(gate, { request: lossy }, 2);
  const waiting = second.acquire("anthropic-a", controller.signal);
  await delay(50);
  await first.complete(held);
  await assert.rejects(waiting, { name: "AbortError" });
  const health = gate.authority.health({ instanceId: uuid(9), buildId: "test" });
  assert.equal(health.active + health.offered, 0);
});

// The health answer is kept per lane, so only the first acquisition in a window pays its round trip.
const healthCalls = (link) => link.calls.filter((call) => call === "GET /v1/health").length;
const cycle = async (instance) => { const held = await instance.acquire("anthropic-a"); assert.equal(held.ticket.state, "active"); await instance.complete(held); };
// Moves Date.now for the client and the lane together, so a test covers minutes of outage or cache age without waiting.
const clock = (t) => { const real = Date.now; let skew = 0; Date.now = () => real() + skew; t.after(() => { Date.now = real; }); return { advance: (ms) => { skew += ms; } }; };

test("a client asks a lane for its health once across acquisitions, again after healthCacheMs, and every time when it is 0", async (t) => {
  const kept = await lane(t); const keptLink = transport(kept); const keeping = client(kept, keptLink, 1);
  await cycle(keeping); await cycle(keeping); await cycle(keeping);
  assert.equal(healthCalls(keptLink), 1);
  assert.equal(keptLink.calls.filter((call) => call === "POST /v1/tickets").length, 3);
  const time = clock(t); const brief = await lane(t); const briefLink = transport(brief); const expiring = client(brief, briefLink, 2, { healthCacheMs: 60_000 });
  await cycle(expiring); time.advance(59_000); await cycle(expiring);
  assert.equal(healthCalls(briefLink), 1);
  time.advance(1_100); await cycle(expiring);
  assert.equal(healthCalls(briefLink), 2);
  const off = await lane(t); const offLink = transport(off); const asking = client(off, offLink, 3, { healthCacheMs: 0 });
  await cycle(asking); await cycle(asking);
  assert.equal(healthCalls(offLink), 2);
});

test("an acquisition that fails drops the kept health answer, and an invalid answer is never kept", async (t) => {
  const gate = await lane(t); const link = transport(gate);
  let refuseCreate = false; let wrongAuthority = false;
  const request = async (input) => {
    if (refuseCreate && input.method === "POST" && input.pathname === "/v1/tickets") { link.calls.push("POST /v1/tickets"); return { status: 400, body: { error: { code: "invalid_request", message: "create refused" } } }; }
    const reply = await link.request(input);
    return wrongAuthority && input.pathname === "/v1/health" ? { ...reply, body: { ...reply.body, authorityId: uuid(99) } } : reply;
  };
  const instance = client(gate, link, 1, { request });
  await cycle(instance);
  assert.equal(healthCalls(link), 1);
  refuseCreate = true;
  await assert.rejects(instance.acquire("anthropic-a"), /create refused/);
  assert.equal(healthCalls(link), 1);
  refuseCreate = false; wrongAuthority = true;
  await assert.rejects(instance.acquire("anthropic-a"), /authority health identity is invalid/);
  assert.equal(healthCalls(link), 2);
  wrongAuthority = false;
  await cycle(instance);
  assert.equal(healthCalls(link), 3);
  await cycle(instance);
  assert.equal(healthCalls(link), 3);
});

test("a kept health answer that names ticket-await still polls and claims once the lane has lost the await route", async (t) => {
  const gate = await lane(t); const link = transport(gate);
  let awaitGone = false;
  const request = async (input) => {
    if (awaitGone && input.method === "POST" && input.pathname.endsWith("/await")) { link.calls.push("POST /v1/tickets/*/await"); return { status: 404, body: { error: { code: "not_found", message: "authority route is unavailable" } } }; }
    return link.request(input);
  };
  const first = client(gate, link, 1); const second = client(gate, link, 2, { request });
  await cycle(second);
  assert.equal(healthCalls(link), 1);
  const stop = stopper(t); const held = await first.acquire("anthropic-a");
  awaitGone = true; link.calls.length = 0;
  const waiting = second.acquire("anthropic-a", stop);
  await delay(50);
  await first.complete(held);
  const acquired = await waiting;
  assert.equal(acquired.ticket.state, "active");
  assert.equal(healthCalls(link), 0, "the waiting client used its kept answer");
  assert.equal(link.calls.filter((call) => call === "POST /v1/tickets/*/await").length, 1);
  assert.ok(link.calls.includes("GET /v1/tickets/*"));
  await second.complete(acquired);
});

test("a create left unanswered through an outage longer than the authority's request window is sent again with a fresh identity", async (t) => {
  const time = clock(t); const gate = await lane(t); const link = transport(gate);
  let down = false; let waited = 0;
  const request = async (input) => { if (down) { link.calls.push(`${input.method} unreachable`); throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); } return link.request(input); };
  const wait = async (ms) => { time.advance(ms); waited += ms; if (waited >= 32_000) down = false; };
  const instance = client(gate, link, 1, { request, wait });
  await cycle(instance);
  assert.equal(healthCalls(link), 1);
  const firstId = Object.values(instance.ledger().tickets).map((record) => record.requestId);
  down = true; link.calls.length = 0;
  const held = await instance.acquire("anthropic-a");
  assert.equal(held.ticket.state, "active");
  assert.ok(waited >= 32_000, "the acquisition waited through the outage");
  assert.equal(link.calls[0], "POST unreachable", "the create went out first, under the kept answer");
  assert.equal(healthCalls(link), 1, "the lane was asked again once it answered");
  assert.equal(link.calls.filter((call) => call === "POST /v1/tickets").length, 2, "the aged create was refused, then sent with a fresh identity");
  assert.ok(!firstId.includes(held.requestId));
  await instance.complete(held);
  const health = gate.authority.health({ instanceId: uuid(9), buildId: "test" });
  assert.equal(health.active + health.offered + health.queued, 0);
});

test("a create the authority refuses as invalid is not sent again when no earlier attempt went unanswered", async (t) => {
  const time = clock(t); const gate = await lane(t); const link = transport(gate);
  let waited = 0;
  // 503 replies without an error body keep the identity, as a lost reply does, until the timestamp is past the window.
  const request = async (input) => { if (waited < 32_000 && input.method === "POST" && input.pathname === "/v1/tickets") { link.calls.push("POST refused"); return { status: 503, headers: {}, body: {} }; } return link.request(input); };
  const wait = async (ms) => { time.advance(ms); waited += ms; };
  const instance = client(gate, link, 1, { request, wait, healthCacheMs: 0 });
  await assert.rejects(instance.acquire("anthropic-a"), /request rejected/);
  assert.equal(link.calls.filter((call) => call === "POST /v1/tickets").length, 1);
  assert.equal(healthCalls(link), 1, "a health answer asked for by this acquisition is not asked for again");
});

test("a lane that starts draining under a kept health answer fails the acquisition at once, as it did when every acquisition asked first", async (t) => {
  const gate = await lane(t); const link = transport(gate);
  const instance = client(gate, link, 1);
  await cycle(instance);
  assert.equal(healthCalls(link), 1);
  await gate.authority.drain();
  await assert.rejects(instance.acquire("anthropic-a"), /authority health identity is invalid/);
  assert.equal(healthCalls(link), 2);
  assert.equal(link.calls.filter((call) => call === "POST /v1/tickets").length, 2, "one refused create, then the health answer decided");
  assert.deepEqual(instance.ledger().tickets, {});
});

test("a kept health answer is asked for again after a failed create, but not after a refusal by a ready lane", async (t) => {
  const gate = await lane(t); const link = transport(gate);
  let reply; let times = 1;
  const request = async (input) => { if (reply && input.method === "POST" && input.pathname === "/v1/tickets") { const sent = reply; if (--times <= 0) reply = undefined; link.calls.push(`POST ${sent.status}`); return sent; } return link.request(input); };
  const instance = client(gate, link, 1, { request });
  await cycle(instance);
  assert.equal(healthCalls(link), 1);
  reply = { status: 429, body: { error: { code: "principal_limit", message: "principal ticket limit reached" } } };
  await cycle(instance);
  assert.equal(healthCalls(link), 1, "a 429 comes from a ready lane");
  reply = { status: 503, body: { error: { code: "authority_starting", message: "authority is starting" } } }; times = 3;
  await cycle(instance);
  assert.equal(link.calls.filter((call) => call === "POST 503").length, 3);
  assert.equal(healthCalls(link), 2, "the first 503 asks the lane again, and later ones do not");
  await cycle(instance);
  assert.equal(healthCalls(link), 2, "and the new answer is kept");
});
