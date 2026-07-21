import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";

import { digestOfObject, sha256Bytes } from "./canonical.js";
import { publicJwkFromPrivate, signObject } from "./crypto.js";
import { parseJsonStrict } from "./json.js";
import type {
  EvaluationRun,
  JsonObject,
  JsonValue,
  PrivateJwk,
  SourceArtifact,
} from "./types.js";

const REFERENCE_EVALUATOR_ID = "evaldossier-reference-evaluator";
const REFERENCE_PROFILE_ID = "json-artifact-conformance-v0";
const REFERENCE_PROFILE_VERSION = "0.1.0";
const REFERENCE_MAPPING_POLICY_ID = "direct-formal-predicate-v0";
const DEFAULT_AUDIENCE = "evaldossier-offline-demo";

export interface ReferenceEvaluationOptions {
  evaluatorKey: PrivateJwk;
  requesterKey: PrivateJwk;
  deliverablePath: string;
  schemaPath: string;
  audience?: string;
  publishedAt?: string;
  expiresAt?: string;
  requestCreatedAt?: string;
  requestExpiresAt?: string;
  capturedAt?: string;
  issuedAt?: string;
}

interface PredicateResult {
  assessment: "AFFIRMED" | "REJECTED" | "INCONCLUSIVE";
  predicateStatus: "ESTABLISHED_TRUE" | "ESTABLISHED_FALSE" | "UNDETERMINED";
  reasonCode: string;
  limitations: string[];
}

interface SchemaEvaluation extends PredicateResult {
  error?: {
    code: string;
    message: string;
    retryable: false;
  };
}

function assertNonEmpty(bytes: Uint8Array, label: string): void {
  if (bytes.byteLength === 0) {
    throw new Error(`${label} must not be empty`);
  }
  if (bytes.byteLength > 5_242_880) {
    throw new Error(`${label} exceeds the v0.1 artifact size limit`);
  }
}

function assertLocalReferencesOnly(value: JsonValue, pointer = ""): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLocalReferencesOnly(item, `${pointer}/${index}`));
    return;
  }

  if (value === null || typeof value !== "object") {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const childPointer = `${pointer}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if ((key === "$ref" || key === "$dynamicRef") && typeof child === "string" && !child.startsWith("#")) {
      throw new Error(`Remote schema reference is forbidden at ${childPointer}`);
    }
    assertLocalReferencesOnly(child, childPointer);
  }
}

function evaluateAgainstLocalSchema(
  deliverableBytes: Uint8Array,
  schemaBytes: Uint8Array,
): SchemaEvaluation {
  let schema: JsonValue;
  try {
    schema = parseJsonStrict(schemaBytes, "reference JSON Schema");
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
      throw new Error("The committed JSON Schema must be an object");
    }
    assertLocalReferencesOnly(schema);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON Schema error";
    return {
      assessment: "INCONCLUSIVE",
      predicateStatus: "UNDETERMINED",
      reasonCode: "LOCAL_SCHEMA_INVALID",
      limitations: ["The committed schema could not be safely compiled as a local-only JSON Schema."],
      error: {
        code: "LOCAL_SCHEMA_INVALID",
        message: message.slice(0, 500),
        retryable: false,
      },
    };
  }

  let deliverable: JsonValue;
  try {
    deliverable = parseJsonStrict(deliverableBytes, "reference deliverable");
  } catch {
    return {
      assessment: "REJECTED",
      predicateStatus: "ESTABLISHED_FALSE",
      reasonCode: "DELIVERABLE_NOT_STRICT_JSON",
      limitations: ["This result establishes only that the committed bytes are not a strict JSON instance of the committed schema."],
    };
  }

  try {
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      validateFormats: false,
    });
    const validate = ajv.compile(schema);
    const valid = validate(deliverable);
    if (valid) {
      return {
        assessment: "AFFIRMED",
        predicateStatus: "ESTABLISHED_TRUE",
        reasonCode: "LOCAL_JSON_SCHEMA_VALID",
        limitations: ["JSON Schema conformance does not establish the deliverable's broader factual accuracy, quality, or commercial fitness."],
      };
    }
    return {
      assessment: "REJECTED",
      predicateStatus: "ESTABLISHED_FALSE",
      reasonCode: "LOCAL_JSON_SCHEMA_MISMATCH",
      limitations: ["This result is limited to the committed local schema and committed JSON bytes."],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON Schema compilation error";
    return {
      assessment: "INCONCLUSIVE",
      predicateStatus: "UNDETERMINED",
      reasonCode: "LOCAL_SCHEMA_INVALID",
      limitations: ["The committed schema could not be safely compiled as a local-only JSON Schema."],
      error: {
        code: "LOCAL_SCHEMA_INVALID",
        message: message.slice(0, 500),
        retryable: false,
      },
    };
  }
}

function aggregate(results: PredicateResult[]): {
  assessment: "AFFIRMED" | "REJECTED" | "INCONCLUSIVE";
  obligationVerdict: "SATISFIED" | "NOT_SATISFIED" | "INCONCLUSIVE";
  reasonCode: string;
} {
  if (results.some((result) => result.predicateStatus === "ESTABLISHED_FALSE")) {
    return {
      assessment: "REJECTED",
      obligationVerdict: "NOT_SATISFIED",
      reasonCode: "REQUIRED_FORMAL_PREDICATE_FALSE",
    };
  }
  if (results.some((result) => result.predicateStatus === "UNDETERMINED")) {
    return {
      assessment: "INCONCLUSIVE",
      obligationVerdict: "INCONCLUSIVE",
      reasonCode: "REQUIRED_FORMAL_PREDICATE_UNDETERMINED",
    };
  }
  return {
    assessment: "AFFIRMED",
    obligationVerdict: "SATISFIED",
    reasonCode: "ALL_REQUIRED_FORMAL_PREDICATES_TRUE",
  };
}

function signed(payload: JsonObject, key: PrivateJwk): JsonObject {
  return signObject(payload, key);
}

/**
 * Build one deterministic, fully offline native evaluation run.
 *
 * The evaluator establishes only three narrow predicates over committed local
 * bytes: presence, raw-byte digest equality, and local JSON Schema validity.
 */
function buildReferenceEvaluationFromFiles(options: ReferenceEvaluationOptions): EvaluationRun {
  const audience = options.audience ?? DEFAULT_AUDIENCE;
  const publishedAt = options.publishedAt ?? "2026-07-21T12:00:00Z";
  const expiresAt = options.expiresAt ?? "2027-07-21T12:00:00Z";
  const requestCreatedAt = options.requestCreatedAt ?? "2026-07-21T12:00:01Z";
  const requestExpiresAt = options.requestExpiresAt ?? "2026-07-22T12:00:01Z";
  const capturedAt = options.capturedAt ?? "2026-07-21T12:00:01Z";
  const issuedAt = options.issuedAt ?? "2026-07-21T12:00:02Z";

  const deliverableBytes = readFileSync(options.deliverablePath);
  const schemaBytes = readFileSync(options.schemaPath);
  assertNonEmpty(deliverableBytes, "deliverable");
  assertNonEmpty(schemaBytes, "schema");

  const actualDeliverableDigest = sha256Bytes(deliverableBytes);
  const schemaDigest = sha256Bytes(schemaBytes);
  const committedDeliverableDigest = actualDeliverableDigest;
  const committedDeliverableSizeBytes = deliverableBytes.byteLength;

  const evaluatorPublicKey = publicJwkFromPrivate(options.evaluatorKey);
  const requesterPublicKey = publicJwkFromPrivate(options.requesterKey);

  const profile = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.profile-definition/0.1",
      profileId: REFERENCE_PROFILE_ID,
      version: REFERENCE_PROFILE_VERSION,
      title: "Local JSON artifact conformance",
      description:
        "Establishes presence, raw-byte SHA-256 equality, and conformance of committed JSON bytes to a committed local-only JSON Schema. It does not establish broader commercial intent.",
      publishedAt,
      publisher: {
        id: REFERENCE_EVALUATOR_ID,
        key: evaluatorPublicKey,
      },
      signingKeyId: evaluatorPublicKey.kid,
      operation: "EVALUATE",
      resultBindingMode: "DIRECT_PREDICATE_RESULT",
      evaluationClass: "DETERMINISTIC",
      allowedBases: ["FORMAL_PREDICATE"],
      predicates: [
        {
          predicateId: "artifact-present",
          description: "The committed deliverable artifact is present and non-empty.",
          basis: "FORMAL_PREDICATE",
        },
        {
          predicateId: "artifact-digest-matches",
          description: "The deliverable's raw-byte SHA-256 digest and size match the request commitment.",
          basis: "FORMAL_PREDICATE",
        },
        {
          predicateId: "local-json-schema-valid",
          description: "The committed deliverable is strict JSON valid against the committed local-only JSON Schema.",
          basis: "FORMAL_PREDICATE",
        },
      ],
      aggregationPolicy: {
        rule: "ALL_REQUIRED_TRUE",
        unknownHandling: "INCONCLUSIVE_WHEN_REQUIRED_PREDICATE_UNDETERMINED",
        obligationEligibleBases: ["FORMAL_PREDICATE"],
      },
      mappingPolicy: {
        policyId: REFERENCE_MAPPING_POLICY_ID,
        description: "Direct deterministic evaluation; no upstream result is normalized or strengthened.",
      },
      signatureContext: {
        audience,
        nonce: "reference-profile-nonce-0001",
      },
    },
    options.evaluatorKey,
  );
  const profileDigest = digestOfObject(profile);

  const manifest = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.evaluator-manifest/0.1",
      manifestId: "reference-evaluator-manifest-v0",
      evaluatorId: REFERENCE_EVALUATOR_ID,
      evaluatorType: "NATIVE",
      issuedAt: publishedAt,
      expiresAt,
      operator: {
        id: "evaldossier-reference-operator",
        displayName: "EvalDossier reference evaluator",
        relationship: "INTERNAL_REFERENCE_OPERATOR",
      },
      signingKeyId: evaluatorPublicKey.kid,
      keys: [evaluatorPublicKey],
      profiles: [
        {
          id: REFERENCE_PROFILE_ID,
          version: REFERENCE_PROFILE_VERSION,
          digest: profileDigest,
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
      signatureContext: {
        audience,
        nonce: "reference-manifest-nonce-0001",
      },
    },
    options.evaluatorKey,
  );

  const request = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.evaluation-request/0.1",
      requestId: "reference-evaluation-request-v0",
      operation: "EVALUATE",
      createdAt: requestCreatedAt,
      expiresAt: requestExpiresAt,
      requester: {
        id: "evaldossier-demo-requester",
        key: requesterPublicKey,
      },
      signingKeyId: requesterPublicKey.kid,
      targetEvaluatorId: REFERENCE_EVALUATOR_ID,
      profile: {
        id: REFERENCE_PROFILE_ID,
        version: REFERENCE_PROFILE_VERSION,
        digest: profileDigest,
      },
      statement: "Evaluate the committed JSON deliverable against the three required formal predicates.",
      criteria: [
        {
          criterionId: "criterion-artifact-present",
          predicateId: "artifact-present",
          required: true,
          statement: "The deliverable artifact is present and non-empty.",
          parameters: [{ name: "artifact-id", value: "reference-deliverable" }],
        },
        {
          criterionId: "criterion-artifact-digest",
          predicateId: "artifact-digest-matches",
          required: true,
          statement: "The deliverable digest and size match their precommitted values.",
          parameters: [{ name: "artifact-id", value: "reference-deliverable" }],
        },
        {
          criterionId: "criterion-json-schema",
          predicateId: "local-json-schema-valid",
          required: true,
          statement: "The deliverable is valid against the committed local-only JSON Schema.",
          parameters: [
            { name: "artifact-id", value: "reference-deliverable" },
            { name: "schema-artifact-id", value: "reference-deliverable-schema" },
          ],
        },
      ],
      artifacts: [
        {
          artifactId: "reference-deliverable",
          role: "DELIVERABLE",
          mediaType: "application/json",
          commitmentMode: "EXACT_INPUT",
          digest: committedDeliverableDigest,
          sizeBytes: committedDeliverableSizeBytes,
        },
        {
          artifactId: "reference-deliverable-schema",
          role: "SCHEMA",
          mediaType: "application/schema+json",
          commitmentMode: "EXACT_INPUT",
          digest: schemaDigest,
          sizeBytes: schemaBytes.byteLength,
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
      signatureContext: {
        audience,
        nonce: "reference-request-nonce-0001",
      },
    },
    options.requesterKey,
  );

  const sourceArtifacts: SourceArtifact[] = [
    {
      artifactId: "reference-deliverable",
      role: "DELIVERABLE",
      sourcePath: options.deliverablePath,
      dossierPath: "evidence/deliverable.json",
      mediaType: "application/json",
    },
    {
      artifactId: "reference-deliverable-schema",
      role: "SCHEMA",
      sourcePath: options.schemaPath,
      dossierPath: "evidence/deliverable.schema.json",
      mediaType: "application/schema+json",
    },
  ];

  const evidenceBundle = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.evidence-bundle/0.1",
      bundleId: "reference-evidence-bundle-v0",
      requestId: "reference-evaluation-request-v0",
      capturedAt,
      collector: {
        id: "evaldossier-demo-requester",
        key: requesterPublicKey,
      },
      signingKeyId: requesterPublicKey.kid,
      captureMode: "GENERATED_SYNTHETIC",
      artifacts: [
        {
          artifactId: "reference-deliverable",
          role: "DELIVERABLE",
          mediaType: "application/json",
          digest: actualDeliverableDigest,
          sizeBytes: deliverableBytes.byteLength,
          path: "evidence/deliverable.json",
          source: {
            systemId: "evaldossier-reference-fixture",
            role: "REFERENCE_FIXTURE",
            controllerRelationship: "INTERNAL_FIXTURE",
            observationMode: "SYNTHETIC",
            originAuthentication: "SYNTHETIC",
            derivation: "GENERATED",
            authorityStatus: "FORMALLY_DEFINED",
          },
        },
        {
          artifactId: "reference-deliverable-schema",
          role: "SCHEMA",
          mediaType: "application/schema+json",
          digest: schemaDigest,
          sizeBytes: schemaBytes.byteLength,
          path: "evidence/deliverable.schema.json",
          source: {
            systemId: "evaldossier-reference-fixture",
            role: "REFERENCE_FIXTURE",
            controllerRelationship: "INTERNAL_FIXTURE",
            observationMode: "SYNTHETIC",
            originAuthentication: "SYNTHETIC",
            derivation: "GENERATED",
            authorityStatus: "FORMALLY_DEFINED",
          },
        },
      ],
      limitations: [
        "Both artifacts are public synthetic fixtures generated for the local demo.",
        "Fixture provenance does not establish external adoption, neutrality, or commercial authority.",
      ],
      signatureContext: {
        audience,
        nonce: "reference-evidence-nonce-0001",
      },
    },
    options.requesterKey,
  );

  const present: PredicateResult = {
    assessment: "AFFIRMED",
    predicateStatus: "ESTABLISHED_TRUE",
    reasonCode: "ARTIFACT_PRESENT",
    limitations: ["Presence establishes neither authorship nor semantic quality."],
  };
  const digestMatches =
    actualDeliverableDigest.value === committedDeliverableDigest.value &&
    deliverableBytes.byteLength === committedDeliverableSizeBytes;
  const digestResult: PredicateResult = digestMatches
    ? {
        assessment: "AFFIRMED",
        predicateStatus: "ESTABLISHED_TRUE",
        reasonCode: "ARTIFACT_DIGEST_MATCHES",
        limitations: ["Digest equality establishes byte identity only."],
      }
    : {
        assessment: "REJECTED",
        predicateStatus: "ESTABLISHED_FALSE",
        reasonCode: "ARTIFACT_DIGEST_MISMATCH",
        limitations: ["The observed artifact differs from the request commitment in digest or byte length."],
      };
  const schemaResult = evaluateAgainstLocalSchema(deliverableBytes, schemaBytes);
  const aggregateResult = aggregate([present, digestResult, schemaResult]);

  const attestation = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.evaluation-attestation/0.1",
      attestationId: "reference-evaluation-attestation-v0",
      issuedAt,
      evaluator: {
        evaluatorId: REFERENCE_EVALUATOR_ID,
        keyId: evaluatorPublicKey.kid,
        softwareVersion: "0.1.0",
      },
      bindings: {
        manifestDigest: digestOfObject(manifest),
        profileDigest,
        requestDigest: digestOfObject(request),
        evidenceBundleDigest: digestOfObject(evidenceBundle),
      },
      mode: "NATIVE_EVALUATION",
      coverage: {
        status: "COMPLETE",
        assessedCriterionIds: [
          "criterion-artifact-present",
          "criterion-artifact-digest",
          "criterion-json-schema",
        ],
        unassessedCriterionIds: [],
      },
      overallAssessment: {
        assessment: aggregateResult.assessment,
        basis: "FORMAL_PREDICATE",
        reasonCode: aggregateResult.reasonCode,
      },
      obligationVerdict: aggregateResult.obligationVerdict,
      assessments: [
        {
          assessmentId: "assessment-artifact-present",
          criterionId: "criterion-artifact-present",
          statement: "The deliverable artifact is present and non-empty.",
          basis: "FORMAL_PREDICATE",
          assessment: present.assessment,
          predicateStatus: present.predicateStatus,
          reasonCode: present.reasonCode,
          evidenceArtifactIds: ["reference-deliverable"],
          limitations: present.limitations,
        },
        {
          assessmentId: "assessment-artifact-digest",
          criterionId: "criterion-artifact-digest",
          statement: "The observed deliverable digest and size match their signed request commitment.",
          basis: "FORMAL_PREDICATE",
          assessment: digestResult.assessment,
          predicateStatus: digestResult.predicateStatus,
          reasonCode: digestResult.reasonCode,
          evidenceArtifactIds: ["reference-deliverable"],
          limitations: digestResult.limitations,
        },
        {
          assessmentId: "assessment-json-schema",
          criterionId: "criterion-json-schema",
          statement: "The committed deliverable is strict JSON valid against the committed local-only JSON Schema.",
          basis: "FORMAL_PREDICATE",
          assessment: schemaResult.assessment,
          predicateStatus: schemaResult.predicateStatus,
          reasonCode: schemaResult.reasonCode,
          evidenceArtifactIds: ["reference-deliverable", "reference-deliverable-schema"],
          limitations: schemaResult.limitations,
        },
      ],
      ignoredInputs: [],
      errors: schemaResult.error === undefined ? [] : [schemaResult.error],
      limitations: [
        "The evaluator proves only the predicates named in the signed profile over the committed bytes.",
        "A SATISFIED obligation verdict here is protocol-local and is not an instruction to move funds.",
      ],
      economicAction: "OUT_OF_SCOPE",
      signatureContext: {
        audience,
        nonce: "reference-attestation-nonce-0001",
      },
    },
    options.evaluatorKey,
  );

  return {
    manifest,
    profile,
    request,
    evidenceBundle,
    attestation,
    sourceArtifacts,
  };
}

/** Build the repository's deterministic reference run from its committed fixtures. */
export async function buildReferenceEvaluation(
  projectRoot: string,
  evaluatorKey: PrivateJwk,
  requesterKey: PrivateJwk,
): Promise<EvaluationRun> {
  return buildReferenceEvaluationFromFiles({
    evaluatorKey,
    requesterKey,
    deliverablePath: join(projectRoot, "fixtures", "reference", "deliverable.json"),
    schemaPath: join(projectRoot, "fixtures", "reference", "deliverable.schema.json"),
  });
}
