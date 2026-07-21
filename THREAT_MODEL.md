# Threat model

## Assets

- Integrity and provenance of each protocol object.
- Binding between request, profile, evidence, evaluator and attestation.
- Honest representation of the epistemic basis of a result.
- Portability and offline verifiability of a dossier.
- Clear separation from economic action.

## Trust boundaries

- Embedded fixture keys prove only control of those fixture keys.
- The evaluator controls its conclusion and may be wrong or malicious.
- Data represented as an upstream response is not ground truth; without portable source authentication, even its named origin is only recorder-attested.
- The dossier exporter packages objects; it does not upgrade their truth.
- A dossier tree may be attacker-supplied, but v0.1 verification assumes that tree is a static snapshot and is not concurrently mutated by another process while verification runs.
- The top-level dossier's signed audience and nonce are self-declared protocol data unless the consumer supplies expected values out of band. Historical enclosed objects may use different audiences; only request and attestation are required to agree internally.
- The SDK runs a caller-supplied evaluator function in the caller's process. `defineEvaluator` freezes a JavaScript object but is not a sandbox, capability boundary or code-authenticity check.
- Caller-supplied signing keys exist in process memory while signing. The SDK does not persist them, but it cannot protect them from other code already executing in that process.

## Principal threats

- JSON duplicate-key ambiguity.
- Signature substitution or algorithm downgrade.
- Modification of signed context outside the signature.
- Replay under another audience or request.
- Artifact substitution across dossiers.
- Path traversal through a malicious dossier index.
- Mapping an upstream `pass` or `supported` value to factual proof.
- Treating a signed mapping tuple as proof that a general mapping implementation was executed correctly.
- Presenting a self-assertion as independent evidence.
- Treating an offline demo as external adoption.
- Using an attestation as a payment instruction.
- Treating SDK conformance as evaluator certification or marketplace approval.
- Running an untrusted evaluator implementation in the same process as signing keys.
- Publishing an incomplete dossier directory after an assembly failure.

## Current mitigations (SDK v0.2.0, protocol v0.1)

- Strict parsing before schema or signature verification.
- One mandatory signature suite: Ed25519 detached JWS with JCS payloads.
- Audience, nonce, timestamps, issuer and key bindings live in the signed payload.
- Every artifact is bound by raw-byte SHA-256 and size.
- Dossier paths are normalized, relative and confined to the dossier root.
- Result basis, evaluator conclusion and evidentiary status are separate fields.
- Upstream responses are preserved by digest and mapping policy version.
- Supported normalization records bind the declared source pointer and `nativeValue` to a signed result; this checks the committed tuple, not arbitrary mapping execution.
- Consumers may pin the expected top-level dossier audience and nonce. Without them, the verifier reports the corresponding audience or dossier-nonce binding as `UNPINNED`; signer trust is a separate property and remains unpinned.
- `economicAction` is schema-fixed to `OUT_OF_SCOPE`.
- No EvalDossier-owned network client, dynamic plugin discovery, remote storage or signing-key persistence; caller-supplied evaluator I/O is outside this guarantee.
- The SDK owns protocol envelope fields, validates every run object before assembly, binds the executable definition to signed evaluator identities, and pins the finished dossier's audience and nonce during immediate verification.
- Package checks require the SDK exports and schemas while excluding compiled tests and common local-only paths.

## Residual limitations

Cryptography cannot prove that an organization is independent, that a model is correct, that a declared mapping program really ran, or that a source has contractual authority. Those relationships require external evidence, replay, and governance not present in v0.1.

The filesystem checks reject traversal, symlinks, hardlinks, unexpected files and byte mismatches at the points where they are inspected. They do not create an atomic snapshot of the whole directory. A hostile process with concurrent write access may still introduce time-of-check/time-of-use races between directory enumeration and later reads. Verify only an immutable snapshot, a read-only copy, or a directory whose mutation is otherwise excluded for the duration of verification.

`runEvaluator` requires a new output path and prevalidates protocol schemas and evaluator identity before creating it. A failure during later dossier assembly may still leave a partial directory. It must not be published or interpreted as a dossier; remove only that exact known target before retrying.
