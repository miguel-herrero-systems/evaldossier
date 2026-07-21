import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { digestOfObject } from "../src/canonical.js";
import { signObject, verifyObjectSignature } from "../src/crypto.js";
import { assembleDossier, verifyDossier } from "../src/dossier.js";
import { runDemo } from "../src/demo.js";
import { buildSyntheticModelJudgmentNormalization } from "../src/model-judgment-adapter.js";
import { readSafeDossierFile, UnsafeDossierPathError } from "../src/fs-safe.js";
import { parseJsonStrict, StrictJsonError } from "../src/json.js";
import { buildReferenceEvaluation } from "../src/reference-evaluator.js";
import type {
  EvaluationRun,
  JsonObject,
  JsonValue,
  PrivateEd25519Jwk,
  PublicEd25519Jwk,
} from "../src/types.js";

const PROJECT_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TEST_AUDIENCE = "evaldossier.regression.consumer";
const TEST_NONCE = "cmVncmVzc2lvbi1kb3NzaWVyLW5vbmNl";

interface FixtureKeys {
  reference: PrivateEd25519Jwk;
  adapter: PrivateEd25519Jwk;
  requester: PrivateEd25519Jwk;
  exporter: PrivateEd25519Jwk;
}

async function temporaryDirectory(t: TestContext, label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `evaldossier-${label}-`));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function asObject(value: JsonValue | undefined, label: string): JsonObject {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function asArray(value: JsonValue | undefined, label: string): JsonValue[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  return value;
}

function asPrivateKey(value: JsonValue, label: string): PrivateEd25519Jwk {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const key = value as JsonObject;
  assert.equal(key.kty, "OKP", `${label}.kty`);
  assert.equal(key.crv, "Ed25519", `${label}.crv`);
  assert.equal(key.alg, "EdDSA", `${label}.alg`);
  assert.equal(key.use, "sig", `${label}.use`);
  assert.equal(typeof key.x, "string", `${label}.x`);
  assert.equal(typeof key.d, "string", `${label}.d`);
  assert.equal(typeof key.kid, "string", `${label}.kid`);
  return key as unknown as PrivateEd25519Jwk;
}

async function loadFixtureKeys(): Promise<FixtureKeys> {
  const keyRoot = join(PROJECT_ROOT, "fixtures", "keys");
  const load = async (name: string): Promise<PrivateEd25519Jwk> =>
    asPrivateKey(
      parseJsonStrict(await readFile(join(keyRoot, name)), name),
      name,
    );
  const [reference, adapter, requester, exporter] = await Promise.all([
    load("reference-evaluator.private.jwk.json"),
    load("adapter.private.jwk.json"),
    load("requester.private.jwk.json"),
    load("exporter.private.jwk.json"),
  ]);
  return { reference, adapter, requester, exporter };
}

function unsigned(value: JsonObject): JsonObject {
  const copy = structuredClone(value);
  delete copy.proof;
  return copy;
}

/**
 * Re-sign the complete object chain without repairing semantic mismatches.
 * This makes each negative test exercise verifier policy rather than merely a
 * stale digest or invalid signature.
 */
function resignRun(
  input: EvaluationRun,
  evaluatorKey: PrivateEd25519Jwk,
  requesterKey: PrivateEd25519Jwk,
): EvaluationRun {
  const run = structuredClone(input);
  run.profile = signObject(unsigned(run.profile), evaluatorKey);

  const manifestPayload = unsigned(run.manifest);
  const profileId = run.profile.profileId;
  const profileVersion = run.profile.version;
  const manifestProfile = asArray(manifestPayload.profiles, "manifest.profiles")
    .map((value, index) => asObject(value, `manifest.profiles[${index}]`))
    .find((value) => value.id === profileId && value.version === profileVersion);
  assert.ok(manifestProfile !== undefined, "manifest must list the mutated profile");
  manifestProfile.digest = digestOfObject(run.profile);
  run.manifest = signObject(manifestPayload, evaluatorKey);

  const requestPayload = unsigned(run.request);
  asObject(requestPayload.profile, "request.profile").digest = digestOfObject(run.profile);
  run.request = signObject(requestPayload, requesterKey);

  run.evidenceBundle = signObject(unsigned(run.evidenceBundle), requesterKey);

  const attestationPayload = unsigned(run.attestation);
  const bindings = asObject(attestationPayload.bindings, "attestation.bindings");
  bindings.manifestDigest = digestOfObject(run.manifest);
  bindings.profileDigest = digestOfObject(run.profile);
  bindings.requestDigest = digestOfObject(run.request);
  bindings.evidenceBundleDigest = digestOfObject(run.evidenceBundle);
  run.attestation = signObject(attestationPayload, evaluatorKey);
  return run;
}

async function assembleTestDossier(
  root: string,
  label: string,
  run: EvaluationRun,
  exporterKey: PrivateEd25519Jwk,
): Promise<string> {
  const dossierRoot = join(root, label);
  await assembleDossier(run, dossierRoot, exporterKey, {
    dossierId: `dossier.regression.${label}`,
    generatedAt: "2026-07-21T13:00:00Z",
    classification:
      asObject(run.request.privacy, "request.privacy").classification === "PUBLIC_CAPTURE_SANITIZED"
        ? "CAPTURED_EXTERNAL_RESPONSE"
        : "INTERNAL_REFERENCE",
    exporterId: "evaldossier.regression.exporter",
    audience: TEST_AUDIENCE,
    nonce: TEST_NONCE,
    warnings: ["Adversarial regression fixture; no external identity or authority is established."],
  });
  return dossierRoot;
}

function publicKeyFromDossier(dossier: JsonObject): PublicEd25519Jwk {
  const exporter = asObject(dossier.exporter, "dossier.exporter");
  return asObject(exporter.key, "dossier.exporter.key") as PublicEd25519Jwk;
}

function jwsParts(value: JsonObject): [string, string, string] {
  const proof = asObject(value.proof, "proof");
  const jws = proof.jws;
  assert.ok(typeof jws === "string", "proof.jws must be a string");
  const parts = jws.split(".");
  assert.equal(parts.length, 3);
  assert.equal(parts[1], "");
  assert.ok(parts[0] !== undefined && parts[2] !== undefined);
  return [parts[0], parts[1], parts[2]];
}

function replaceProtectedHeader(value: JsonObject, header: JsonObject): JsonObject {
  const copy = structuredClone(value);
  const proof = asObject(copy.proof, "proof");
  const [, detachedPayload, signature] = jwsParts(copy);
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  proof.jws = `${encodedHeader}.${detachedPayload}.${signature}`;
  return copy;
}

function propertyNames(value: JsonValue): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(propertyNames);
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, child]) => [key, ...propertyNames(child)]);
  }
  return [];
}

async function snapshotDirectory(root: string): Promise<Array<[string, string]>> {
  const snapshot: Array<[string, string]> = [];

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else {
        assert.equal(entry.isFile(), true, `unexpected non-file demo entry: ${absolutePath}`);
        snapshot.push([
          relative(root, absolutePath),
          (await readFile(absolutePath)).toString("base64"),
        ]);
      }
    }
  }

  await visit(root);
  return snapshot;
}

test("strict JSON rejects duplicate keys and malformed UTF-8 at the trust boundary", async (t) => {
  await t.test("duplicate object member", () => {
    assert.throws(
      () => parseJsonStrict(Buffer.from('{"decision":"first","decision":"second"}'), "duplicate fixture"),
      (error: unknown) => error instanceof StrictJsonError && error.code === "DUPLICATE_KEY",
    );
  });

  await t.test("malformed UTF-8", () => {
    assert.throws(
      () => parseJsonStrict(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), "invalid UTF-8 fixture"),
      (error: unknown) => error instanceof StrictJsonError && error.code === "INVALID_UTF8",
    );
  });

  await t.test("negative zero", () => {
    assert.throws(
      () => parseJsonStrict('{"value":-0}', "negative-zero fixture"),
      (error: unknown) => error instanceof StrictJsonError && error.code === "NEGATIVE_ZERO",
    );
  });

  await t.test("integer outside the interoperable safe range", () => {
    assert.throws(
      () => parseJsonStrict('{"value":9007199254740992}', "unsafe-integer fixture"),
      (error: unknown) => error instanceof StrictJsonError && error.code === "UNSAFE_INTEGER",
    );
  });
});

test("detached JWS verification rejects algorithm and protected-header substitution", async (t) => {
  const root = await temporaryDirectory(t, "jws");
  const demoRoot = join(root, "demo");
  await runDemo(demoRoot);
  const verified = await verifyDossier(join(demoRoot, "formal"));
  const key = publicKeyFromDossier(verified.dossier);
  const [encodedHeader] = jwsParts(verified.dossier);
  const originalHeader = parseJsonStrict<JsonObject>(
    Buffer.from(encodedHeader, "base64url"),
    "original protected header",
  );

  await t.test("alg none substitution", () => {
    const tampered = replaceProtectedHeader(verified.dossier, {
      ...originalHeader,
      alg: "none",
    });
    assert.throws(
      () => verifyObjectSignature(tampered, key),
      /protected header|EdDSA|UNEXPECTED_MEMBERS/i,
    );
  });

  await t.test("unapproved jku header", () => {
    const tampered = replaceProtectedHeader(verified.dossier, {
      ...originalHeader,
      jku: "https://attacker.invalid/key-set.json",
    });
    assert.throws(
      () => verifyObjectSignature(tampered, key),
      /protected header must contain exactly|UNEXPECTED_MEMBERS/i,
    );
  });
});

test("a modified source artifact invalidates the enclosing dossier", async (t) => {
  const root = await temporaryDirectory(t, "source-tamper");
  const demoRoot = join(root, "demo");
  await runDemo(demoRoot);
  const dossierRoot = join(demoRoot, "model-judgment");
  const sourceArtifact = join(dossierRoot, "evidence", "model-response.json");

  await appendFile(sourceArtifact, Buffer.from("\n", "utf8"));

  await assert.rejects(
    () => verifyDossier(dossierRoot),
    /Size mismatch|Digest mismatch/,
  );
});

test("confined dossier reads reject traversal and symbolic links", async (t) => {
  const root = await temporaryDirectory(t, "paths");
  const dossierRoot = join(root, "dossier");
  await mkdir(dossierRoot);
  await writeFile(join(root, "outside.json"), "{}", "utf8");

  await t.test("parent traversal", async () => {
    await assert.rejects(
      () => readSafeDossierFile(dossierRoot, "../outside.json"),
      (error: unknown) => error instanceof UnsafeDossierPathError && error.code === "UNSAFE_SEGMENT",
    );
  });

  await t.test("final-component symlink", async () => {
    const linkPath = join(dossierRoot, "linked.json");
    await symlink(join(root, "outside.json"), linkPath);
    await assert.rejects(
      () => readSafeDossierFile(dossierRoot, "linked.json"),
      (error: unknown) => error instanceof UnsafeDossierPathError && error.code === "SYMLINK_COMPONENT",
    );
  });
});

test("signed audience and digest bindings cannot be altered without detection", async (t) => {
  const root = await temporaryDirectory(t, "bindings");
  const demoRoot = join(root, "demo");
  await runDemo(demoRoot);
  const verified = await verifyDossier(join(demoRoot, "formal"));

  await t.test("audience tamper", () => {
    const dossier = structuredClone(verified.dossier);
    asObject(dossier.signatureContext, "dossier.signatureContext").audience = "attacker.invalid";
    assert.equal(verifyObjectSignature(dossier, publicKeyFromDossier(dossier)).valid, false);
  });

  await t.test("attestation request binding tamper", () => {
    const attestation = structuredClone(verified.objects.attestation);
    const evaluator = asObject(attestation.evaluator, "attestation.evaluator");
    assert.equal(typeof evaluator.keyId, "string");
    const keys = asArray(verified.objects.manifest.keys, "manifest.keys").map((value) =>
      asObject(value, "manifest key"),
    );
    const signingKey = keys.find((candidate) => candidate.kid === evaluator.keyId);
    assert.ok(signingKey !== undefined, "attestation signing key must be in the manifest");
    asObject(
      asObject(attestation.bindings, "attestation.bindings").requestDigest,
      "attestation.bindings.requestDigest",
    ).value = "0".repeat(64);
    assert.equal(
      verifyObjectSignature(attestation, signingKey as PublicEd25519Jwk).valid,
      false,
    );
  });
});

test("caller-pinned dossier audience and nonce are enforced", async (t) => {
  const root = await temporaryDirectory(t, "caller-bindings");
  const keys = await loadFixtureKeys();
  const run = await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester);
  const dossierRoot = await assembleTestDossier(root, "caller-bindings", run, keys.exporter);

  const verified = await verifyDossier(dossierRoot, {
    expectedAudience: TEST_AUDIENCE,
    expectedDossierNonce: TEST_NONCE,
  });
  assert.equal(verified.summary.audienceBinding, "PINNED");
  assert.equal(verified.summary.dossierNonceBinding, "PINNED");

  await t.test("wrong audience", async () => {
    await assert.rejects(
      () => verifyDossier(dossierRoot, { expectedAudience: "unexpected.consumer" }),
      /Dossier audience mismatch/,
    );
  });

  await t.test("wrong nonce", async () => {
    await assert.rejects(
      () => verifyDossier(dossierRoot, { expectedDossierNonce: "dW5leHBlY3RlZC1ub25jZS0wMDAx" }),
      /Dossier nonce does not match/,
    );
  });
});

test("fully re-signed basis laundering is rejected", async (t) => {
  const root = await temporaryDirectory(t, "basis-laundering");
  const keys = await loadFixtureKeys();
  const run = structuredClone(
    await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester),
  );
  const allowedBases = asArray(run.profile.allowedBases, "profile.allowedBases");
  allowedBases.push("MODEL_JUDGMENT");
  const firstPredicate = asObject(
    asArray(run.profile.predicates, "profile.predicates")[0],
    "profile.predicates[0]",
  );
  firstPredicate.basis = "MODEL_JUDGMENT";

  const resigned = resignRun(run, keys.reference, keys.requester);
  const dossierRoot = await assembleTestDossier(root, "basis-laundering", resigned, keys.exporter);
  await assert.rejects(
    () => verifyDossier(dossierRoot),
    /Assessment basis FORMAL_PREDICATE does not match predicate artifact-present basis MODEL_JUDGMENT/,
  );
});

test("fully re-signed EXACT_INPUT substitutions cannot inherit true assessments", async (t) => {
  const keys = await loadFixtureKeys();

  const exercise = async (
    label: string,
    mutate: (requestArtifact: JsonObject) => void,
    expected: RegExp,
  ): Promise<void> => {
    const root = await temporaryDirectory(t, label);
    const run = structuredClone(
      await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester),
    );
    const requestArtifact = asObject(
      asArray(run.request.artifacts, "request.artifacts")[0],
      "request.artifacts[0]",
    );
    mutate(requestArtifact);

    const assessments = asArray(run.attestation.assessments, "attestation.assessments").map(
      (value, index) => asObject(value, `attestation.assessments[${index}]`),
    );
    assert.ok(
      assessments.every((assessment) => assessment.predicateStatus === "ESTABLISHED_TRUE"),
      "the forged run deliberately retains every positive predicate result",
    );
    assert.equal(run.attestation.obligationVerdict, "SATISFIED");

    const resigned = resignRun(run, keys.reference, keys.requester);
    const dossierRoot = await assembleTestDossier(root, label, resigned, keys.exporter);
    await assert.rejects(() => verifyDossier(dossierRoot), expected);
  };

  await t.test("digest differs from the observed evidence", async () => {
    await exercise(
      "exact-input-digest-substitution",
      (requestArtifact) => {
        requestArtifact.digest = {
          algorithm: "sha-256",
          value: "0".repeat(64),
        };
      },
      /does not match its exact request digest commitment/,
    );
  });

  await t.test("size differs from the observed evidence", async () => {
    await exercise(
      "exact-input-size-substitution",
      (requestArtifact) => {
        const sizeBytes = requestArtifact.sizeBytes;
        if (typeof sizeBytes !== "number") {
          throw new TypeError("request artifact sizeBytes must be numeric");
        }
        requestArtifact.sizeBytes = sizeBytes + 1;
      },
      /does not match its exact request size commitment/,
    );
  });
});

test("unused mixed-basis profile predicates do not contaminate a formal-only request", async (t) => {
  const root = await temporaryDirectory(t, "unused-mixed-profile-basis");
  const keys = await loadFixtureKeys();
  const run = structuredClone(
    await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester),
  );
  asArray(run.profile.allowedBases, "profile.allowedBases").push("MODEL_JUDGMENT");
  asArray(run.profile.predicates, "profile.predicates").push({
    predicateId: "optional-model-opinion",
    description: "A profile capability that this particular request does not invoke.",
    basis: "MODEL_JUDGMENT",
  });

  const resigned = resignRun(run, keys.reference, keys.requester);
  const dossierRoot = await assembleTestDossier(
    root,
    "unused-mixed-profile-basis",
    resigned,
    keys.exporter,
  );
  const verified = await verifyDossier(dossierRoot);
  assert.equal(
    asObject(verified.objects.attestation.overallAssessment, "overallAssessment").basis,
    "FORMAL_PREDICATE",
  );
  assert.deepEqual(verified.summary.bases, ["FORMAL_PREDICATE"]);
  assert.equal(verified.summary.overallBasis, "FORMAL_PREDICATE");
  assert.equal(verified.summary.obligationVerdict, "SATISFIED");
});

test("a genuinely mixed request requires and accepts an explicit MIXED overall basis", async (t) => {
  const keys = await loadFixtureKeys();

  const buildMixedRun = async (): Promise<EvaluationRun> => {
    const run = structuredClone(
      await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester),
    );
    asArray(run.profile.allowedBases, "profile.allowedBases").push("MODEL_JUDGMENT");
    asArray(run.profile.predicates, "profile.predicates").push({
      predicateId: "requested-model-opinion",
      description: "A requested model judgment that cannot establish predicate truth.",
      basis: "MODEL_JUDGMENT",
    });
    asArray(run.request.criteria, "request.criteria").push({
      criterionId: "criterion-model-opinion",
      predicateId: "requested-model-opinion",
      required: true,
      statement: "Obtain a model judgment without upgrading it to truth.",
      parameters: [],
    });
    asArray(run.attestation.assessments, "attestation.assessments").push({
      assessmentId: "assessment-model-opinion",
      criterionId: "criterion-model-opinion",
      statement: "The model judged the supplied artifact positively.",
      basis: "MODEL_JUDGMENT",
      assessment: "AFFIRMED",
      predicateStatus: "UNDETERMINED",
      reasonCode: "MODEL_JUDGMENT_ONLY",
      evidenceArtifactIds: ["reference-deliverable"],
      limitations: ["A model judgment does not establish the requested predicate as true."],
    });
    asArray(
      asObject(run.attestation.coverage, "attestation.coverage").assessedCriterionIds,
      "coverage.assessedCriterionIds",
    ).push("criterion-model-opinion");
    return run;
  };

  await t.test("FORMAL_PREDICATE overall basis is rejected", async () => {
    const root = await temporaryDirectory(t, "mixed-request-formal-overall");
    const resigned = resignRun(await buildMixedRun(), keys.reference, keys.requester);
    const dossierRoot = await assembleTestDossier(
      root,
      "mixed-request-formal-overall",
      resigned,
      keys.exporter,
    );
    await assert.rejects(
      () => verifyDossier(dossierRoot),
      /Overall basis must be MIXED for the requested criteria/,
    );
  });

  await t.test("MIXED basis with an inconclusive required judgment verifies", async () => {
    const root = await temporaryDirectory(t, "mixed-request-mixed-overall");
    const run = await buildMixedRun();
    const overall = asObject(run.attestation.overallAssessment, "attestation.overallAssessment");
    overall.basis = "MIXED";
    overall.assessment = "INCONCLUSIVE";
    overall.reasonCode = "REQUIRED_MIXED_BASIS_UNDETERMINED";
    run.attestation.obligationVerdict = "INCONCLUSIVE";

    const resigned = resignRun(run, keys.reference, keys.requester);
    const dossierRoot = await assembleTestDossier(
      root,
      "mixed-request-mixed-overall",
      resigned,
      keys.exporter,
    );
    const verified = await verifyDossier(dossierRoot);
    assert.equal(
      asObject(verified.objects.attestation.overallAssessment, "overallAssessment").basis,
      "MIXED",
    );
    assert.deepEqual(verified.summary.bases, ["FORMAL_PREDICATE", "MODEL_JUDGMENT"]);
    assert.equal(verified.summary.overallBasis, "MIXED");
    assert.equal(verified.summary.obligationVerdict, "INCONCLUSIVE");
  });
});

test("fully re-signed evaluator identity, version, and mode mismatches are rejected", async (t) => {
  const keys = await loadFixtureKeys();

  const exercise = async (
    label: string,
    mutate: (attestation: JsonObject) => void,
    expected: RegExp,
  ): Promise<void> => {
    const root = await temporaryDirectory(t, label);
    const run = structuredClone(
      await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester),
    );
    mutate(run.attestation);
    const resigned = resignRun(run, keys.reference, keys.requester);
    const dossierRoot = await assembleTestDossier(root, label, resigned, keys.exporter);
    await assert.rejects(() => verifyDossier(dossierRoot), expected);
  };

  await t.test("evaluatorId mismatch", async () => {
    await exercise(
      "evaluator-id-mismatch",
      (attestation) => {
        asObject(attestation.evaluator, "attestation.evaluator").evaluatorId =
          "different-reference-evaluator";
      },
      /Attestation evaluator does not match the manifest/,
    );
  });

  await t.test("softwareVersion mismatch", async () => {
    await exercise(
      "software-version-mismatch",
      (attestation) => {
        asObject(attestation.evaluator, "attestation.evaluator").softwareVersion = "9.9.9";
      },
      /Attestation software version does not match the manifest/,
    );
  });

  await t.test("mode mismatch", async () => {
    await exercise(
      "mode-mismatch",
      (attestation) => {
        attestation.mode = "UPSTREAM_NORMALIZATION";
      },
      /Attestation mode UPSTREAM_NORMALIZATION is incompatible with EVALUATE/,
    );
  });
});

test("fully re-signed inconsistent coverage is rejected", async (t) => {
  const root = await temporaryDirectory(t, "coverage-mismatch");
  const keys = await loadFixtureKeys();
  const run = structuredClone(
    await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester),
  );
  const coverage = asObject(run.attestation.coverage, "attestation.coverage");
  coverage.assessedCriterionIds = [
    "criterion-artifact-present",
    "criterion-artifact-digest",
  ];
  const resigned = resignRun(run, keys.reference, keys.requester);
  const dossierRoot = await assembleTestDossier(root, "coverage-mismatch", resigned, keys.exporter);

  await assert.rejects(
    () => verifyDossier(dossierRoot),
    /Coverage assessedCriterionIds do not match the actual assessments/,
  );
});

test("fully re-signed duplicate evidence paths are rejected", async (t) => {
  const root = await temporaryDirectory(t, "duplicate-evidence-path");
  const keys = await loadFixtureKeys();
  const run = structuredClone(
    await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester),
  );
  const requestArtifacts = asArray(run.request.artifacts, "request.artifacts");
  const evidenceArtifacts = asArray(run.evidenceBundle.artifacts, "evidenceBundle.artifacts");
  const firstEvidence = asObject(evidenceArtifacts[0], "evidenceBundle.artifacts[0]");
  const secondEvidence = asObject(evidenceArtifacts[1], "evidenceBundle.artifacts[1]");
  const secondRequest = asObject(requestArtifacts[1], "request.artifacts[1]");
  secondEvidence.path = firstEvidence.path as JsonValue;
  secondEvidence.mediaType = firstEvidence.mediaType as JsonValue;
  secondRequest.mediaType = firstEvidence.mediaType as JsonValue;

  const resigned = resignRun(run, keys.reference, keys.requester);
  const dossierRoot = await assembleTestDossier(
    root,
    "duplicate-evidence-path",
    resigned,
    keys.exporter,
  );
  await assert.rejects(
    () => verifyDossier(dossierRoot),
    /Multiple evidence artifacts reference the same dossier path/,
  );
});

test("fully re-signed upstream mapping substitutions are rejected", async (t) => {
  const keys = await loadFixtureKeys();

  const exercise = async (
    label: string,
    mutate: (mapping: JsonObject) => void,
    expected: RegExp,
  ): Promise<void> => {
    const root = await temporaryDirectory(t, label);
    const run = structuredClone(
      await buildSyntheticModelJudgmentNormalization(PROJECT_ROOT, keys.adapter, keys.requester),
    );
    const overall = asObject(run.attestation.overallAssessment, "attestation.overallAssessment");
    const mapping = asObject(overall.upstreamMapping, "overallAssessment.upstreamMapping");
    mutate(mapping);
    const resigned = resignRun(run, keys.adapter, keys.requester);
    const dossierRoot = await assembleTestDossier(root, label, resigned, keys.exporter);
    await assert.rejects(() => verifyDossier(dossierRoot), expected);
  };

  await t.test("nativeValue mismatch", async () => {
    await exercise(
      "upstream-native-value-mismatch",
      (mapping) => {
        mapping.nativeValue = "fail";
      },
      /nativeValue does not match the committed source/,
    );
  });

  await t.test("nativePointer mismatch", async () => {
    await exercise(
      "upstream-native-pointer-mismatch",
      (mapping) => {
        mapping.nativePointer = "/response/scoring/not_present";
      },
      /JSON Pointer does not resolve/,
    );
  });

  await t.test("mapping policy mismatch", async () => {
    await exercise(
      "upstream-policy-mismatch",
      (mapping) => {
        mapping.mappingPolicyId = "substituted-mapping-policy-v0";
      },
      /does not use the signed profile mapping policy/,
    );
  });
});

test("an uncommitted extra file invalidates an otherwise valid dossier", async (t) => {
  const root = await temporaryDirectory(t, "uncommitted-file");
  const keys = await loadFixtureKeys();
  const run = await buildReferenceEvaluation(PROJECT_ROOT, keys.reference, keys.requester);
  const dossierRoot = await assembleTestDossier(root, "uncommitted-file", run, keys.exporter);
  await writeFile(join(dossierRoot, "evidence", "uncommitted.json"), "{}\n", "utf8");

  await assert.rejects(
    () => verifyDossier(dossierRoot),
    /Uncommitted file in dossier: evidence\/uncommitted\.json/,
  );
});

test("the synthetic model fixture remains judgment, never predicate truth or payout", async (t) => {
  const root = await temporaryDirectory(t, "model-judgment-boundary");
  const demoRoot = join(root, "demo");
  await runDemo(demoRoot);
  const verified = await verifyDossier(join(demoRoot, "model-judgment"));
  const attestation = verified.objects.attestation;
  const assessments = asArray(attestation.assessments, "attestation.assessments").map((value) =>
    asObject(value, "assessment"),
  );
  const favorable = assessments.find((assessment) => assessment.assessment === "AFFIRMED");

  assert.equal(assessments.length, 3);
  assert.ok(favorable !== undefined, "the synthetic fixture must contain a favorable judgment");
  assert.equal(favorable.predicateStatus, "UNDETERMINED");
  assert.equal(favorable.basis, "MODEL_JUDGMENT");
  assert.ok(assessments.every((assessment) => assessment.predicateStatus === "UNDETERMINED"));
  assert.equal(attestation.obligationVerdict, "INCONCLUSIVE");
  assert.equal(attestation.economicAction, "OUT_OF_SCOPE");
  assert.equal(verified.summary.obligationVerdict, "INCONCLUSIVE");
  assert.equal(verified.summary.economicAction, "OUT_OF_SCOPE");
  assert.deepEqual(verified.summary.provenance, ["SYNTHETIC"]);
  assert.deepEqual(
    propertyNames(attestation).filter((key) => key.toLowerCase().includes("payout")),
    [],
    "upstream payout data may be cited as ignored source input, but must not become an attestation property",
  );
});

test("the native formal reference evaluator can establish SATISFIED", async (t) => {
  const root = await temporaryDirectory(t, "formal");
  const demoRoot = join(root, "demo");
  await runDemo(demoRoot);
  const verified = await verifyDossier(join(demoRoot, "formal"));

  assert.equal(verified.objects.attestation.mode, "NATIVE_EVALUATION");
  assert.equal(verified.objects.attestation.obligationVerdict, "SATISFIED");
  assert.equal(verified.summary.obligationVerdict, "SATISFIED");
  assert.deepEqual(verified.summary.bases, ["FORMAL_PREDICATE"]);
  assert.deepEqual(verified.summary.predicateStatuses, ["ESTABLISHED_TRUE"]);
  assert.equal(verified.summary.economicAction, "OUT_OF_SCOPE");
});

test("two independent demo runs are byte-for-byte reproducible", async (t) => {
  const root = await temporaryDirectory(t, "reproducibility");
  const first = join(root, "first");
  const second = join(root, "second");
  await runDemo(first);
  await runDemo(second);

  assert.deepEqual(await snapshotDirectory(first), await snapshotDirectory(second));
});
