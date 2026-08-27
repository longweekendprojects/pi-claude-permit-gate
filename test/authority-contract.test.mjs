import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function validateContract(contractRoot = root) {
  return spawnSync(process.execPath, [path.join(contractRoot, "scripts", "validate-authority-contract.mjs")], { cwd: contractRoot, encoding: "utf8" });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function copyContract() {
  const contractRoot = await mkdtemp(path.join(os.tmpdir(), "pi-authority-contract-"));
  await mkdir(path.join(contractRoot, "test"), { recursive: true });
  await Promise.all([
    cp(path.join(root, "protocol"), path.join(contractRoot, "protocol"), { recursive: true }),
    cp(path.join(root, "scripts"), path.join(contractRoot, "scripts"), { recursive: true }),
    cp(path.join(root, "test", "fixtures"), path.join(contractRoot, "test", "fixtures"), { recursive: true }),
  ]);
  return contractRoot;
}

async function updateFixtureDigest(contractRoot, relativePath) {
  const fixtureRoot = path.join(contractRoot, "test", "fixtures", "authority-v1");
  const manifestPath = path.join(fixtureRoot, "manifest.json");
  const manifest = await readJson(manifestPath);
  const entry = [...manifest.valid, ...manifest.invalid].find((candidate) => candidate.file === relativePath);
  assert.ok(entry, `fixture ${relativePath} must be listed`);
  entry.sha256 = digest(await readFile(path.join(fixtureRoot, relativePath)));
  await writeJson(manifestPath, manifest);
}

async function mutateFixture(contractRoot, relativePath, mutate, { updateDigest = true } = {}) {
  const fixturePath = path.join(contractRoot, "test", "fixtures", "authority-v1", relativePath);
  const fixture = await readJson(fixturePath);
  mutate(fixture);
  await writeJson(fixturePath, fixture);
  if (updateDigest) await updateFixtureDigest(contractRoot, relativePath);
}

async function expectContractFailure(label, mutate, expectedDiagnostic) {
  const contractRoot = await copyContract();
  try {
    await mutate(contractRoot);
    const result = validateContract(contractRoot);
    assert.notEqual(result.status, 0, `${label} must fail validation`);
    assert.match(result.stderr, expectedDiagnostic, `${label} must report its rejection`);
  } finally {
    await rm(contractRoot, { recursive: true, force: true });
  }
}

test("authority protocol fixtures enforce response allowlists, malformed classes, and digest drift", async () => {
  const first = validateContract();
  const second = validateContract();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.match(first.stdout, /28 valid fixtures, 21 invalid fixtures/);

  await expectContractFailure("unknown key", (contractRoot) => mutateFixture(contractRoot, "valid/health-response.json", (fixture) => { fixture.body.bySession = {}; }), /is not allowed/);
  await expectContractFailure("closed allowance status", (contractRoot) => mutateFixture(contractRoot, "valid/allowance-publish-request.json", (fixture) => { fixture.fiveHour.status = "unknown"; }), /allowed values/);
  await expectContractFailure("fractional timestamp", (contractRoot) => mutateFixture(contractRoot, "valid/ticket-create-request.json", (fixture) => { fixture.createdAtEpochMs = 1760000000000.5; }), /must be integer/);
  await expectContractFailure("missing nullable key", (contractRoot) => mutateFixture(contractRoot, "valid/ticket-queued.json", (fixture) => { delete fixture.lease; }), /lease is required/);
  await expectContractFailure("non-retryable startup error", (contractRoot) => mutateFixture(contractRoot, "valid/error-degraded-response.json", (fixture) => { fixture.body.error.code = "authority_starting"; }), /must match exactly one schema/);
  await expectContractFailure("fixture digest drift", (contractRoot) => mutateFixture(contractRoot, "valid/health-response.json", (fixture) => { fixture.body.active = 0; }, { updateDigest: false }), /does not match its canonical SHA-256 digest/);
  await expectContractFailure("schema digest drift", async (contractRoot) => {
    const schemaPath = path.join(contractRoot, "protocol", "authority-v1.schema.json");
    await writeFile(schemaPath, `${await readFile(schemaPath, "utf8")}\n`);
  }, /fixture manifest schemaSha256 must equal/);
});
