// A fake authority for the token cache tests. It is its own module so a child process can import it without running tests.
import path from "node:path";
import { createAuthorityClient } from "../index.ts";

const sessionId = "88888888-8888-4888-8888-888888888888"; const ticketId = "77777777-7777-4777-8777-777777777777";
const configFor = (statePath) => ({ mode: "authority-client", origin: "https://authority.example", expectedAuthorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", installationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", statePath, keychain: { permitMutate: { service: "test", account: "permit" }, snapshotRead: { service: "test", account: "snapshot" }, allowancePublish: { service: "test", account: "allowance" } }, monitorSource: "authority", publisherEnabled: false, lanes: { "anthropic-a": { port: 8791, accountBindingId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, "anthropic-b": { port: 8792, accountBindingId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }, "anthropic-c": { port: 8793, accountBindingId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }, "anthropic-d": { port: 8794, accountBindingId: "ffffffff-ffff-4fff-8fff-ffffffffffff" } } });
const lease = { leaseId: "55555555-5555-4555-8555-555555555555", generation: 1, claimedAtEpochMs: 4_000, renewSequence: 0, renewByEpochMs: 5_000, serverDeadlineEpochMs: 6_000 };
const ticket = (requestId, state, revision) => ({ schemaVersion: 1, ticketId, requestId, provider: "anthropic-a", state, revision, createdAtEpochMs: 1_000, enqueuedAtEpochMs: 1_001, offeredAtEpochMs: state === "queued" ? null : 1_500, offerExpiresAtEpochMs: state === "queued" ? null : 9_000, terminalAtEpochMs: null, terminalReason: null, queueAhead: 0, lease: state === "active" ? lease : null });
export const tokenOf = (name) => `${name}.${"a".repeat(43)}`;
// The authority's own refusal body: every refusal says "request rejected", whatever its cause.
const refused = { status: 401, body: { schemaVersion: 1, error: { code: "unauthenticated", message: "request rejected", retryable: false, retryAfterMs: null } } };

// A fake authority that accepts one bearer: queued on create, offered on the second poll, active on claim.
export function harness(directory, { accepts, reads, token, onRequest }) {
  let ledger = { schemaVersion: 1, tickets: {} }; let requestId; let polls = 0;
  const seen = { tokenReads: 0, requests: [], refusals: 0 };
  const client = createAuthorityClient(configFor(path.join(directory, "authority-client-tickets-v1.json")), { sessionId, token: token ?? (async () => { const value = reads[Math.min(seen.tokenReads, reads.length - 1)]; seen.tokenReads++; return value; }), readLedger: async () => structuredClone(ledger), writeLedger: async (next) => { ledger = structuredClone(next); }, wait: async () => {}, request: async (request) => {
    const line = `${request.method} ${request.pathname}`; seen.requests.push(line);
    const accepted = typeof accepts === "function" ? accepts() : accepts;
    if (request.authorization !== `Bearer ${accepted}`) { seen.refusals++; return refused; }
    onRequest?.(line);
    if (request.pathname === "/v1/health") return { status: 200, body: { schemaVersion: 1, protocolVersion: 2, authorityId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", instanceId: "33333333-3333-4333-8333-333333333333", provider: "anthropic-a", port: 8791, stateSchemaVersion: 2, status: "ready" } };
    if (request.pathname === "/v1/tickets") { requestId = request.body.requestId; return { status: 201, body: ticket(requestId, "queued", 1) }; }
    if (request.pathname === `/v1/tickets/${ticketId}`) return { status: 200, body: ++polls < 2 ? ticket(requestId, "queued", 1) : ticket(requestId, "offered", 2) };
    if (request.pathname === `/v1/tickets/${ticketId}/claim`) return { status: 200, body: ticket(requestId, "active", 3) };
    throw new Error(`unexpected request ${request.pathname}`);
  } });
  return { client, seen };
}
