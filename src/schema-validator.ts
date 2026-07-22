import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";

import { parseJsonFileStrict } from "./json.js";
import {
  PROTOCOL_SCHEMA_VERSIONS,
  type JsonObject,
  type ProtocolSchemaVersion,
} from "./types.js";

const COMMON_SCHEMA_FILE = "common.schema.json";
const addFormats = addFormatsModule as unknown as FormatsPlugin;
const PROTOCOL_SCHEMA_FILES = [
  "evaluator-manifest.schema.json",
  "profile-definition.schema.json",
  "evaluation-request.schema.json",
  "evidence-bundle.schema.json",
  "evaluation-attestation.schema.json",
  "dossier.schema.json",
] as const;

const SCHEMA_ID_BY_VERSION: Record<ProtocolSchemaVersion, string> = {
  "evaldossier.evaluator-manifest/0.1": "https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluator-manifest.schema.json",
  "evaldossier.profile-definition/0.1": "https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/profile-definition.schema.json",
  "evaldossier.evaluation-request/0.1": "https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluation-request.schema.json",
  "evaldossier.evidence-bundle/0.1": "https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evidence-bundle.schema.json",
  "evaldossier.evaluation-attestation/0.1": "https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/evaluation-attestation.schema.json",
  "evaldossier.dossier/0.1": "https://raw.githubusercontent.com/miguel-herrero-systems/evaldossier/v0.1.0/schemas/dossier.schema.json",
};

const RESOURCE_LIMITS = {
  dossierArtifacts: 64,
  assessedCriterionIds: 128,
  unassessedCriterionIds: 128,
  assessments: 128,
  evidenceArtifactIds: 32,
  acceptedClassifications: 2,
  allowedBases: 6,
  obligationEligibleBases: 6,
} as const;

const MAX_SCHEMA_DIAGNOSTIC_CHARS = 256;
const MAX_SCHEMA_PARAM_ENTRIES = 16;
const MAX_SCHEMA_PARAM_DEPTH = 4;

export interface SchemaIssue {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  message: string;
  params: Record<string, unknown>;
}

export interface SchemaValidationResult {
  valid: boolean;
  schemaVersion?: string;
  errors: SchemaIssue[];
}

export class ProtocolSchemaError extends Error {
  readonly issues: SchemaIssue[];

  constructor(message: string, issues: SchemaIssue[] = []) {
    super(message);
    this.name = "ProtocolSchemaError";
    this.issues = issues;
  }
}

function diagnosticDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

function boundDiagnosticString(value: string): string {
  if (value.length <= MAX_SCHEMA_DIAGNOSTIC_CHARS) {
    return value;
  }
  const suffix = `...[sha256:${diagnosticDigest(value)};chars:${value.length}]`;
  return `${value.slice(0, MAX_SCHEMA_DIAGNOSTIC_CHARS - suffix.length)}${suffix}`;
}

function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return boundDiagnosticString(value);
  }
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (depth >= MAX_SCHEMA_PARAM_DEPTH) {
    return "[diagnostic value depth omitted]";
  }
  if (Array.isArray(value)) {
    const bounded = value
      .slice(0, MAX_SCHEMA_PARAM_ENTRIES)
      .map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
    if (value.length > MAX_SCHEMA_PARAM_ENTRIES) {
      bounded.push(`[${value.length - MAX_SCHEMA_PARAM_ENTRIES} entries omitted]`);
    }
    return bounded;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const bounded: Record<string, unknown> = {};
    for (const [key, entry] of entries.slice(0, MAX_SCHEMA_PARAM_ENTRIES)) {
      bounded[boundDiagnosticString(key)] = sanitizeDiagnosticValue(entry, depth + 1);
    }
    if (entries.length > MAX_SCHEMA_PARAM_ENTRIES) {
      bounded.__omittedEntries = entries.length - MAX_SCHEMA_PARAM_ENTRIES;
    }
    return bounded;
  }
  return `[${typeof value} omitted]`;
}

function sanitizeDiagnosticParams(params: Record<string, unknown>): Record<string, unknown> {
  return sanitizeDiagnosticValue(params) as Record<string, unknown>;
}

function issue(error: ErrorObject): SchemaIssue {
  return {
    instancePath: boundDiagnosticString(error.instancePath),
    schemaPath: boundDiagnosticString(error.schemaPath),
    keyword: boundDiagnosticString(error.keyword),
    message: boundDiagnosticString(error.message ?? "schema validation failed"),
    params: sanitizeDiagnosticParams(error.params),
  };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function maxItemsIssue(
  instancePath: string,
  schemaPath: string,
  limit: number,
): SchemaIssue {
  return {
    instancePath,
    schemaPath,
    keyword: "maxItems",
    message: `must NOT have more than ${limit} items`,
    params: { limit },
  };
}

function pushMaxItemsIssue(
  issues: SchemaIssue[],
  value: unknown,
  instancePath: string,
  schemaPath: string,
  limit: number,
): void {
  const entries = arrayValue(value);
  if (entries !== undefined && entries.length > limit) {
    issues.push(maxItemsIssue(instancePath, schemaPath, limit));
  }
}

/**
 * Reject protocol-wide and implicit operational limits before semantic
 * validation. Ajv is configured to fail on its first schema error; this pass
 * additionally enforces cross-object/domain limits that protocol 0.1 leaves
 * implicit without mutating its immutable published schemas.
 */
function resourceAdmissionIssues(
  value: unknown,
  schemaVersion: ProtocolSchemaVersion,
): SchemaIssue[] {
  const root = objectValue(value);
  if (root === undefined) {
    return [];
  }

  const issues: SchemaIssue[] = [];
  switch (schemaVersion) {
    case "evaldossier.dossier/0.1":
      pushMaxItemsIssue(
        issues,
        root.artifacts,
        "/artifacts",
        "#/properties/artifacts/maxItems",
        RESOURCE_LIMITS.dossierArtifacts,
      );
      break;

    case "evaldossier.evaluation-attestation/0.1": {
      const coverage = objectValue(root.coverage);
      if (coverage !== undefined) {
        pushMaxItemsIssue(
          issues,
          coverage.assessedCriterionIds,
          "/coverage/assessedCriterionIds",
          "#/properties/coverage/properties/assessedCriterionIds/maxItems",
          RESOURCE_LIMITS.assessedCriterionIds,
        );
        pushMaxItemsIssue(
          issues,
          coverage.unassessedCriterionIds,
          "/coverage/unassessedCriterionIds",
          "#/properties/coverage/properties/unassessedCriterionIds/maxItems",
          RESOURCE_LIMITS.unassessedCriterionIds,
        );
      }

      const assessments = arrayValue(root.assessments);
      pushMaxItemsIssue(
        issues,
        assessments,
        "/assessments",
        "#/properties/assessments/maxItems",
        RESOURCE_LIMITS.assessments,
      );
      if (assessments !== undefined && assessments.length <= RESOURCE_LIMITS.assessments) {
        for (let index = 0; index < assessments.length; index += 1) {
          const assessment = objectValue(assessments[index]);
          if (assessment !== undefined) {
            pushMaxItemsIssue(
              issues,
              assessment.evidenceArtifactIds,
              `/assessments/${index}/evidenceArtifactIds`,
              "#/x-evaldossier-operational-limits/evidenceArtifactIds/maxItems",
              RESOURCE_LIMITS.evidenceArtifactIds,
            );
          }
        }
      }
      break;
    }

    case "evaldossier.evaluator-manifest/0.1": {
      const dataPractices = objectValue(root.dataPractices);
      if (dataPractices !== undefined) {
        pushMaxItemsIssue(
          issues,
          dataPractices.acceptedClassifications,
          "/dataPractices/acceptedClassifications",
          "#/x-evaldossier-operational-limits/acceptedClassifications/maxItems",
          RESOURCE_LIMITS.acceptedClassifications,
        );
      }
      break;
    }

    case "evaldossier.profile-definition/0.1": {
      pushMaxItemsIssue(
        issues,
        root.allowedBases,
        "/allowedBases",
        "#/x-evaldossier-operational-limits/allowedBases/maxItems",
        RESOURCE_LIMITS.allowedBases,
      );
      const aggregationPolicy = objectValue(root.aggregationPolicy);
      if (aggregationPolicy !== undefined) {
        pushMaxItemsIssue(
          issues,
          aggregationPolicy.obligationEligibleBases,
          "/aggregationPolicy/obligationEligibleBases",
          "#/properties/aggregationPolicy/properties/obligationEligibleBases/maxItems",
          RESOURCE_LIMITS.obligationEligibleBases,
        );
      }
      break;
    }

    default:
      break;
  }
  return issues;
}

function protocolSchemaVersion(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>).schemaVersion;
  return typeof candidate === "string" ? candidate : undefined;
}

function isProtocolSchemaVersion(value: string): value is ProtocolSchemaVersion {
  return (PROTOCOL_SCHEMA_VERSIONS as readonly string[]).includes(value);
}

function defaultSchemaDirectory(): string {
  const sourceCandidate = fileURLToPath(new URL("../schemas/", import.meta.url));
  if (existsSync(resolve(sourceCandidate, COMMON_SCHEMA_FILE))) {
    return sourceCandidate;
  }
  const compiledCandidate = fileURLToPath(new URL("../../schemas/", import.meta.url));
  if (existsSync(resolve(compiledCandidate, COMMON_SCHEMA_FILE))) {
    return compiledCandidate;
  }
  throw new ProtocolSchemaError(
    `cannot locate bundled schemas (checked ${sourceCandidate} and ${compiledCandidate})`,
  );
}

export class ProtocolSchemaValidator {
  readonly schemaDirectory: string;
  readonly #validators = new Map<ProtocolSchemaVersion, ValidateFunction>();

  constructor(schemaDirectory: string, validators: Map<ProtocolSchemaVersion, ValidateFunction>) {
    this.schemaDirectory = schemaDirectory;
    this.#validators = validators;
  }

  validateProtocolObject(
    value: unknown,
    expectedSchemaVersion?: ProtocolSchemaVersion,
  ): SchemaValidationResult {
    const declaredVersion = protocolSchemaVersion(value);
    if (declaredVersion === undefined) {
      return {
        valid: false,
        errors: [
          {
            instancePath: "",
            schemaPath: "",
            keyword: "schemaVersion",
            message: "protocol object must declare a string schemaVersion",
            params: {},
          },
        ],
      };
    }
    if (expectedSchemaVersion !== undefined && declaredVersion !== expectedSchemaVersion) {
      const diagnosticVersion = boundDiagnosticString(declaredVersion);
      return {
        valid: false,
        schemaVersion: diagnosticVersion,
        errors: [
          {
            instancePath: "/schemaVersion",
            schemaPath: "",
            keyword: "const",
            message: `expected ${expectedSchemaVersion}, received ${diagnosticVersion}`,
            params: { allowedValue: expectedSchemaVersion },
          },
        ],
      };
    }
    if (!isProtocolSchemaVersion(declaredVersion)) {
      const diagnosticVersion = boundDiagnosticString(declaredVersion);
      return {
        valid: false,
        schemaVersion: diagnosticVersion,
        errors: [
          {
            instancePath: "/schemaVersion",
            schemaPath: "",
            keyword: "enum",
            message: `unsupported protocol schema version ${diagnosticVersion}`,
            params: { allowedValues: [...PROTOCOL_SCHEMA_VERSIONS] },
          },
        ],
      };
    }

    const validator = this.#validators.get(declaredVersion);
    if (validator === undefined) {
      throw new ProtocolSchemaError(`schema validator was not compiled for ${declaredVersion}`);
    }
    const admissionIssues = resourceAdmissionIssues(value, declaredVersion);
    if (admissionIssues.length > 0) {
      return {
        valid: false,
        schemaVersion: declaredVersion,
        errors: admissionIssues,
      };
    }
    const valid = validator(value) as boolean;
    return {
      valid,
      schemaVersion: declaredVersion,
      errors: valid ? [] : (validator.errors ?? []).map(issue),
    };
  }

  assertProtocolObject(
    value: unknown,
    expectedSchemaVersion?: ProtocolSchemaVersion,
  ): asserts value is JsonObject {
    const result = this.validateProtocolObject(value, expectedSchemaVersion);
    if (!result.valid) {
      const detail = result.errors
        .map((entry) => `${entry.instancePath || "/"}: ${entry.message}`)
        .join("; ");
      throw new ProtocolSchemaError(`protocol schema validation failed: ${detail}`, result.errors);
    }
  }
}

export async function createSchemaValidator(
  schemaDirectory = defaultSchemaDirectory(),
): Promise<ProtocolSchemaValidator> {
  const directory = resolve(schemaDirectory);
  const ajv = new Ajv2020({
    allErrors: false,
    allowUnionTypes: true,
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    strict: true,
    // JSON Schema permits conditional `properties` without a repeated local
    // `type`; the enclosing object schemas already constrain those locations.
    strictTypes: false,
    // Likewise, a conditional `required` may name a property declared by its
    // enclosing schema rather than redeclaring it inside the `then` branch.
    strictRequired: false,
    validateFormats: true,
  });
  addFormats(ajv);

  const common = await parseJsonFileStrict<JsonObject>(resolve(directory, COMMON_SCHEMA_FILE), {
    label: COMMON_SCHEMA_FILE,
  });
  ajv.addSchema(common);
  for (const fileName of PROTOCOL_SCHEMA_FILES) {
    const schema = await parseJsonFileStrict<JsonObject>(resolve(directory, fileName), {
      label: fileName,
    });
    ajv.addSchema(schema);
  }

  const validators = new Map<ProtocolSchemaVersion, ValidateFunction>();
  for (const schemaVersion of PROTOCOL_SCHEMA_VERSIONS) {
    const validator = ajv.getSchema(SCHEMA_ID_BY_VERSION[schemaVersion]);
    if (validator === undefined) {
      throw new ProtocolSchemaError(`unable to compile schema for ${schemaVersion}`);
    }
    validators.set(schemaVersion, validator);
  }
  return new ProtocolSchemaValidator(directory, validators);
}

let defaultValidatorPromise: Promise<ProtocolSchemaValidator> | undefined;

/** Convenience wrapper using one cached, local-only schema registry. */
export async function validateProtocolObject(
  value: unknown,
  expectedSchemaVersion?: ProtocolSchemaVersion,
): Promise<SchemaValidationResult> {
  defaultValidatorPromise ??= createSchemaValidator();
  const validator = await defaultValidatorPromise;
  return validator.validateProtocolObject(value, expectedSchemaVersion);
}
