import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { defaultAuthorityRequest } from "../index.ts";

// A request cancelled before it was sent destroyed itself before its error listener existed, so the
// abort escaped as an uncaught exception and took down the whole agent process.
test("a cancelled authority request rejects instead of crashing the process", async () => {
  const uncaught = [];
  const onUncaught = (error) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  try {
    const request = defaultAuthorityRequest("https://localhost");
    const before = new AbortController(); before.abort();
    await assert.rejects(request({ method: "GET", port: 9, pathname: "/v1/health", authorization: "Bearer x", signal: before.signal }), { name: "AbortError" });
    const server = net.createServer(() => {}).listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const during = new AbortController();
    const pending = request({ method: "GET", port: server.address().port, pathname: "/", authorization: "Bearer x", signal: during.signal });
    setTimeout(() => during.abort(), 50);
    await assert.rejects(pending, { name: "AbortError" });
    server.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(uncaught, []);
  } finally { process.off("uncaughtException", onUncaught); }
});
