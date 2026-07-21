import { digestOfObject, sha256Bytes } from "./canonical.js";
import {
  publicJwkFromPrivate,
  signObject,
  verifyObjectSignature,
} from "./crypto.js";
import {
  assembleDossier,
  verifyDossier,
  type AssembleDossierOptions,
  type VerifiedDossier,
} from "./dossier.js";
import { validateProtocolObject } from "./schema-validator.js";
import { summarizeAttestation } from "./report.js";
import {
  PROTOCOL_VERSION,
  type Digest,
  type EvaluationRun,
  type JsonObject,
  type PrivateEd25519Jwk,
  type ProtocolSchemaVersion,
  type PublicEd25519Jwk,
} from "./types.js";

const EVALUATOR_ID_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{2,127}$/;

export const SDK_PROTOCOL_SCHEMA_VERSIONS = Object.freeze({
  "evaluator-manifest": "evaldossier.evaluator-manifest/0.1",
  "profile-definition": "evaldossier.profile-definition/0.1",
  "evaluation-request": "evaldossier.evaluation-request/0.1",
  "evidence-bundle": "evaldossier.evidence-bundle/0.1",
  "evaluation-attestation": "evaldossier.evaluation-attestation/0.1",
} as const satisfies Record<string, ProtocolSchemaVersion>);

export type IssuableProtocolObjectKind = keyof typeof SDK_PROTOCOL_SCHEMA_VERSIONS;

/**
 * Payload accepted by createSignedProtocolObject.
 *
 * The SDK owns the protocol version, schema version and proof members so a
 * caller cannot accidentally sign an object under the wrong protocol type.
 */
export type ProtocolObjectPayload = JsonObject & {
  protocolVersion?: never;
  schemaVersion?: never;
  proof?: never;
};

export type MaybePromise<T> = T | Promise<T>;

/** A local evaluator or offline adapter capable of producing one complete run. */
export interface EvaluatorDefinition<Input> {
  evaluatorId: string;
  evaluate(input: Input): MaybePromise<EvaluationRun>;
}

export interface RunEvaluatorOptions {
  /** Must not already exist. The core creates it with exclusive mkdir semantics. */
  outputDirectory: string;
  /** Exporter key used only for the top-level dossier signature. */
  exporterKey: PrivateEd25519Jwk;
  /** Signed dossier context and metadata. */
  dossier: AssembleDossierOptions;
}

export interface EvaluatorExecution {
  evaluatorId: string;
  outputDirectory: string;
  run: EvaluationRun;
  dossier: JsonObject;
  verified: VerifiedDossier;
}

export interface ConformanceExpectations {
  bases?: readonly string[];
  overallBasis?: string;
  predicateStatuses?: readonly string[];
  obligationVerdict?: string;
}

export type ConformanceCheckId =
  | "EVALUATOR_ID_BOUND"
  | "SCHEMAS_VALID"
  | "INTEGRITY_VALID"
  | "SIGNATURES_VALID"
  | "AUDIENCE_PINNED"
  | "DOSSIER_NONCE_PINNED"
  | "ECONOMIC_ACTION_OUT_OF_SCOPE"
  | "EXPECTED_BASES"
  | "EXPECTED_OVERALL_BASIS"
  | "EXPECTED_PREDICATE_STATUSES"
  | "EXPECTED_OBLIGATION_VERDICT";

export interface ConformanceCheck {
  id: ConformanceCheckId;
  status: "PASS";
}

export interface EvaluatorConformanceResult extends EvaluatorExecution {
  status: "PASS";
  checks: ConformanceCheck[];
}

export type EvaluatorSdkErrorCode =
  | "INVALID_EVALUATOR_ID"
  | "INVALID_EVALUATION_RUN"
  | "INVALID_EVALUATOR_OPTIONS"
  | "INVALID_PROTOCOL_PAYLOAD"
  | "INVALID_PROTOCOL_OBJECT"
  | "EVALUATOR_ID_MISMATCH"
  | "CONFORMANCE_EXPECTATION_FAILED";

export class EvaluatorSdkError extends Error {
  readonly code: EvaluatorSdkErrorCode;

  constructor(code: EvaluatorSdkErrorCode, message: string) {
    super(message);
    this.name = "EvaluatorSdkError";
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringMember(value: JsonObject, member: string, label: string): string {
  const candidate = value[member];
  if (typeof candidate !== "string") {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATION_RUN",
      `${label}.${member} must be a string`,
    );
  }
  return candidate;
}

function objectMember(value: JsonObject, member: string, label: string): JsonObject {
  const candidate = value[member];
  if (!isObject(candidate)) {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATION_RUN",
      `${label}.${member} must be an object`,
    );
  }
  return candidate;
}

function assertEvaluatorId(evaluatorId: unknown): asserts evaluatorId is string {
  if (
    typeof evaluatorId !== "string" ||
    !EVALUATOR_ID_PATTERN.test(evaluatorId)
  ) {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATOR_ID",
      "evaluatorId must satisfy the EvalDossier identifier grammar",
    );
  }
}

function snapshot<T>(
  value: T,
  code: EvaluatorSdkErrorCode,
  label: string,
): T {
  try {
    return structuredClone(value);
  } catch {
    throw new EvaluatorSdkError(code, `${label} must be structured-cloneable data`);
  }
}

function schemaErrorText(
  errors: Array<{ instancePath: string; message: string }>,
): string {
  return errors
    .map((error) => `${error.instancePath || "/"}: ${error.message}`)
    .join("; ");
}

/**
 * Add the fixed v0.1 protocol envelope, sign it and validate the result against
 * the bundled local schema. This function does not establish signer identity or
 * the truth of the payload.
 */
export async function createSignedProtocolObject(
  kind: IssuableProtocolObjectKind,
  payload: ProtocolObjectPayload,
  signingKey: PrivateEd25519Jwk,
): Promise<JsonObject> {
  if (
    typeof kind !== "string" ||
    !Object.hasOwn(SDK_PROTOCOL_SCHEMA_VERSIONS, kind)
  ) {
    throw new EvaluatorSdkError(
      "INVALID_PROTOCOL_PAYLOAD",
      "unsupported protocol object kind",
    );
  }
  if (!isObject(payload)) {
    throw new EvaluatorSdkError(
      "INVALID_PROTOCOL_PAYLOAD",
      "protocol payload must be a JSON object",
    );
  }
  const safePayload = snapshot(
    payload,
    "INVALID_PROTOCOL_PAYLOAD",
    "protocol payload",
  );
  const safeSigningKey = snapshot(
    signingKey,
    "INVALID_PROTOCOL_PAYLOAD",
    "signing key",
  );
  for (const reserved of ["protocolVersion", "schemaVersion", "proof"] as const) {
    if (Object.hasOwn(safePayload, reserved)) {
      throw new EvaluatorSdkError(
        "INVALID_PROTOCOL_PAYLOAD",
        `${reserved} is owned by the SDK and must not be supplied`,
      );
    }
  }

  const schemaVersion = SDK_PROTOCOL_SCHEMA_VERSIONS[kind];
  const signed = signObject(
    {
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion,
      ...safePayload,
    },
    safeSigningKey,
  );
  const validation = await validateProtocolObject(signed, schemaVersion);
  if (!validation.valid) {
    throw new EvaluatorSdkError(
      "INVALID_PROTOCOL_OBJECT",
      `${kind} failed protocol validation: ${schemaErrorText(validation.errors)}`,
    );
  }
  try {
    if (!verifyObjectSignature(signed, publicJwkFromPrivate(safeSigningKey)).valid) {
      throw new EvaluatorSdkError(
        "INVALID_PROTOCOL_OBJECT",
        `${kind} signature did not verify after creation`,
      );
    }
  } catch (error) {
    if (error instanceof EvaluatorSdkError) {
      throw error;
    }
    throw new EvaluatorSdkError(
      "INVALID_PROTOCOL_OBJECT",
      `${kind} signature did not verify after creation`,
    );
  }
  return signed;
}

/** Digest a complete signed protocol object using EvalDossier canonical JSON. */
export function protocolObjectDigest(value: JsonObject): Digest {
  return digestOfObject(value);
}

/** Digest exact artifact bytes for request and evidence commitments. */
export function artifactDigest(value: Uint8Array | string): Digest {
  return sha256Bytes(value);
}

/** Derive the public signing JWK without retaining the private component. */
export function publicSigningKey(key: PrivateEd25519Jwk): PublicEd25519Jwk {
  return publicJwkFromPrivate(key);
}

/**
 * Define an evaluator without registering it globally or granting it authority.
 * The returned object is frozen to prevent accidental runtime replacement.
 */
export function defineEvaluator<Input>(
  definition: EvaluatorDefinition<Input>,
): Readonly<EvaluatorDefinition<Input>> {
  if (definition === null || typeof definition !== "object") {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATION_RUN",
      "evaluator definition must be an object",
    );
  }
  const evaluatorId: unknown = definition.evaluatorId;
  const evaluate: unknown = definition.evaluate;
  assertEvaluatorId(evaluatorId);
  if (typeof evaluate !== "function") {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATION_RUN",
      "evaluator definition must provide an evaluate function",
    );
  }
  return Object.freeze({
    evaluatorId,
    evaluate: evaluate as EvaluatorDefinition<Input>["evaluate"],
  });
}

const RUN_OBJECTS = [
  ["manifest", "evaldossier.evaluator-manifest/0.1"],
  ["profile", "evaldossier.profile-definition/0.1"],
  ["request", "evaldossier.evaluation-request/0.1"],
  ["evidenceBundle", "evaldossier.evidence-bundle/0.1"],
  ["attestation", "evaldossier.evaluation-attestation/0.1"],
] as const satisfies ReadonlyArray<readonly [keyof EvaluationRun, ProtocolSchemaVersion]>;

async function assertEvaluationRun(
  run: EvaluationRun,
  expectedEvaluatorId: string,
): Promise<void> {
  if (!isObject(run) || !Array.isArray(run.sourceArtifacts)) {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATION_RUN",
      "evaluator must return a complete EvaluationRun",
    );
  }

  for (const [member, schemaVersion] of RUN_OBJECTS) {
    const value = run[member];
    if (!isObject(value)) {
      throw new EvaluatorSdkError(
        "INVALID_EVALUATION_RUN",
        `evaluation run member ${member} must be a JSON object`,
      );
    }
    const validation = await validateProtocolObject(value, schemaVersion);
    if (!validation.valid) {
      throw new EvaluatorSdkError(
        "INVALID_PROTOCOL_OBJECT",
        `${member} failed protocol validation: ${schemaErrorText(validation.errors)}`,
      );
    }
  }

  const manifestEvaluatorId = stringMember(run.manifest, "evaluatorId", "manifest");
  const requestEvaluatorId = stringMember(run.request, "targetEvaluatorId", "request");
  const attestationEvaluator = objectMember(run.attestation, "evaluator", "attestation");
  const attestationEvaluatorId = stringMember(
    attestationEvaluator,
    "evaluatorId",
    "attestation.evaluator",
  );
  const observedIds = [manifestEvaluatorId, requestEvaluatorId, attestationEvaluatorId];
  if (observedIds.some((value) => value !== expectedEvaluatorId)) {
    throw new EvaluatorSdkError(
      "EVALUATOR_ID_MISMATCH",
      `evaluator definition ${expectedEvaluatorId} does not match the signed run identities`,
    );
  }
}

interface PreparedEvaluation {
  evaluatorId: string;
  run: EvaluationRun;
  options: RunEvaluatorOptions;
}

function captureEvaluator<Input>(evaluator: EvaluatorDefinition<Input>): {
  evaluatorId: string;
  evaluate(input: Input): MaybePromise<EvaluationRun>;
} {
  if (evaluator === null || typeof evaluator !== "object") {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATION_RUN",
      "evaluator definition must be an object",
    );
  }
  const evaluatorId: unknown = evaluator.evaluatorId;
  const evaluate: unknown = evaluator.evaluate;
  assertEvaluatorId(evaluatorId);
  if (typeof evaluate !== "function") {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATION_RUN",
      "evaluator definition must provide an evaluate function",
    );
  }
  return {
    evaluatorId,
    evaluate: (input: Input) => Reflect.apply(evaluate, evaluator, [input]),
  };
}

function snapshotOptions(options: RunEvaluatorOptions): RunEvaluatorOptions {
  const captured = snapshot<unknown>(
    options,
    "INVALID_EVALUATOR_OPTIONS",
    "evaluator options",
  );
  if (
    !isObject(captured) ||
    typeof captured.outputDirectory !== "string" ||
    captured.outputDirectory.length === 0 ||
    !isObject(captured.exporterKey) ||
    !isObject(captured.dossier)
  ) {
    throw new EvaluatorSdkError(
      "INVALID_EVALUATOR_OPTIONS",
      "evaluator options must include an output directory, exporter key and dossier metadata",
    );
  }
  return captured as unknown as RunEvaluatorOptions;
}

function snapshotEvaluationRun(value: unknown): EvaluationRun {
  return snapshot<unknown>(
    value,
    "INVALID_EVALUATION_RUN",
    "evaluation run",
  ) as EvaluationRun;
}

function capturePromiseLike<T>(value: MaybePromise<T>): Promise<T> | undefined {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  const then = (value as PromiseLike<T>).then;
  if (typeof then !== "function") {
    return undefined;
  }
  return new Promise<T>((resolve, reject) => {
    try {
      Reflect.apply(then, value, [resolve, reject]);
    } catch (error) {
      reject(error);
    }
  });
}

async function prepareEvaluation<Input>(
  evaluator: EvaluatorDefinition<Input>,
  input: Input,
  options: RunEvaluatorOptions,
): Promise<PreparedEvaluation> {
  const capturedEvaluator = captureEvaluator(evaluator);
  const capturedOptions = snapshotOptions(options);
  const returned = capturedEvaluator.evaluate(input);
  const pending = capturePromiseLike(returned);
  const run = snapshotEvaluationRun(
    pending === undefined ? returned : await pending,
  );
  await assertEvaluationRun(run, capturedEvaluator.evaluatorId);
  return {
    evaluatorId: capturedEvaluator.evaluatorId,
    run,
    options: capturedOptions,
  };
}

async function materializeEvaluation(
  prepared: PreparedEvaluation,
): Promise<EvaluatorExecution> {
  const { evaluatorId, run, options } = prepared;
  const dossier = await assembleDossier(
    run,
    options.outputDirectory,
    options.exporterKey,
    options.dossier,
  );
  const verified = await verifyDossier(options.outputDirectory, {
    expectedAudience: options.dossier.audience,
    expectedDossierNonce: options.dossier.nonce,
  });
  return {
    evaluatorId,
    outputDirectory: options.outputDirectory,
    run,
    dossier,
    verified,
  };
}

/**
 * Execute one local evaluator, assemble its signed dossier and immediately
 * verify it with the caller's audience and nonce pinned.
 *
 * No network requests, registry writes, economic actions or key persistence are
 * performed by this orchestration layer.
 */
export async function runEvaluator<Input>(
  evaluator: EvaluatorDefinition<Input>,
  input: Input,
  options: RunEvaluatorOptions,
): Promise<EvaluatorExecution> {
  return materializeEvaluation(await prepareEvaluation(evaluator, input, options));
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function assertEqualString(
  label: string,
  actual: string,
  expected: string,
): void {
  if (actual !== expected) {
    throw new EvaluatorSdkError(
      "CONFORMANCE_EXPECTATION_FAILED",
      `${label}: expected ${expected}, received ${actual}`,
    );
  }
}

function assertEqualStrings(
  label: string,
  actual: readonly string[],
  expected: readonly string[],
): void {
  const actualSorted = sorted(actual);
  const expectedSorted = sorted(expected);
  if (
    actualSorted.length !== expectedSorted.length ||
    actualSorted.some((value, index) => value !== expectedSorted[index])
  ) {
    throw new EvaluatorSdkError(
      "CONFORMANCE_EXPECTATION_FAILED",
      `${label}: expected ${expectedSorted.join(", ")}, received ${actualSorted.join(", ")}`,
    );
  }
}

function snapshotExpectations(
  expectations: ConformanceExpectations,
): ConformanceExpectations {
  const captured = snapshot<unknown>(
    expectations,
    "CONFORMANCE_EXPECTATION_FAILED",
    "conformance expectations",
  );
  if (!isObject(captured)) {
    throw new EvaluatorSdkError(
      "CONFORMANCE_EXPECTATION_FAILED",
      "conformance expectations must be an object",
    );
  }
  const allowedMembers = new Set([
    "bases",
    "overallBasis",
    "predicateStatuses",
    "obligationVerdict",
  ]);
  for (const member of Object.keys(captured)) {
    if (!allowedMembers.has(member)) {
      throw new EvaluatorSdkError(
        "CONFORMANCE_EXPECTATION_FAILED",
        `unknown conformance expectation: ${member}`,
      );
    }
  }
  for (const member of ["overallBasis", "obligationVerdict"] as const) {
    if (captured[member] !== undefined && typeof captured[member] !== "string") {
      throw new EvaluatorSdkError(
        "CONFORMANCE_EXPECTATION_FAILED",
        `${member} expectation must be a string`,
      );
    }
  }
  for (const member of ["bases", "predicateStatuses"] as const) {
    const value = captured[member];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    ) {
      throw new EvaluatorSdkError(
        "CONFORMANCE_EXPECTATION_FAILED",
        `${member} expectation must be an array of strings`,
      );
    }
  }
  return captured as unknown as ConformanceExpectations;
}

interface DeclaredSemanticSummary {
  bases: readonly string[];
  overallBasis: string;
  predicateStatuses: readonly string[];
  obligationVerdict: string;
}

function assertSemanticExpectations(
  summary: DeclaredSemanticSummary,
  expectations: ConformanceExpectations,
): ConformanceCheck[] {
  const checks: ConformanceCheck[] = [];
  if (expectations.bases !== undefined) {
    assertEqualStrings("bases", summary.bases, expectations.bases);
    checks.push({ id: "EXPECTED_BASES", status: "PASS" });
  }
  if (expectations.overallBasis !== undefined) {
    assertEqualString("overallBasis", summary.overallBasis, expectations.overallBasis);
    checks.push({ id: "EXPECTED_OVERALL_BASIS", status: "PASS" });
  }
  if (expectations.predicateStatuses !== undefined) {
    assertEqualStrings(
      "predicateStatuses",
      summary.predicateStatuses,
      expectations.predicateStatuses,
    );
    checks.push({ id: "EXPECTED_PREDICATE_STATUSES", status: "PASS" });
  }
  if (expectations.obligationVerdict !== undefined) {
    assertEqualString(
      "obligationVerdict",
      summary.obligationVerdict,
      expectations.obligationVerdict,
    );
    checks.push({ id: "EXPECTED_OBLIGATION_VERDICT", status: "PASS" });
  }
  return checks;
}

/**
 * Run the end-to-end conformance path and assert the semantic result expected by
 * the evaluator author. Success means structural and declared-semantic
 * conformance only; it does not certify independence, identity or factual truth.
 */
export async function assertEvaluatorConformance<Input>(
  evaluator: EvaluatorDefinition<Input>,
  input: Input,
  options: RunEvaluatorOptions,
  expectations: ConformanceExpectations = {},
): Promise<EvaluatorConformanceResult> {
  const capturedExpectations = snapshotExpectations(expectations);
  const prepared = await prepareEvaluation(evaluator, input, options);
  assertSemanticExpectations(
    summarizeAttestation(prepared.run.attestation),
    capturedExpectations,
  );
  const execution = await materializeEvaluation(prepared);
  const summary = execution.verified.summary;
  assertEqualString("schema", summary.schema, "VALID");
  assertEqualString("integrity", summary.integrity, "VALID");
  assertEqualString("signatures", summary.signatures, "VALID");
  assertEqualString("audienceBinding", summary.audienceBinding, "PINNED");
  assertEqualString(
    "dossierNonceBinding",
    summary.dossierNonceBinding,
    "PINNED",
  );
  assertEqualString("economicAction", summary.economicAction, "OUT_OF_SCOPE");
  const checks: ConformanceCheck[] = [
    { id: "EVALUATOR_ID_BOUND", status: "PASS" },
    { id: "SCHEMAS_VALID", status: "PASS" },
    { id: "INTEGRITY_VALID", status: "PASS" },
    { id: "SIGNATURES_VALID", status: "PASS" },
    { id: "AUDIENCE_PINNED", status: "PASS" },
    { id: "DOSSIER_NONCE_PINNED", status: "PASS" },
    { id: "ECONOMIC_ACTION_OUT_OF_SCOPE", status: "PASS" },
  ];
  checks.push(...assertSemanticExpectations(summary, capturedExpectations));

  return {
    ...execution,
    status: "PASS",
    checks,
  };
}
