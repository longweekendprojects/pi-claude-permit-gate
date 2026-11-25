import test from "node:test";
import assert from "node:assert/strict";
import { providerFailure } from "../index.ts";

// An overload on one model paused the whole account lane for a minute after every failure, so the
// overloaded model's retries kept healthy models on the same account to one request per minute.
test("an overload does not throttle the lane, but a rate limit does", () => {
  const failed = (errorMessage) => ({ role: "assistant", stopReason: "error", errorMessage });
  assert.equal(providerFailure(failed('{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_1"}')), undefined);
  assert.equal(providerFailure(failed("529 Overloaded")), undefined);
  assert.equal(providerFailure(failed('{"type":"error","error":{"type":"rate_limit_error","message":"Rate limited"}}')), "rate-limit");
});
