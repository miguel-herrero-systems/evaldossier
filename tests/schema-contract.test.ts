import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport, { type FormatsPlugin } from "ajv-formats";

type JsonObject = Record<string, any>;
const addFormats = addFormatsImport as unknown as FormatsPlugin;

const schemaDirectory = fileURLToPath(new URL("../../schemas/", import.meta.url));
const schemaFiles = [
  "common.schema.json",
  "evaluator-manifest.schema.json",
  "profile-definition.schema.json",
  "evaluation-request.schema.json",
  "evidence-bundle.schema.json",
  "evaluation-attestation.schema.json",
  "dossier.schema.json",
] as const;

const ajv = new Ajv2020({
  allErrors: true,
  allowUnionTypes: true,
  strict: false,
  validateFormats: true,
});
addFormats(ajv);

for (const filename of schemaFiles) {
  const schema = JSON.parse(readFileSync(`${schemaDirectory}${filename}`, "utf8")) as JsonObject;
  ajv.addSchema(schema);
}

function validator(schemaId: string): ValidateFunction {
  const validate = ajv.getSchema(schemaId);
  assert.ok(validate, `schema not registered: ${schemaId}`);
  return validate;
}

function assertValid(validate: ValidateFunction, instance: unknown): void {
  assert.equal(validate(instance), true, ajv.errorsText(validate.errors, { separator: "\n" }));
}

function assertInvalid(validate: ValidateFunction, instance: unknown): void {
  assert.equal(validate(instance), false, "expected schema validation to fail");
}

const digest = {
  algorithm: "sha-256",
  value: "0".repeat(64),
};

const keyId = "A".repeat(43);
const publicKey = {
  kty: "OKP",
  crv: "Ed25519",
  x: "B".repeat(43),
  kid: keyId,
  alg: "EdDSA",
  use: "sig",
};

const signatureContext = {
  audience: "evaldossier-contract-tests",
  nonce: "N".repeat(22),
};

const proof = {
  type: "evaldossier.detached-jws/0.1",
  jws: "eA..eA",
};

function validProfile(): JsonObject {
  return {
    protocolVersion: "evaldossier/0.1",
    schemaVersion: "evaldossier.profile-definition/0.1",
    profileId: "profile.formal-json",
    version: "0.1.0",
    title: "Formal JSON profile",
    description: "Checks a committed JSON deliverable against a committed schema.",
    publishedAt: "2026-07-21T00:00:00Z",
    publisher: { id: "publisher.reference", key: publicKey },
    signingKeyId: keyId,
    operation: "EVALUATE",
    resultBindingMode: "DIRECT_PREDICATE_RESULT",
    evaluationClass: "DETERMINISTIC",
    allowedBases: ["FORMAL_PREDICATE"],
    predicates: [
      {
        predicateId: "predicate.json-schema-valid",
        description: "The committed deliverable validates against the committed schema.",
        basis: "FORMAL_PREDICATE",
      },
    ],
    aggregationPolicy: {
      rule: "ALL_REQUIRED_TRUE",
      unknownHandling: "INCONCLUSIVE_WHEN_REQUIRED_PREDICATE_UNDETERMINED",
      obligationEligibleBases: ["FORMAL_PREDICATE"],
    },
    mappingPolicy: {
      policyId: "mapping.native-v1",
      description: "Native predicate results are preserved without semantic strengthening.",
    },
    signatureContext,
    proof,
  };
}

function validManifest(): JsonObject {
  return {
    protocolVersion: "evaldossier/0.1",
    schemaVersion: "evaldossier.evaluator-manifest/0.1",
    manifestId: "manifest.reference-v1",
    evaluatorId: "evaluator.reference",
    evaluatorType: "NATIVE",
    issuedAt: "2026-07-21T00:00:00Z",
    expiresAt: "2027-07-21T00:00:00Z",
    operator: {
      id: "operator.reference",
      displayName: "EvalDossier reference operator",
      relationship: "INTERNAL_REFERENCE_OPERATOR",
    },
    signingKeyId: keyId,
    keys: [publicKey],
    profiles: [
      {
        id: "profile.formal-json",
        version: "0.1.0",
        digest,
      },
    ],
    software: {
      name: "evaldossier-reference-evaluator",
      version: "0.1.0",
      sourceVisibility: "OPEN_SOURCE",
    },
    dataPractices: {
      acceptedClassifications: ["PUBLIC_SYNTHETIC"],
      trainingUse: false,
      networkUse: false,
    },
    signatureContext,
    proof,
  };
}

function validRequest(): JsonObject {
  return {
    protocolVersion: "evaldossier/0.1",
    schemaVersion: "evaldossier.evaluation-request/0.1",
    requestId: "request.reference-v1",
    operation: "EVALUATE",
    createdAt: "2026-07-21T00:00:00Z",
    expiresAt: "2026-07-22T00:00:00Z",
    requester: { id: "requester.reference", key: publicKey },
    signingKeyId: keyId,
    targetEvaluatorId: "evaluator.reference",
    profile: {
      id: "profile.formal-json",
      version: "0.1.0",
      digest,
    },
    statement: "The committed deliverable satisfies the committed JSON Schema.",
    criteria: [
      {
        criterionId: "criterion.json-schema-valid",
        predicateId: "predicate.json-schema-valid",
        required: true,
        statement: "Validate the deliverable against the schema.",
        parameters: [
          { name: "deliverableArtifactId", value: "artifact.deliverable" },
          { name: "schemaArtifactId", value: "artifact.schema" },
        ],
      },
    ],
    artifacts: [
      {
        artifactId: "artifact.deliverable",
        role: "DELIVERABLE",
        mediaType: "application/json",
        commitmentMode: "EXACT_INPUT",
        digest,
        sizeBytes: 2,
      },
      {
        artifactId: "artifact.schema",
        role: "SCHEMA",
        mediaType: "application/schema+json",
        commitmentMode: "EXACT_INPUT",
        digest,
        sizeBytes: 2,
      },
    ],
    privacy: {
      classification: "PUBLIC_SYNTHETIC",
      trainingUse: false,
    },
    economicBoundary: {
      paymentExecution: "OUT_OF_SCOPE",
      paymentRecommendation: "OUT_OF_SCOPE",
    },
    signatureContext,
    proof,
  };
}

function validEvidence(): JsonObject {
  return {
    protocolVersion: "evaldossier/0.1",
    schemaVersion: "evaldossier.evidence-bundle/0.1",
    bundleId: "bundle.reference-v1",
    requestId: "request.reference-v1",
    capturedAt: "2026-07-21T00:00:01Z",
    collector: { id: "collector.reference", key: publicKey },
    signingKeyId: keyId,
    captureMode: "GENERATED_SYNTHETIC",
    artifacts: [
      {
        artifactId: "artifact.deliverable",
        role: "DELIVERABLE",
        mediaType: "application/json",
        digest,
        sizeBytes: 2,
        path: "evidence/deliverable.json",
        source: {
          systemId: "fixture.reference",
          role: "REFERENCE_FIXTURE",
          controllerRelationship: "INTERNAL_FIXTURE",
          observationMode: "SYNTHETIC",
          originAuthentication: "SYNTHETIC",
          derivation: "GENERATED",
          authorityStatus: "FORMALLY_DEFINED",
        },
      },
    ],
    limitations: ["Synthetic evidence establishes protocol behavior, not external adoption."],
    signatureContext,
    proof,
  };
}

function validAttestation(): JsonObject {
  return {
    protocolVersion: "evaldossier/0.1",
    schemaVersion: "evaldossier.evaluation-attestation/0.1",
    attestationId: "attestation.reference-v1",
    issuedAt: "2026-07-21T00:00:02Z",
    evaluator: {
      evaluatorId: "evaluator.reference",
      keyId,
      softwareVersion: "0.1.0",
    },
    bindings: {
      manifestDigest: digest,
      profileDigest: digest,
      requestDigest: digest,
      evidenceBundleDigest: digest,
    },
    mode: "NATIVE_EVALUATION",
    coverage: {
      status: "COMPLETE",
      assessedCriterionIds: ["criterion.json-schema-valid"],
      unassessedCriterionIds: [],
    },
    overallAssessment: {
      assessment: "AFFIRMED",
      basis: "FORMAL_PREDICATE",
      reasonCode: "ALL_REQUIRED_PREDICATES_TRUE",
    },
    obligationVerdict: "SATISFIED",
    assessments: [
      {
        assessmentId: "assessment.json-schema-valid",
        criterionId: "criterion.json-schema-valid",
        statement: "The deliverable validates against the committed schema.",
        basis: "FORMAL_PREDICATE",
        assessment: "AFFIRMED",
        predicateStatus: "ESTABLISHED_TRUE",
        reasonCode: "JSON_SCHEMA_VALID",
        evidenceArtifactIds: ["artifact.deliverable", "artifact.schema"],
        limitations: [],
      },
    ],
    ignoredInputs: [],
    errors: [],
    limitations: [],
    economicAction: "OUT_OF_SCOPE",
    signatureContext,
    proof,
  };
}

function validDossier(): JsonObject {
  const rolesAndPaths = [
    ["EVALUATOR_MANIFEST", "objects/manifest.json"],
    ["PROFILE_DEFINITION", "objects/profile.json"],
    ["EVALUATION_REQUEST", "objects/request.json"],
    ["EVIDENCE_BUNDLE", "objects/evidence-bundle.json"],
    ["EVALUATION_ATTESTATION", "objects/attestation.json"],
  ] as const;

  return {
    protocolVersion: "evaldossier/0.1",
    schemaVersion: "evaldossier.dossier/0.1",
    dossierId: "dossier.reference-v1",
    generatedAt: "2026-07-21T00:00:03Z",
    classification: "INTERNAL_REFERENCE",
    exporter: { id: "exporter.reference", key: publicKey },
    signingKeyId: keyId,
    artifacts: rolesAndPaths.map(([role, path]) => ({
      role,
      path,
      mediaType: "application/json",
      digest,
      sizeBytes: 2,
      requiredForVerification: true,
    })),
    bindings: {
      manifestDigest: digest,
      profileDigest: digest,
      requestDigest: digest,
      evidenceBundleDigest: digest,
      attestationDigest: digest,
    },
    warnings: [],
    economicAction: "OUT_OF_SCOPE",
    signatureContext,
    proof,
  };
}

const sixProtocolObjects = [
  ["https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluator-manifest.schema.json", validManifest],
  ["https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/profile-definition.schema.json", validProfile],
  ["https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluation-request.schema.json", validRequest],
  ["https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evidence-bundle.schema.json", validEvidence],
  ["https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluation-attestation.schema.json", validAttestation],
  ["https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/dossier.schema.json", validDossier],
] as const;

test("the six v0.1 protocol schemas accept minimal valid objects", async (t) => {
  for (const [schemaId, factory] of sixProtocolObjects) {
    await t.test(schemaId, () => {
      assertValid(validator(schemaId), factory());
    });
  }
});

test("MODEL_JUDGMENT preserves an assessment but cannot establish predicate truth", () => {
  const validate = validator(
    "https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluation-attestation.schema.json",
  );
  const judgment = validAttestation();
  judgment.mode = "UPSTREAM_NORMALIZATION";
  judgment.overallAssessment = {
    assessment: "AFFIRMED",
    basis: "MODEL_JUDGMENT",
    reasonCode: "UPSTREAM_AFFIRMED",
  };
  judgment.obligationVerdict = "INCONCLUSIVE";
  judgment.assessments[0].basis = "MODEL_JUDGMENT";
  judgment.assessments[0].assessment = "AFFIRMED";
  judgment.assessments[0].predicateStatus = "UNDETERMINED";
  judgment.assessments[0].reasonCode = "UPSTREAM_AFFIRMED";

  assertValid(validate, judgment);

  judgment.assessments[0].predicateStatus = "ESTABLISHED_TRUE";
  assertInvalid(validate, judgment);
});

test("protocol confidence is a decimal string, never a JSON number", () => {
  const validate = validator(
    "https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluation-attestation.schema.json",
  );
  const attestation = validAttestation();
  attestation.assessments[0].confidence = {
    value: "0.675",
    scale: "0_TO_1",
    calibration: "UPSTREAM_REPORTED_UNVERIFIED",
  };
  assertValid(validate, attestation);

  attestation.assessments[0].confidence.value = 0.675;
  assertInvalid(validate, attestation);
});

test("a dossier contains exactly one artifact for each enclosed protocol role", () => {
  const validate = validator("https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/dossier.schema.json");

  const missingRole = validDossier();
  missingRole.artifacts = missingRole.artifacts.filter(
    (artifact: JsonObject) => artifact.role !== "EVALUATION_ATTESTATION",
  );
  assertInvalid(validate, missingRole);

  const duplicateRole = validDossier();
  duplicateRole.artifacts.push({
    ...duplicateRole.artifacts[0],
    path: "objects/manifest-duplicate.json",
  });
  assertInvalid(validate, duplicateRole);
});

test("a redacted derivative declares the recorder-reported original digest", () => {
  const validate = validator("https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evidence-bundle.schema.json");
  const evidence = validEvidence();
  evidence.captureMode = "CAPTURED_OFFLINE_SANITIZED";
  evidence.artifacts[0].source = {
    systemId: "upstream.example",
    role: "UPSTREAM_EVALUATOR",
    controllerRelationship: "UNESTABLISHED",
    observationMode: "CAPTURED_OFFLINE",
    originAuthentication: "RECORDER_ATTESTED",
    derivation: "REDACTED_DERIVATIVE",
    reportedOriginalDigest: digest,
    authorityStatus: "NON_AUTHORITATIVE",
  };
  assertValid(validate, evidence);

  delete evidence.artifacts[0].source.reportedOriginalDigest;
  assertInvalid(validate, evidence);
});

test("v0.1 attestations and dossiers reject economic actions", () => {
  const attestation = validAttestation();
  attestation.economicAction = "RELEASE";
  assertInvalid(
    validator("https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluation-attestation.schema.json"),
    attestation,
  );

  const dossier = validDossier();
  dossier.economicAction = "REFUND";
  assertInvalid(validator("https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/dossier.schema.json"), dossier);
});
