import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleDossier, verifyDossier } from "./dossier.js";
import { buildSyntheticModelJudgmentNormalization } from "./model-judgment-adapter.js";
import { parseJsonFileStrict } from "./json.js";
import { buildReferenceEvaluation } from "./reference-evaluator.js";
import type { JsonObject, PrivateEd25519Jwk } from "./types.js";
import type { VerificationSummary } from "./report.js";

const DEMO_MARKER = ".evaldossier-demo-root";

export interface DemoResult {
  outputRoot: string;
  formal: VerificationSummary;
  modelJudgment: VerificationSummary;
}

function projectRootFromModule(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

function asPrivateKey(value: unknown, source: string): PrivateEd25519Jwk {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} must contain a private JWK object`);
  }
  const key = value as JsonObject;
  if (
    key.kty !== "OKP" ||
    key.crv !== "Ed25519" ||
    typeof key.d !== "string" ||
    typeof key.x !== "string" ||
    typeof key.kid !== "string" ||
    key.alg !== "EdDSA" ||
    key.use !== "sig"
  ) {
    throw new Error(`${source} is not an EvalDossier Ed25519 private fixture key`);
  }
  return key as unknown as PrivateEd25519Jwk;
}

async function loadPrivateKey(projectRoot: string, name: string): Promise<PrivateEd25519Jwk> {
  const path = join(projectRoot, "fixtures", "keys", name);
  return asPrivateKey(await parseJsonFileStrict(path), path);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function prepareOutputRoot(outputRoot: string): Promise<void> {
  const resolved = resolve(outputRoot);
  const marker = join(resolved, DEMO_MARKER);
  const formal = join(resolved, "formal");
  const modelJudgment = join(resolved, "model-judgment");
  const legacyCapturedModelJudgment = join(resolved, "captured-model-judgment");
  const markerExists = await exists(marker);

  if (
    !markerExists &&
    ((await exists(formal)) ||
      (await exists(modelJudgment)) ||
      (await exists(legacyCapturedModelJudgment)))
  ) {
    throw new Error(
      `Refusing to replace unmarked directories under ${resolved}; remove or move them explicitly`,
    );
  }
  if (markerExists) {
    const contents = await readFile(marker, "utf8");
    if (contents !== "evaldossier-demo-output-v1\n") {
      throw new Error(`Invalid demo marker at ${marker}`);
    }
    await rm(formal, { recursive: true, force: true });
    await rm(modelJudgment, { recursive: true, force: true });
    await rm(legacyCapturedModelJudgment, { recursive: true, force: true });
  }

  await mkdir(resolved, { recursive: true });
  await writeFile(marker, "evaldossier-demo-output-v1\n", { flag: markerExists ? "w" : "wx" });
}

export async function runDemo(outputRootInput: string): Promise<DemoResult> {
  const projectRoot = projectRootFromModule();
  const outputRoot = resolve(outputRootInput);
  await prepareOutputRoot(outputRoot);

  const [referenceKey, adapterKey, requesterKey, exporterKey] = await Promise.all([
    loadPrivateKey(projectRoot, "reference-evaluator.private.jwk.json"),
    loadPrivateKey(projectRoot, "adapter.private.jwk.json"),
    loadPrivateKey(projectRoot, "requester.private.jwk.json"),
    loadPrivateKey(projectRoot, "exporter.private.jwk.json"),
  ]);

  const [formalRun, modelJudgmentRun] = await Promise.all([
    buildReferenceEvaluation(projectRoot, referenceKey, requesterKey),
    buildSyntheticModelJudgmentNormalization(projectRoot, adapterKey, requesterKey),
  ]);

  const formalDirectory = join(outputRoot, "formal");
  const modelJudgmentDirectory = join(outputRoot, "model-judgment");

  await assembleDossier(formalRun, formalDirectory, exporterKey, {
    dossierId: "dossier.formal.reference.001",
    generatedAt: "2026-07-21T12:00:10Z",
    classification: "INTERNAL_REFERENCE",
    exporterId: "evaldossier.fixture.exporter",
    audience: "evaldossier.demo.consumer",
    nonce: "Zm9ybWFsLWRvc3NpZXItbm9uY2U",
    warnings: [
      "Fixture keys establish demo key control only; no institutional identity or trust is pinned.",
    ],
  });

  await assembleDossier(modelJudgmentRun, modelJudgmentDirectory, exporterKey, {
    dossierId: "dossier.synthetic.model-judgment.001",
    generatedAt: "2026-07-21T12:10:20Z",
    classification: "INTERNAL_REFERENCE",
    exporterId: "evaldossier.fixture.exporter",
    audience: "evaldossier.demo.consumer",
    nonce: "synthetic-model-judgment-nonce-0001",
    warnings: [
      "This model-judgment fixture is project-authored synthetic data and represents no external provider or production event.",
      "A favorable synthetic model judgment remains UNDETERMINED without an eligible evidentiary basis.",
      "Synthetic payout fields remain ignored source data and are never mapped to an economic action.",
    ],
  });

  const [formalVerification, modelJudgmentVerification] = await Promise.all([
    verifyDossier(formalDirectory),
    verifyDossier(modelJudgmentDirectory),
  ]);

  return {
    outputRoot,
    formal: formalVerification.summary,
    modelJudgment: modelJudgmentVerification.summary,
  };
}
