import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyDossier } from "../../dist/src/dossier.js";
import { buildReferenceEvaluation } from "../../dist/src/reference-evaluator.js";
import { assertEvaluatorConformance, defineEvaluator } from "../../dist/src/sdk.js";
import { parseJsonStrict } from "../../dist/src/json.js";

const PIN_SOURCES = Object.freeze({
  "user-request": "USER_REQUEST",
  "upstream-context": "UPSTREAM_CONTEXT",
});
const VERIFY_NON_CLAIMS = Object.freeze([
  "PINNED establishes equality with a supplied expected value; it does not establish how that value was obtained.",
  "Pin provenance is caller-declared and is not independently verified by this integration.",
  "No truth, neutrality, legal identity, authority, or payment entitlement is established by this result alone.",
]);
const CONFORMANCE_NON_CLAIMS = Object.freeze([
  "Conformance establishes compatibility with declared protocol semantics, not evaluator certification.",
  "The bundled keys and evidence are public synthetic fixtures and establish no institutional identity or external adoption.",
  "No truth, neutrality, legal authority, or payment entitlement is established by this result alone.",
]);
const CONFIG_KEYS = Object.freeze(["hostName", "hostSlug", "integrationId"]);
const REQUEST_KEYS = Object.freeze([
  "audience",
  "audienceSource",
  "dossier",
  "nonce",
  "nonceSource",
  "schemaVersion",
]);
const REQUEST_SCHEMA_VERSION = "evaldossier.local-verification-request/0.1";
const CONFORMANCE_REQUEST_KEYS = Object.freeze(["output", "schemaVersion"]);
const CONFORMANCE_REQUEST_SCHEMA_VERSION = "evaldossier.local-conformance-request/0.1";
const MAX_REQUEST_BYTES = 16 * 1024;

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../..");

class IntegrationError extends Error {
  constructor(code, message, diagnostic = undefined) {
    super(message);
    this.name = "IntegrationError";
    this.code = code;
    this.diagnostic = diagnostic;
  }
}

function fail(code, message, diagnostic = undefined) {
  throw new IntegrationError(code, message, diagnostic);
}

function assertExactKeys(
  value,
  expectedKeys,
  label,
  errorCode = "INVALID_INTEGRATION_CONFIG",
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(errorCode, `${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpected = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpected.length ||
    actualKeys.some((key, index) => key !== sortedExpected[index])
  ) {
    fail(errorCode, `${label} has unsupported or missing fields`);
  }
}

function requestString(value, field, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    fail(
      "INVALID_VERIFICATION_REQUEST",
      `${field} must be a non-empty string no longer than ${maxLength} characters`,
    );
  }
  return value;
}

function normalizeVerificationRequest(value) {
  assertExactKeys(
    value,
    REQUEST_KEYS,
    "verification request",
    "INVALID_VERIFICATION_REQUEST",
  );
  if (value.schemaVersion !== REQUEST_SCHEMA_VERSION) {
    fail("INVALID_VERIFICATION_REQUEST", "verification request schemaVersion is unsupported");
  }
  return Object.freeze({
    dossier: requestString(value.dossier, "dossier", 4096),
    audience: requestString(value.audience, "audience", 2048),
    nonce: requestString(value.nonce, "nonce", 4096),
    audienceSource: requestString(value.audienceSource, "audienceSource", 32),
    nonceSource: requestString(value.nonceSource, "nonceSource", 32),
  });
}

function normalizeConformanceRequest(value) {
  assertExactKeys(
    value,
    CONFORMANCE_REQUEST_KEYS,
    "conformance request",
    "INVALID_CONFORMANCE_REQUEST",
  );
  if (value.schemaVersion !== CONFORMANCE_REQUEST_SCHEMA_VERSION) {
    fail("INVALID_CONFORMANCE_REQUEST", "conformance request schemaVersion is unsupported");
  }
  return Object.freeze({
    output: requestString(value.output, "output", 4096),
  });
}

function normalizeIntegrationConfig(value) {
  assertExactKeys(value, CONFIG_KEYS, "integration config");
  const { hostName, hostSlug, integrationId } = value;
  if (
    typeof hostName !== "string" ||
    !/^[A-Za-z][A-Za-z0-9 .-]{0,63}$/u.test(hostName)
  ) {
    fail("INVALID_INTEGRATION_CONFIG", "hostName is invalid");
  }
  if (
    typeof hostSlug !== "string" ||
    !/^[a-z][a-z0-9-]{0,31}$/u.test(hostSlug)
  ) {
    fail("INVALID_INTEGRATION_CONFIG", "hostSlug is invalid");
  }
  if (
    typeof integrationId !== "string" ||
    !/^evaldossier-[a-z][a-z0-9-]*-(?:local|plugin)\/0\.1$/u.test(integrationId)
  ) {
    fail("INVALID_INTEGRATION_CONFIG", "integrationId is invalid");
  }
  return Object.freeze({ hostName, hostSlug, integrationId });
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function failureDiagnostic(error) {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    detailSha256: sha256Text(detail),
    rawDetailEmitted: false,
  };
}

function localPathReference(value) {
  return {
    kind: "LOCAL_PATH",
    pathSha256: sha256Text(value),
    rawPathEmitted: false,
  };
}

function modelSafeSummary(summary) {
  return {
    schema: summary.schema,
    integrity: summary.integrity,
    signatures: summary.signatures,
    keyControl: summary.keyControl,
    signerTrust: summary.signerTrust,
    identity: summary.identity,
    audienceBinding: summary.audienceBinding,
    dossierNonceBinding: summary.dossierNonceBinding,
    provenance: [...summary.provenance],
    bases: [...summary.bases],
    overallBasis: summary.overallBasis,
    predicateStatuses: [...summary.predicateStatuses],
    obligationVerdict: summary.obligationVerdict,
    economicAction: summary.economicAction,
    untrustedText: {
      dossierIdSha256: sha256Text(summary.dossierId),
      audienceSha256: sha256Text(summary.audience),
      warningCount: summary.warnings.length,
      warningSha256: summary.warnings.map(sha256Text),
      rawTextEmitted: false,
    },
  };
}

function containsWindowsDeviceAlias(value) {
  return value.split(/[\\/]+/u).some((segment) => {
    const normalized = segment.replace(/[ .]+$/u, "");
    const [baseName] = normalized.split(/[.:]/u, 1);
    return /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³])$/iu.test(
      baseName,
    );
  });
}

function assertLocalPath(value, label) {
  if (value.includes("\0")) {
    fail("INVALID_LOCAL_PATH", `${label} contains a NUL byte`);
  }
  if (/^[\\/]{2}/.test(value)) {
    fail(
      "NETWORK_REFERENCE_FORBIDDEN",
      `${label} must not use a network or device-namespace filesystem path`,
    );
  }
  if (containsWindowsDeviceAlias(value)) {
    fail(
      "DEVICE_REFERENCE_FORBIDDEN",
      `${label} must not contain a reserved Windows device alias`,
    );
  }
  const looksLikeScheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
  const windowsDrivePath = /^[A-Za-z]:[\\/]/.test(value);
  if (looksLikeScheme && !(process.platform === "win32" && windowsDrivePath)) {
    fail("NETWORK_REFERENCE_FORBIDDEN", `${label} must be a local filesystem path, not a URL`);
  }
}

function parseOptions(args, valueOptions, hostName) {
  const values = new Map();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      if (json) {
        fail("DUPLICATE_OPTION", "--json may be supplied only once");
      }
      json = true;
      continue;
    }
    if (!valueOptions.has(argument)) {
      fail("UNKNOWN_OPTION", "An unsupported option was supplied");
    }
    if (values.has(argument)) {
      fail("DUPLICATE_OPTION", `${argument} may be supplied only once`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.length === 0) {
      fail("MISSING_OPTION_VALUE", `${argument} requires a non-empty value`);
    }
    values.set(argument, value);
    index += 1;
  }

  if (!json) {
    fail("JSON_OUTPUT_REQUIRED", `--json is required for the ${hostName} integration`);
  }
  return values;
}

function required(values, option) {
  const value = values.get(option);
  if (value === undefined) {
    fail("INPUT_REQUIRED", `${option} is required and must not be inferred from a dossier`);
  }
  return value;
}

function pinSource(value, option) {
  if (!Object.hasOwn(PIN_SOURCES, value)) {
    fail(
      "INVALID_PIN_SOURCE",
      `${option} must be user-request or upstream-context; dossier-derived sources are forbidden`,
    );
  }
  return PIN_SOURCES[value];
}

async function verifyCommand(config, args) {
  const values = parseOptions(
    args,
    new Set([
      "--dossier",
      "--audience",
      "--nonce",
      "--audience-source",
      "--nonce-source",
    ]),
    config.hostName,
  );

  return verifyInputs(config, {
    expectedAudience: required(values, "--audience"),
    expectedDossierNonce: required(values, "--nonce"),
    audienceSource: required(values, "--audience-source"),
    nonceSource: required(values, "--nonce-source"),
    dossierInput: required(values, "--dossier"),
  });
}

async function readStrictRequestFile(requestInput, label) {
  assertLocalPath(requestInput, "--request");
  const requestPath = resolve(requestInput);
  let handle;
  try {
    const beforeOpen = await lstat(requestPath);
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink() || beforeOpen.nlink !== 1) {
      fail(
        label.code,
        `${label.name} must be one regular, non-linked local file`,
      );
    }
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    handle = await open(requestPath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== beforeOpen.dev ||
      opened.ino !== beforeOpen.ino
    ) {
      fail(label.code, `${label.name} changed while it was being opened`);
    }
    if (opened.size > MAX_REQUEST_BYTES) {
      fail(label.code, `${label.name} exceeds the byte limit`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_REQUEST_BYTES) {
      fail(label.code, `${label.name} grew beyond the byte limit while being read`);
    }
    return parseJsonStrict(bytes, `structured ${label.name}`);
  } catch (error) {
    if (error instanceof IntegrationError) {
      throw error;
    }
    fail(
      label.code,
      `structured ${label.name} is invalid`,
      failureDiagnostic(error),
    );
  } finally {
    await handle?.close();
  }
}

async function readVerificationRequest(requestInput) {
  const parsed = await readStrictRequestFile(requestInput, {
    code: "INVALID_VERIFICATION_REQUEST",
    name: "verification request",
  });
  return normalizeVerificationRequest(parsed);
}

async function readOneJsonLineFromStdin(errorCode, label) {
  if (process.stdin.isTTY) {
    fail(errorCode, `${label} requires structured non-interactive stdin`);
  }
  const bytes = await new Promise((resolveInput, rejectInput) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
    };
    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };
    const onError = (error) => settle(rejectInput, error);
    const onEnd = () => settle(rejectInput, new Error(`${label} ended before newline`));
    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.byteLength;
      if (totalBytes > MAX_REQUEST_BYTES + 1) {
        settle(rejectInput, new Error(`${label} exceeds the byte limit`));
        return;
      }
      const newlineIndex = buffer.indexOf(0x0a);
      if (newlineIndex === -1) {
        chunks.push(buffer);
        return;
      }
      if (newlineIndex !== buffer.byteLength - 1) {
        settle(rejectInput, new Error(`${label} must contain exactly one JSON line`));
        return;
      }
      chunks.push(buffer.subarray(0, newlineIndex));
      const combined = Buffer.concat(chunks);
      if (combined.byteLength === 0 || combined.byteLength > MAX_REQUEST_BYTES) {
        settle(rejectInput, new Error(`${label} has an invalid byte length`));
        return;
      }
      settle(resolveInput, combined);
    };

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  }).catch((error) => {
    fail(errorCode, `${label} is invalid`, failureDiagnostic(error));
  });

  try {
    return parseJsonStrict(bytes, label);
  } catch (error) {
    fail(errorCode, `${label} is invalid`, failureDiagnostic(error));
  }
}

async function verifyRequestCommand(config, args) {
  const values = parseOptions(args, new Set(["--request"]), config.hostName);
  const request = await readVerificationRequest(required(values, "--request"));
  return verifyInputs(config, {
    expectedAudience: request.audience,
    expectedDossierNonce: request.nonce,
    audienceSource: request.audienceSource,
    nonceSource: request.nonceSource,
    dossierInput: request.dossier,
  });
}

async function verifyStdinCommand(config, args) {
  const values = parseOptions(args, new Set(), config.hostName);
  if (values.size !== 0) {
    fail("UNKNOWN_OPTION", "An unsupported option was supplied");
  }
  const parsed = await readOneJsonLineFromStdin(
    "INVALID_VERIFICATION_REQUEST",
    "structured verification request",
  );
  const request = normalizeVerificationRequest(parsed);
  return verifyInputs(config, {
    expectedAudience: request.audience,
    expectedDossierNonce: request.nonce,
    audienceSource: request.audienceSource,
    nonceSource: request.nonceSource,
    dossierInput: request.dossier,
  });
}

async function verifyInputs(
  config,
  { expectedAudience, expectedDossierNonce, audienceSource, nonceSource, dossierInput },
) {
  // Validate every expected value and declared source before resolving or
  // reading the dossier path. This does not prove how the orchestrator obtained
  // those values; the output keeps that limitation explicit.
  const normalizedAudienceSource = pinSource(audienceSource, "audience source");
  const normalizedNonceSource = pinSource(nonceSource, "nonce source");
  assertLocalPath(dossierInput, "--dossier");
  const dossierPath = resolve(dossierInput);

  let verified;
  try {
    verified = await verifyDossier(dossierPath, {
      expectedAudience,
      expectedDossierNonce,
    });
  } catch (error) {
    fail("VERIFICATION_FAILED", "Dossier verification failed", failureDiagnostic(error));
  }

  if (
    verified.summary.audienceBinding !== "PINNED" ||
    verified.summary.dossierNonceBinding !== "PINNED"
  ) {
    fail("PINNING_INVARIANT_FAILED", "The verifier did not report both context bindings as PINNED");
  }
  if (verified.summary.economicAction !== "OUT_OF_SCOPE") {
    fail("ECONOMIC_BOUNDARY_FAILED", "EvalDossier protocol 0.1 forbids economic action");
  }

  return {
    integration: config.integrationId,
    operation: "verify",
    status: "PASS",
    dossierLocation: localPathReference(dossierPath),
    pinProvenance: {
      audience: normalizedAudienceSource,
      nonce: normalizedNonceSource,
      assurance: "CALLER_DECLARED_NOT_VERIFIED",
    },
    summary: modelSafeSummary(verified.summary),
    nonClaims: [...VERIFY_NON_CLAIMS],
  };
}

async function loadFixtureKey(name) {
  const text = await readFile(resolve(projectRoot, "fixtures", "keys", name), "utf8");
  return JSON.parse(text);
}

function conformanceDossier(config) {
  return {
    dossierId: `${config.hostSlug}.skill.reference.conformance.001`,
    generatedAt: "2026-07-21T12:00:10Z",
    classification: "INTERNAL_REFERENCE",
    exporterId: "evaldossier.fixture.exporter",
    audience: `evaldossier.${config.hostSlug}.skill.example`,
    nonce: Buffer.from(`${config.hostSlug}-skill-reference-nonce-001`, "utf8").toString(
      "base64url",
    ),
    warnings: [
      `This dossier was generated by the local ${config.hostName} Skill conformance path with public synthetic fixture keys.`,
      "Fixture key control establishes no institutional identity, trust, authority, or production readiness.",
    ],
  };
}

async function runConformance(config, outputInput) {
  assertLocalPath(outputInput, "--output");
  const outputDirectory = resolve(outputInput);

  const [evaluatorKey, requesterKey, exporterKey] = await Promise.all([
    loadFixtureKey("reference-evaluator.private.jwk.json"),
    loadFixtureKey("requester.private.jwk.json"),
    loadFixtureKey("exporter.private.jwk.json"),
  ]);

  const evaluator = defineEvaluator({
    evaluatorId: "evaldossier-reference-evaluator",
    async evaluate(input) {
      return buildReferenceEvaluation(input.projectRoot, input.evaluatorKey, input.requesterKey);
    },
  });

  let result;
  try {
    result = await assertEvaluatorConformance(
      evaluator,
      { projectRoot, evaluatorKey, requesterKey },
      {
        outputDirectory,
        exporterKey,
        dossier: conformanceDossier(config),
      },
      {
        bases: ["FORMAL_PREDICATE"],
        overallBasis: "FORMAL_PREDICATE",
        predicateStatuses: ["ESTABLISHED_TRUE"],
        obligationVerdict: "SATISFIED",
      },
    );
  } catch (error) {
    fail("CONFORMANCE_FAILED", "Evaluator conformance failed", failureDiagnostic(error));
  }

  return {
    integration: config.integrationId,
    operation: "conformance",
    status: "PASS",
    dossierLocation: localPathReference(outputDirectory),
    pinProvenance: {
      audience: "PUBLIC_TEST_FIXTURE",
      nonce: "PUBLIC_TEST_FIXTURE",
      assurance: "SYNTHETIC_CONFORMANCE_ONLY",
    },
    checks: result.checks,
    summary: modelSafeSummary(result.verified.summary),
    nonClaims: [...CONFORMANCE_NON_CLAIMS],
  };
}

async function conformanceCommand(config, args) {
  const values = parseOptions(args, new Set(["--output"]), config.hostName);
  return runConformance(config, required(values, "--output"));
}

async function conformanceStdinCommand(config, args) {
  const values = parseOptions(args, new Set(), config.hostName);
  if (values.size !== 0) {
    fail("UNKNOWN_OPTION", "An unsupported option was supplied");
  }
  const parsed = await readOneJsonLineFromStdin(
    "INVALID_CONFORMANCE_REQUEST",
    "structured conformance request",
  );
  const request = normalizeConformanceRequest(parsed);
  return runConformance(config, request.output);
}

async function main(config, args) {
  const [operation, ...rest] = args;
  if (operation === "verify") {
    return verifyCommand(config, rest);
  }
  if (operation === "verify-request") {
    return verifyRequestCommand(config, rest);
  }
  if (operation === "verify-stdin") {
    return verifyStdinCommand(config, rest);
  }
  if (operation === "conformance") {
    return conformanceCommand(config, rest);
  }
  if (operation === "conformance-stdin") {
    return conformanceStdinCommand(config, rest);
  }
  fail(
    "UNKNOWN_OPERATION",
    "Operation must be verify, verify-request, verify-stdin, conformance or conformance-stdin",
  );
}

export async function runLocalIntegrationCli(configInput, args = process.argv.slice(2)) {
  let config;
  try {
    config = normalizeIntegrationConfig(configInput);
    const result = await main(config, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const integrationError =
      error instanceof IntegrationError
        ? error
        : new IntegrationError("INTEGRATION_FAILED", "Unexpected integration failure");
    const operation =
      args[0] === "verify" || args[0] === "verify-request" || args[0] === "verify-stdin"
      ? "verify"
      : args[0] === "conformance" || args[0] === "conformance-stdin"
        ? "conformance"
        : "unknown";
    process.stdout.write(
      `${JSON.stringify(
        {
          integration: config?.integrationId ?? "evaldossier-local/invalid-config",
          operation,
          status: "FAIL",
          error: {
            code: integrationError.code,
            message: integrationError.message,
            ...(integrationError.diagnostic === undefined
              ? {}
              : { diagnostic: integrationError.diagnostic }),
          },
        },
        null,
        2,
      )}\n`,
    );
    process.stderr.write(
      `EvalDossier ${config?.hostName ?? "local"} integration: ${integrationError.message}\n`,
    );
    process.exitCode = 1;
  }
}
