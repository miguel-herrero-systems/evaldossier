import { readFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildReferenceEvaluation, renderVerificationSummary } from "evaldossier";
import { assertEvaluatorConformance, defineEvaluator } from "evaldossier/sdk";

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function loadFixtureKey(name) {
  const text = await readFile(join(projectRoot, "fixtures", "keys", name), "utf8");
  return JSON.parse(text);
}

const [evaluatorKey, requesterKey, exporterKey] = await Promise.all([
  loadFixtureKey("reference-evaluator.private.jwk.json"),
  loadFixtureKey("requester.private.jwk.json"),
  loadFixtureKey("exporter.private.jwk.json"),
]);

const evaluator = defineEvaluator({
  evaluatorId: "evaldossier-reference-evaluator",
  async evaluate(input) {
    return buildReferenceEvaluation(input.projectRoot, input.evaluatorKey, input.requesterKey);
  },
});

const temporaryRoot = await mkdtemp(join(tmpdir(), "evaldossier-sdk-example-"));
try {
  const result = await assertEvaluatorConformance(
    evaluator,
    { projectRoot, evaluatorKey, requesterKey },
    {
      outputDirectory: join(temporaryRoot, "dossier"),
      exporterKey,
      dossier: {
        dossierId: "sdk.reference.conformance.001",
        generatedAt: "2026-07-21T12:00:10Z",
        classification: "INTERNAL_REFERENCE",
        exporterId: "evaldossier.fixture.exporter",
        audience: "evaldossier.sdk.example",
        nonce: "c2RrLXJlZmVyZW5jZS1ub25jZS0wMDE",
        warnings: [
          "Fixture keys establish demo key control only; no institutional identity or trust is pinned.",
        ],
      },
    },
    {
      bases: ["FORMAL_PREDICATE"],
      overallBasis: "FORMAL_PREDICATE",
      predicateStatuses: ["ESTABLISHED_TRUE"],
      obligationVerdict: "SATISFIED",
    },
  );

  process.stdout.write(
    [
      "EvalDossier SDK conformance: PASS",
      `Checks: ${result.checks.map((check) => check.id).join(", ")}`,
      "",
      renderVerificationSummary(result.verified.summary),
      "",
    ].join("\n"),
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
