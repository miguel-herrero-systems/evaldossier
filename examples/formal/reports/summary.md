# EvalDossier human-readable report

> This rendering is committed by the dossier but is not authoritative. Verify the signed JSON objects.

- Attestation: `reference-evaluation-attestation-v0`
- Mode: `NATIVE_EVALUATION`
- Coverage: `COMPLETE`
- Overall assessment: `AFFIRMED`
- Overall basis: `FORMAL_PREDICATE`
- Obligation verdict: `SATISFIED`
- Economic action: `OUT_OF_SCOPE`

| Result | Basis | Assessment | Predicate status | Upstream confidence | Statement |
|---|---|---|---|---:|---|
| assessment-artifact-present | FORMAL_PREDICATE | AFFIRMED | ESTABLISHED_TRUE | — | The deliverable artifact is present and non-empty. |
| assessment-artifact-digest | FORMAL_PREDICATE | AFFIRMED | ESTABLISHED_TRUE | — | The observed deliverable digest and size match their signed request commitment. |
| assessment-json-schema | FORMAL_PREDICATE | AFFIRMED | ESTABLISHED_TRUE | — | The committed deliverable is strict JSON valid against the committed local-only JSON Schema. |

## Interpretation boundary

A valid signature proves integrity and control of a demo signing key. It does not establish institutional identity, independence, factual truth, contractual authority, or a payment instruction.
