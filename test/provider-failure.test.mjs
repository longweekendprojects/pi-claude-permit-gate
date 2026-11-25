import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MODEL_ID_PATTERN, providerFailure, providerOverload, warmFailure } from "../index.ts";
import { MODEL_ID_PATTERN as AUTHORITY_MODEL_ID_PATTERN } from "../authority-state.mjs";

// An overload on one model paused the whole account lane for a minute after every failure, so the
// overloaded model's retries kept healthy models on the same account to one request per minute.
test("an overload does not throttle the lane, but a rate limit does", () => {
  const failed = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });
  assert.equal(providerFailure(failed('{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}')), undefined);
  assert.equal(providerFailure(failed("529 Overloaded")), undefined);
  assert.equal(providerFailure(failed('{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}')), "rate-limit");
});

// Once an account used up its weekly Fable allowance, every Fable request got a 429 that asked for a
// wait of about four days. Each one halved the lane's limit, so Opus on the same account queued too.
// Fewer concurrent requests cannot help a used-up allowance, so only a short-wait 429 throttles.
test("a 429 that asks for a wait of hours or days does not throttle the lane", () => {
  const failed = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });
  const exhausted = 'Server requested 377113s retry delay (max: 120s). 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_011ChP9x2AozTzagDspdNJ9Q"}';
  assert.equal(providerFailure(failed(exhausted)), undefined);
  assert.equal(providerFailure(failed(exhausted.replace("377113s", "301s"))), undefined);
  assert.equal(providerFailure(failed(exhausted.replace("377113s", "300s"))), "rate-limit");
  assert.equal(warmFailure(429, { "retry-after": "377113" }), undefined);
  assert.equal(warmFailure(429, { "retry-after": "30" }), "rate-limit");
  assert.equal(warmFailure(429, {}), "rate-limit");
  assert.equal(warmFailure(429, undefined), "rate-limit");
  assert.equal(warmFailure(200, {}), undefined);
});

test("an overloaded reply names its model for the lane monitor, and nothing else does", () => {
  const incident = { role: "assistant", provider: "anthropic-c", model: "claude-fable-5-2", stopReason: "error", errorMessage: '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011ChP3f1L2ttp2i1qUr8Bm6"            }' };
  assert.equal(providerOverload(incident), "claude-fable-5-2");
  assert.equal(providerOverload({ ...incident, errorMessage: '{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}' }), undefined);
  assert.equal(providerOverload({ ...incident, stopReason: "stop", errorMessage: undefined }), undefined);
  assert.equal(providerOverload({ ...incident, model: "bad model id" }), undefined);
});

// The client drops every report it cannot send, so a model id rule that drifts between the client, the
// authority, and the schema would silently hide every alert.
test("the client, the authority, and the protocol schema share one model id rule", () => {
  const schema = JSON.parse(fs.readFileSync(new URL("../protocol/authority-v1.schema.json", import.meta.url), "utf8"));
  assert.equal(MODEL_ID_PATTERN, schema.$defs.ModelId.pattern);
  assert.equal(AUTHORITY_MODEL_ID_PATTERN, schema.$defs.ModelId.pattern);
});
