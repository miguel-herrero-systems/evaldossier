#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertEvaluatorConformance,
  buildReferenceEvaluation,
  defineEvaluator,
  verifyDossier,
} from "../../../../dist/src/index.js";

const INTEGRATION = "evaldossier-codex-local/0.1";
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

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "../../../..");

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

function parseOptions(args, valueOptions) {
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
    fail("JSON_OUTPUT_REQUIRED", "--json is required for the Codex integration");
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

async function verifyCommand(args) {
  const values = parseOptions(
    args,
    new Set([
      "--dossier",
      "--audience",
      "--nonce",
      "--audience-source",
      "--nonce-source",
    ]),
  );

  // Validate every expected value and declared source before resolving or
  // reading the dossier path. This does not prove how the orchestrator obtained
  // those values; the output keeps that limitation explicit.
  const expectedAudience = required(values, "--audience");
  const expectedDossierNonce = required(values, "--nonce");
  const audienceSource = pinSource(required(values, "--audience-source"), "--audience-source");
  const nonceSource = pinSource(required(values, "--nonce-source"), "--nonce-source");
  const dossierInput = required(values, "--dossier");
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
    integration: INTEGRATION,
    operation: "verify",
    status: "PASS",
    dossierLocation: localPathReference(dossierPath),
    pinProvenance: {
      audience: audienceSource,
      nonce: nonceSource,
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

async function conformanceCommand(args) {
  const values = parseOptions(args, new Set(["--output"]));
  const outputInput = required(values, "--output");
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
        dossier: {
          dossierId: "codex.skill.reference.conformance.001",
          generatedAt: "2026-07-21T12:00:10Z",
          classification: "INTERNAL_REFERENCE",
          exporterId: "evaldossier.fixture.exporter",
          audience: "evaldossier.codex.skill.example",
          nonce: "Y29kZXgtc2tpbGwtcmVmZXJlbmNlLW5vbmNlLTAwMQ",
          warnings: [
            "This dossier was generated by the local Codex Skill conformance path with public synthetic fixture keys.",
            "Fixture key control establishes no institutional identity, trust, authority, or production readiness.",
          ],
        },
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
    integration: INTEGRATION,
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

async function main(args = process.argv.slice(2)) {
  const [operation, ...rest] = args;
  if (operation === "verify") {
    return verifyCommand(rest);
  }
  if (operation === "conformance") {
    return conformanceCommand(rest);
  }
  fail("UNKNOWN_OPERATION", "Operation must be verify or conformance");
}

main().then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  },
  (error) => {
    const integrationError =
      error instanceof IntegrationError
        ? error
        : new IntegrationError("INTEGRATION_FAILED", "Unexpected integration failure");
    const operation = process.argv[2] === "verify" || process.argv[2] === "conformance"
      ? process.argv[2]
      : "unknown";
    process.stdout.write(
      `${JSON.stringify(
        {
          integration: INTEGRATION,
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
    process.stderr.write(`EvalDossier Codex integration: ${integrationError.message}\n`);
    process.exitCode = 1;
  },
);
