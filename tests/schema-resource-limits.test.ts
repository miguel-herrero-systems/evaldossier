import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import test from "node:test";

import { createSchemaValidator } from "../src/schema-validator.js";
import type { ProtocolSchemaVersion } from "../src/types.js";

const validatorPromise = createSchemaValidator();

function protocolObject(
  schemaVersion: ProtocolSchemaVersion,
  properties: Record<string, unknown>,
): Record<string, unknown> {
  return { schemaVersion, ...properties };
}

// Immutable wire-schema bytes from Git tag v0.1.0. A changed digest requires a
// new protocol/schema identity rather than an SDK-only security patch.
const RELEASED_PROTOCOL_SCHEMA_SHA256 = {
  "evaluation-attestation.schema.json":
    "f94e2bf6b935e67731638447f8c791a1c1e2529951c37c4a41b45cac41c9cabd",
  "evaluator-manifest.schema.json":
    "b0b126799544d3633502ffdd7422818743dd91005af56e3dd7c628caa4b7c864",
  "profile-definition.schema.json":
    "4f2a85e126958c8219b687d173b3887ce97b32d99af391b85aea1e9b9187dd21",
} as const;

function validManifestWithKeys(keys: unknown[]): Record<string, unknown> {
  const keyId = "K".repeat(43);
  const digest = { algorithm: "sha-256", value: "a".repeat(64) };
  return {
    protocolVersion: "evaldossier/0.1",
    schemaVersion: "evaldossier.evaluator-manifest/0.1",
    manifestId: "manifest.resource-limit-test",
    evaluatorId: "evaluator.resource-limit-test",
    evaluatorType: "NATIVE",
    issuedAt: "2026-07-21T00:00:00Z",
    expiresAt: "2027-07-21T00:00:00Z",
    operator: {
      id: "operator.resource-limit-test",
      displayName: "Resource limit test operator",
      relationship: "INTERNAL_REFERENCE_OPERATOR",
    },
    signingKeyId: keyId,
    keys,
    profiles: [{ id: "profile.formal-json", version: "0.1.0", digest }],
    software: {
      name: "evaldossier-resource-limit-test",
      version: "0.1.0",
      sourceVisibility: "OPEN_SOURCE",
    },
    dataPractices: {
      acceptedClassifications: ["PUBLIC_SYNTHETIC"],
      trainingUse: false,
      networkUse: false,
    },
    signatureContext: {
      audience: "evaldossier-resource-limit-tests",
      nonce: "N".repeat(22),
    },
    proof: { type: "evaldossier.detached-jws/0.1", jws: "eA..eA" },
  };
}

async function assertRejectedAtAdmission(
  value: Record<string, unknown>,
  expectedPath: string,
  expectedLimit: number,
): Promise<void> {
  const validator = await validatorPromise;
  const result = validator.validateProtocolObject(value);

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  const [issue] = result.errors;
  assert.ok(issue);
  assert.equal(issue.instancePath, expectedPath);
  assert.match(issue.schemaPath, /\/maxItems$/);
  assert.equal(issue.keyword, "maxItems");
  assert.equal(issue.message, `must NOT have more than ${expectedLimit} items`);
  assert.deepEqual(issue.params, { limit: expectedLimit });
}

test("resource admission rejects oversized dossier artifact indexes before Ajv", async () => {
  await assertRejectedAtAdmission(
    protocolObject("evaldossier.dossier/0.1", {
      artifacts: Array.from({ length: 65 }, () => ({})),
    }),
    "/artifacts",
    64,
  );
});

test("resource admission rejects oversized attestation coverage arrays before Ajv", async (t) => {
  for (const field of ["assessedCriterionIds", "unassessedCriterionIds"] as const) {
    await t.test(field, async () => {
      await assertRejectedAtAdmission(
        protocolObject("evaldossier.evaluation-attestation/0.1", {
          coverage: { [field]: Array.from({ length: 129 }, (_, index) => `criterion-${index}`) },
        }),
        `/coverage/${field}`,
        128,
      );
    });
  }
});

test("resource admission rejects oversized assessment collections before Ajv", async () => {
  await assertRejectedAtAdmission(
    protocolObject("evaldossier.evaluation-attestation/0.1", {
      assessments: Array.from({ length: 129 }, () => ({})),
    }),
    "/assessments",
    128,
  );
});

test("resource admission rejects oversized evidence references before Ajv", async () => {
  await assertRejectedAtAdmission(
    protocolObject("evaldossier.evaluation-attestation/0.1", {
      assessments: [
        {
          evidenceArtifactIds: Array.from({ length: 33 }, (_, index) => `artifact-${index}`),
        },
      ],
    }),
    "/assessments/0/evidenceArtifactIds",
    32,
  );
});

test("resource admission rejects impossible manifest classification cardinality before Ajv", async () => {
  await assertRejectedAtAdmission(
    protocolObject("evaldossier.evaluator-manifest/0.1", {
      dataPractices: {
        acceptedClassifications: [
          "PUBLIC_SYNTHETIC",
          "PUBLIC_CAPTURE_SANITIZED",
          "PUBLIC_SYNTHETIC",
        ],
      },
    }),
    "/dataPractices/acceptedClassifications",
    2,
  );
});

test("resource admission bounds both profile basis collections before Ajv", async (t) => {
  await t.test("allowedBases", async () => {
    await assertRejectedAtAdmission(
      protocolObject("evaldossier.profile-definition/0.1", {
        allowedBases: Array.from({ length: 7 }, () => "FORMAL_PREDICATE"),
      }),
      "/allowedBases",
      6,
    );
  });

  await t.test("obligationEligibleBases", async () => {
    await assertRejectedAtAdmission(
      protocolObject("evaldossier.profile-definition/0.1", {
        aggregationPolicy: {
          obligationEligibleBases: Array.from({ length: 7 }, () => "FORMAL_PREDICATE"),
        },
      }),
      "/aggregationPolicy/obligationEligibleBases",
      6,
    );
  });
});

test("published protocol 0.1 schema bytes remain identical to tag v0.1.0", async (t) => {
  for (const [fileName, expectedDigest] of Object.entries(RELEASED_PROTOCOL_SCHEMA_SHA256)) {
    await t.test(fileName, async () => {
      const bytes = await readFile(resolve("schemas", fileName));
      const actualDigest = createHash("sha256").update(bytes).digest("hex");
      assert.equal(actualDigest, expectedDigest);
    });
  }
});

test("Ajv rejects a 40k manifest key array before visiting any item", async () => {
  const validator = await validatorPromise;
  const backingKeys = Array.from({ length: 40_000 }, () => ({}));
  const keys = new Proxy(backingKeys, {
    get(target, property, receiver) {
      if (typeof property === "string" && /^(?:0|[1-9][0-9]*)$/.test(property)) {
        throw new Error(`schema validator fanned out into manifest.keys[${property}]`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  const startedAt = performance.now();
  const result = validator.validateProtocolObject(validManifestWithKeys(keys));
  const elapsedMs = performance.now() - startedAt;

  assert.equal(result.valid, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.instancePath, "/keys");
  assert.equal(result.errors[0]?.keyword, "maxItems");
  assert.ok(elapsedMs < 1_000, `fail-fast validation took ${elapsedMs.toFixed(1)} ms`);
});

test("schema diagnostics bound attacker-controlled property names and versions", async (t) => {
  const validator = await validatorPromise;

  await t.test("additional property params", () => {
    const keyId = "K".repeat(43);
    const candidate = validManifestWithKeys([
      {
        alg: "EdDSA",
        crv: "Ed25519",
        kid: keyId,
        kty: "OKP",
        use: "sig",
        x: "X".repeat(43),
      },
    ]);
    candidate[`attacker-${"x".repeat(1024 * 1024)}`] = true;

    const result = validator.validateProtocolObject(candidate);
    const serialized = JSON.stringify(result);
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.keyword, "additionalProperties");
    assert.ok(serialized.length < 4_096, `diagnostic serialized to ${serialized.length} chars`);
    assert.match(serialized, /sha256:[a-f0-9]{16}/u);
  });

  await t.test("unsupported schemaVersion", () => {
    const result = validator.validateProtocolObject({
      schemaVersion: `unknown-${"v".repeat(1024 * 1024)}`,
    });
    const serialized = JSON.stringify(result);
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.keyword, "enum");
    assert.ok(serialized.length < 2_048, `diagnostic serialized to ${serialized.length} chars`);
    assert.match(serialized, /sha256:[a-f0-9]{16}/u);
  });
});
