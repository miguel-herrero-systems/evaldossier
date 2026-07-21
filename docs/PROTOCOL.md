# EvalDossier protocol 0.1

This document describes the normative shape and interpretation of the six EvalDossier v0.1 protocol objects. The JSON Schemas are authoritative for syntax; this document is authoritative for the intended semantic boundary of the reference implementation.

## Schema identifiers

The v0.1 JSON Schema identifiers are pinned to the versioned release path under `miguel-herrero-systems/evaldossier` at tag `v0.1.0`. The reference implementation loads and registers the committed local schema files; it does not fetch remote schemas or require network access. The URLs provide a controlled, version-specific public identity and become directly retrievable when the matching GitHub release tag is published.

## Design goal

EvalDossier packages an evaluation so a third party can verify its declared integrity, inspect the committed tuple by which upstream fields were represented, and see exactly what the result claims and does not claim to establish. The v0.1 verifier does not re-execute evaluator predicates or a general adapter mapping. It is not a payment instruction, identity registry, neutrality certificate, or truth oracle.

The central separation is:

```text
assessment -> predicateStatus -> obligationVerdict -> economic action
```

- `assessment` records what an evaluator says it concluded.
- `predicateStatus` records what the evaluator declares its method established over the committed inputs; the general verifier checks allowed combinations but not arbitrary method execution.
- `obligationVerdict` applies the signed profile's eligibility and aggregation policy.
- Economic action is fixed to `OUT_OF_SCOPE` in v0.1.

## Protocol objects

### 1. Evaluator manifest

The manifest identifies an evaluator or adapter, embeds its Ed25519 public key, names its supported profile digest, and declares its software and data practices. Its self-signature establishes control of the embedded key. It does not establish legal identity, competence, independence, or trust.

### 2. Profile definition

The profile fixes the operation, permitted result bases, predicates, aggregation rule, and the bases eligible to determine an obligation. A normalization profile may deliberately set `obligationEligibleBases` to an empty array. In that case it can preserve an upstream assessment but can never produce `SATISFIED` or `NOT_SATISFIED`.

Profiles contain only declarative, closed data. EvalDossier v0.1 does not execute expressions, plugins, scripts, remote `$ref` values, or arbitrary URLs.

### 3. Evaluation request

The signed request binds the audience, nonce, evaluator manifest, profile, criteria, and exact input commitments. Every v0.1 request artifact uses `commitmentMode: EXACT_INPUT`; its digest and byte length must match the corresponding evidence artifact. A mismatch is a structurally invalid dossier, not a negative commercial predicate result. The reference evaluator's digest assessment records the successful byte-identity check for audit clarity; its negative branch is defensive and cannot survive v0.1 dossier verification. Expected values that may legitimately differ from observed inputs require a future, separately typed predicate parameter or policy object and must not be smuggled into an exact-input commitment. For offline normalization the request commits the captured snapshot before the adapter runs; it does not claim to predate the upstream service's original evaluation.

Audience and nonce have two distinct properties. Their signatures make later alteration detectable, and the verifier requires the request and attestation audiences to agree. Historical enclosed objects may otherwise carry audiences from their own signing contexts; v0.1 does not require one audience string across the whole dossier.

The top-level dossier audience and nonce become an external trust decision only when the consumer supplies independently expected values through `verify --audience ... --nonce ...` (or the equivalent library options). A mismatch is then rejected. Without `--audience`, the verifier reports `Audience binding: UNPINNED`; without `--nonce`, it reports `Dossier nonce binding: UNPINNED`. Neither form of context pinning establishes signer identity or trust.

### 4. Evidence bundle

The bundle binds the exact bytes declared as evaluated and records their declared provenance. Its collector signature establishes that the bundle verifies under the embedded key, not the real-world identity of the assembler or who originally produced every artifact.

`originAuthentication` must be interpreted narrowly:

- `SOURCE_SIGNED`: reserved for a portable source signature that has actually been verified. The v0.1 reference verifier rejects this value because the protocol does not yet carry and verify such an origin proof; accepting the label alone would be an evidentiary upgrade.
- `RECORDER_ATTESTED`: the recorder attests to the capture; the source did not provide portable authentication.
- `SELF_ASSERTED`: the purported source supplied the statement about itself.
- `SYNTHETIC`: generated test material.
- `UNESTABLISHED`: no origin authentication was established.

A redacted artifact is marked `REDACTED_DERIVATIVE`. A recorder-reported digest of the original bytes is useful trace metadata, but it is not a source signature.

### 5. Evaluation attestation

The attestation contains claim-scoped results, bindings to every preceding object, coverage, errors, ignored inputs, limitations, the overall assessment, and the obligation verdict.

Each atomic result declares one basis:

- `FORMAL_PREDICATE`
- `CRYPTOGRAPHIC_PROOF`
- `AUTHORITATIVE_OBSERVATION`
- `MODEL_JUDGMENT`
- `HEURISTIC`
- `SELF_ASSERTION`

`MODEL_JUDGMENT`, `HEURISTIC`, and `SELF_ASSERTION` always imply `predicateStatus: UNDETERMINED` in v0.1. An adapter may preserve or weaken an upstream result; it may not strengthen its evidentiary status without additional evidence and an eligible method.

Atomic bases remain claim-scoped. If all criteria actually requested use one basis, `overallAssessment.basis` must name it. If the requested criteria span more than one basis, the overall field is `MIXED`; that aggregate label never replaces or strengthens the basis recorded on each atomic assessment.

`FORMAL_PREDICATE` is likewise a signed declaration unless the consumer separately replays the predicate or verifies a proof of execution. The repository's native reference evaluator does execute its three documented checks while constructing the demo, but the general dossier verifier does not infer that every external evaluator did the same merely from its basis label.

For a supported upstream-normalization record, the signed attestation declares a `sourceArtifactId`, JSON Pointer, `nativeValue`, mapping-policy identifier and normalized result, while its evidence binding leads to the committed source bytes. The reference verifier can check that the pointer resolves within those bytes and equals the declared native value. That check authenticates the committed tuple and detects tampering; it does not execute a general mapping implementation, prove that the named policy was followed, or establish the truth of either the native or normalized conclusion.

### 6. Dossier

The dossier is a signed portable index. It contains exactly one manifest, profile, request, evidence bundle, and attestation, plus the committed source artifacts and an optional non-authoritative human report. The dossier does not include itself in its entry list.

Every entry binds a relative path, raw-byte SHA-256 digest, byte length, media type, and whether it is required for verification. A verifier rejects absolute paths, traversal, backslashes, repeated paths, symbolic links, hardlinks, oversized files, missing or unexpected artifacts, and digest mismatches.

These filesystem checks assume a static dossier tree for the duration of one verification. They do not provide an atomic filesystem snapshot and therefore do not eliminate every time-of-check/time-of-use race against a process that can concurrently mutate the tree.

## Signing profile

All protocol objects use one signature suite:

- Ed25519 (`EdDSA`);
- detached compact JWS;
- normal base64url-encoded payload;
- RFC 8785/JCS canonical JSON after removing the complete `proof` member;
- `kid` equal to the RFC 7638 SHA-256 thumbprint of the Ed25519 public JWK;
- no network key discovery.

The protected header contains exactly:

```json
{
  "alg": "EdDSA",
  "kid": "<RFC-7638-thumbprint>",
  "typ": "<schemaVersion>"
}
```

Unknown headers, alternate algorithms, `alg: none`, key URLs, padded or non-canonical base64url, a non-empty detached payload segment, and a mismatched `kid` or `typ` are rejected.

## Verification layers

Successful offline verification is deliberately not reported as a single universal `VERIFIED` claim. The reference verifier distinguishes:

1. Schema validity.
2. Raw-byte integrity and cross-object bindings.
3. Signature validity and key control.
4. Expected top-level dossier audience and nonce, when externally supplied; each binding is otherwise reported `UNPINNED`.
5. Signer trust and identity, which remain unpinned in the demo.
6. Evidence provenance.
7. Predicate status and protocol-local basis eligibility.
8. Obligation verdict recomputed from the declared results and profile.
9. Economic action, always `OUT_OF_SCOPE`.

This separation helps a consumer avoid misreading a self-signed but internally consistent dossier as a trusted institutional identity or a true commercial claim.

## Synthetic model-judgment fixture

The second example is a project-authored synthetic interoperability fixture. It is neither a captured third-party response nor a claim about an external evaluator, integration, production event, adoption, or demand. No v0.1 component contacts a remote service.

The adapter preserves synthetic source fields—`supported`, score, notes, aggregate result and mapping pointers—but types each no-evidence claim as `MODEL_JUDGMENT`. A synthetic `supported: true` therefore becomes:

```json
{
  "assessment": "AFFIRMED",
  "predicateStatus": "UNDETERMINED",
  "basis": "MODEL_JUDGMENT"
}
```

The synthetic source's aggregate result remains an overall model assessment. Because the profile has no obligation-eligible basis, the obligation verdict is `INCONCLUSIVE`. Its deliberately included payout recommendation remains only in the source artifact and never crosses the v0.1 economic boundary.

The verifier checks the supported pointer/native-value binding in this fixture, but it does not rerun a generic adapter or certify that the mapping policy is correct. Removing the fixture and adapter would leave the native evaluator, schemas, dossier format and verifier operational.

## Non-claims

A valid EvalDossier does not by itself establish:

- that an evaluator is neutral or independent;
- that an embedded key belongs to a real-world organization;
- that an upstream capture originated from the named service unless portable origin authentication is present;
- that a model judgment is factually correct;
- that a signed normalizer actually executed a general mapping implementation or chose a semantically correct mapping;
- that an unpinned audience or nonce was selected by the intended consumer;
- that a formal predicate captured the parties' full commercial intent;
- that an obligation should cause any payment, refund, release, or rejection.

Those are separate trust, governance, contractual, and economic layers.
