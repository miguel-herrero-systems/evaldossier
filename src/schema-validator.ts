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

function issue(error: ErrorObject): SchemaIssue {
  return {
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
    params: error.params,
  };
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
      return {
        valid: false,
        schemaVersion: declaredVersion,
        errors: [
          {
            instancePath: "/schemaVersion",
            schemaPath: "",
            keyword: "const",
            message: `expected ${expectedSchemaVersion}, received ${declaredVersion}`,
            params: { allowedValue: expectedSchemaVersion },
          },
        ],
      };
    }
    if (!isProtocolSchemaVersion(declaredVersion)) {
      return {
        valid: false,
        schemaVersion: declaredVersion,
        errors: [
          {
            instancePath: "/schemaVersion",
            schemaPath: "",
            keyword: "enum",
            message: `unsupported protocol schema version ${declaredVersion}`,
            params: { allowedValues: [...PROTOCOL_SCHEMA_VERSIONS] },
          },
        ],
      };
    }

    const validator = this.#validators.get(declaredVersion);
    if (validator === undefined) {
      throw new ProtocolSchemaError(`schema validator was not compiled for ${declaredVersion}`);
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
    allErrors: true,
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
