import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  canonicalBytes,
  digestOfObject,
  sha256Bytes,
} from "./canonical.js";
import {
  publicJwkFromPrivate,
  signObject,
  verifyObjectSignature,
} from "./crypto.js";
import { readSafeDossierFile, validateDossierRelativePath } from "./fs-safe.js";
import { parseJsonStrict } from "./json.js";
import { renderAttestationReport, summarizeAttestation } from "./report.js";
import { validateProtocolObject } from "./schema-validator.js";
import type {
  Digest,
  EvaluationRun,
  JsonObject,
  JsonValue,
  PrivateEd25519Jwk,
  PublicEd25519Jwk,
} from "./types.js";
import type { VerificationSummary } from "./report.js";

const OBJECT_FILES = {
  EVALUATOR_MANIFEST: "objects/evaluator-manifest.json",
  PROFILE_DEFINITION: "objects/profile-definition.json",
  EVALUATION_REQUEST: "objects/evaluation-request.json",
  EVIDENCE_BUNDLE: "objects/evidence-bundle.json",
  EVALUATION_ATTESTATION: "objects/evaluation-attestation.json",
} as const;

const PROTOCOL_ROLES = Object.keys(OBJECT_FILES) as Array<keyof typeof OBJECT_FILES>;

const MAX_DOSSIER_ENTRIES = 64;
const MAX_DOSSIER_FILESYSTEM_NODES = 128;
const MAX_DOSSIER_DIRECTORY_DEPTH = 8;

export interface AssembleDossierOptions {
  dossierId: string;
  generatedAt: string;
  classification: "INTERNAL_REFERENCE" | "CAPTURED_EXTERNAL_RESPONSE";
  exporterId: string;
  audience: string;
  nonce: string;
  warnings?: string[];
}

export interface VerifiedDossier {
  dossier: JsonObject;
  objects: {
    manifest: JsonObject;
    profile: JsonObject;
    request: JsonObject;
    evidenceBundle: JsonObject;
    attestation: JsonObject;
  };
  summary: VerificationSummary;
}

export interface VerifyDossierOptions {
  /** Pin the signed audience to the consumer's independently expected value. */
  expectedAudience?: string;
  /** Pin the dossier-level nonce when the consumer issued one out of band. */
  expectedDossierNonce?: string;
}

interface DossierEntry {
  role: string;
  path: string;
  mediaType: string;
  digest: Digest;
  sizeBytes: number;
  requiredForVerification: boolean;
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectAt(value: JsonValue | undefined, field: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`Expected ${field} to be an object`);
  }
  return value;
}

function arrayAt(value: JsonValue | undefined, field: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an array`);
  }
  return value;
}

function stringAt(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`);
  }
  return value;
}

function booleanAt(value: JsonValue | undefined, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Expected ${field} to be a boolean`);
  }
  return value;
}

function integerAt(value: JsonValue | undefined, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`Expected ${field} to be a safe integer`);
  }
  return value;
}

function timestampAt(value: JsonValue | undefined, field: string): number {
  const text = stringAt(value, field);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`Invalid timestamp at ${field}`);
  }
  return milliseconds;
}

function digestAt(value: JsonValue | undefined, field: string): Digest {
  const object = objectAt(value, field);
  const algorithm = stringAt(object.algorithm, `${field}.algorithm`);
  const digest = stringAt(object.value, `${field}.value`);
  if (algorithm !== "sha-256" || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`Invalid ${field}`);
  }
  return { algorithm: "sha-256", value: digest };
}

function sameDigest(left: Digest, right: Digest): boolean {
  return left.algorithm === right.algorithm && left.value === right.value;
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function setEquals(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function decodeJsonPointerSegment(segment: string, pointer: string): string {
  if (/(?:~[^01]|~$)/.test(segment)) {
    throw new Error(`Invalid JSON Pointer escape in ${pointer}`);
  }
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function resolveJsonPointer(document: JsonValue, pointer: string): JsonValue {
  if (pointer === "") {
    return document;
  }
  if (!pointer.startsWith("/")) {
    throw new Error(`JSON Pointer must start with '/': ${pointer}`);
  }

  let current: JsonValue = document;
  for (const encodedSegment of pointer.slice(1).split("/")) {
    const segment = decodeJsonPointerSegment(encodedSegment, pointer);
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(segment)) {
        throw new Error(`Invalid array index ${JSON.stringify(segment)} in ${pointer}`);
      }
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        throw new Error(`Array index out of range in ${pointer}`);
      }
      current = current[index] as JsonValue;
      continue;
    }
    if (isObject(current) && Object.hasOwn(current, segment)) {
      current = current[segment] as JsonValue;
      continue;
    }
    throw new Error(`JSON Pointer does not resolve: ${pointer}`);
  }
  return current;
}

function schemaErrorText(errors: Array<{ instancePath: string; message: string }>): string {
  return errors.map((error) => `${error.instancePath || "/"}: ${error.message}`).join("; ");
}

function expectDigest(actual: Digest, expectedValue: JsonValue | undefined, field: string): void {
  const expected = digestAt(expectedValue, field);
  if (!sameDigest(actual, expected)) {
    throw new Error(`${field} does not match the committed object`);
  }
}

function publicKeyFrom(value: JsonValue | undefined, field: string): PublicEd25519Jwk {
  return objectAt(value, field) as unknown as PublicEd25519Jwk;
}

function entryFromObject(value: JsonValue, index: number): DossierEntry {
  const entry = objectAt(value, `dossier.artifacts[${index}]`);
  return {
    role: stringAt(entry.role, `dossier.artifacts[${index}].role`),
    path: stringAt(entry.path, `dossier.artifacts[${index}].path`),
    mediaType: stringAt(entry.mediaType, `dossier.artifacts[${index}].mediaType`),
    digest: digestAt(entry.digest, `dossier.artifacts[${index}].digest`),
    sizeBytes: integerAt(entry.sizeBytes, `dossier.artifacts[${index}].sizeBytes`),
    requiredForVerification: booleanAt(
      entry.requiredForVerification,
      `dossier.artifacts[${index}].requiredForVerification`,
    ),
  };
}

function entryJson(entry: DossierEntry): JsonObject {
  return {
    role: entry.role,
    path: entry.path,
    mediaType: entry.mediaType,
    digest: entry.digest as unknown as JsonObject,
    sizeBytes: entry.sizeBytes,
    requiredForVerification: entry.requiredForVerification,
  };
}

async function writeCommittedFile(
  root: string,
  relativePath: string,
  bytes: Uint8Array,
  role: string,
  mediaType: string,
  requiredForVerification: boolean,
): Promise<DossierEntry> {
  const destination = safeOutputPath(root, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes, { flag: "wx" });
  return {
    role,
    path: relativePath,
    mediaType,
    digest: sha256Bytes(bytes),
    sizeBytes: bytes.byteLength,
    requiredForVerification,
  };
}

function safeOutputPath(root: string, relativePath: string): string {
  const segments = validateDossierRelativePath(relativePath, 200);
  if (!/^(?:objects|evidence|reports)\/[A-Za-z0-9._/-]+$/.test(relativePath)) {
    throw new Error(`Unsafe dossier output path: ${relativePath}`);
  }
  const absoluteRoot = resolve(root);
  const destination = resolve(absoluteRoot, ...segments);
  const fromRoot = relative(absoluteRoot, destination);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`Dossier output path escapes its root: ${relativePath}`);
  }
  return destination;
}

function prevalidateOutputPlan(root: string, relativePaths: readonly string[]): void {
  if (relativePaths.length > MAX_DOSSIER_ENTRIES) {
    throw new Error(`Dossier contains too many entries: ${relativePaths.length}`);
  }
  const portablePaths = new Set<string>();
  for (const relativePath of relativePaths) {
    safeOutputPath(root, relativePath);
    const portablePath = relativePath.toLowerCase();
    if (portablePaths.has(portablePath)) {
      throw new Error(`Duplicate or case-colliding dossier path: ${relativePath}`);
    }
    portablePaths.add(portablePath);
  }
}

async function readSourceArtifact(path: string): Promise<Buffer> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Source artifact must be a regular non-symlink file: ${path}`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`Hard-linked source artifacts are forbidden: ${path}`);
  }
  if (metadata.size < 1 || metadata.size > 5 * 1024 * 1024) {
    throw new Error(`Source artifact is empty or exceeds 5 MiB: ${path}`);
  }

  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size < 1 || opened.size > 5 * 1024 * 1024) {
      throw new Error(`Source artifact changed or is unsafe: ${path}`);
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength !== opened.size) {
      throw new Error(`Source artifact changed while being read: ${path}`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function writeProtocolObject(
  root: string,
  relativePath: string,
  value: JsonObject,
  role: string,
): Promise<DossierEntry> {
  const validation = await validateProtocolObject(value);
  if (!validation.valid) {
    throw new Error(`Invalid ${role}: ${schemaErrorText(validation.errors)}`);
  }
  return writeCommittedFile(
    root,
    relativePath,
    canonicalBytes(value),
    role,
    "application/json",
    true,
  );
}

export async function assembleDossier(
  run: EvaluationRun,
  outputDirectory: string,
  exporterKey: PrivateEd25519Jwk,
  options: AssembleDossierOptions,
): Promise<JsonObject> {
  const objectValues: Array<[keyof typeof OBJECT_FILES, JsonObject]> = [
    ["EVALUATOR_MANIFEST", run.manifest],
    ["PROFILE_DEFINITION", run.profile],
    ["EVALUATION_REQUEST", run.request],
    ["EVIDENCE_BUNDLE", run.evidenceBundle],
    ["EVALUATION_ATTESTATION", run.attestation],
  ];
  // Capture path-bearing metadata before the first await so a direct
  // assembleDossier caller cannot swap in an unvalidated destination while
  // protocol objects are being checked.
  const sourceArtifacts = run.sourceArtifacts.map((source) => ({ ...source }));

  prevalidateOutputPlan(outputDirectory, [
    ...objectValues.map(([role]) => OBJECT_FILES[role]),
    ...sourceArtifacts.map(({ dossierPath }) => dossierPath),
    "reports/summary.md",
  ]);

  const outputRoot = resolve(outputDirectory);
  await mkdir(outputRoot, { recursive: false });
  const createdRoot = await lstat(outputRoot);
  let complete = false;
  try {
    const entries: DossierEntry[] = [];
    for (const [role, value] of objectValues) {
      entries.push(await writeProtocolObject(outputRoot, OBJECT_FILES[role], value, role));
    }

    // Source artifacts are read, committed and released one at a time. This
    // preserves the 5 MiB per-file bound without retaining the aggregate
    // dossier payload in memory.
    for (const source of sourceArtifacts) {
      const bytes = await readSourceArtifact(source.sourcePath);
      entries.push(
        await writeCommittedFile(
          outputRoot,
          source.dossierPath,
          bytes,
          "SOURCE_ARTIFACT",
          source.mediaType,
          true,
        ),
      );
    }

    const humanReport = Buffer.from(renderAttestationReport(run.attestation), "utf8");
    entries.push(
      await writeCommittedFile(
        outputRoot,
        "reports/summary.md",
        humanReport,
        "HUMAN_REPORT",
        "text/markdown",
        false,
      ),
    );
    requireUniqueEntries(entries);

    const exporterPublicKey = publicJwkFromPrivate(exporterKey);
    const unsigned: JsonObject = {
      protocolVersion: "evaldossier/0.1",
      schemaVersion: "evaldossier.dossier/0.1",
      dossierId: options.dossierId,
      generatedAt: options.generatedAt,
      classification: options.classification,
      exporter: {
        id: options.exporterId,
        key: exporterPublicKey as unknown as JsonObject,
      },
      signingKeyId: exporterPublicKey.kid,
      artifacts: entries.map(entryJson),
      bindings: {
        manifestDigest: digestOfObject(run.manifest) as unknown as JsonObject,
        profileDigest: digestOfObject(run.profile) as unknown as JsonObject,
        requestDigest: digestOfObject(run.request) as unknown as JsonObject,
        evidenceBundleDigest: digestOfObject(run.evidenceBundle) as unknown as JsonObject,
        attestationDigest: digestOfObject(run.attestation) as unknown as JsonObject,
      },
      warnings: options.warnings ?? [],
      economicAction: "OUT_OF_SCOPE",
      signatureContext: {
        audience: options.audience,
        nonce: options.nonce,
      },
    };

    const dossier = signObject(unsigned, exporterKey);
    const dossierValidation = await validateProtocolObject(dossier);
    if (!dossierValidation.valid) {
      throw new Error(`Invalid dossier: ${schemaErrorText(dossierValidation.errors)}`);
    }
    await writeFile(join(outputRoot, "dossier.json"), canonicalBytes(dossier), { flag: "wx" });
    complete = true;
    return dossier;
  } finally {
    if (!complete) {
      try {
        const currentRoot = await lstat(outputRoot);
        if (
          !currentRoot.isSymbolicLink() &&
          currentRoot.isDirectory() &&
          currentRoot.dev === createdRoot.dev &&
          currentRoot.ino === createdRoot.ino
        ) {
          await rm(outputRoot, { recursive: true, force: true });
        }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

function requireUniqueEntries(entries: DossierEntry[]): void {
  const paths = new Set<string>();
  for (const entry of entries) {
    const portablePath = entry.path.toLowerCase();
    if (paths.has(portablePath)) {
      throw new Error(`Duplicate or case-colliding dossier path: ${entry.path}`);
    }
    paths.add(portablePath);
  }

  for (const role of PROTOCOL_ROLES) {
    const count = entries.filter((entry) => entry.role === role).length;
    if (count !== 1) {
      throw new Error(`Dossier must contain exactly one ${role}; found ${count}`);
    }
  }
}

async function rejectUnexpectedFiles(
  root: string,
  expectedPaths: Set<string>,
  directory = root,
  prefix = "",
  state: { nodes: number } = { nodes: 0 },
  depth = 0,
): Promise<void> {
  if (depth > MAX_DOSSIER_DIRECTORY_DEPTH) {
    throw new Error(`Dossier directory nesting exceeds ${MAX_DOSSIER_DIRECTORY_DEPTH}`);
  }
  const children = await readdir(directory, { withFileTypes: true });
  for (const child of children) {
    state.nodes += 1;
    if (state.nodes > MAX_DOSSIER_FILESYSTEM_NODES) {
      throw new Error(`Dossier tree exceeds ${MAX_DOSSIER_FILESYSTEM_NODES} filesystem entries`);
    }
    const relativePath = prefix === "" ? child.name : `${prefix}/${child.name}`;
    if (child.isSymbolicLink()) {
      throw new Error(`Unlisted symbolic link in dossier: ${relativePath}`);
    }
    if (child.isDirectory()) {
      if (![...expectedPaths].some((expected) => expected.startsWith(`${relativePath}/`))) {
        throw new Error(`Uncommitted directory in dossier: ${relativePath}`);
      }
      await rejectUnexpectedFiles(
        root,
        expectedPaths,
        join(directory, child.name),
        relativePath,
        state,
        depth + 1,
      );
      continue;
    }
    if (!child.isFile()) {
      throw new Error(`Unsupported filesystem entry in dossier: ${relativePath}`);
    }
    if (!expectedPaths.has(relativePath)) {
      throw new Error(`Uncommitted file in dossier: ${relativePath}`);
    }
  }
}

function findRole(entries: DossierEntry[], role: keyof typeof OBJECT_FILES): DossierEntry {
  const entry = entries.find((candidate) => candidate.role === role);
  if (entry === undefined) {
    throw new Error(`Missing dossier role ${role}`);
  }
  return entry;
}

async function verifyEntryBytes(root: string, entry: DossierEntry): Promise<Uint8Array> {
  const bytes = await readSafeDossierFile(root, entry.path);
  if (bytes.byteLength !== entry.sizeBytes) {
    throw new Error(`Size mismatch for ${entry.path}`);
  }
  if (!sameDigest(sha256Bytes(bytes), entry.digest)) {
    throw new Error(`Digest mismatch for ${entry.path}`);
  }
  return bytes;
}

async function readProtocolEntry(
  root: string,
  entry: DossierEntry,
): Promise<JsonObject> {
  const bytes = await verifyEntryBytes(root, entry);
  const parsed = parseJsonStrict(bytes, entry.path);
  if (!isObject(parsed)) {
    throw new Error(`${entry.path} must contain a JSON object`);
  }
  const validation = await validateProtocolObject(parsed);
  if (!validation.valid) {
    throw new Error(`Invalid protocol object ${entry.path}: ${schemaErrorText(validation.errors)}`);
  }
  return parsed;
}

function requireValidSignature(value: JsonObject, key: PublicEd25519Jwk, field: string): void {
  const verification = verifyObjectSignature(value, key);
  if (!verification.valid) {
    throw new Error(`Invalid signature for ${field}`);
  }
}

function findManifestKey(manifest: JsonObject, keyId: string): PublicEd25519Jwk {
  const keys = arrayAt(manifest.keys, "manifest.keys").map((key, index) =>
    publicKeyFrom(key, `manifest.keys[${index}]`),
  );
  const key = keys.find((candidate) => candidate.kid === keyId);
  if (key === undefined) {
    throw new Error(`Manifest does not contain signing key ${keyId}`);
  }
  return key;
}

function verifyCrossBindings(
  dossier: JsonObject,
  manifest: JsonObject,
  profile: JsonObject,
  request: JsonObject,
  evidenceBundle: JsonObject,
  attestation: JsonObject,
): void {
  const bindings = objectAt(dossier.bindings, "dossier.bindings");
  const actual = {
    manifestDigest: digestOfObject(manifest),
    profileDigest: digestOfObject(profile),
    requestDigest: digestOfObject(request),
    evidenceBundleDigest: digestOfObject(evidenceBundle),
    attestationDigest: digestOfObject(attestation),
  };

  expectDigest(actual.manifestDigest, bindings.manifestDigest, "dossier.bindings.manifestDigest");
  expectDigest(actual.profileDigest, bindings.profileDigest, "dossier.bindings.profileDigest");
  expectDigest(actual.requestDigest, bindings.requestDigest, "dossier.bindings.requestDigest");
  expectDigest(
    actual.evidenceBundleDigest,
    bindings.evidenceBundleDigest,
    "dossier.bindings.evidenceBundleDigest",
  );
  expectDigest(
    actual.attestationDigest,
    bindings.attestationDigest,
    "dossier.bindings.attestationDigest",
  );

  const manifestProfiles = arrayAt(manifest.profiles, "manifest.profiles");
  const manifestProfile = manifestProfiles
    .map((value, index) => objectAt(value, `manifest.profiles[${index}]`))
    .find(
      (value) =>
        stringAt(value.id, "manifest profile id") === stringAt(profile.profileId, "profile.profileId") &&
        stringAt(value.version, "manifest profile version") === stringAt(profile.version, "profile.version"),
    );
  if (manifestProfile === undefined) {
    throw new Error("Manifest does not authorize the enclosed profile");
  }
  expectDigest(actual.profileDigest, manifestProfile.digest, "manifest profile digest");

  const requestProfile = objectAt(request.profile, "request.profile");
  if (
    stringAt(requestProfile.id, "request.profile.id") !== stringAt(profile.profileId, "profile.profileId") ||
    stringAt(requestProfile.version, "request.profile.version") !== stringAt(profile.version, "profile.version")
  ) {
    throw new Error("Request profile identity does not match the enclosed profile");
  }
  expectDigest(actual.profileDigest, requestProfile.digest, "request.profile.digest");

  if (
    stringAt(request.targetEvaluatorId, "request.targetEvaluatorId") !==
    stringAt(manifest.evaluatorId, "manifest.evaluatorId")
  ) {
    throw new Error("Request target evaluator does not match the manifest");
  }
  if (stringAt(request.operation, "request.operation") !== stringAt(profile.operation, "profile.operation")) {
    throw new Error("Request operation does not match profile operation");
  }
  if (
    stringAt(evidenceBundle.requestId, "evidenceBundle.requestId") !==
    stringAt(request.requestId, "request.requestId")
  ) {
    throw new Error("Evidence bundle is bound to another request");
  }

  const attestationEvaluator = objectAt(attestation.evaluator, "attestation.evaluator");
  if (
    stringAt(attestationEvaluator.evaluatorId, "attestation.evaluator.evaluatorId") !==
    stringAt(manifest.evaluatorId, "manifest.evaluatorId")
  ) {
    throw new Error("Attestation evaluator does not match the manifest");
  }
  const manifestSoftware = objectAt(manifest.software, "manifest.software");
  if (
    stringAt(attestationEvaluator.softwareVersion, "attestation.evaluator.softwareVersion") !==
    stringAt(manifestSoftware.version, "manifest.software.version")
  ) {
    throw new Error("Attestation software version does not match the manifest");
  }

  const operation = stringAt(profile.operation, "profile.operation");
  const bindingMode = stringAt(profile.resultBindingMode, "profile.resultBindingMode");
  const attestationMode = stringAt(attestation.mode, "attestation.mode");
  const evaluatorType = stringAt(manifest.evaluatorType, "manifest.evaluatorType");
  const expectedMode = operation === "EVALUATE" ? "NATIVE_EVALUATION" : "UPSTREAM_NORMALIZATION";
  if (attestationMode !== expectedMode) {
    throw new Error(`Attestation mode ${attestationMode} is incompatible with ${operation}`);
  }
  if (
    (operation === "EVALUATE" && bindingMode !== "DIRECT_PREDICATE_RESULT") ||
    (operation === "NORMALIZE" && bindingMode !== "PRESERVE_UPSTREAM_ASSESSMENT")
  ) {
    throw new Error("Profile operation and result-binding mode are incompatible");
  }
  if (
    (attestationMode === "NATIVE_EVALUATION" && !["NATIVE", "HYBRID"].includes(evaluatorType)) ||
    (attestationMode === "UPSTREAM_NORMALIZATION" && !["ADAPTER", "HYBRID"].includes(evaluatorType))
  ) {
    throw new Error(`Evaluator type ${evaluatorType} cannot issue ${attestationMode}`);
  }

  const attestationBindings = objectAt(attestation.bindings, "attestation.bindings");
  expectDigest(actual.manifestDigest, attestationBindings.manifestDigest, "attestation manifest binding");
  expectDigest(actual.profileDigest, attestationBindings.profileDigest, "attestation profile binding");
  expectDigest(actual.requestDigest, attestationBindings.requestDigest, "attestation request binding");
  expectDigest(
    actual.evidenceBundleDigest,
    attestationBindings.evidenceBundleDigest,
    "attestation evidence binding",
  );

  const requestContext = objectAt(request.signatureContext, "request.signatureContext");
  const attestationContext = objectAt(attestation.signatureContext, "attestation.signatureContext");
  if (
    stringAt(requestContext.audience, "request audience") !==
    stringAt(attestationContext.audience, "attestation audience")
  ) {
    throw new Error("Attestation audience does not match the request");
  }
}

function expectedObligationVerdict(
  profile: JsonObject,
  request: JsonObject,
  attestation: JsonObject,
): "SATISFIED" | "NOT_SATISFIED" | "INCONCLUSIVE" {
  const aggregation = objectAt(profile.aggregationPolicy, "profile.aggregationPolicy");
  const aggregationRule = stringAt(aggregation.rule, "aggregationPolicy.rule");
  const eligibleBases = new Set(
    arrayAt(aggregation.obligationEligibleBases, "aggregationPolicy.obligationEligibleBases").map(
      (basis, index) => stringAt(basis, `obligationEligibleBases[${index}]`),
    ),
  );
  const allowedBases = new Set(
    arrayAt(profile.allowedBases, "profile.allowedBases").map((basis, index) =>
      stringAt(basis, `allowedBases[${index}]`),
    ),
  );
  for (const basis of eligibleBases) {
    if (!allowedBases.has(basis)) {
      throw new Error(`Obligation-eligible basis ${basis} is not allowed by the profile`);
    }
  }

  if (aggregationRule === "PRESERVE_UPSTREAM_OVERALL") {
    if (eligibleBases.size !== 0) {
      throw new Error("PRESERVE_UPSTREAM_OVERALL cannot establish an obligation in v0.1");
    }
    return "INCONCLUSIVE";
  }
  if (aggregationRule !== "ALL_REQUIRED_TRUE") {
    throw new Error(`Unsupported aggregation rule: ${aggregationRule}`);
  }

  const criteria = arrayAt(request.criteria, "request.criteria").map((value, index) =>
    objectAt(value, `request.criteria[${index}]`),
  );
  const assessments = arrayAt(attestation.assessments, "attestation.assessments").map(
    (value, index) => objectAt(value, `attestation.assessments[${index}]`),
  );

  const criterionIds = new Set<string>();
  for (const criterion of criteria) {
    const id = stringAt(criterion.criterionId, "criterion.criterionId");
    if (criterionIds.has(id)) {
      throw new Error(`Duplicate criterionId: ${id}`);
    }
    criterionIds.add(id);
  }

  const assessmentIds = new Set<string>();
  const byCriterion = new Map<string, JsonObject>();
  for (const assessment of assessments) {
    const assessmentId = stringAt(assessment.assessmentId, "assessment.assessmentId");
    const criterionId = stringAt(assessment.criterionId, "assessment.criterionId");
    if (assessmentIds.has(assessmentId) || byCriterion.has(criterionId)) {
      throw new Error(`Duplicate assessment or criterion result: ${assessmentId}/${criterionId}`);
    }
    assessmentIds.add(assessmentId);
    byCriterion.set(criterionId, assessment);

    const basis = stringAt(assessment.basis, "assessment.basis");
    if (!allowedBases.has(basis)) {
      throw new Error(`Assessment uses basis not allowed by profile: ${basis}`);
    }
    if (!eligibleBases.has(basis) && stringAt(assessment.predicateStatus, "assessment.predicateStatus") !== "UNDETERMINED") {
      throw new Error(`Ineligible basis ${basis} cannot establish a predicate`);
    }
  }

  let hasFalse = false;
  let hasUndetermined = false;
  for (const criterion of criteria) {
    if (!booleanAt(criterion.required, "criterion.required")) {
      continue;
    }
    const criterionId = stringAt(criterion.criterionId, "criterion.criterionId");
    const assessment = byCriterion.get(criterionId);
    if (assessment === undefined) {
      hasUndetermined = true;
      continue;
    }
    const basis = stringAt(assessment.basis, "assessment.basis");
    const status = stringAt(assessment.predicateStatus, "assessment.predicateStatus");
    if (!eligibleBases.has(basis) || status === "UNDETERMINED") {
      hasUndetermined = true;
    } else if (status === "ESTABLISHED_FALSE") {
      hasFalse = true;
    } else if (status !== "ESTABLISHED_TRUE") {
      throw new Error(`Unknown predicate status: ${status}`);
    }
  }

  if (hasFalse) {
    return "NOT_SATISFIED";
  }
  if (hasUndetermined || eligibleBases.size === 0) {
    return "INCONCLUSIVE";
  }
  return "SATISFIED";
}

function verifySemanticBoundary(
  profile: JsonObject,
  request: JsonObject,
  attestation: JsonObject,
  dossier: JsonObject,
): void {
  for (const [object, field] of [
    [request, "request.economicBoundary"],
    [attestation, "attestation"],
    [dossier, "dossier"],
  ] as Array<[JsonObject, string]>) {
    if (field === "request.economicBoundary") {
      const boundary = objectAt(object.economicBoundary, field);
      if (
        stringAt(boundary.paymentExecution, `${field}.paymentExecution`) !== "OUT_OF_SCOPE" ||
        stringAt(boundary.paymentRecommendation, `${field}.paymentRecommendation`) !== "OUT_OF_SCOPE"
      ) {
        throw new Error("Evaluation request crosses the v0.1 economic boundary");
      }
    } else if (stringAt(object.economicAction, `${field}.economicAction`) !== "OUT_OF_SCOPE") {
      throw new Error(`${field} crosses the v0.1 economic boundary`);
    }
  }

  const expected = expectedObligationVerdict(profile, request, attestation);
  const actual = stringAt(attestation.obligationVerdict, "attestation.obligationVerdict");
  if (actual !== expected) {
    throw new Error(`Invalid obligation verdict: expected ${expected}, got ${actual}`);
  }
}

function verifyTemporalBindings(
  dossier: JsonObject,
  manifest: JsonObject,
  profile: JsonObject,
  request: JsonObject,
  evidenceBundle: JsonObject,
  attestation: JsonObject,
): void {
  const manifestIssued = timestampAt(manifest.issuedAt, "manifest.issuedAt");
  const manifestExpires = timestampAt(manifest.expiresAt, "manifest.expiresAt");
  const profilePublished = timestampAt(profile.publishedAt, "profile.publishedAt");
  const requestCreated = timestampAt(request.createdAt, "request.createdAt");
  const requestExpires = timestampAt(request.expiresAt, "request.expiresAt");
  const evidenceCaptured = timestampAt(evidenceBundle.capturedAt, "evidenceBundle.capturedAt");
  const attestationIssued = timestampAt(attestation.issuedAt, "attestation.issuedAt");
  const dossierGenerated = timestampAt(dossier.generatedAt, "dossier.generatedAt");

  if (manifestIssued > manifestExpires) {
    throw new Error("Manifest validity interval is reversed");
  }
  if (requestCreated > requestExpires) {
    throw new Error("Request validity interval is reversed");
  }
  if (profilePublished > requestCreated) {
    throw new Error("Request predates the enclosed profile");
  }
  if (attestationIssued < manifestIssued || attestationIssued > manifestExpires) {
    throw new Error("Attestation was issued outside the manifest validity interval");
  }
  if (attestationIssued < requestCreated || attestationIssued > requestExpires) {
    throw new Error("Attestation was issued outside the request validity interval");
  }
  if (attestationIssued < evidenceCaptured) {
    throw new Error("Attestation predates its evidence capture");
  }
  if (request.operation === "EVALUATE" && evidenceCaptured < requestCreated) {
    throw new Error("Native evaluation evidence predates its request");
  }
  if (dossierGenerated < attestationIssued) {
    throw new Error("Dossier predates its attestation");
  }
}

function verifyEvidenceEntries(
  entries: DossierEntry[],
  evidenceBundle: JsonObject,
): string[] {
  const sourceEntries = new Map(
    entries
      .filter((entry) => entry.role === "SOURCE_ARTIFACT")
      .map((entry) => [entry.path, entry] as const),
  );
  const provenance: string[] = [];
  const artifactIds = new Set<string>();
  const usedPaths = new Set<string>();

  const artifacts = arrayAt(evidenceBundle.artifacts, "evidenceBundle.artifacts");
  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = objectAt(artifacts[index], `evidenceBundle.artifacts[${index}]`);
    const artifactId = stringAt(artifact.artifactId, `evidenceBundle.artifacts[${index}].artifactId`);
    if (artifactIds.has(artifactId)) {
      throw new Error(`Duplicate evidence artifactId: ${artifactId}`);
    }
    artifactIds.add(artifactId);

    const path = stringAt(artifact.path, `evidenceBundle.artifacts[${index}].path`);
    if (usedPaths.has(path)) {
      throw new Error(`Multiple evidence artifacts reference the same dossier path: ${path}`);
    }
    usedPaths.add(path);
    const entry = sourceEntries.get(path);
    if (entry === undefined) {
      throw new Error(`Evidence bundle references uncommitted source artifact ${path}`);
    }
    expectDigest(entry.digest, artifact.digest, `evidence artifact ${artifactId} digest`);
    if (entry.sizeBytes !== integerAt(artifact.sizeBytes, `evidence artifact ${artifactId} sizeBytes`)) {
      throw new Error(`Evidence artifact size mismatch: ${artifactId}`);
    }
    const source = objectAt(artifact.source, `evidence artifact ${artifactId}.source`);
    const originAuthentication = stringAt(
      source.originAuthentication,
      `evidence artifact ${artifactId}.originAuthentication`,
    );
    if (originAuthentication === "SOURCE_SIGNED") {
      throw new Error(
        `SOURCE_SIGNED provenance is unsupported until a portable origin proof is committed and verified: ${artifactId}`,
      );
    }
    provenance.push(originAuthentication);
  }
  if (!setEquals(new Set(sourceEntries.keys()), usedPaths)) {
    throw new Error("Dossier contains source artifacts not referenced by the evidence bundle");
  }
  return [...new Set(provenance)].sort();
}

function verifyDeclaredGraph(
  entries: DossierEntry[],
  profile: JsonObject,
  request: JsonObject,
  evidenceBundle: JsonObject,
  attestation: JsonObject,
): void {
  const allowedBases = new Set(
    arrayAt(profile.allowedBases, "profile.allowedBases").map((value, index) =>
      stringAt(value, `profile.allowedBases[${index}]`),
    ),
  );
  const predicates = new Map<string, JsonObject>();
  for (const [index, value] of arrayAt(profile.predicates, "profile.predicates").entries()) {
    const predicate = objectAt(value, `profile.predicates[${index}]`);
    const id = stringAt(predicate.predicateId, `profile.predicates[${index}].predicateId`);
    if (predicates.has(id)) {
      throw new Error(`Duplicate profile predicateId: ${id}`);
    }
    const predicateBasis = stringAt(predicate.basis, `profile.predicates[${index}].basis`);
    if (!allowedBases.has(predicateBasis)) {
      throw new Error(`Profile predicate ${id} uses undeclared basis ${predicateBasis}`);
    }
    predicates.set(id, predicate);
  }

  const criteria = new Map<string, JsonObject>();
  for (const [index, value] of arrayAt(request.criteria, "request.criteria").entries()) {
    const criterion = objectAt(value, `request.criteria[${index}]`);
    const id = stringAt(criterion.criterionId, `request.criteria[${index}].criterionId`);
    const predicateId = stringAt(criterion.predicateId, `request.criteria[${index}].predicateId`);
    if (criteria.has(id)) {
      throw new Error(`Duplicate request criterionId: ${id}`);
    }
    if (!predicates.has(predicateId)) {
      throw new Error(`Criterion ${id} references unknown profile predicate ${predicateId}`);
    }
    criteria.set(id, criterion);
  }

  const requestArtifacts = new Map<string, JsonObject>();
  for (const [index, value] of arrayAt(request.artifacts, "request.artifacts").entries()) {
    const artifact = objectAt(value, `request.artifacts[${index}]`);
    const id = stringAt(artifact.artifactId, `request.artifacts[${index}].artifactId`);
    if (requestArtifacts.has(id)) {
      throw new Error(`Duplicate request artifactId: ${id}`);
    }
    requestArtifacts.set(id, artifact);
  }

  const evidenceArtifacts = new Map<string, JsonObject>();
  for (const [index, value] of arrayAt(evidenceBundle.artifacts, "evidenceBundle.artifacts").entries()) {
    const artifact = objectAt(value, `evidenceBundle.artifacts[${index}]`);
    const id = stringAt(artifact.artifactId, `evidenceBundle.artifacts[${index}].artifactId`);
    if (evidenceArtifacts.has(id)) {
      throw new Error(`Duplicate evidence artifactId: ${id}`);
    }
    const requested = requestArtifacts.get(id);
    if (requested === undefined) {
      throw new Error(`Evidence artifact ${id} was not committed by the request`);
    }
    if (
      stringAt(artifact.role, `evidence artifact ${id}.role`) !==
        stringAt(requested.role, `request artifact ${id}.role`) ||
      stringAt(artifact.mediaType, `evidence artifact ${id}.mediaType`) !==
        stringAt(requested.mediaType, `request artifact ${id}.mediaType`)
    ) {
      throw new Error(`Evidence artifact ${id} changes the requested role or media type`);
    }
    if (stringAt(requested.commitmentMode, `request artifact ${id}.commitmentMode`) !== "EXACT_INPUT") {
      throw new Error(`Unsupported request artifact commitment mode for ${id}`);
    }
    const requestedDigest = digestAt(requested.digest, `request artifact ${id}.digest`);
    const observedDigest = digestAt(artifact.digest, `evidence artifact ${id}.digest`);
    if (!sameDigest(requestedDigest, observedDigest)) {
      throw new Error(`Evidence artifact ${id} does not match its exact request digest commitment`);
    }
    if (
      integerAt(requested.sizeBytes, `request artifact ${id}.sizeBytes`) !==
      integerAt(artifact.sizeBytes, `evidence artifact ${id}.sizeBytes`)
    ) {
      throw new Error(`Evidence artifact ${id} does not match its exact request size commitment`);
    }
    const entry = entries.find(
      (candidate) =>
        candidate.role === "SOURCE_ARTIFACT" &&
        candidate.path === stringAt(artifact.path, `evidence artifact ${id}.path`),
    );
    if (entry === undefined || entry.mediaType !== stringAt(artifact.mediaType, `evidence artifact ${id}.mediaType`)) {
      throw new Error(`Dossier entry for evidence artifact ${id} has the wrong media type`);
    }
    evidenceArtifacts.set(id, artifact);
  }
  if (requestArtifacts.size !== evidenceArtifacts.size) {
    throw new Error("Not every requested artifact is present in the evidence bundle");
  }

  const resultCriteria = new Set<string>();
  for (const [index, value] of arrayAt(attestation.assessments, "attestation.assessments").entries()) {
    const assessment = objectAt(value, `attestation.assessments[${index}]`);
    const criterionId = stringAt(
      assessment.criterionId,
      `attestation.assessments[${index}].criterionId`,
    );
    const criterion = criteria.get(criterionId);
    if (criterion === undefined) {
      throw new Error(`Assessment references unknown criterion ${criterionId}`);
    }
    if (resultCriteria.has(criterionId)) {
      throw new Error(`Multiple assessments target criterion ${criterionId}`);
    }
    resultCriteria.add(criterionId);
    const predicateId = stringAt(criterion.predicateId, `criterion ${criterionId}.predicateId`);
    const predicate = predicates.get(predicateId);
    if (predicate === undefined) {
      throw new Error(`Criterion ${criterionId} references unknown predicate ${predicateId}`);
    }
    const expectedBasis = stringAt(predicate.basis, `predicate ${predicateId}.basis`);
    const actualBasis = stringAt(assessment.basis, `assessment ${criterionId}.basis`);
    if (actualBasis !== expectedBasis) {
      throw new Error(
        `Assessment basis ${actualBasis} does not match predicate ${predicateId} basis ${expectedBasis}`,
      );
    }
    for (const [referenceIndex, reference] of arrayAt(
      assessment.evidenceArtifactIds,
      `attestation.assessments[${index}].evidenceArtifactIds`,
    ).entries()) {
      const artifactId = stringAt(
        reference,
        `attestation.assessments[${index}].evidenceArtifactIds[${referenceIndex}]`,
      );
      if (!evidenceArtifacts.has(artifactId)) {
        throw new Error(`Assessment references unknown evidence artifact ${artifactId}`);
      }
    }
  }

  const coverage = objectAt(attestation.coverage, "attestation.coverage");
  const assessedCoverage = new Set(
    arrayAt(coverage.assessedCriterionIds, "coverage.assessedCriterionIds").map((value, index) =>
      stringAt(value, `coverage.assessedCriterionIds[${index}]`),
    ),
  );
  const unassessedCoverage = new Set(
    arrayAt(coverage.unassessedCriterionIds, "coverage.unassessedCriterionIds").map((value, index) =>
      stringAt(value, `coverage.unassessedCriterionIds[${index}]`),
    ),
  );
  if (!setEquals(assessedCoverage, resultCriteria)) {
    throw new Error("Coverage assessedCriterionIds do not match the actual assessments");
  }
  for (const id of unassessedCoverage) {
    if (!criteria.has(id) || assessedCoverage.has(id)) {
      throw new Error(`Invalid or overlapping unassessed criterion ${id}`);
    }
  }
  const expectedUnassessed = new Set([...criteria.keys()].filter((id) => !resultCriteria.has(id)));
  if (!setEquals(unassessedCoverage, expectedUnassessed)) {
    throw new Error("Coverage does not partition every requested criterion");
  }
  const expectedCoverageStatus =
    assessedCoverage.size === criteria.size ? "COMPLETE" : assessedCoverage.size === 0 ? "UNKNOWN" : "PARTIAL";
  if (stringAt(coverage.status, "coverage.status") !== expectedCoverageStatus) {
    throw new Error(`Coverage status must be ${expectedCoverageStatus}`);
  }

  const aggregation = objectAt(profile.aggregationPolicy, "profile.aggregationPolicy");
  const aggregationRule = stringAt(aggregation.rule, "aggregationPolicy.rule");
  const overall = objectAt(attestation.overallAssessment, "attestation.overallAssessment");
  const overallBasis = stringAt(overall.basis, "attestation.overallAssessment.basis");
  if (overallBasis !== "MIXED" && !allowedBases.has(overallBasis)) {
    throw new Error(`Overall assessment uses basis not allowed by profile: ${overallBasis}`);
  }
  const requestedPredicateBases = new Set(
    [...criteria.values()].map((criterion) => {
      const predicateId = stringAt(criterion.predicateId, "criterion.predicateId");
      const predicate = predicates.get(predicateId);
      if (predicate === undefined) {
        throw new Error(`Criterion references unknown predicate ${predicateId}`);
      }
      return stringAt(predicate.basis, `predicate ${predicateId}.basis`);
    }),
  );
  const expectedOverallBasis =
    requestedPredicateBases.size === 1 ? ([...requestedPredicateBases][0] as string) : "MIXED";
  if (overallBasis !== expectedOverallBasis) {
    throw new Error(`Overall basis must be ${expectedOverallBasis} for the requested criteria`);
  }
  if (aggregationRule === "ALL_REQUIRED_TRUE") {
    const expectedVerdict = expectedObligationVerdict(profile, request, attestation);
    const expectedAssessment =
      expectedVerdict === "SATISFIED"
        ? "AFFIRMED"
        : expectedVerdict === "NOT_SATISFIED"
          ? "REJECTED"
          : "INCONCLUSIVE";
    if (stringAt(overall.assessment, "overallAssessment.assessment") !== expectedAssessment) {
      throw new Error(`Overall assessment must be ${expectedAssessment} for ${expectedVerdict}`);
    }
  } else if (aggregationRule === "PRESERVE_UPSTREAM_OVERALL") {
    if (stringAt(profile.operation, "profile.operation") !== "NORMALIZE") {
      throw new Error("PRESERVE_UPSTREAM_OVERALL requires a normalization profile");
    }
  } else {
    throw new Error(`Unsupported aggregation rule: ${aggregationRule}`);
  }
}

async function verifyUpstreamMappings(
  root: string,
  profile: JsonObject,
  evidenceBundle: JsonObject,
  attestation: JsonObject,
): Promise<void> {
  const operation = stringAt(profile.operation, "profile.operation");
  const policy = objectAt(profile.mappingPolicy, "profile.mappingPolicy");
  const policyId = stringAt(policy.policyId, "profile.mappingPolicy.policyId");
  const artifacts = new Map<string, JsonObject>();
  for (const [index, value] of arrayAt(evidenceBundle.artifacts, "evidenceBundle.artifacts").entries()) {
    const artifact = objectAt(value, `evidenceBundle.artifacts[${index}]`);
    artifacts.set(stringAt(artifact.artifactId, `evidence artifact ${index}.artifactId`), artifact);
  }

  const mappings: Array<{ mapping: JsonObject; evidenceIds?: Set<string>; label: string }> = [];
  const overall = objectAt(attestation.overallAssessment, "attestation.overallAssessment");
  if (overall.upstreamMapping !== undefined) {
    mappings.push({
      mapping: objectAt(overall.upstreamMapping, "overallAssessment.upstreamMapping"),
      label: "overallAssessment.upstreamMapping",
    });
  } else if (operation === "NORMALIZE") {
    throw new Error("Normalization overall assessment must declare upstreamMapping");
  }

  for (const [index, value] of arrayAt(attestation.assessments, "attestation.assessments").entries()) {
    const assessment = objectAt(value, `attestation.assessments[${index}]`);
    const evidenceIds = new Set(
      arrayAt(assessment.evidenceArtifactIds, `assessment ${index}.evidenceArtifactIds`).map((id, idIndex) =>
        stringAt(id, `assessment ${index}.evidenceArtifactIds[${idIndex}]`),
      ),
    );
    if (assessment.upstreamMapping !== undefined) {
      mappings.push({
        mapping: objectAt(assessment.upstreamMapping, `assessment ${index}.upstreamMapping`),
        evidenceIds,
        label: `assessment ${index}.upstreamMapping`,
      });
    } else if (operation === "NORMALIZE") {
      throw new Error(`Normalization assessment ${index} must declare upstreamMapping`);
    }
  }

  if (operation !== "NORMALIZE") {
    if (mappings.length !== 0) {
      throw new Error("Native evaluations must not declare upstream mappings");
    }
    return;
  }

  const parsedSources = new Map<string, JsonValue>();
  for (const { mapping, evidenceIds, label } of mappings) {
    const sourceArtifactId = stringAt(mapping.sourceArtifactId, `${label}.sourceArtifactId`);
    const artifact = artifacts.get(sourceArtifactId);
    if (artifact === undefined) {
      throw new Error(`${label} references unknown source artifact ${sourceArtifactId}`);
    }
    if (evidenceIds !== undefined && !evidenceIds.has(sourceArtifactId)) {
      throw new Error(`${label} source artifact is not cited by its assessment`);
    }
    if (stringAt(mapping.mappingPolicyId, `${label}.mappingPolicyId`) !== policyId) {
      throw new Error(`${label} does not use the signed profile mapping policy`);
    }
    const mediaType = stringAt(artifact.mediaType, `evidence artifact ${sourceArtifactId}.mediaType`);
    if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
      throw new Error(`${label} source artifact is not JSON`);
    }
    let source = parsedSources.get(sourceArtifactId);
    if (source === undefined) {
      const path = stringAt(artifact.path, `evidence artifact ${sourceArtifactId}.path`);
      source = parseJsonStrict(await readSafeDossierFile(root, path), path);
      parsedSources.set(sourceArtifactId, source);
    }
    const pointer = stringAt(mapping.nativePointer, `${label}.nativePointer`);
    const observed = resolveJsonPointer(source, pointer);
    const declared = mapping.nativeValue;
    if (declared === undefined || !sameJsonValue(observed, declared)) {
      throw new Error(`${label}.nativeValue does not match the committed source at ${pointer}`);
    }
  }
}

function verifyAudienceBindings(
  dossier: JsonObject,
  options: VerifyDossierOptions,
): { audience: string; audienceBinding: "PINNED" | "UNPINNED"; dossierNonceBinding: "PINNED" | "UNPINNED" } {
  const dossierContext = objectAt(dossier.signatureContext, "dossier.signatureContext");
  const audience = stringAt(dossierContext.audience, "dossier.signatureContext.audience");
  const dossierNonce = stringAt(dossierContext.nonce, "dossier.signatureContext.nonce");
  if (options.expectedAudience !== undefined && options.expectedAudience !== audience) {
    throw new Error(`Dossier audience mismatch: expected ${options.expectedAudience}, got ${audience}`);
  }
  if (options.expectedDossierNonce !== undefined && options.expectedDossierNonce !== dossierNonce) {
    throw new Error("Dossier nonce does not match the caller's expected nonce");
  }
  return {
    audience,
    audienceBinding: options.expectedAudience === undefined ? "UNPINNED" : "PINNED",
    dossierNonceBinding: options.expectedDossierNonce === undefined ? "UNPINNED" : "PINNED",
  };
}

export async function verifyDossier(
  root: string,
  options: VerifyDossierOptions = {},
): Promise<VerifiedDossier> {
  const dossierBytes = await readSafeDossierFile(root, "dossier.json");
  const parsed = parseJsonStrict(dossierBytes, "dossier.json");
  if (!isObject(parsed)) {
    throw new Error("dossier.json must contain an object");
  }
  const dossier = parsed;
  const validation = await validateProtocolObject(dossier);
  if (!validation.valid) {
    throw new Error(`Invalid dossier schema: ${schemaErrorText(validation.errors)}`);
  }

  const exporter = objectAt(dossier.exporter, "dossier.exporter");
  requireValidSignature(dossier, publicKeyFrom(exporter.key, "dossier.exporter.key"), "dossier");

  const entries = arrayAt(dossier.artifacts, "dossier.artifacts").map(entryFromObject);
  requireUniqueEntries(entries);
  await rejectUnexpectedFiles(
    root,
    new Set(["dossier.json", ...entries.map((entry) => entry.path)]),
  );
  for (const entry of entries) {
    await verifyEntryBytes(root, entry);
  }

  const manifest = await readProtocolEntry(root, findRole(entries, "EVALUATOR_MANIFEST"));
  const profile = await readProtocolEntry(root, findRole(entries, "PROFILE_DEFINITION"));
  const request = await readProtocolEntry(root, findRole(entries, "EVALUATION_REQUEST"));
  const evidenceBundle = await readProtocolEntry(root, findRole(entries, "EVIDENCE_BUNDLE"));
  const attestation = await readProtocolEntry(root, findRole(entries, "EVALUATION_ATTESTATION"));

  const manifestKeyId = stringAt(manifest.signingKeyId, "manifest.signingKeyId");
  const manifestKey = findManifestKey(manifest, manifestKeyId);
  requireValidSignature(manifest, manifestKey, "manifest");

  const publisher = objectAt(profile.publisher, "profile.publisher");
  requireValidSignature(profile, publicKeyFrom(publisher.key, "profile.publisher.key"), "profile");
  const requester = objectAt(request.requester, "request.requester");
  requireValidSignature(request, publicKeyFrom(requester.key, "request.requester.key"), "request");
  const collector = objectAt(evidenceBundle.collector, "evidenceBundle.collector");
  requireValidSignature(
    evidenceBundle,
    publicKeyFrom(collector.key, "evidenceBundle.collector.key"),
    "evidence bundle",
  );

  const evaluator = objectAt(attestation.evaluator, "attestation.evaluator");
  const attestationKeyId = stringAt(evaluator.keyId, "attestation.evaluator.keyId");
  requireValidSignature(attestation, findManifestKey(manifest, attestationKeyId), "attestation");

  verifyCrossBindings(dossier, manifest, profile, request, evidenceBundle, attestation);
  verifyDeclaredGraph(entries, profile, request, evidenceBundle, attestation);
  await verifyUpstreamMappings(root, profile, evidenceBundle, attestation);
  verifySemanticBoundary(profile, request, attestation, dossier);
  verifyTemporalBindings(dossier, manifest, profile, request, evidenceBundle, attestation);
  const provenance = verifyEvidenceEntries(entries, evidenceBundle);
  const audience = verifyAudienceBindings(dossier, options);
  const attestationSummary = summarizeAttestation(attestation);

  const warnings = arrayAt(dossier.warnings, "dossier.warnings").map((warning, index) =>
    stringAt(warning, `dossier.warnings[${index}]`),
  );

  return {
    dossier,
    objects: { manifest, profile, request, evidenceBundle, attestation },
    summary: {
      dossierId: stringAt(dossier.dossierId, "dossier.dossierId"),
      schema: "VALID",
      integrity: "VALID",
      signatures: "VALID",
      keyControl: "ESTABLISHED",
      signerTrust: "UNPINNED",
      identity: "NOT_ESTABLISHED",
      audience: audience.audience,
      audienceBinding: audience.audienceBinding,
      dossierNonceBinding: audience.dossierNonceBinding,
      provenance,
      bases: attestationSummary.bases,
      overallBasis: attestationSummary.overallBasis,
      predicateStatuses: attestationSummary.predicateStatuses,
      obligationVerdict: attestationSummary.obligationVerdict,
      economicAction: "OUT_OF_SCOPE",
      warnings,
    },
  };
}
