import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const ADAPTER_ID = "evaldossier-model-judgment-fixture-adapter";
const PROFILE_ID = "synthetic-model-judgment-normalization-v0";
const PROFILE_VERSION = "0.1.0";
const MAPPING_POLICY_ID = "synthetic-model-judgment-mapping-v0";
const REQUEST_ARTIFACT_ID = "synthetic-model-request";
const RESPONSE_ARTIFACT_ID = "synthetic-model-response";
const RUBRIC_ARTIFACT_ID = "synthetic-model-rubric";
const DEFAULT_AUDIENCE = "evaldossier-offline-demo";

export interface SyntheticModelJudgmentOptions {
  adapterKey: PrivateJwk;
  requesterKey: PrivateJwk;
  requestFixturePath: string;
  responseFixturePath: string;
  rubricFixturePath: string;
  audience?: string;
  publishedAt?: string;
  expiresAt?: string;
  requestCreatedAt?: string;
  requestExpiresAt?: string;
  generatedAt?: string;
  issuedAt?: string;
}

interface SyntheticClaim {
  fixtureClaimId: string;
  text: string;
  claimType: "qualitative" | "factual_quality" | "compliance";
  supported: boolean;
  confidence: number;
  notes: string;
}

interface ParsedFixture {
  claims: SyntheticClaim[];
  overallResult: "pass" | "fail" | "inconclusive";
}

function asObject(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertExactKeys(object: JsonObject, keys: readonly string[], label: string): void {
  const expected = [...keys].sort();
  const actual = Object.keys(object).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(
      `${label} has an unexpected shape (expected: ${expected.join(", ")}; found: ${actual.join(", ")})`,
    );
  }
}

function asString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function asBoolean(value: JsonValue | undefined, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function asUnitNumber(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number in [0,1]`);
  }
  return value;
}

function asInteger(value: JsonValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
  return value;
}

function asStringArray(value: JsonValue | undefined, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

function assertLiteral(actual: JsonValue | undefined, expected: JsonValue, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} must equal ${JSON.stringify(expected)}`);
  }
}

function decimalConfidence(value: number): string {
  const rendered = value.toFixed(6).replace(/(?:\.0+|(?<=\.[0-9]*?)0+)$/, "");
  if (!/^(?:0(?:\.[0-9]{1,6})?|1(?:\.0{1,6})?)$/.test(rendered)) {
    throw new Error(`Cannot represent synthetic confidence ${value} as a v0.1 decimal string`);
  }
  return rendered;
}

function validateRubricFixture(value: JsonValue): void {
  const root = asObject(value, "synthetic rubric fixture");
  assertExactKeys(root, ["fixtureVersion", "generator", "rubric"], "synthetic rubric fixture");
  assertLiteral(root.fixtureVersion, "evaldossier.synthetic-rubric/0.1", "rubric.fixtureVersion");
  assertLiteral(root.generator, "EvalDossier", "rubric.generator");

  const rubric = asObject(root.rubric, "rubric.rubric");
  assertExactKeys(
    rubric,
    ["engine", "version", "evidenceMode", "dimensions", "supportedSemantics"],
    "rubric.rubric",
  );
  assertLiteral(rubric.engine, "synthetic-model-judge", "rubric.engine");
  asString(rubric.version, "rubric.version");
  assertLiteral(rubric.evidenceMode, "NONE", "rubric.evidenceMode");
  const dimensions = asStringArray(rubric.dimensions, "rubric.dimensions");
  if (dimensions.length === 0) {
    throw new Error("rubric.dimensions must not be empty");
  }
  asString(rubric.supportedSemantics, "rubric.supportedSemantics");
}

function parseSyntheticFixture(
  requestBytes: Uint8Array,
  responseBytes: Uint8Array,
  rubricBytes: Uint8Array,
): ParsedFixture {
  const requestRoot = asObject(parseJsonStrict(requestBytes, "synthetic model request"), "request fixture");
  assertExactKeys(
    requestRoot,
    ["fixtureVersion", "generator", "evidenceSupplied", "request"],
    "request fixture",
  );
  assertLiteral(
    requestRoot.fixtureVersion,
    "evaldossier.synthetic-upstream-request/0.1",
    "request.fixtureVersion",
  );
  assertLiteral(requestRoot.generator, "EvalDossier", "request.generator");
  assertLiteral(requestRoot.evidenceSupplied, false, "request.evidenceSupplied");
  const request = asObject(requestRoot.request, "request.request");
  assertExactKeys(request, ["deliverable", "taskType", "topic"], "request.request");
  asString(request.deliverable, "request.request.deliverable");
  asString(request.taskType, "request.request.taskType");
  asString(request.topic, "request.request.topic");

  const responseRoot = asObject(
    parseJsonStrict(responseBytes, "synthetic model response"),
    "response fixture",
  );
  assertExactKeys(responseRoot, ["fixtureVersion", "generator", "response"], "response fixture");
  assertLiteral(
    responseRoot.fixtureVersion,
    "evaldossier.synthetic-upstream-response/0.1",
    "response.fixtureVersion",
  );
  assertLiteral(responseRoot.generator, "EvalDossier", "response.generator");
  const response = asObject(responseRoot.response, "response.response");
  assertExactKeys(response, ["scoring", "claims"], "response.response");

  const scoring = asObject(response.scoring, "response.response.scoring");
  assertExactKeys(
    scoring,
    [
      "quality_score",
      "confidence_score",
      "missing_evidence_flags",
      "contradiction_flags",
      "result",
      "payout_recommendation",
      "payout_tier",
    ],
    "response.response.scoring",
  );
  asUnitNumber(scoring.quality_score, "response.response.scoring.quality_score");
  asUnitNumber(scoring.confidence_score, "response.response.scoring.confidence_score");
  asStringArray(scoring.missing_evidence_flags, "response.response.scoring.missing_evidence_flags");
  asStringArray(scoring.contradiction_flags, "response.response.scoring.contradiction_flags");
  const overallResult = asString(scoring.result, "response.response.scoring.result");
  if (overallResult !== "pass" && overallResult !== "fail" && overallResult !== "inconclusive") {
    throw new Error("response.response.scoring.result is outside the synthetic fixture vocabulary");
  }
  asString(scoring.payout_recommendation, "response.response.scoring.payout_recommendation");
  asInteger(scoring.payout_tier, "response.response.scoring.payout_tier");

  if (!Array.isArray(response.claims) || response.claims.length === 0 || response.claims.length > 64) {
    throw new Error("response.response.claims must contain between 1 and 64 claims");
  }
  const seenIds = new Set<string>();
  const claims = response.claims.map((entry, index): SyntheticClaim => {
    const claim = asObject(entry, `response.response.claims[${index}]`);
    assertExactKeys(
      claim,
      ["fixture_claim_id", "text", "claim_type", "supported", "confidence", "notes"],
      `response.response.claims[${index}]`,
    );
    const fixtureClaimId = asString(claim.fixture_claim_id, `claims[${index}].fixture_claim_id`);
    if (!/^[A-Za-z][A-Za-z0-9._:-]{2,127}$/.test(fixtureClaimId) || seenIds.has(fixtureClaimId)) {
      throw new Error(`claims[${index}].fixture_claim_id is invalid or duplicated`);
    }
    seenIds.add(fixtureClaimId);
    const claimType = asString(claim.claim_type, `claims[${index}].claim_type`);
    if (claimType !== "qualitative" && claimType !== "factual_quality" && claimType !== "compliance") {
      throw new Error(`claims[${index}].claim_type is outside the synthetic fixture vocabulary`);
    }
    return {
      fixtureClaimId,
      text: asString(claim.text, `claims[${index}].text`),
      claimType,
      supported: asBoolean(claim.supported, `claims[${index}].supported`),
      confidence: asUnitNumber(claim.confidence, `claims[${index}].confidence`),
      notes: asString(claim.notes, `claims[${index}].notes`),
    };
  });

  validateRubricFixture(parseJsonStrict(rubricBytes, "synthetic rubric"));
  return { claims, overallResult };
}

function signed(payload: JsonObject, key: PrivateJwk): JsonObject {
  return signObject(payload, key);
}

function overallMapping(result: ParsedFixture["overallResult"]): {
  assessment: "AFFIRMED" | "REJECTED" | "INCONCLUSIVE";
  reasonCode: string;
} {
  switch (result) {
    case "pass":
      return { assessment: "AFFIRMED", reasonCode: "UPSTREAM_OVERALL_PASS" };
    case "fail":
      return { assessment: "REJECTED", reasonCode: "UPSTREAM_OVERALL_FAIL" };
    case "inconclusive":
      return { assessment: "INCONCLUSIVE", reasonCode: "UPSTREAM_OVERALL_INCONCLUSIVE" };
  }
}

function syntheticSource(): JsonObject {
  return {
    systemId: "evaldossier-synthetic-model-fixture",
    role: "REFERENCE_FIXTURE",
    controllerRelationship: "INTERNAL_FIXTURE",
    observationMode: "SYNTHETIC",
    originAuthentication: "SYNTHETIC",
    derivation: "GENERATED",
    authorityStatus: "NON_AUTHORITATIVE",
  };
}

/** Normalize a project-authored synthetic upstream-style model judgment. */
function buildSyntheticModelJudgmentFromFiles(options: SyntheticModelJudgmentOptions): EvaluationRun {
  const audience = options.audience ?? DEFAULT_AUDIENCE;
  const publishedAt = options.publishedAt ?? "2026-07-21T12:05:00Z";
  const expiresAt = options.expiresAt ?? "2027-07-21T12:05:00Z";
  const requestCreatedAt = options.requestCreatedAt ?? "2026-07-21T12:10:00Z";
  const requestExpiresAt = options.requestExpiresAt ?? "2026-07-22T12:10:00Z";
  const generatedAt = options.generatedAt ?? "2026-07-21T12:10:01Z";
  const issuedAt = options.issuedAt ?? "2026-07-21T12:10:02Z";

  const requestBytes = readFileSync(options.requestFixturePath);
  const responseBytes = readFileSync(options.responseFixturePath);
  const rubricBytes = readFileSync(options.rubricFixturePath);
  for (const [label, bytes] of [
    ["request fixture", requestBytes],
    ["response fixture", responseBytes],
    ["rubric fixture", rubricBytes],
  ] as const) {
    if (bytes.byteLength === 0 || bytes.byteLength > 5_242_880) {
      throw new Error(`${label} is empty or exceeds the v0.1 artifact size limit`);
    }
  }

  const fixture = parseSyntheticFixture(requestBytes, responseBytes, rubricBytes);
  const adapterPublicKey = publicJwkFromPrivate(options.adapterKey);
  const requesterPublicKey = publicJwkFromPrivate(options.requesterKey);

  const profile = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.profile-definition/0.1",
      profileId: PROFILE_ID,
      version: PROFILE_VERSION,
      title: "Synthetic no-evidence model-judgment normalization",
      description:
        "Preserves a project-authored synthetic upstream-style assessment as MODEL_JUDGMENT without upgrading it to factual truth. The fixture demonstrates the normalization boundary and makes no claim about an external provider.",
      publishedAt,
      publisher: { id: ADAPTER_ID, key: adapterPublicKey },
      signingKeyId: adapterPublicKey.kid,
      operation: "NORMALIZE",
      resultBindingMode: "PRESERVE_UPSTREAM_ASSESSMENT",
      evaluationClass: "UPSTREAM_NORMALIZATION",
      allowedBases: ["MODEL_JUDGMENT"],
      predicates: [
        {
          predicateId: "source-claim-assessment",
          description:
            "Preserve the synthetic source's supported boolean as a typed assessment, not as an established predicate.",
          basis: "MODEL_JUDGMENT",
        },
      ],
      aggregationPolicy: {
        rule: "PRESERVE_UPSTREAM_OVERALL",
        unknownHandling: "INCONCLUSIVE_WHEN_REQUIRED_PREDICATE_UNDETERMINED",
        obligationEligibleBases: [],
      },
      mappingPolicy: {
        policyId: MAPPING_POLICY_ID,
        description:
          "Map synthetic supported booleans to AFFIRMED or REJECTED MODEL_JUDGMENT assessments; force every predicateStatus to UNDETERMINED; preserve the aggregate result; never map payout fields to a recommendation or action.",
      },
      signatureContext: { audience, nonce: "model-judgment-profile-nonce-0001" },
    },
    options.adapterKey,
  );
  const profileDigest = digestOfObject(profile);

  const manifest = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.evaluator-manifest/0.1",
      manifestId: "model-judgment-adapter-manifest-v0",
      evaluatorId: ADAPTER_ID,
      evaluatorType: "ADAPTER",
      issuedAt: publishedAt,
      expiresAt,
      operator: {
        id: "evaldossier-adapter-operator",
        displayName: "EvalDossier synthetic fixture adapter",
        relationship: "INTERNAL_REFERENCE_OPERATOR",
      },
      signingKeyId: adapterPublicKey.kid,
      keys: [adapterPublicKey],
      profiles: [{ id: PROFILE_ID, version: PROFILE_VERSION, digest: profileDigest }],
      software: {
        name: "evaldossier-model-judgment-fixture-adapter",
        version: "0.1.0",
        sourceVisibility: "OPEN_SOURCE",
      },
      dataPractices: {
        acceptedClassifications: ["PUBLIC_SYNTHETIC"],
        trainingUse: false,
        networkUse: false,
      },
      signatureContext: { audience, nonce: "model-judgment-manifest-nonce-0001" },
    },
    options.adapterKey,
  );

  const requestArtifacts = [
    {
      artifactId: REQUEST_ARTIFACT_ID,
      role: "UPSTREAM_REQUEST",
      mediaType: "application/json",
      commitmentMode: "EXACT_INPUT",
      digest: sha256Bytes(requestBytes),
      sizeBytes: requestBytes.byteLength,
    },
    {
      artifactId: RESPONSE_ARTIFACT_ID,
      role: "UPSTREAM_RESPONSE",
      mediaType: "application/json",
      commitmentMode: "EXACT_INPUT",
      digest: sha256Bytes(responseBytes),
      sizeBytes: responseBytes.byteLength,
    },
    {
      artifactId: RUBRIC_ARTIFACT_ID,
      role: "POLICY",
      mediaType: "application/json",
      commitmentMode: "EXACT_INPUT",
      digest: sha256Bytes(rubricBytes),
      sizeBytes: rubricBytes.byteLength,
    },
  ];
  const observedArtifacts = requestArtifacts.map(
    ({ commitmentMode: _commitmentMode, ...artifact }) => artifact,
  );
  const criterionIds = fixture.claims.map((claim) => `criterion-${claim.fixtureClaimId}`);

  const request = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.evaluation-request/0.1",
      requestId: "model-judgment-normalization-request-v0",
      operation: "NORMALIZE",
      createdAt: requestCreatedAt,
      expiresAt: requestExpiresAt,
      requester: { id: "evaldossier-demo-requester", key: requesterPublicKey },
      signingKeyId: requesterPublicKey.kid,
      targetEvaluatorId: ADAPTER_ID,
      profile: { id: PROFILE_ID, version: PROFILE_VERSION, digest: profileDigest },
      statement:
        "Normalize the exact synthetic model-judgment fixture without establishing factual truth or recommending an economic action.",
      criteria: fixture.claims.map((claim, index) => ({
        criterionId: criterionIds[index] as string,
        predicateId: "source-claim-assessment",
        required: true,
        statement: claim.text,
        parameters: [
          { name: "claim-index", value: index },
          { name: "supported-pointer", value: `/response/claims/${index}/supported` },
          { name: "confidence-pointer", value: `/response/claims/${index}/confidence` },
          { name: "notes-pointer", value: `/response/claims/${index}/notes` },
        ],
      })),
      artifacts: requestArtifacts,
      privacy: { classification: "PUBLIC_SYNTHETIC", trainingUse: false },
      economicBoundary: {
        paymentExecution: "OUT_OF_SCOPE",
        paymentRecommendation: "OUT_OF_SCOPE",
      },
      signatureContext: { audience, nonce: "model-judgment-request-nonce-0001" },
    },
    options.requesterKey,
  );

  const sourceArtifacts: SourceArtifact[] = [
    {
      artifactId: REQUEST_ARTIFACT_ID,
      role: "UPSTREAM_REQUEST",
      sourcePath: options.requestFixturePath,
      dossierPath: "evidence/model-request.json",
      mediaType: "application/json",
    },
    {
      artifactId: RESPONSE_ARTIFACT_ID,
      role: "UPSTREAM_RESPONSE",
      sourcePath: options.responseFixturePath,
      dossierPath: "evidence/model-response.json",
      mediaType: "application/json",
    },
    {
      artifactId: RUBRIC_ARTIFACT_ID,
      role: "POLICY",
      sourcePath: options.rubricFixturePath,
      dossierPath: "evidence/model-rubric.json",
      mediaType: "application/json",
    },
  ];

  const evidenceBundle = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.evidence-bundle/0.1",
      bundleId: "synthetic-model-judgment-evidence-v0",
      requestId: "model-judgment-normalization-request-v0",
      capturedAt: generatedAt,
      collector: { id: "evaldossier-demo-requester", key: requesterPublicKey },
      signingKeyId: requesterPublicKey.kid,
      captureMode: "GENERATED_SYNTHETIC",
      artifacts: [
        { ...observedArtifacts[0], path: "evidence/model-request.json", source: syntheticSource() },
        { ...observedArtifacts[1], path: "evidence/model-response.json", source: syntheticSource() },
        { ...observedArtifacts[2], path: "evidence/model-rubric.json", source: syntheticSource() },
      ],
      limitations: [
        "Every source artifact is generated by this project and represents no external evaluator or production event.",
        "The fixture demonstrates type-preserving normalization, not model quality, origin, adoption, or demand.",
      ],
      signatureContext: { audience, nonce: "model-judgment-evidence-nonce-0001" },
    },
    options.requesterKey,
  );

  const upstreamOverall = overallMapping(fixture.overallResult);
  const assessments = fixture.claims.map((claim, index) => ({
    assessmentId: `assessment-${claim.fixtureClaimId}`,
    criterionId: criterionIds[index] as string,
    statement: claim.text,
    basis: "MODEL_JUDGMENT",
    assessment: claim.supported ? "AFFIRMED" : "REJECTED",
    predicateStatus: "UNDETERMINED",
    reasonCode: claim.supported ? "UPSTREAM_SUPPORTED_TRUE" : "UPSTREAM_SUPPORTED_FALSE",
    evidenceArtifactIds: [RESPONSE_ARTIFACT_ID, RUBRIC_ARTIFACT_ID],
    confidence: {
      value: decimalConfidence(claim.confidence),
      scale: "0_TO_1",
      calibration: "UPSTREAM_REPORTED_UNVERIFIED",
    },
    upstreamMapping: {
      sourceArtifactId: RESPONSE_ARTIFACT_ID,
      nativePointer: `/response/claims/${index}/supported`,
      nativeValue: claim.supported,
      mappingPolicyId: MAPPING_POLICY_ID,
    },
    limitations: [
      `Synthetic claim type: ${claim.claimType}. Synthetic source note: ${claim.notes}`,
      "No evidence was supplied. The supported boolean is preserved as a model judgment, not factual proof.",
    ],
  }));

  const attestation = signed(
    {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.evaluation-attestation/0.1",
      attestationId: "model-judgment-normalization-attestation-v0",
      issuedAt,
      evaluator: {
        evaluatorId: ADAPTER_ID,
        keyId: adapterPublicKey.kid,
        softwareVersion: "0.1.0",
      },
      bindings: {
        manifestDigest: digestOfObject(manifest),
        profileDigest,
        requestDigest: digestOfObject(request),
        evidenceBundleDigest: digestOfObject(evidenceBundle),
      },
      mode: "UPSTREAM_NORMALIZATION",
      coverage: {
        status: "COMPLETE",
        assessedCriterionIds: criterionIds,
        unassessedCriterionIds: [],
      },
      overallAssessment: {
        assessment: upstreamOverall.assessment,
        basis: "MODEL_JUDGMENT",
        reasonCode: upstreamOverall.reasonCode,
        upstreamMapping: {
          sourceArtifactId: RESPONSE_ARTIFACT_ID,
          nativePointer: "/response/scoring/result",
          nativeValue: fixture.overallResult,
          mappingPolicyId: MAPPING_POLICY_ID,
        },
      },
      obligationVerdict: "INCONCLUSIVE",
      assessments,
      ignoredInputs: [
        {
          pointer: "/response/scoring/quality_score",
          reason: "Synthetic aggregate score is retained but is not used to establish a predicate.",
        },
        {
          pointer: "/response/scoring/confidence_score",
          reason: "Synthetic aggregate confidence is retained but is not a calibrated probability.",
        },
        {
          pointer: "/response/scoring/missing_evidence_flags",
          reason: "Synthetic diagnostic prose is not a formal predicate result.",
        },
        {
          pointer: "/response/scoring/contradiction_flags",
          reason: "Synthetic diagnostic prose is not a formal predicate result.",
        },
        {
          pointer: "/response/scoring/payout_recommendation",
          reason: "Synthetic payout language is source data only and never crosses the economic boundary.",
        },
        {
          pointer: "/response/scoring/payout_tier",
          reason: "Synthetic payout tier is source data only and never crosses the economic boundary.",
        },
      ],
      errors: [],
      limitations: [
        "The adapter signature commits to normalization of project-authored synthetic bytes; it proves neither factual truth nor external execution.",
        "No evidence was supplied, so every MODEL_JUDGMENT predicate remains UNDETERMINED.",
        "Confidence values are synthetic, unverified, and uncalibrated.",
        `Coverage COMPLETE refers only to the ${fixture.claims.length} synthetic claim criteria.`,
        "The fixture makes no claim about any external provider, integration, production event, adoption, or demand.",
      ],
      economicAction: "OUT_OF_SCOPE",
      signatureContext: { audience, nonce: "model-judgment-attestation-nonce-0001" },
    },
    options.adapterKey,
  );

  return { manifest, profile, request, evidenceBundle, attestation, sourceArtifacts };
}

/** Build the deterministic offline normalization run from project-authored fixtures. */
export async function buildSyntheticModelJudgmentNormalization(
  projectRoot: string,
  adapterKey: PrivateJwk,
  requesterKey: PrivateJwk,
): Promise<EvaluationRun> {
  const fixtureRoot = join(projectRoot, "fixtures", "model-judgment", "no-evidence-synthetic");
  return buildSyntheticModelJudgmentFromFiles({
    adapterKey,
    requesterKey,
    requestFixturePath: join(fixtureRoot, "request.json"),
    responseFixturePath: join(fixtureRoot, "response.json"),
    rubricFixturePath: join(fixtureRoot, "rubric.json"),
  });
}
