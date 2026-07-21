import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  buildReferenceEvaluation,
  verifyObjectSignature,
  type JsonObject,
  type PrivateEd25519Jwk,
} from "evaldossier";
import {
  EvaluatorSdkError,
  SDK_PROTOCOL_SCHEMA_VERSIONS,
  assertEvaluatorConformance,
  createSignedProtocolObject,
  defineEvaluator,
  protocolObjectDigest,
  publicSigningKey,
  runEvaluator,
  type ProtocolObjectPayload,
} from "evaldossier/sdk";

import { parseJsonFileStrict } from "../src/json.js";
import { validateProtocolObject } from "../src/schema-validator.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

async function loadKey(name: string): Promise<PrivateEd25519Jwk> {
  return (await parseJsonFileStrict(
    join(projectRoot, "fixtures", "keys", name),
  )) as unknown as PrivateEd25519Jwk;
}

async function referenceKeys(): Promise<{
  evaluatorKey: PrivateEd25519Jwk;
  requesterKey: PrivateEd25519Jwk;
  exporterKey: PrivateEd25519Jwk;
}> {
  const [evaluatorKey, requesterKey, exporterKey] = await Promise.all([
    loadKey("reference-evaluator.private.jwk.json"),
    loadKey("requester.private.jwk.json"),
    loadKey("exporter.private.jwk.json"),
  ]);
  return { evaluatorKey, requesterKey, exporterKey };
}

function dossierOptions(outputDirectory: string, exporterKey: PrivateEd25519Jwk) {
  return {
    outputDirectory,
    exporterKey,
    dossier: {
      dossierId: "sdk.reference.conformance.001",
      generatedAt: "2026-07-21T12:00:10Z",
      classification: "INTERNAL_REFERENCE" as const,
      exporterId: "evaldossier.fixture.exporter",
      audience: "evaldossier.sdk.tests",
      nonce: "c2RrLWNvbmZvcm1hbmNlLW5vbmNlLTAwMQ",
      warnings: ["Public deterministic fixture keys; never use them in production."],
    },
  };
}

test("the SDK creates a schema-valid signed protocol object without owning its claims", async () => {
  const { evaluatorKey } = await referenceKeys();
  const captured = await parseJsonFileStrict<JsonObject>(
    join(projectRoot, "examples", "formal", "objects", "profile-definition.json"),
  );
  const {
    protocolVersion: _protocolVersion,
    schemaVersion: _schemaVersion,
    proof: _proof,
    ...unsignedPayload
  } = captured;

  const signed = await createSignedProtocolObject(
    "profile-definition",
    unsignedPayload as ProtocolObjectPayload,
    evaluatorKey,
  );
  const validation = await validateProtocolObject(
    signed,
    "evaldossier.profile-definition/0.1",
  );

  assert.equal(validation.valid, true);
  assert.equal(signed.protocolVersion, "evaldossier/0.1");
  assert.equal(signed.schemaVersion, "evaldossier.profile-definition/0.1");
  assert.equal(verifyObjectSignature(signed, publicSigningKey(evaluatorKey)).valid, true);
  assert.match(protocolObjectDigest(signed).value, /^[a-f0-9]{64}$/);
});

test("signed protocol-object creation snapshots nested payload data before validation", async () => {
  const { evaluatorKey } = await referenceKeys();
  const captured = await parseJsonFileStrict<JsonObject>(
    join(projectRoot, "examples", "formal", "objects", "profile-definition.json"),
  );
  const {
    protocolVersion: _protocolVersion,
    schemaVersion: _schemaVersion,
    proof: _proof,
    ...unsignedPayload
  } = captured;
  const publisher = unsignedPayload.publisher as JsonObject;
  const originalPublisherId = publisher.id;

  const pending = createSignedProtocolObject(
    "profile-definition",
    unsignedPayload as ProtocolObjectPayload,
    evaluatorKey,
  );
  publisher.id = "mutated-after-signing";
  const signed = await pending;

  assert.equal((signed.publisher as JsonObject).id, originalPublisherId);
  assert.equal(verifyObjectSignature(signed, publicSigningKey(evaluatorKey)).valid, true);
});

test("the SDK refuses caller-controlled protocol envelope fields", async () => {
  const { evaluatorKey } = await referenceKeys();
  await assert.rejects(
    createSignedProtocolObject(
      "profile-definition",
      { protocolVersion: "evaldossier/9.9" } as unknown as ProtocolObjectPayload,
      evaluatorKey,
    ),
    (error: unknown) =>
      error instanceof EvaluatorSdkError && error.code === "INVALID_PROTOCOL_PAYLOAD",
  );
});

test("the SDK rejects unknown protocol object kinds from untyped callers", async () => {
  const { evaluatorKey } = await referenceKeys();
  for (const kind of ["unknown-kind", new String("profile-definition")]) {
    await assert.rejects(
      createSignedProtocolObject(
        kind as never,
        {} as ProtocolObjectPayload,
        evaluatorKey,
      ),
      (error: unknown) =>
        error instanceof EvaluatorSdkError && error.code === "INVALID_PROTOCOL_PAYLOAD",
    );
  }
});

test("defineEvaluator validates identity and freezes the executable definition", () => {
  const evaluator = defineEvaluator({
    evaluatorId: "sdk-test-evaluator",
    evaluate: () => {
      throw new Error("not executed");
    },
  });
  assert.equal(Object.isFrozen(evaluator), true);
  assert.equal(Object.isFrozen(SDK_PROTOCOL_SCHEMA_VERSIONS), true);
  assert.throws(
    () => defineEvaluator({ evaluatorId: "x", evaluate: evaluator.evaluate }),
    (error: unknown) =>
      error instanceof EvaluatorSdkError && error.code === "INVALID_EVALUATOR_ID",
  );
  for (const evaluatorId of [null, undefined, { toString: () => "valid-id" }]) {
    assert.throws(
      () =>
        defineEvaluator({
          evaluatorId,
          evaluate: evaluator.evaluate,
        } as never),
      (error: unknown) =>
        error instanceof EvaluatorSdkError && error.code === "INVALID_EVALUATOR_ID",
    );
  }
});

test("runEvaluator produces a dossier and pins its consumer context", async () => {
  const keys = await referenceKeys();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-sdk-test-"));
  try {
    const evaluator = defineEvaluator({
      evaluatorId: "evaldossier-reference-evaluator",
      evaluate: () =>
        buildReferenceEvaluation(projectRoot, keys.evaluatorKey, keys.requesterKey),
    });
    const result = await runEvaluator(
      evaluator,
      undefined,
      dossierOptions(join(temporaryRoot, "dossier"), keys.exporterKey),
    );

    assert.equal(result.verified.summary.schema, "VALID");
    assert.equal(result.verified.summary.integrity, "VALID");
    assert.equal(result.verified.summary.signatures, "VALID");
    assert.equal(result.verified.summary.audienceBinding, "PINNED");
    assert.equal(result.verified.summary.dossierNonceBinding, "PINNED");
    assert.equal(result.verified.summary.economicAction, "OUT_OF_SCOPE");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runEvaluator snapshots getters, options and synchronous run data before awaiting", async () => {
  const keys = await referenceKeys();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-sdk-snapshot-"));
  const firstOutput = join(temporaryRoot, "first-dossier");
  const secondOutput = join(temporaryRoot, "second-dossier");
  try {
    const mutableRun = await buildReferenceEvaluation(
      projectRoot,
      keys.evaluatorKey,
      keys.requesterKey,
    );
    let evaluatorIdReads = 0;
    const evaluator = {
      get evaluatorId() {
        evaluatorIdReads += 1;
        return "evaldossier-reference-evaluator";
      },
      evaluate() {
        return mutableRun;
      },
    };
    const baseOptions = dossierOptions(firstOutput, keys.exporterKey);
    let outputDirectoryReads = 0;
    const options = {
      get outputDirectory() {
        outputDirectoryReads += 1;
        return outputDirectoryReads === 1 ? firstOutput : secondOutput;
      },
      exporterKey: baseOptions.exporterKey,
      dossier: baseOptions.dossier,
    };

    const pending = runEvaluator(evaluator, undefined, options);
    (mutableRun.profile.publisher as JsonObject).id = "mutated-after-return";
    baseOptions.dossier.audience = "mutated-after-start";
    const result = await pending;

    assert.equal(evaluatorIdReads, 1);
    assert.equal(outputDirectoryReads, 1);
    assert.equal(result.outputDirectory, firstOutput);
    assert.equal(
      (result.run.profile.publisher as JsonObject).id,
      "evaldossier-reference-evaluator",
    );
    assert.equal(result.verified.summary.audience, "evaldossier.sdk.tests");
    assert.equal(
      verifyObjectSignature(result.run.profile, publicSigningKey(keys.evaluatorKey)).valid,
      true,
    );
    await access(firstOutput);
    await assert.rejects(access(secondOutput));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runEvaluator rejects a definition that does not match signed identities before writing", async () => {
  const keys = await referenceKeys();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-sdk-id-test-"));
  const outputDirectory = join(temporaryRoot, "dossier");
  try {
    const evaluator = defineEvaluator({
      evaluatorId: "different-evaluator",
      evaluate: () =>
        buildReferenceEvaluation(projectRoot, keys.evaluatorKey, keys.requesterKey),
    });
    await assert.rejects(
      runEvaluator(
        evaluator,
        undefined,
        dossierOptions(outputDirectory, keys.exporterKey),
      ),
      (error: unknown) =>
        error instanceof EvaluatorSdkError && error.code === "EVALUATOR_ID_MISMATCH",
    );
    await assert.rejects(access(outputDirectory));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("runEvaluator rejects an invalid run schema before creating output", async () => {
  const keys = await referenceKeys();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-sdk-schema-test-"));
  const outputDirectory = join(temporaryRoot, "dossier");
  try {
    const evaluator = defineEvaluator({
      evaluatorId: "evaldossier-reference-evaluator",
      async evaluate() {
        const run = await buildReferenceEvaluation(
          projectRoot,
          keys.evaluatorKey,
          keys.requesterKey,
        );
        run.profile.unexpectedSdkField = true;
        return run;
      },
    });
    await assert.rejects(
      runEvaluator(
        evaluator,
        undefined,
        dossierOptions(outputDirectory, keys.exporterKey),
      ),
      (error: unknown) =>
        error instanceof EvaluatorSdkError && error.code === "INVALID_PROTOCOL_OBJECT",
    );
    await assert.rejects(access(outputDirectory));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the conformance kit checks declared semantics without claiming external truth", async () => {
  const keys = await referenceKeys();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-sdk-conformance-"));
  try {
    const evaluator = defineEvaluator({
      evaluatorId: "evaldossier-reference-evaluator",
      evaluate: () =>
        buildReferenceEvaluation(projectRoot, keys.evaluatorKey, keys.requesterKey),
    });
    const result = await assertEvaluatorConformance(
      evaluator,
      undefined,
      dossierOptions(join(temporaryRoot, "dossier"), keys.exporterKey),
      {
        bases: ["FORMAL_PREDICATE"],
        overallBasis: "FORMAL_PREDICATE",
        predicateStatuses: ["ESTABLISHED_TRUE"],
        obligationVerdict: "SATISFIED",
      },
    );

    assert.equal(result.status, "PASS");
    assert.equal(result.checks.length, 11);
    assert.deepEqual(
      result.checks.map((check) => check.status),
      Array.from({ length: 11 }, () => "PASS"),
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the conformance kit fails closed on an unexpected semantic result", async () => {
  const keys = await referenceKeys();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-sdk-expectation-"));
  const outputDirectory = join(temporaryRoot, "dossier");
  try {
    const evaluator = defineEvaluator({
      evaluatorId: "evaldossier-reference-evaluator",
      evaluate: () =>
        buildReferenceEvaluation(projectRoot, keys.evaluatorKey, keys.requesterKey),
    });
    await assert.rejects(
      assertEvaluatorConformance(
        evaluator,
        undefined,
        dossierOptions(outputDirectory, keys.exporterKey),
        { obligationVerdict: "NOT_SATISFIED" },
      ),
      (error: unknown) =>
        error instanceof EvaluatorSdkError &&
        error.code === "CONFORMANCE_EXPECTATION_FAILED",
    );
    await assert.rejects(access(outputDirectory));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("the conformance kit rejects misspelled expectation keys before writing", async () => {
  const keys = await referenceKeys();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-sdk-unknown-expectation-"));
  const outputDirectory = join(temporaryRoot, "dossier");
  try {
    const evaluator = defineEvaluator({
      evaluatorId: "evaldossier-reference-evaluator",
      evaluate: () =>
        buildReferenceEvaluation(projectRoot, keys.evaluatorKey, keys.requesterKey),
    });
    await assert.rejects(
      assertEvaluatorConformance(
        evaluator,
        undefined,
        dossierOptions(outputDirectory, keys.exporterKey),
        { obligationVerdit: "NOT_SATISFIED" } as never,
      ),
      (error: unknown) =>
        error instanceof EvaluatorSdkError &&
        error.code === "CONFORMANCE_EXPECTATION_FAILED",
    );
    await assert.rejects(access(outputDirectory));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
