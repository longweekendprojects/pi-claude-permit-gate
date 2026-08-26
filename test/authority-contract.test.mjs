import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const validator = path.join(root, "scripts", "validate-authority-contract.mjs");

function validateContract() {
  return spawnSync(process.execPath, [validator], { cwd: root, encoding: "utf8" });
}

test("authority protocol fixtures enforce response allowlists, bounds, and deterministic validation", () => {
  const first = validateContract();
  const second = validateContract();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /22 valid fixtures, 16 invalid fixtures/);
});
