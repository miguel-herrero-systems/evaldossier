import type { JsonObject, JsonValue } from "./types.js";

export interface VerificationSummary {
  dossierId: string;
  schema: "VALID" | "INVALID";
  integrity: "VALID" | "INVALID";
  signatures: "VALID" | "INVALID";
  keyControl: "ESTABLISHED" | "NOT_ESTABLISHED";
  signerTrust: "UNPINNED";
  identity: "NOT_ESTABLISHED";
  audience: string;
  audienceBinding: "PINNED" | "UNPINNED";
  dossierNonceBinding: "PINNED" | "UNPINNED";
  provenance: string[];
  bases: string[];
  overallBasis: string;
  predicateStatuses: string[];
  obligationVerdict: string;
  economicAction: "OUT_OF_SCOPE";
  warnings: string[];
}

function asObject(value: JsonValue | undefined, field: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an object`);
  }
  return value;
}

function asArray(value: JsonValue | undefined, field: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an array`);
  }
  return value;
}

function asString(value: JsonValue | undefined, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string`);
  }
  return value;
}

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("`", "\\`")
    .replace(/[\r\n]+/g, " ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function summarizeAttestation(attestation: JsonObject): {
  bases: string[];
  overallBasis: string;
  predicateStatuses: string[];
  obligationVerdict: string;
  economicAction: "OUT_OF_SCOPE";
} {
  const assessments = asArray(attestation.assessments, "attestation.assessments");
  const objects = assessments.map((assessment, index) =>
    asObject(assessment, `attestation.assessments[${index}]`),
  );
  const overall = asObject(attestation.overallAssessment, "attestation.overallAssessment");

  const economicAction = asString(attestation.economicAction, "attestation.economicAction");
  if (economicAction !== "OUT_OF_SCOPE") {
    throw new Error("EvalDossier v0.1 forbids economic actions");
  }

  return {
    bases: unique(objects.map((assessment) => asString(assessment.basis, "assessment.basis"))),
    overallBasis: asString(overall.basis, "overallAssessment.basis"),
    predicateStatuses: unique(
      objects.map((assessment) => asString(assessment.predicateStatus, "assessment.predicateStatus")),
    ),
    obligationVerdict: asString(attestation.obligationVerdict, "attestation.obligationVerdict"),
    economicAction,
  };
}

export function renderAttestationReport(attestation: JsonObject): string {
  const overall = asObject(attestation.overallAssessment, "attestation.overallAssessment");
  const coverage = asObject(attestation.coverage, "attestation.coverage");
  const assessments = asArray(attestation.assessments, "attestation.assessments").map(
    (assessment, index) => asObject(assessment, `attestation.assessments[${index}]`),
  );
  const summary = summarizeAttestation(attestation);

  const rows = assessments.map((assessment) => {
    const confidence = assessment.confidence;
    const confidenceValue =
      confidence === undefined
        ? "—"
        : asString(asObject(confidence, "assessment.confidence").value, "assessment.confidence.value");

    return `| ${escapeMarkdown(asString(assessment.assessmentId, "assessment.assessmentId"))} | ${escapeMarkdown(asString(assessment.basis, "assessment.basis"))} | ${escapeMarkdown(asString(assessment.assessment, "assessment.assessment"))} | ${escapeMarkdown(asString(assessment.predicateStatus, "assessment.predicateStatus"))} | ${escapeMarkdown(confidenceValue)} | ${escapeMarkdown(asString(assessment.statement, "assessment.statement"))} |`;
  });

  return [
    "# EvalDossier human-readable report",
    "",
    "> This rendering is committed by the dossier but is not authoritative. Verify the signed JSON objects.",
    "",
    `- Attestation: \`${escapeMarkdown(asString(attestation.attestationId, "attestation.attestationId"))}\``,
    `- Mode: \`${escapeMarkdown(asString(attestation.mode, "attestation.mode"))}\``,
    `- Coverage: \`${escapeMarkdown(asString(coverage.status, "coverage.status"))}\``,
    `- Overall assessment: \`${escapeMarkdown(asString(overall.assessment, "overallAssessment.assessment"))}\``,
    `- Overall basis: \`${escapeMarkdown(summary.overallBasis)}\``,
    `- Obligation verdict: \`${escapeMarkdown(summary.obligationVerdict)}\``,
    `- Economic action: \`${summary.economicAction}\``,
    "",
    "| Result | Basis | Assessment | Predicate status | Upstream confidence | Statement |",
    "|---|---|---|---|---:|---|",
    ...rows,
    "",
    "## Interpretation boundary",
    "",
    "A valid signature proves integrity and control of a demo signing key. It does not establish institutional identity, independence, factual truth, contractual authority, or a payment instruction.",
    "",
  ].join("\n");
}

export function renderVerificationSummary(summary: VerificationSummary): string {
  return [
    `Dossier: ${summary.dossierId}`,
    `Schema: ${summary.schema}`,
    `Integrity: ${summary.integrity}`,
    `Signatures: ${summary.signatures}`,
    `Key control: ${summary.keyControl}`,
    `Signer trust: ${summary.signerTrust}`,
    `Identity: ${summary.identity}`,
    `Audience: ${summary.audience}`,
    `Audience binding: ${summary.audienceBinding}`,
    `Dossier nonce binding: ${summary.dossierNonceBinding}`,
    `Provenance: ${summary.provenance.join(", ") || "UNESTABLISHED"}`,
    `Atomic bases: ${summary.bases.join(", ")}`,
    `Overall basis: ${summary.overallBasis}`,
    `Predicate status: ${summary.predicateStatuses.join(", ")}`,
    `Obligation verdict: ${summary.obligationVerdict}`,
    `Economic action: ${summary.economicAction}`,
    ...summary.warnings.map((warning) => `Warning: ${warning}`),
  ].join("\n");
}
