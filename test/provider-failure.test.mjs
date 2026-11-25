import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { MODEL_ID_PATTERN, providerFailure, providerOverload } from "../index.ts";
import { MODEL_ID_PATTERN as AUTHORITY_MODEL_ID_PATTERN } from "../authority-state.mjs";

// An overload on one model paused the whole account lane for a minute after every failure, so the
// overloaded model's retries kept healthy models on the same account to one request per minute.
test("an overload does not throttle the lane, but a rate limit does", () => {
  const failed = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });
  assert.equal(providerFailure(failed('{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}')), undefined);
  assert.equal(providerFailure(failed("529 Overloaded")), undefined);
  assert.equal(providerFailure(failed('{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}')), "rate-limit");
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
