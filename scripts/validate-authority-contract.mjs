#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schemaPath = path.join(root, "protocol", "authority-v1.schema.json");
const fixtureRoot = path.join(root, "test", "fixtures", "authority-v1");
const manifestPath = path.join(fixtureRoot, "manifest.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function deepEqual(left, right) {
  if (left === right) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isObject(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function jsonPointer(schema, reference) {
  if (!reference.startsWith("#/")) throw new Error(`Only internal schema references are supported: ${reference}`);
  return reference.slice(2).split("/").reduce((current, token) => {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isObject(current) || !(key in current)) throw new Error(`Schema reference does not exist: ${reference}`);
    return current[key];
  }, schema);
}

function validate(value, rule, schema, location = "$") {
  if (rule === true) return [];
  if (rule === false) return [`${location} is forbidden`];
  if (!isObject(rule)) return [`${location} has an invalid schema rule`];
  if (rule.$ref) return validate(value, jsonPointer(schema, rule.$ref), schema, location);

  const errors = [];
  if (rule.allOf) {
    for (const nested of rule.allOf) errors.push(...validate(value, nested, schema, location));
  }
  if (rule.anyOf) {
    const matches = rule.anyOf.filter((nested) => validate(value, nested, schema, location).length === 0);
    if (matches.length === 0) errors.push(`${location} must match at least one schema`);
  }
  if (rule.oneOf) {
    const outcomes = rule.oneOf.map((nested) => validate(value, nested, schema, location));
    const matches = outcomes.filter((outcome) => outcome.length === 0);
    if (matches.length !== 1) errors.push(`${location} must match exactly one schema${matches.length === 0 ? `: ${outcomes.flat().join(" | ")}` : ""}`);
  }
  if (rule.not && validate(value, rule.not, schema, location).length === 0) errors.push(`${location} must not match the forbidden schema`);
  if (rule.if) {
    const branch = validate(value, rule.if, schema, location).length === 0 ? rule.then : rule.else;
    if (branch) errors.push(...validate(value, branch, schema, location));
  }

  if (rule.type) {
    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    if (!types.some((type) => typeMatches(value, type))) {
      errors.push(`${location} must be ${types.join(" or ")}`);
      return errors;
    }
  }
  if (Object.hasOwn(rule, "const") && !deepEqual(value, rule.const)) errors.push(`${location} must equal ${JSON.stringify(rule.const)}`);
  if (rule.enum && !rule.enum.some((candidate) => deepEqual(value, candidate))) errors.push(`${location} must equal one of the allowed values`);

  if (typeof value === "number" && Number.isFinite(value)) {
    if (rule.minimum !== undefined && value < rule.minimum) errors.push(`${location} must be at least ${rule.minimum}`);
    if (rule.maximum !== undefined && value > rule.maximum) errors.push(`${location} must be at most ${rule.maximum}`);
  }
  if (typeof value === "string") {
    if (rule.minLength !== undefined && value.length < rule.minLength) errors.push(`${location} must have at least ${rule.minLength} characters`);
    if (rule.maxLength !== undefined && value.length > rule.maxLength) errors.push(`${location} must have at most ${rule.maxLength} characters`);
    if (rule.pattern && !(new RegExp(rule.pattern).test(value))) errors.push(`${location} must match ${rule.pattern}`);
  }
  if (isObject(value)) {
    const properties = rule.properties ?? {};
    for (const key of rule.required ?? []) if (!(key in value)) errors.push(`${location}.${key} is required`);
    if (rule.minProperties !== undefined && Object.keys(value).length < rule.minProperties) errors.push(`${location} must have at least ${rule.minProperties} properties`);
    if (rule.maxProperties !== undefined && Object.keys(value).length > rule.maxProperties) errors.push(`${location} must have at most ${rule.maxProperties} properties`);
    for (const [key, item] of Object.entries(properties)) if (key in value) errors.push(...validate(value[key], item, schema, `${location}.${key}`));
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push(`${location}.${key} is not allowed`);
    } else if (isObject(rule.additionalProperties)) {
      for (const key of Object.keys(value)) if (!(key in properties)) errors.push(...validate(value[key], rule.additionalProperties, schema, `${location}.${key}`));
    }
  }
  if (Array.isArray(value)) {
    if (rule.minItems !== undefined && value.length < rule.minItems) errors.push(`${location} must have at least ${rule.minItems} items`);
    if (rule.maxItems !== undefined && value.length > rule.maxItems) errors.push(`${location} must have at most ${rule.maxItems} items`);
    if (rule.uniqueItems) {
      for (let index = 0; index < value.length; index += 1) {
        if (value.some((candidate, candidateIndex) => candidateIndex < index && deepEqual(candidate, value[index]))) errors.push(`${location}[${index}] must be unique`);
      }
    }
    if (rule.items) value.forEach((item, index) => errors.push(...validate(item, rule.items, schema, `${location}[${index}]`)));
  }
  return errors;
}

function assertMetadata(schema) {
  const metadata = schema["x-authorityProtocolV1"];
  const errors = [];
  const equal = (actual, expected, label) => { if (!deepEqual(actual, expected)) errors.push(`schema metadata ${label} must equal ${JSON.stringify(expected)}`); };
  if (!isObject(metadata)) return ["schema metadata x-authorityProtocolV1 is required"];
  equal(metadata.protocolVersion, 2, "protocolVersion");
  equal(metadata.requestBodyLimitBytes, 16384, "requestBodyLimitBytes");
  equal(metadata.responseBodyLimitBytes, 65536, "responseBodyLimitBytes");
  equal(metadata.safeIntegerMaximum, 9007199254740991, "safeIntegerMaximum");
  equal(metadata.transport, {
    scheme: "https",
    contentType: "application/json",
    cacheControl: "no-store",
    unknownKeys: "rejected",
    timestampUnit: "epoch milliseconds unless the field is named EpochSeconds",
  }, "transport");
  equal(metadata.authorization?.scopes, ["permit:mutate", "snapshot:read", "allowance:publish"], "authorization.scopes");
  equal(metadata.modes, {
    daemonMode: ["local", "authority"],
    clientMode: ["local", "authority-client"],
    monitorSource: ["local", "authority"],
  }, "modes");
  equal(metadata.limits, {
    authenticatedInstallationPrincipalsPerAuthority: 32,
    liveSessionsPerPrincipal: 32,
    nonterminalTicketsPerSession: 16,
    nonterminalTicketsPerPrincipal: 64,
    nonterminalTicketsPerLane: 256,
    retainedTicketOrTombstoneRecordsPerLane: 4096,
    operationResultsPerTicket: 32,
    verifierRecordsPerAuthority: 192,
    verifierRecordsPerInstallationScope: 2,
    publisherPendingSnapshotsPerProvider: 64,
    publisherPendingSnapshotsPerInstallation: 256,
  }, "limits");
  equal(metadata.timing, {
    offerTtlMs: { minimum: 5000, maximum: 120000 },
    renewIntervalMs: { minimum: 5000, maximum: 300000 },
    renewDeadlineMs: { minimum: 15000, maximum: 3600000 },
    terminalRetentionMsMinimum: 86400000,
  }, "timing");
  const requiredPrivacyFields = ["bySession", "installationId", "sessionId", "requestId", "ticketId", "leaseId", "accountBindingId", "token", "verifier", "oauth", "headers", "body", "path", "rawError"];
  if (!requiredPrivacyFields.every((field) => metadata.privacy?.forbiddenSharedFields?.includes(field))) errors.push("schema metadata privacy.forbiddenSharedFields is incomplete");
  return errors;
}

function semanticErrors(value, tags, manifest) {
  const errors = [];
  for (const tag of tags ?? []) {
    if (tag === "ticket-create-time") {
      if (Math.abs(value.createdAtEpochMs - manifest.referenceNowEpochMs) > 30000) errors.push("createdAtEpochMs must be within 30000ms of the deterministic fixture clock");
    } else if (tag === "allowance-observation-time") {
      if (value.observedAtEpochMs > manifest.referenceNowEpochMs + 30000) errors.push("observedAtEpochMs must be no more than 30000ms in the future");
      if (value.observedAtEpochMs < manifest.storedAllowanceObservedAtEpochMs - 30000) errors.push("observedAtEpochMs must not be more than 30000ms older than stored allowance truth");
    } else if (tag === "authority-timing") {
      if (value.renewDeadlineMs < value.renewIntervalMs * 3) errors.push("renewDeadlineMs must be at least three renew intervals");
    } else if (tag === "aggregate-capacity") {
      const aggregate = value.body ?? value;
      if (aggregate.active + aggregate.offered + aggregate.uncertain > aggregate.currentConcurrency) errors.push("active plus offered plus uncertain must not exceed currentConcurrency");
      if (aggregate.currentConcurrency > aggregate.maximumConcurrency) errors.push("currentConcurrency must not exceed maximumConcurrency");
    } else if (tag === "verifier-store") {
      const tokenIds = new Set();
      const verifierCounts = new Map();
      for (const verifier of value.verifiers) {
        if (tokenIds.has(verifier.tokenId)) errors.push("verifier tokenId values must be unique");
        tokenIds.add(verifier.tokenId);
        const key = `${verifier.installationId}\u0000${verifier.scope}`;
        const count = (verifierCounts.get(key) ?? 0) + 1;
        verifierCounts.set(key, count);
        if (count > 2) errors.push("an installation scope may have only one predecessor/successor verifier overlap");
        if (verifier.generation > value.generation) errors.push("verifier generation must not exceed store generation");
        if (verifier.expiresAtEpochMs <= verifier.issuedAtEpochMs) errors.push("verifier expiry must follow issue time");
      }
    } else if (tag === "error-response") {
      const retryAfter = value.headers["Retry-After"];
      const { retryable, retryAfterMs } = value.body.error;
      if (retryable) {
        if (!/^[1-9][0-9]*$/.test(retryAfter ?? "")) errors.push("retryable error must include integer-seconds Retry-After");
        else if (retryAfterMs !== Number(retryAfter) * 1000) errors.push("retryAfterMs must equal Retry-After seconds multiplied by 1000");
      } else if (retryAfter !== undefined || retryAfterMs !== null) {
        errors.push("non-retryable error must omit Retry-After and use retryAfterMs null");
      }
    } else if (tag === "ticket-response") {
      const revision = value.body.revision;
      if (value.headers.ETag !== `"revision-${revision}"`) errors.push("ETag must match the TicketV1 revision");
      if (value.headers.Location !== undefined && value.headers.Location !== `/v1/tickets/${value.body.ticketId}`) errors.push("Location must match the TicketV1 ticketId");
    } else {
      errors.push(`unknown semantic validator tag: ${tag}`);
    }
  }
  return errors;
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`${path.relative(root, file)} is not valid JSON: ${error.message}`);
  }
}

async function listJsonFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listJsonFiles(path.join(directory, entry.name), relative));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(relative);
  }
  return files;
}

function parseArguments(args) {
  let digestFile;
  let printSchemaDigest = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--digest-file") {
      if (digestFile || !args[index + 1]) throw new Error("--digest-file requires one path");
      digestFile = path.resolve(process.cwd(), args[index + 1]);
      index += 1;
    } else if (args[index] === "--print-schema-digest") {
      printSchemaDigest = true;
    } else {
      throw new Error(`Unknown argument: ${args[index]}`);
    }
  }
  return { digestFile, printSchemaDigest };
}

async function readExpectedDigest(file) {
  const content = (await readFile(file, "utf8")).trim();
  if (/^[0-9a-f]{64}$/.test(content)) return content;
  try {
    const parsed = JSON.parse(content);
    if (/^[0-9a-f]{64}$/.test(parsed.schemaSha256)) return parsed.schemaSha256;
  } catch {}
  throw new Error(`${file} must contain a SHA-256 digest or a JSON object with schemaSha256`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const schemaBytes = await readFile(schemaPath);
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  const manifest = await readJson(manifestPath);
  const schemaDigest = sha256(schemaBytes);
  const errors = [...assertMetadata(schema)];

  if (!isObject(manifest)) errors.push("fixture manifest must be an object");
  if (manifest.schemaSha256 !== schemaDigest) errors.push(`fixture manifest schemaSha256 must equal ${schemaDigest}`);
  if (!Number.isInteger(manifest.referenceNowEpochMs)) errors.push("fixture manifest referenceNowEpochMs must be an integer");
  if (!Number.isInteger(manifest.storedAllowanceObservedAtEpochMs)) errors.push("fixture manifest storedAllowanceObservedAtEpochMs must be an integer");
  if (!Array.isArray(manifest.valid) || !Array.isArray(manifest.invalid)) errors.push("fixture manifest must contain valid and invalid arrays");

  const entries = [...(manifest.valid ?? []).map((entry) => ({ ...entry, expectedValid: true })), ...(manifest.invalid ?? []).map((entry) => ({ ...entry, expectedValid: false }))];
  const listedFiles = new Set();
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.file !== "string" || typeof entry.definition !== "string" || typeof entry.sha256 !== "string") {
      errors.push("each fixture manifest entry needs file, definition, and sha256");
      continue;
    }
    if (entry.file.startsWith("/") || entry.file.includes("..")) {
      errors.push(`fixture path must stay below the fixture root: ${entry.file}`);
      continue;
    }
    if (listedFiles.has(entry.file)) errors.push(`fixture is listed more than once: ${entry.file}`);
    listedFiles.add(entry.file);
    if (!schema.$defs?.[entry.definition]) {
      errors.push(`fixture ${entry.file} references unknown definition ${entry.definition}`);
      continue;
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      errors.push(`fixture ${entry.file} has an invalid SHA-256 digest`);
      continue;
    }
    const fixturePath = path.join(fixtureRoot, entry.file);
    let fixtureBytes;
    let fixture;
    try {
      fixtureBytes = await readFile(fixturePath);
      fixture = JSON.parse(fixtureBytes.toString("utf8"));
    } catch (error) {
      errors.push(`fixture ${entry.file} cannot be read as JSON: ${error.message}`);
      continue;
    }
    if (sha256(fixtureBytes) !== entry.sha256) errors.push(`fixture ${entry.file} does not match its canonical SHA-256 digest`);
    const fixtureErrors = [
      ...validate(fixture, schema.$defs[entry.definition], schema),
      ...semanticErrors(fixture, entry.semantics, manifest),
    ];
    if (entry.expectedValid && fixtureErrors.length > 0) errors.push(`valid fixture ${entry.file} failed: ${fixtureErrors.join("; ")}`);
    if (!entry.expectedValid && fixtureErrors.length === 0) errors.push(`invalid fixture ${entry.file} unexpectedly passed`);
    if (!entry.expectedValid && typeof entry.expectedError === "string" && !fixtureErrors.some((error) => error.includes(entry.expectedError))) {
      errors.push(`invalid fixture ${entry.file} did not fail with ${JSON.stringify(entry.expectedError)}: ${fixtureErrors.join("; ")}`);
    }
  }

  const actualFiles = (await listJsonFiles(fixtureRoot)).filter((file) => file !== "manifest.json");
  const unlisted = actualFiles.filter((file) => !listedFiles.has(file));
  const missing = [...listedFiles].filter((file) => !actualFiles.includes(file));
  if (unlisted.length) errors.push(`unlisted fixture files: ${unlisted.join(", ")}`);
  if (missing.length) errors.push(`missing fixture files: ${missing.join(", ")}`);

  if (options.digestFile) {
    const expectedDigest = await readExpectedDigest(options.digestFile);
    if (expectedDigest !== schemaDigest) errors.push(`digest file ${options.digestFile} does not match ${schemaDigest}`);
  }
  if (errors.length) throw new Error(`authority protocol validation failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  if (options.printSchemaDigest) console.log(schemaDigest);
  else console.log(`Authority protocol v1 validated: ${manifest.valid.length} valid fixtures, ${manifest.invalid.length} invalid fixtures; schema sha256=${schemaDigest}.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
